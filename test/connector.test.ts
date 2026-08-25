import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRelayConnector,
  type AgentAdapter,
  type AgentRequest,
  type RelayConnectorOptions,
  type RelayTask,
} from "../src/connector.js";
import { encryptEventContext } from "../src/crypto.js";
import type { PagentEventMetadata } from "../src/types.js";

const CURRENT_KEY = Buffer.alloc(32, 1).toString("base64url");
const PREVIOUS_KEY = Buffer.alloc(32, 2).toString("base64url");
const WRONG_KEY = Buffer.alloc(32, 3).toString("base64url");
const CURRENT_KEYRING = { current: CURRENT_KEY };
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("relay connector", () => {
  it("decrypts an allowed task and builds the read-only prompt locally", async () => {
    const requests: AgentRequest[] = [];
    const results: string[] = [];
    const connections: boolean[] = [];
    const relayTask = await task("task-1");
    const fetchRelay = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer connector-secret",
      );
      expect(new Headers(init?.headers).get("accept")).toBe(
        "text/event-stream",
      );
      expect(new Headers(init?.headers).has("last-event-id")).toBe(false);
      return sseResponse(relayTask, [7, 13, 5]);
    });
    const inboxPath = await temporaryInbox();
    const connector = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      token: "connector-secret",
      onAgentResult: (result) => {
        results.push(result.threadId ?? "unknown");
      },
      onConnectionChange: (connected) => connections.push(connected),
      fetch: fetchRelay as typeof fetch,
    });

    await connector.runOnce();

    expect(fetchRelay).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      cwd: resolve("."),
      prompt: expect.stringContaining(
        "Find the root cause and report the supporting evidence. Do not modify files.",
      ),
      event: {
        id: "event-task-1",
        type: "health.failed",
        environment: "staging",
        occurredAt: "2026-08-24T12:00:00.000Z",
        investigation: { cooldownMs: 0 },
        payload: { reason: "pool exhausted" },
      },
    });
    expect(requests[0]?.prompt).toContain("Event ID: event-task-1");
    expect(requests[0]?.prompt).toContain('"reason": "pool exhausted"');
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toEqual({
      version: 2,
      cursor: "task-1",
      pending: [],
      completed: ["task-1"],
    });
    expect(results).toEqual(["thread-1"]);
    expect(connections).toEqual([true, false]);
  });

  it("persists only ciphertext when an agent run remains pending", async () => {
    const relayTask = await task("task-ciphertext");
    const inboxPath = await temporaryInbox();
    const failure = new Error("Codex unavailable");
    const connector = createRelayConnector({
      ...connectorOptions(inboxPath, {
        run: vi.fn(async () => Promise.reject(failure)),
      }),
      fetch: vi.fn(async () => sseResponse(relayTask)) as typeof fetch,
    });

    await expect(connector.runOnce()).rejects.toBe(failure);

    const inbox = await readFile(inboxPath, "utf8");
    expect(inbox).not.toContain("pool exhausted");
    expect(inbox).not.toContain("payload");
    expect(JSON.parse(inbox)).toMatchObject({
      version: 2,
      cursor: "task-ciphertext",
      pending: [
        {
          id: "task-ciphertext",
          context: {
            algorithm: "A256GCM",
            keyId: "current",
            ciphertext: relayTask.context.ciphertext,
          },
        },
      ],
      completed: [],
    });
  });

  it("cancels an active agent run and leaves its encrypted task pending", async () => {
    const relayTask = await task("task-cancelled");
    const inboxPath = await temporaryInbox();
    let receivedSignal: AbortSignal | undefined;
    let markAgentStarted: (() => void) | undefined;
    const agentStarted = new Promise<void>((resolve) => {
      markAgentStarted = resolve;
    });
    const connector = createRelayConnector({
      ...connectorOptions(inboxPath, {
        run: vi.fn(async (request) => {
          receivedSignal = request.signal;
          markAgentStarted?.();
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(request.signal?.reason),
              { once: true },
            );
          });
          return {};
        }),
      }),
      fetch: vi.fn(async () => sseResponse(relayTask)) as typeof fetch,
    });
    const abort = new AbortController();
    const running = connector.run({ signal: abort.signal });

    await agentStarted;
    abort.abort();
    await running;

    expect(receivedSignal).toBe(abort.signal);
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toMatchObject({
      pending: [{ id: "task-cancelled" }],
      completed: [],
    });
  });

  it("resumes an encrypted task and does not replay a completed task", async () => {
    const requests: AgentRequest[] = [];
    const inboxPath = await temporaryInbox();
    const relayTask = await task("task-2");
    const first = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      fetch: vi.fn(async () => sseResponse(relayTask)) as typeof fetch,
    });
    await first.runOnce();

    const secondFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("last-event-id")).toBe("task-2");
        return sseResponse(relayTask);
      },
    );
    const second = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      fetch: secondFetch as typeof fetch,
    });

    await second.runOnce();

    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it.each([
    {
      name: "environment",
      overrides: { environment: "development" },
      message: "disallowed environment development",
    },
    {
      name: "repository",
      overrides: { repositoryKey: "unknown" },
      message: "unknown repository unknown",
    },
  ])("fails closed for an unlisted $name", async ({ overrides, message }) => {
    const requests: AgentRequest[] = [];
    const errors: unknown[] = [];
    const inboxPath = await temporaryInbox();
    const relayTask = await task(`task-${overrides.environment ?? "repository"}`, {
      overrides,
    });
    const connector = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      onError: (error) => errors.push(error),
      fetch: vi.fn(async () => sseResponse(relayTask)) as typeof fetch,
    });

    await connector.runOnce();

    expect(requests).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(
      expect.objectContaining({ message: expect.stringContaining(message) }),
    );
  });

  it.each([
    {
      name: "an unknown key",
      createTask: () => task("task-unknown", { keyId: "unknown" }),
      message: "unknown context key unknown",
    },
    {
      name: "a wrong key",
      createTask: () => task("task-wrong", { key: WRONG_KEY }),
      message: "context could not be decrypted",
    },
    {
      name: "tampered ciphertext",
      createTask: async () => {
        const relayTask = await task("task-tampered");
        return {
          ...relayTask,
          context: {
            ...relayTask.context,
            ciphertext: flipFirstCharacter(relayTask.context.ciphertext),
          },
        };
      },
      message: "context could not be decrypted",
    },
  ])("keeps $name pending and never runs the agent", async ({ createTask, message }) => {
    const requests: AgentRequest[] = [];
    const inboxPath = await temporaryInbox();
    const relayTask = await createTask();
    const connector = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      fetch: vi.fn(async () => sseResponse(relayTask)) as typeof fetch,
    });

    await expect(connector.runOnce()).rejects.toThrow(message);

    expect(requests).toHaveLength(0);
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toMatchObject({
      pending: [{ id: relayTask.id }],
      completed: [],
    });
  });

  it("decrypts tasks with the previous key during rotation", async () => {
    const requests: AgentRequest[] = [];
    const inboxPath = await temporaryInbox();
    const relayTask = await task("task-rotation", {
      keyId: "previous",
      key: PREVIOUS_KEY,
    });
    const connector = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      encryption: {
        keys: { current: CURRENT_KEY, previous: PREVIOUS_KEY },
      },
      fetch: vi.fn(async () => sseResponse(relayTask)) as typeof fetch,
    });

    await connector.runOnce();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.event.payload).toEqual({ reason: "pool exhausted" });
  });

  it("retries a failed local run before reconnecting", async () => {
    const inboxPath = await temporaryInbox();
    const failure = new Error("Codex unavailable");
    const relayTask = await task("task-5");
    const failing = createRelayConnector({
      ...connectorOptions(inboxPath, {
        run: vi.fn(async () => Promise.reject(failure)),
      }),
      fetch: vi.fn(async () => sseResponse(relayTask)) as typeof fetch,
    });

    await expect(failing.runOnce()).rejects.toBe(failure);

    const requests: AgentRequest[] = [];
    const recoveryFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("last-event-id")).toBe("task-5");
      return emptySseResponse();
    });
    const recovered = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      fetch: recoveryFetch as typeof fetch,
    });

    await recovered.runOnce();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.event.id).toBe("event-task-5");
    expect(recoveryFetch).toHaveBeenCalledTimes(1);
  });
});

function connectorOptions(
  inboxPath: string,
  agent: AgentAdapter,
): RelayConnectorOptions {
  return {
    url: "https://relay.example.test/events",
    token: "secret",
    inboxPath,
    repositories: { pagent: "." },
    environments: ["staging"],
    encryption: { keys: CURRENT_KEYRING },
    agent,
  };
}

function recordingAgent(requests: AgentRequest[]): AgentAdapter {
  return {
    async run(request) {
      requests.push(request);
      return { threadId: "thread-1" };
    },
  };
}

async function task(
  id: string,
  options: {
    overrides?: Partial<RelayTask>;
    keyId?: string;
    key?: string;
  } = {},
): Promise<RelayTask> {
  const base = {
    id,
    eventId: `event-${id}`,
    type: "health.failed",
    environment: "staging",
    occurredAt: "2026-08-24T12:00:00.000Z",
    investigation: { cooldownMs: 0 },
    repositoryKey: "pagent",
    ...options.overrides,
  };
  const metadata: PagentEventMetadata = {
    id: base.eventId,
    type: base.type,
    environment: base.environment,
    occurredAt: base.occurredAt,
    investigation: base.investigation,
  };
  const context = await encryptEventContext(
    metadata,
    { reason: "pool exhausted" },
    { keyId: options.keyId ?? "current", key: options.key ?? CURRENT_KEY },
  );

  return { ...base, context };
}

function sseResponse(relayTask: RelayTask, chunkSizes: number[] = []): Response {
  const content = `: heartbeat\r\nid: ${relayTask.id}\r\nevent: task\r\ndata: ${JSON.stringify(relayTask)}\r\n\r\n`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const size of chunkSizes) {
    chunks.push(encoder.encode(content.slice(offset, offset + size)));
    offset += size;
  }
  chunks.push(encoder.encode(content.slice(offset)));

  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

function emptySseResponse(): Response {
  return new Response(": heartbeat\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function flipFirstCharacter(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

async function temporaryInbox(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pagent-connector-"));
  temporaryDirectories.push(directory);
  return join(directory, "inbox.json");
}
