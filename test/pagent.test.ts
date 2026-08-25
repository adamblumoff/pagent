import { afterEach, describe, expect, it, vi } from "vitest";

import { decryptEventContext } from "../src/crypto.js";
import { createPagent, defineEvent } from "../src/index.js";
import type { EncryptedRelayEvent } from "../src/types.js";

const TEST_ENCRYPTION_KEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const healthFailed = defineEvent<{ reason: string }>({
  name: "health.failed",
  enabledIn: ["staging"],
  investigation: { cooldownMs: 60_000 },
});

afterEach(() => {
  vi.restoreAllMocks();
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
      encryption: encryptionOptions(),
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
    const body = requestBody(relayFetch);
    expect(body.version).toBe(2);
    expect(body.event).toMatchObject({
      type: "health.failed",
      environment: "staging",
      investigation: { cooldownMs: 60_000 },
    });
    expect(body.event.context).toMatchObject({
      algorithm: "A256GCM",
      keyId: "test-key",
    });
    expect(JSON.stringify(body)).not.toContain("pool exhausted");
    await expect(decryptedPayload(body.event)).resolves.toEqual({
      reason: "pool exhausted",
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
      encryption: encryptionOptions(),
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
      encryption: encryptionOptions(),
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
      encryption: encryptionOptions(),
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
      encryption: encryptionOptions(),
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
    await expect(decryptedPayload(eventBody(relayFetch))).resolves.toEqual({
      message: "database offline",
    });
  });

  it("preserves synchronous errors while observing them", async () => {
    const relayFetch = successfulRelay();
    const failure = new Error("synchronous failure");
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      relay: relayOptions(),
      encryption: encryptionOptions(),
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
      encryption: encryptionOptions(),
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
      encryption: encryptionOptions(),
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
      encryption: encryptionOptions(),
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

  it("uses an injected host-neutral relay transport", async () => {
    const transport = vi.fn(async () => ({ ok: true, status: 202 }));
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      encryption: encryptionOptions(),
      relay: { ...relayOptions(), transport },
    });
    const observed = pagent.observe(() => "failed", {
      event: defineEvent<{ reason: string }>({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({ reason: "worker exited" }),
    });

    expect(observed()).toBe("failed");
    await pagent.flush();

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledWith(
      "https://relay.example.test/v1/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer relay-secret",
        }),
      }),
    );
  });

  it("imports the encryption key once per client", async () => {
    const importKey = vi.spyOn(globalThis.crypto.subtle, "importKey");
    const transport = vi.fn(async () => ({ ok: true, status: 202 }));
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      encryption: encryptionOptions(),
      relay: { ...relayOptions(), transport },
    });
    const observed = pagent.observe(() => "failed", {
      event: defineEvent<{ reason: string }>({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({ reason: "worker exited" }),
    });

    observed();
    observed();
    await pagent.flush();

    expect(importKey).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("flushes only work pending when the snapshot is taken", async () => {
    const responses: Array<
      (response: { ok: boolean; status: number }) => void
    > = [];
    const transport = vi.fn(
      () =>
        new Promise<{ ok: boolean; status: number }>((resolve) => {
          responses.push(resolve);
        }),
    );
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      encryption: encryptionOptions(),
      relay: { ...relayOptions(), transport },
    });
    const observed = pagent.observe(() => "failed", {
      event: defineEvent<{ reason: string }>({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({ reason: "worker exited" }),
    });

    observed();
    const firstFlush = pagent.flush();
    observed();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(2));
    responses[0]?.({ ok: true, status: 202 });
    await firstFlush;

    expect(responses).toHaveLength(2);
    responses[1]?.({ ok: true, status: 202 });
    await pagent.flush();
  });

  it("rejects context that JSON would silently alter", async () => {
    const errors: unknown[] = [];
    const relayFetch = successfulRelay();
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      encryption: encryptionOptions(),
      relay: relayOptions(),
      onDeliveryError: (error) => errors.push(error),
    });
    const observed = pagent.observe(() => "failed", {
      event: defineEvent<{ metric: number }>({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({ metric: Number.NaN }),
    });

    expect(observed()).toBe("failed");
    await pagent.flush();

    expect(relayFetch).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "event_preparation_failed",
      retryable: false,
    });
    expect((errors[0] as Error).cause).toMatchObject({
      message: "context.metric contains a non-finite number.",
    });
  });

  it("authenticates visible metadata with the encrypted context", async () => {
    const relayFetch = successfulRelay();
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      encryption: encryptionOptions(),
      relay: relayOptions(),
    });
    const observed = pagent.observe(() => "failed", {
      event: defineEvent<{ reason: string }>({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({ reason: "worker exited" }),
    });

    observed();
    await pagent.flush();
    const event = eventBody(relayFetch);

    await expect(
      decryptEventContext(
        { ...event, environment: "tampered" },
        event.context,
        TEST_ENCRYPTION_KEY,
      ),
    ).rejects.toThrow("Pagent could not decrypt context");
  });

  it("rejects oversized relay envelopes before sending them", async () => {
    const relayFetch = vi.fn();
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", relayFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      relay: { ...relayOptions(), maxEnvelopeBytes: 128 },
      encryption: encryptionOptions(),
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
      encryption: encryptionOptions(),
      onDeliveryError: (error) => errors.push(error),
    });
    const observed = pagent.observe(() => "application result", {
      event: defineEvent({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({}),
    });

    expect(observed()).toBe("application result");
    await vi.waitFor(() => expect(relayFetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(25);
    await pagent.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "PagentDeliveryError",
      code: "timeout",
      retryable: true,
    });
  });

  it("requires relay configuration when enabled", () => {
    expect(() =>
      createPagent({
        enabled: true,
        environment: "production",
        encryption: encryptionOptions(),
      }),
    ).toThrow("Pagent requires a relay when enabled.");
  });

  it("requires encryption configuration when enabled", () => {
    expect(() =>
      createPagent({
        enabled: true,
        environment: "production",
        relay: relayOptions(),
      }),
    ).toThrow("Pagent requires encryption when enabled.");
  });

  it("rejects an invalid encryption key when enabled", () => {
    expect(() =>
      createPagent({
        enabled: true,
        environment: "production",
        relay: relayOptions(),
        encryption: { keyId: "invalid", key: "AA" },
      }),
    ).toThrow("Pagent encryption key must decode to 32 bytes.");
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

function encryptionOptions() {
  return { keyId: "test-key", key: TEST_ENCRYPTION_KEY };
}

function successfulRelay() {
  const relayFetch = vi.fn(
    async () => new Response(null, { status: 202 }),
  );
  vi.stubGlobal("fetch", relayFetch);
  return relayFetch;
}

function requestBody(relayFetch: ReturnType<typeof vi.fn>) {
  const request = relayFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof request?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(request.body) as {
    version: number;
    event: EncryptedRelayEvent;
  };
}

function eventBody(relayFetch: ReturnType<typeof vi.fn>): EncryptedRelayEvent {
  return requestBody(relayFetch).event;
}

function decryptedPayload(event: EncryptedRelayEvent) {
  return decryptEventContext(event, event.context, TEST_ENCRYPTION_KEY);
}
