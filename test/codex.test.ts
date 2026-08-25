import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough } from "node:stream";

import { beforeEach, describe, expect, it, vi } from "vitest";

const childProcesses = vi.hoisted(() => ({
  spawn: vi.fn(),
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: childProcesses.spawn,
}));

import { codexAgent } from "../src/connector.js";
import { probeCodexAppServer } from "../src/codex.js";

interface SentMessage {
  id?: number;
  method: string;
  params: Record<string, unknown>;
}

describe("codexAgent", () => {
  beforeEach(() => {
    childProcesses.spawn.mockReset();
  });

  it("uses the installed Codex app server and inherits Codex defaults", async () => {
    const server = fakeAppServer();
    childProcesses.spawn.mockImplementation(() => {
      queueMicrotask(() => server.child.emit("spawn"));
      return server.child;
    });

    const result = await codexAgent().run(request());

    expect(childProcesses.spawn).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--listen", "stdio://"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    expect(server.message("initialize")?.params).toEqual({
      clientInfo: {
        name: "pagent",
        title: "Pagent",
        version: "0.0.0",
      },
    });
    expect(server.message("thread/start")?.params).toEqual({
      cwd: process.cwd(),
    });
    expect(server.message("turn/start")?.params).toEqual({
      threadId: "codex-thread-1",
      input: [
        {
          type: "text",
          text: "Investigate the health failure",
          text_elements: [],
        },
      ],
    });
    expect(result).toEqual({
      threadId: "codex-thread-1",
      finalResponse: "The threshold caused the failure.",
    });
  });

  it("only overrides Codex permissions when configured", async () => {
    const server = fakeAppServer();
    childProcesses.spawn.mockImplementation(() => {
      queueMicrotask(() => server.child.emit("spawn"));
      return server.child;
    });

    await codexAgent({
      approvalPolicy: "never",
      sandboxMode: "read-only",
    }).run(request());

    expect(server.message("thread/start")?.params).toEqual({
      cwd: process.cwd(),
      approvalPolicy: "never",
      sandbox: "read-only",
    });
  });

  it("kills an active app-server run when the connector stops", async () => {
    const server = fakeAppServer(false);
    childProcesses.spawn.mockImplementation(() => {
      queueMicrotask(() => server.child.emit("spawn"));
      return server.child;
    });
    const abort = new AbortController();
    const run = codexAgent().run({ ...request(), signal: abort.signal });

    await vi.waitFor(() => {
      expect(server.message("turn/start")).toBeDefined();
    });
    abort.abort();

    await expect(run).rejects.toMatchObject({ name: "AbortError" });
    expect(server.child.kill).toHaveBeenCalled();
  });

  it("fails clearly when Codex is not installed", async () => {
    const child = fakeChild();
    childProcesses.spawn.mockImplementation(() => {
      queueMicrotask(() => {
        child.emit(
          "error",
          Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" }),
        );
      });
      return child;
    });

    await expect(codexAgent().run(request())).rejects.toThrow(
      "Codex CLI was not found on PATH",
    );
  });

  it("fails before launching Codex when the repository is not local", async () => {
    await expect(
      codexAgent().run(request("/definitely/not/a/local/repository")),
    ).rejects.toThrow("Clone or download it before starting Pagent");
    expect(childProcesses.spawn).not.toHaveBeenCalled();
  });

  it("probes app-server initialization without creating a thread", async () => {
    const server = fakeAppServer();
    childProcesses.spawn.mockImplementation(() => {
      queueMicrotask(() => server.child.emit("spawn"));
      return server.child;
    });

    await probeCodexAppServer({ timeoutMs: 100 });

    expect(server.message("initialize")?.params).toEqual({
      clientInfo: {
        name: "pagent-doctor",
        title: "Pagent Doctor",
        version: "0.0.0",
      },
    });
    expect(server.message("initialized")).toBeDefined();
    expect(server.message("thread/start")).toBeUndefined();
    expect(server.child.kill).toHaveBeenCalled();
  });
});

function request(cwd = process.cwd()) {
  return {
    cwd,
    prompt: "Investigate the health failure",
    event: {
      id: "event-1",
      type: "health.failed",
      environment: "staging",
      occurredAt: "2026-08-24T12:00:00.000Z",
      investigation: { cooldownMs: 0 },
      payload: { reason: "latency threshold" },
    },
  };
}

function fakeAppServer(completeTurn = true) {
  const child = fakeChild();
  const sent: SentMessage[] = [];
  let input = "";

  child.stdin.on("data", (chunk: Buffer | string) => {
    input += chunk.toString();
    let newline = input.indexOf("\n");

    while (newline >= 0) {
      const line = input.slice(0, newline);
      input = input.slice(newline + 1);
      const message = JSON.parse(line) as SentMessage;
      sent.push(message);
      respond(child, message, completeTurn);
      newline = input.indexOf("\n");
    }
  });

  return {
    child,
    message(method: string) {
      return sent.find((message) => message.method === method);
    },
  };
}

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  return child;
}

function respond(
  child: ChildProcessWithoutNullStreams,
  message: SentMessage,
  completeTurn: boolean,
): void {
  const send = (value: unknown) => {
    (child.stdout as PassThrough).write(`${JSON.stringify(value)}\n`);
  };

  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
  } else if (message.method === "thread/start") {
    send({
      id: message.id,
      result: { thread: { id: "codex-thread-1" } },
    });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    if (!completeTurn) {
      return;
    }
    send({
      method: "item/completed",
      params: {
        threadId: "codex-thread-1",
        turnId: "turn-1",
        item: {
          type: "agentMessage",
          text: "The threshold caused the failure.",
        },
      },
    });
    send({
      method: "turn/completed",
      params: {
        threadId: "codex-thread-1",
        turn: {
          id: "turn-1",
          status: "completed",
          error: null,
          items: [],
        },
      },
    });
  }
}
