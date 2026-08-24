import { describe, expect, it, vi } from "vitest";

import {
  createPagent,
  defineEvent,
  type AgentAdapter,
  type AgentRequest,
} from "../src/index.js";

function recordingAgent(requests: AgentRequest[]): AgentAdapter {
  return {
    async run(request) {
      requests.push(request);
      return { threadId: "thread-1", finalResponse: "done" };
    },
  };
}

const healthFailed = defineEvent<{ reason: string }>({
  name: "health.failed",
  enabledIn: ["staging"],
  cooldownMs: 60_000,
  prompt: (event) => `Investigate: ${event.payload.reason}`,
});

describe("Pagent", () => {
  it("starts an agent in the background when an observation matches", async () => {
    const requests: AgentRequest[] = [];
    const results: string[] = [];
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      cwd: ".",
      agent: recordingAgent(requests),
      onAgentResult: (result) => {
        results.push(result.threadId ?? "missing");
      },
    });
    const checkHealth = pagent.observe(
      () => ({ status: "unhealthy" as const, reason: "pool exhausted" }),
      {
        event: healthFailed,
        when: ({ result }) => result.status === "unhealthy",
        context: ({ result }) => ({ reason: result.reason }),
      },
    );

    expect(checkHealth()).toEqual({
      status: "unhealthy",
      reason: "pool exhausted",
    });
    expect(requests).toHaveLength(0);

    await pagent.drain();

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      prompt: "Investigate: pool exhausted",
      event: {
        type: "health.failed",
        environment: "staging",
        payload: { reason: "pool exhausted" },
      },
    });
    expect(requests[0]?.cwd).toMatch(/pagent$/);
    expect(results).toEqual(["thread-1"]);
  });

  it.each([
    { name: "disabled", enabled: false, environment: "staging" },
    { name: "missing environment", enabled: true, environment: undefined },
    { name: "unlisted environment", enabled: true, environment: "local" },
  ])("fails closed when $name", async ({ enabled, environment }) => {
    const requests: AgentRequest[] = [];
    const when = vi.fn(() => true);
    const pagent = createPagent({
      enabled,
      environment,
      agent: recordingAgent(requests),
    });
    const observed = pagent.observe(() => "unchanged", {
      event: healthFailed,
      when,
      context: () => ({ reason: "should not run" }),
    });

    expect(observed()).toBe("unchanged");
    await pagent.drain();

    expect(when).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });

  it("suppresses matching events during the cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T12:00:00Z"));
    const requests: AgentRequest[] = [];
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      agent: recordingAgent(requests),
    });
    const observed = pagent.observe(() => "failed", {
      event: healthFailed,
      when: () => true,
      context: () => ({ reason: "still unhealthy" }),
    });

    observed();
    observed();
    await pagent.drain();
    expect(requests).toHaveLength(1);

    vi.advanceTimersByTime(60_000);
    observed();
    await pagent.drain();
    expect(requests).toHaveLength(2);

    vi.useRealTimers();
  });

  it("does not overlap runs for the same event", async () => {
    let finishRun: (() => void) | undefined;
    const run = vi.fn(
      () =>
        new Promise<{}>((resolve) => {
          finishRun = () => resolve({});
        }),
    );
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      agent: { run },
    });
    const observed = pagent.observe(() => "failed", {
      event: healthFailed,
      when: () => true,
      context: () => ({ reason: "still unhealthy" }),
    });

    observed();
    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    observed();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run).toHaveBeenCalledTimes(1);

    finishRun?.();
    await pagent.drain();
  });

  it("preserves async resolutions and rejections", async () => {
    const requests: AgentRequest[] = [];
    const event = defineEvent<{ message: string }>({
      name: "operation.failed",
      enabledIn: ["staging"],
      prompt: (pagentEvent) => pagentEvent.payload.message,
    });
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      agent: recordingAgent(requests),
    });
    const successful = pagent.observe(async () => 42, {
      event,
      when: () => false,
      context: () => ({ message: "not used" }),
    });
    const failure = new Error("database offline");
    const failing = pagent.observe(
      async () => {
        throw failure;
      },
      {
        event,
        on: "error",
        when: () => true,
        context: (observation) => ({
          message:
            observation.error instanceof Error
              ? observation.error.message
              : "unknown",
        }),
      },
    );

    await expect(successful()).resolves.toBe(42);
    await expect(failing()).rejects.toBe(failure);
    await pagent.drain();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.event.payload).toEqual({ message: "database offline" });
  });

  it("preserves synchronous errors while observing them", async () => {
    const requests: AgentRequest[] = [];
    const failure = new Error("synchronous failure");
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      agent: recordingAgent(requests),
    });
    const observed = pagent.observe(
      () => {
        throw failure;
      },
      {
        event: healthFailed,
        on: "error",
        when: () => true,
        context: () => ({ reason: failure.message }),
      },
    );

    expect(observed).toThrow(failure);
    await pagent.drain();
    expect(requests).toHaveLength(1);
  });

  it("reports background failures without changing application behavior", async () => {
    const failure = new Error("agent unavailable");
    const errors: unknown[] = [];
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      agent: {
        async run() {
          throw failure;
        },
      },
      onError: (error) => errors.push(error),
    });
    const observed = pagent.observe(() => "application result", {
      event: healthFailed,
      when: () => true,
      context: () => ({ reason: "unhealthy" }),
    });

    expect(observed()).toBe("application result");
    await pagent.drain();
    expect(errors).toEqual([failure]);
  });
});
