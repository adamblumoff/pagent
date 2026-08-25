import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRelayConnector,
  type AgentAdapter,
  type AgentRequest,
  type RelayTask,
} from "../src/connector.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("relay connector", () => {
  it("streams an allowed task into the local agent without a writeback", async () => {
    const requests: AgentRequest[] = [];
    const results: string[] = [];
    const fetchRelay = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer connector-secret",
      );
      expect(new Headers(init?.headers).get("accept")).toBe(
        "text/event-stream",
      );
      expect(new Headers(init?.headers).has("last-event-id")).toBe(false);
      return sseResponse(task("task-1"), [7, 13, 5]);
    });
    const inboxPath = await temporaryInbox();
    const connector = createRelayConnector({
      url: "https://relay.example.test/events",
      token: "connector-secret",
      inboxPath,
      repositories: { pagent: "." },
      environments: ["staging"],
      agent: recordingAgent(requests),
      onAgentResult: (result) => {
        results.push(result.threadId ?? "unknown");
      },
      fetch: fetchRelay as typeof fetch,
    });

    await connector.runOnce();

    expect(fetchRelay).toHaveBeenCalledTimes(1);
    expect(requests).toEqual([
      {
        cwd: resolve("."),
        prompt: "Find the cause of the failed health check.",
        event: {
          id: "task-1",
          type: "health.failed",
          environment: "staging",
          occurredAt: "2026-08-24T12:00:00.000Z",
          investigation: { cooldownMs: 0 },
          payload: { reason: "pool exhausted" },
        },
      },
    ]);
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toEqual({
      version: 1,
      cursor: "task-1",
      pending: [],
      completed: ["task-1"],
    });
    expect(results).toEqual(["thread-1"]);
  });

  it("resumes from disk and does not run a completed task twice", async () => {
    const requests: AgentRequest[] = [];
    const inboxPath = await temporaryInbox();
    const first = createRelayConnector({
      url: "https://relay.example.test/events",
      token: "secret",
      inboxPath,
      repositories: { pagent: "." },
      environments: ["staging"],
      agent: recordingAgent(requests),
      fetch: vi.fn(async () => sseResponse(task("task-2"))) as typeof fetch,
    });
    await first.runOnce();

    const secondFetch = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit) => {
        expect(new Headers(init?.headers).get("last-event-id")).toBe("task-2");
        return sseResponse(task("task-2"));
      },
    );
    const second = createRelayConnector({
      url: "https://relay.example.test/events",
      token: "secret",
      inboxPath,
      repositories: { pagent: "." },
      environments: ["staging"],
      agent: recordingAgent(requests),
      fetch: secondFetch as typeof fetch,
    });

    await second.runOnce();

    expect(secondFetch).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(1);
  });

  it.each([
    {
      name: "environment",
      task: task("task-3", { environment: "development" }),
      message: "disallowed environment development",
    },
    {
      name: "repository",
      task: task("task-4", { repositoryKey: "unknown" }),
      message: "unknown repository unknown",
    },
  ])("fails closed for an unlisted $name", async ({ task: relayTask, message }) => {
    const requests: AgentRequest[] = [];
    const errors: unknown[] = [];
    const inboxPath = await temporaryInbox();
    const connector = createRelayConnector({
      url: "https://relay.example.test/events",
      token: "secret",
      inboxPath,
      repositories: { pagent: "." },
      environments: ["staging"],
      agent: recordingAgent(requests),
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

  it("keeps a failed run in the local inbox and retries it before reconnecting", async () => {
    const inboxPath = await temporaryInbox();
    const failure = new Error("Codex unavailable");
    const failingFetch = vi.fn(async () => sseResponse(task("task-5")));
    const failing = createRelayConnector({
      url: "https://relay.example.test/events",
      token: "secret",
      inboxPath,
      repositories: { pagent: "." },
      environments: ["staging"],
      agent: { run: vi.fn(async () => Promise.reject(failure)) },
      fetch: failingFetch as typeof fetch,
    });

    await expect(failing.runOnce()).rejects.toBe(failure);
    expect(JSON.parse(await readFile(inboxPath, "utf8"))).toMatchObject({
      cursor: "task-5",
      pending: [{ id: "task-5" }],
      completed: [],
    });

    const requests: AgentRequest[] = [];
    const recoveryFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("last-event-id")).toBe("task-5");
      return emptySseResponse();
    });
    const recovered = createRelayConnector({
      url: "https://relay.example.test/events",
      token: "secret",
      inboxPath,
      repositories: { pagent: "." },
      environments: ["staging"],
      agent: recordingAgent(requests),
      fetch: recoveryFetch as typeof fetch,
    });

    await recovered.runOnce();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.event.id).toBe("task-5");
    expect(recoveryFetch).toHaveBeenCalledTimes(1);
  });
});

function recordingAgent(requests: AgentRequest[]): AgentAdapter {
  return {
    async run(request) {
      requests.push(request);
      return { threadId: "thread-1" };
    },
  };
}

function task(
  id: string,
  overrides: Partial<RelayTask> = {},
): RelayTask {
  return {
    id,
    type: "health.failed",
    environment: "staging",
    occurredAt: "2026-08-24T12:00:00.000Z",
    investigation: { cooldownMs: 0 },
    repositoryKey: "pagent",
    prompt: "Find the cause of the failed health check.",
    payload: { reason: "pool exhausted" },
    ...overrides,
  };
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

async function temporaryInbox(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pagent-connector-"));
  temporaryDirectories.push(directory);
  return join(directory, "inbox.json");
}
