import { afterEach, describe, expect, it, vi } from "vitest";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

  it("emits a versioned event envelope to a relay", async () => {
    const relayFetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(null, { status: 202 }),
    );
    vi.stubGlobal("fetch", relayFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      relay: {
        url: "https://relay.example.test/v1/events",
        token: "relay-secret",
      },
    });
    const observed = pagent.observe(() => ({ status: "failed" as const }), {
      event: defineEvent<{ reason: string }>({ name: "job.failed" }),
      when: ({ result }) => result.status === "failed",
      context: () => ({ reason: "worker exited" }),
    });

    expect(observed()).toEqual({ status: "failed" });
    expect(relayFetch).not.toHaveBeenCalled();
    await pagent.drain();

    expect(relayFetch).toHaveBeenCalledTimes(1);
    const [url, request] = relayFetch.mock.calls[0]!;
    expect(request).toBeDefined();
    expect(url.toString()).toBe("https://relay.example.test/v1/events");
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer relay-secret",
        "content-type": "application/json",
      },
    });
    expect(JSON.parse(request!.body as string)).toMatchObject({
      version: 1,
      event: {
        type: "job.failed",
        environment: "production",
        payload: { reason: "worker exited" },
      },
    });
  });

  it("isolates relay failures from the observed application", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      relay: {
        url: "https://relay.example.test/v1/events",
        token: "relay-secret",
      },
      onError: (error) => errors.push(error),
    });
    const observed = pagent.observe(() => "application result", {
      event: defineEvent({ name: "job.failed" }),
      when: () => true,
      context: () => ({ reason: "worker exited" }),
    });

    expect(observed()).toBe("application result");
    await pagent.drain();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toEqual(
      new Error("Pagent relay rejected the event with HTTP 503."),
    );
  });

  it("rejects oversized relay envelopes before sending them", async () => {
    const relayFetch = vi.fn();
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", relayFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      relay: {
        url: "https://relay.example.test/v1/events",
        token: "relay-secret",
        maxEnvelopeBytes: 128,
      },
      onError: (error) => errors.push(error),
    });
    const observed = pagent.observe(() => "application result", {
      event: defineEvent({ name: "job.failed" }),
      when: () => true,
      context: () => ({ detail: "x".repeat(256) }),
    });

    expect(observed()).toBe("application result");
    await pagent.drain();

    expect(relayFetch).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toMatch(/the limit is 128 bytes/);
  });

  it("aborts relay requests after the configured timeout", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const relayFetch = vi.fn(
      (_url: URL, request: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", relayFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      relay: {
        url: "https://relay.example.test/v1/events",
        token: "relay-secret",
        timeoutMs: 25,
      },
      onError: (error) => errors.push(error),
    });
    const observed = pagent.observe(() => "application result", {
      event: defineEvent({ name: "job.failed" }),
      when: () => true,
      context: () => ({}),
    });

    expect(observed()).toBe("application result");
    await vi.advanceTimersByTimeAsync(25);
    await pagent.drain();

    expect(relayFetch).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ name: "AbortError" });
  });
});
