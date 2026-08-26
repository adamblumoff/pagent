import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentAdapter, AgentRequest } from "../src/agent.js";
import {
  createRelayConnector,
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
    const relayTask = await task("1");
    const fetchRelay = connectorFetch(
      () => sseResponse(relayTask, [7, 13, 5]),
      (_url, init) => {
        expect(init?.method).toBe("GET");
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer connector-secret",
        );
        expect(new Headers(init?.headers).get("accept")).toBe(
          "text/event-stream",
        );
        expect(new Headers(init?.headers).has("last-event-id")).toBe(false);
      },
      "connector-secret",
    );
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

    expect(fetchRelay).toHaveBeenCalledTimes(2);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      cwd: resolve("."),
      prompt: expect.stringContaining(
        "Find the root cause and report the supporting evidence. Do not modify files.",
      ),
      event: {
        id: "event-1",
        type: "health.failed",
        environment: "staging",
        occurredAt: "2026-08-24T12:00:00.000Z",
        investigation: { cooldownMs: 0 },
        payload: { reason: "pool exhausted" },
      },
    });
    expect(requests[0]?.prompt).toContain("Event ID: event-1");
    expect(requests[0]?.prompt).toContain('"reason": "pool exhausted"');
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toEqual({
      version: 4,
      cursor: "1",
      pending: [],
      acknowledgements: [],
    });
    expect(results).toEqual(["thread-1"]);
    expect(connections).toEqual([true, false]);
  });

  it("persists only ciphertext when an agent run remains pending", async () => {
    const relayTask = await task("2");
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
      version: 4,
      cursor: "2",
      pending: [
        {
          id: "2",
          context: {
            algorithm: "A256GCM",
            keyId: "current",
            ciphertext: relayTask.context.ciphertext,
          },
        },
      ],
    });
  });

  it("cancels an active agent run and leaves its encrypted task pending", async () => {
    const relayTask = await task("3");
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
      pending: [{ id: "3" }],
    });
  });

  it("ignores duplicate and older deliveries without moving the cursor backward", async () => {
    const requests: AgentRequest[] = [];
    const inboxPath = await temporaryInbox();
    const relayTask = await task("4");
    const olderTask = await task("3");
    const first = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      fetch: connectorFetch(() => sseResponse(relayTask)),
    });
    await first.runOnce();

    const secondFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("last-event-id")).toBe("4");
        return sseResponse([relayTask, olderTask]);
      },
    );
    const second = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      fetch: secondFetch as typeof fetch,
    });

    await second.runOnce();

    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toEqual({
      version: 4,
      cursor: "4",
      pending: [],
      acknowledgements: [],
    });
  });

  it.each([
    {
      id: "5",
      name: "environment",
      overrides: { environment: "development" },
      message: "disallowed environment development",
    },
    {
      id: "6",
      name: "repository",
      overrides: { repositoryKey: "unknown" },
      message: "unknown repository unknown",
    },
  ])("fails closed for an unlisted $name", async ({ id, overrides, message }) => {
    const requests: AgentRequest[] = [];
    const errors: unknown[] = [];
    const inboxPath = await temporaryInbox();
    const relayTask = await task(id, { overrides });
    const connector = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      onError: (error) => errors.push(error),
      fetch: vi.fn(async () => sseResponse(relayTask)) as typeof fetch,
    });

    await expect(connector.runOnce()).rejects.toThrow(message);

    expect(requests).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toMatchObject({
      pending: [{ id }],
    });
  });

  it.each([
    {
      name: "an unknown key",
      createTask: () => task("7", { keyId: "unknown" }),
      message: "unknown context key unknown",
    },
    {
      name: "a wrong key",
      createTask: () => task("8", { key: WRONG_KEY }),
      message: "context could not be decrypted",
    },
    {
      name: "tampered ciphertext",
      createTask: async () => {
        const relayTask = await task("9");
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
    });
  });

  it("drains an offline task with its retained key after rotation", async () => {
    const inboxPath = await temporaryInbox();
    const relayTask = await task("10", {
      keyId: "key-a",
      key: PREVIOUS_KEY,
    });
    const failure = new Error("Codex unavailable");
    const offline = createRelayConnector({
      ...connectorOptions(inboxPath, {
        run: vi.fn(async () => Promise.reject(failure)),
      }),
      encryption: { keys: { "key-a": PREVIOUS_KEY } },
      fetch: vi.fn(async () => sseResponse(relayTask)) as typeof fetch,
    });

    await expect(offline.runOnce()).rejects.toBe(failure);
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toMatchObject({
      cursor: "10",
      pending: [{ id: "10", context: { keyId: "key-a" } }],
    });

    const requests: AgentRequest[] = [];
    const rotated = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      encryption: {
        keys: { "key-b": CURRENT_KEY, "key-a": PREVIOUS_KEY },
      },
      fetch: connectorFetch(() => emptySseResponse()),
    });

    await rotated.runOnce();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.event.payload).toEqual({ reason: "pool exhausted" });
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toEqual({
      version: 4,
      cursor: "10",
      pending: [],
      acknowledgements: [],
    });
  });

  it("retries a failed local run before reconnecting", async () => {
    const inboxPath = await temporaryInbox();
    const failure = new Error("Codex unavailable");
    const relayTask = await task("11");
    const failing = createRelayConnector({
      ...connectorOptions(inboxPath, {
        run: vi.fn(async () => Promise.reject(failure)),
      }),
      fetch: vi.fn(async () => sseResponse(relayTask)) as typeof fetch,
    });

    await expect(failing.runOnce()).rejects.toBe(failure);

    const requests: AgentRequest[] = [];
    const recoveryFetch = connectorFetch(() => emptySseResponse(), (
      _url,
      init,
    ) => {
      expect(new Headers(init?.headers).get("last-event-id")).toBe("11");
    });
    const recovered = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      fetch: recoveryFetch as typeof fetch,
    });

    await recovered.runOnce();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.event.id).toBe("event-11");
    expect(recoveryFetch).toHaveBeenCalledTimes(2);
  });

  it("retries a failed acknowledgement without running Codex twice", async () => {
    const inboxPath = await temporaryInbox();
    const relayTask = await task("14");
    const requests: AgentRequest[] = [];
    const failedAcknowledgement = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) =>
        init?.method === "POST"
          ? new Response(null, { status: 503 })
          : sseResponse(relayTask),
    ) as typeof fetch;
    const first = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      fetch: failedAcknowledgement,
    });

    await expect(first.runOnce()).rejects.toThrow(
      "Relay acknowledgement failed with status 503",
    );
    expect(requests).toHaveLength(1);
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toEqual({
      version: 4,
      cursor: "14",
      pending: [],
      acknowledgements: ["14"],
    });

    const methods: string[] = [];
    const recovered = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      fetch: vi.fn(async (_input, init) => {
        methods.push(init?.method ?? "GET");
        return init?.method === "POST"
          ? new Response(null, { status: 200 })
          : emptySseResponse();
      }) as typeof fetch,
    });

    await recovered.runOnce();

    expect(methods).toEqual(["POST", "GET"]);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toEqual({
      version: 4,
      cursor: "14",
      pending: [],
      acknowledgements: [],
    });
  });

  it("migrates v2 state while preserving its cursor and pending task", async () => {
    const inboxPath = await temporaryInbox();
    const relayTask = await task("12");
    await writeFile(
      inboxPath,
      `${JSON.stringify({
        version: 2,
        cursor: "12",
        pending: [relayTask],
        completed: ["1", "2", "3"],
      })}\n`,
      "utf8",
    );
    const failure = new Error("Codex unavailable");
    const connector = createRelayConnector({
      ...connectorOptions(inboxPath, {
        run: vi.fn(async () => Promise.reject(failure)),
      }),
      fetch: vi.fn(async () => emptySseResponse()) as typeof fetch,
    });

    await expect(connector.runOnce()).rejects.toBe(failure);

    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toEqual({
      version: 4,
      cursor: "12",
      pending: [relayTask],
      acknowledgements: [],
    });
  });

  it("skips an invalid task and resumes after its sequence ID", async () => {
    const inboxPath = await temporaryInbox();
    const errors: unknown[] = [];
    const requests: AgentRequest[] = [];
    const invalid = await task("13");
    const first = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      onError: (error) => errors.push(error),
      fetch: vi.fn(async () =>
        sseMessageResponse("13", JSON.stringify({ ...invalid, id: "99" })),
      ) as typeof fetch,
    });

    await first.runOnce();

    expect(requests).toHaveLength(0);
    expect(errors).toEqual([
      expect.objectContaining({ message: "Relay task 13 has an invalid shape." }),
    ]);
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toEqual({
      version: 4,
      cursor: "13",
      pending: [],
      acknowledgements: [],
    });

    const fetchRelay = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("last-event-id")).toBe("13");
        return emptySseResponse();
      },
    );
    const second = createRelayConnector({
      ...connectorOptions(inboxPath, recordingAgent(requests)),
      fetch: fetchRelay as typeof fetch,
    });

    await second.runOnce();

    expect(fetchRelay).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(0);
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

function sseResponse(
  input: RelayTask | readonly RelayTask[],
  chunkSizes: number[] = [],
): Response {
  const relayTasks = Array.isArray(input) ? input : [input];
  const content = `: heartbeat\r\n${relayTasks
    .map(
      (relayTask) =>
        `id: ${relayTask.id}\r\nevent: task\r\ndata: ${JSON.stringify(relayTask)}\r\n\r\n`,
    )
    .join("")}`;
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

function sseMessageResponse(id: string, data: string): Response {
  return new Response(`id: ${id}\nevent: task\ndata: ${data}\n\n`, {
    headers: { "content-type": "text/event-stream" },
  });
}

function emptySseResponse(): Response {
  return new Response(": heartbeat\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}

function connectorFetch(
  sse: () => Response,
  inspectSse?: (input: string | URL | Request, init?: RequestInit) => void,
  token = "secret",
): typeof fetch {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "POST") {
      expect(input.toString()).toMatch(/\/tasks\/[1-9]\d*\/ack$/u);
      expect(new Headers(init.headers).get("authorization")).toBe(
        `Bearer ${token}`,
      );
      return new Response(
        JSON.stringify({ version: 1, status: "acknowledged" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    inspectSse?.(input, init);
    return sse();
  }) as typeof fetch;
}

function flipFirstCharacter(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}

async function temporaryInbox(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pagent-connector-"));
  temporaryDirectories.push(directory);
  return join(directory, "inbox.json");
}
