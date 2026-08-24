import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  const run = vi.fn();
  const startThread = vi.fn((_options?: unknown) => ({
    id: "codex-thread-1" as string | null,
    run,
  }));
  const constructor = vi.fn();

  return { constructor, run, startThread };
});

vi.mock("@openai/codex-sdk", () => ({
  Codex: class MockCodex {
    constructor(options?: unknown) {
      sdk.constructor(options);
    }

    startThread(options?: unknown) {
      return sdk.startThread(options);
    }
  },
}));

import { codexAgent } from "../src/index.js";

describe("codexAgent", () => {
  beforeEach(() => {
    sdk.constructor.mockClear();
    sdk.startThread.mockClear();
    sdk.run.mockReset();
  });

  it("starts a read-only non-interactive thread by default", async () => {
    sdk.run.mockResolvedValue({ finalResponse: "fixed" });
    const agent = codexAgent({ apiKey: "test-key" });

    const result = await agent.run({
      cwd: "/tmp/example-repo",
      prompt: "Investigate the health failure",
      event: {
        id: "event-1",
        type: "health.failed",
        environment: "staging",
        occurredAt: "2026-08-24T12:00:00.000Z",
        payload: { reason: "latency threshold" },
      },
    });

    expect(sdk.constructor).toHaveBeenCalledWith({ apiKey: "test-key" });
    expect(sdk.startThread).toHaveBeenCalledWith({
      approvalPolicy: "never",
      sandboxMode: "read-only",
      workingDirectory: "/tmp/example-repo",
    });
    expect(sdk.run).toHaveBeenCalledWith("Investigate the health failure");
    expect(result).toEqual({
      threadId: "codex-thread-1",
      finalResponse: "fixed",
    });
  });

  it("uses the configured sandbox mode", async () => {
    sdk.run.mockResolvedValue({ finalResponse: "fixed" });
    const agent = codexAgent({ sandboxMode: "workspace-write" });

    await agent.run({
      cwd: "/tmp/example-repo",
      prompt: "Fix the health failure",
      event: {
        id: "event-2",
        type: "health.failed",
        environment: "staging",
        occurredAt: "2026-08-24T12:00:00.000Z",
        payload: { reason: "latency threshold" },
      },
    });

    expect(sdk.startThread).toHaveBeenCalledWith({
      approvalPolicy: "never",
      sandboxMode: "workspace-write",
      workingDirectory: "/tmp/example-repo",
    });
  });
});
