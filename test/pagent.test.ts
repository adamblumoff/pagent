import { afterEach, describe, expect, it, vi } from "vitest";

import { createPagent, defineEvent } from "../src/index.js";

const healthFailed = defineEvent<{ reason: string }>({
  name: "health.failed",
  enabledIn: ["staging"],
  investigation: { cooldownMs: 60_000 },
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Pagent", () => {
  it("sends a developer-approved result trigger in the background", async () => {
    const relayFetch = successfulRelay();
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      relay: relayOptions(),
    });
    const checkHealth = pagent.observe(
      () => ({ status: "unhealthy" as const, reason: "pool exhausted" }),
      {
        event: healthFailed,
        on: "result",
        triggerWhen: ({ result }) => result.status === "unhealthy",
        context: ({ result }) => ({ reason: result.reason }),
      },
    );

    expect(checkHealth()).toEqual({
      status: "unhealthy",
      reason: "pool exhausted",
    });
    expect(relayFetch).not.toHaveBeenCalled();
    await pagent.flush();

    expect(relayFetch).toHaveBeenCalledTimes(1);
    expect(eventBody(relayFetch)).toMatchObject({
      type: "health.failed",
      environment: "staging",
      investigation: { cooldownMs: 60_000 },
      payload: { reason: "pool exhausted" },
    });
  });

  it.each([
    { name: "disabled", enabled: false, environment: "staging" },
    { name: "missing environment", enabled: true, environment: undefined },
    { name: "unlisted environment", enabled: true, environment: "local" },
  ])("fails closed when $name", async ({ enabled, environment }) => {
    const relayFetch = successfulRelay();
    const triggerWhen = vi.fn(() => true);
    const pagent = createPagent({
      enabled,
      environment,
      relay: relayOptions(),
    });
    const observed = pagent.observe(() => "unchanged", {
      event: healthFailed,
      on: "result",
      triggerWhen,
      context: () => ({ reason: "should not run" }),
    });

    expect(observed()).toBe("unchanged");
    await pagent.flush();

    expect(triggerWhen).not.toHaveBeenCalled();
    expect(relayFetch).not.toHaveBeenCalled();
  });

  it("delivers every qualifying trigger even while the same event is in flight", async () => {
    const responses: Array<(response: Response) => void> = [];
    const relayFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", relayFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      relay: relayOptions(),
    });
    const observed = pagent.observe(() => "failed", {
      event: healthFailed,
      on: "result",
      triggerWhen: () => true,
      context: () => ({ reason: "still unhealthy" }),
    });

    observed();
    observed();
    await vi.waitFor(() => expect(relayFetch).toHaveBeenCalledTimes(2));

    for (const respond of responses) {
      respond(new Response(null, { status: 202 }));
    }
    await pagent.flush();
  });

  it("does not let a failed delivery suppress a later trigger", async () => {
    const errors: unknown[] = [];
    const relayFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", relayFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      relay: relayOptions(),
      onDeliveryError: (error) => errors.push(error),
    });
    const observed = pagent.observe(() => "failed", {
      event: healthFailed,
      on: "result",
      triggerWhen: () => true,
      context: () => ({ reason: "still unhealthy" }),
    });

    observed();
    await pagent.flush();
    observed();
    await pagent.flush();

    expect(relayFetch).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "PagentDeliveryError",
      code: "relay_rejected",
      retryable: true,
      statusCode: 503,
    });
  });

  it("preserves async resolutions and rejections", async () => {
    const relayFetch = successfulRelay();
    const event = defineEvent<{ message: string }>({
      name: "operation.failed",
      enabledIn: ["staging"],
    });
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      relay: relayOptions(),
    });
    const successful = pagent.observe(async () => 42, {
      event,
      on: "result",
      triggerWhen: () => false,
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
        triggerWhen: () => true,
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
    await pagent.flush();

    expect(relayFetch).toHaveBeenCalledTimes(1);
    expect(eventBody(relayFetch).payload).toEqual({ message: "database offline" });
  });

  it("preserves synchronous errors while observing them", async () => {
    const relayFetch = successfulRelay();
    const failure = new Error("synchronous failure");
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      relay: relayOptions(),
    });
    const observed = pagent.observe(
      () => {
        throw failure;
      },
      {
        event: healthFailed,
        on: "error",
        triggerWhen: () => true,
        context: () => ({ reason: failure.message }),
      },
    );

    expect(observed).toThrow(failure);
    await pagent.flush();
    expect(relayFetch).toHaveBeenCalledTimes(1);
  });

  it("adds a dynamic group to the relay investigation policy", async () => {
    const relayFetch = successfulRelay();
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      relay: relayOptions(),
    });
    const observed = pagent.observe(() => ({ region: "us-east-1" }), {
      event: healthFailed,
      on: "result",
      triggerWhen: () => true,
      group: ({ result }) => ` ${result.region} `,
      context: () => ({ reason: "unhealthy" }),
    });

    observed();
    await pagent.flush();

    expect(eventBody(relayFetch).investigation).toEqual({
      cooldownMs: 60_000,
      group: "us-east-1",
    });
  });

  it("reports background failures without changing application behavior", async () => {
    const errors: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 })),
    );
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      relay: relayOptions(),
      onDeliveryError: (error) => errors.push(error),
    });
    const observed = pagent.observe(() => "application result", {
      event: defineEvent({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({ reason: "worker exited" }),
    });

    expect(observed()).toBe("application result");
    await pagent.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      message: "Pagent relay rejected the event with HTTP 503.",
      code: "relay_rejected",
      retryable: true,
      statusCode: 503,
    });
  });

  it("uses zero cooldown by default", async () => {
    const relayFetch = successfulRelay();
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      relay: relayOptions(),
    });
    const observed = pagent.observe(() => "application result", {
      event: defineEvent({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({ reason: "worker exited" }),
    });

    observed();
    await pagent.flush();

    expect(eventBody(relayFetch).investigation).toEqual({ cooldownMs: 0 });
  });

  it("rejects oversized relay envelopes before sending them", async () => {
    const relayFetch = vi.fn();
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", relayFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      relay: { ...relayOptions(), maxEnvelopeBytes: 128 },
      onDeliveryError: (error) => errors.push(error),
    });
    const observed = pagent.observe(() => "application result", {
      event: defineEvent({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({ detail: "x".repeat(256) }),
    });

    expect(observed()).toBe("application result");
    await pagent.flush();

    expect(relayFetch).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "payload_too_large",
      retryable: false,
    });
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
      relay: { ...relayOptions(), timeoutMs: 25 },
      onDeliveryError: (error) => errors.push(error),
    });
    const observed = pagent.observe(() => "application result", {
      event: defineEvent({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({}),
    });

    expect(observed()).toBe("application result");
    await vi.advanceTimersByTimeAsync(25);
    await pagent.flush();

    expect(relayFetch).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "PagentDeliveryError",
      code: "timeout",
      retryable: true,
    });
  });

  it("requires relay configuration when enabled", () => {
    expect(() =>
      createPagent({ enabled: true, environment: "production" }),
    ).toThrow("Pagent requires a relay when enabled.");
  });

  it("does not require or validate relay configuration while inert", () => {
    expect(() => createPagent({ enabled: true })).not.toThrow();
    expect(() =>
      createPagent({
        enabled: false,
        environment: "production",
        relay: { url: "not a URL", token: "" },
      }),
    ).not.toThrow();
  });

  it("rejects invalid event definitions when they are declared", () => {
    expect(() => defineEvent({ name: " health.failed" })).toThrow(
      /event name must be a trimmed, non-empty string/,
    );
    expect(() =>
      defineEvent({
        name: "health.failed",
        investigation: { cooldownMs: -1 },
      }),
    ).toThrow(/cooldownMs must be a non-negative integer/);
  });
});

function relayOptions() {
  return {
    url: "https://relay.example.test/v1/events",
    token: "relay-secret",
  };
}

function successfulRelay() {
  const relayFetch = vi.fn(
    async () => new Response(null, { status: 202 }),
  );
  vi.stubGlobal("fetch", relayFetch);
  return relayFetch;
}

function eventBody(relayFetch: ReturnType<typeof vi.fn>) {
  const request = relayFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof request?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return (JSON.parse(request.body) as { event: Record<string, unknown> }).event;
}
