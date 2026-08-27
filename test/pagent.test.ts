import { afterEach, describe, expect, it, vi } from "vitest";

import { decryptEventContext } from "../src/crypto.js";
import { createPagent, defineEvent } from "../src/index.js";
import type { EncryptedPagentEvent } from "../src/types.js";

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
    const endpointFetch = successfulEndpoint();
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      endpoint: endpointOptions(),
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
    expect(endpointFetch).not.toHaveBeenCalled();
    await pagent.flush();

    expect(endpointFetch).toHaveBeenCalledTimes(1);
    const body = requestBody(endpointFetch);
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

  it("reports the accepted event ID without changing the wrapped return", async () => {
    const endpointFetch = successfulEndpoint();
    const receipts: Array<{ eventId: string; deliveredAt: string }> = [];
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      endpoint: endpointOptions(),
      encryption: encryptionOptions(),
      onDelivery: (receipt) => receipts.push(receipt),
    });
    const observed = pagent.observe(() => "application result", {
      event: healthFailed,
      on: "result",
      triggerWhen: () => true,
      context: () => ({ reason: "pool exhausted" }),
    });

    expect(observed()).toBe("application result");
    await pagent.flush();

    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ eventId: eventBody(endpointFetch).id });
    expect(new Date(receipts[0]!.deliveredAt).toISOString()).toBe(
      receipts[0]!.deliveredAt,
    );
  });

  it.each([
    { name: "disabled", enabled: false, environment: "staging" },
    { name: "missing environment", enabled: true, environment: undefined },
    { name: "unlisted environment", enabled: true, environment: "local" },
  ])("fails closed when $name", async ({ enabled, environment }) => {
    const endpointFetch = successfulEndpoint();
    const triggerWhen = vi.fn(() => true);
    const pagent = createPagent({
      enabled,
      environment,
      endpoint: endpointOptions(),
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
    expect(endpointFetch).not.toHaveBeenCalled();
  });

  it("delivers every qualifying trigger even while the same event is in flight", async () => {
    const responses: Array<(response: Response) => void> = [];
    const endpointFetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          responses.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", endpointFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      endpoint: endpointOptions(),
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
    await vi.waitFor(() => expect(endpointFetch).toHaveBeenCalledTimes(2));

    for (const respond of responses) {
      respond(new Response(null, { status: 202 }));
    }
    await pagent.flush();
  });

  it("does not let a failed delivery suppress a later trigger", async () => {
    const errors: unknown[] = [];
    const endpointFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 202 }));
    vi.stubGlobal("fetch", endpointFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      endpoint: endpointOptions(),
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

    expect(endpointFetch).toHaveBeenCalledTimes(2);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "PagentDeliveryError",
      code: "endpoint_rejected",
      retryable: false,
      statusCode: 503,
    });
  });

  it("preserves async resolutions and rejections", async () => {
    const endpointFetch = successfulEndpoint();
    const event = defineEvent<{ message: string }>({
      name: "operation.failed",
      enabledIn: ["staging"],
    });
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      endpoint: endpointOptions(),
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

    expect(endpointFetch).toHaveBeenCalledTimes(1);
    await expect(decryptedPayload(eventBody(endpointFetch))).resolves.toEqual({
      message: "database offline",
    });
  });

  it("preserves synchronous errors while observing them", async () => {
    const endpointFetch = successfulEndpoint();
    const failure = new Error("synchronous failure");
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      endpoint: endpointOptions(),
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
    expect(endpointFetch).toHaveBeenCalledTimes(1);
  });

  it("adds a dynamic group to the endpoint investigation policy", async () => {
    const endpointFetch = successfulEndpoint();
    const pagent = createPagent({
      enabled: true,
      environment: "staging",
      endpoint: endpointOptions(),
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

    expect(eventBody(endpointFetch).investigation).toEqual({
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
      endpoint: endpointOptions(),
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
      message: "Pagent endpoint rejected the event with HTTP 503.",
      code: "endpoint_rejected",
      retryable: false,
      statusCode: 503,
    });
  });

  it("uses zero cooldown by default", async () => {
    const endpointFetch = successfulEndpoint();
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      endpoint: endpointOptions(),
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

    expect(eventBody(endpointFetch).investigation).toEqual({ cooldownMs: 0 });
  });

  it("uses an injected host-neutral endpoint transport", async () => {
    const transport = vi.fn(async () => ({ ok: true, status: 202 }));
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      encryption: encryptionOptions(),
      endpoint: { ...endpointOptions(), transport },
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
      "https://endpoint.example.test/v1/events",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer source-secret",
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
      endpoint: { ...endpointOptions(), transport },
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
      endpoint: { ...endpointOptions(), transport },
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
    const endpointFetch = successfulEndpoint();
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      encryption: encryptionOptions(),
      endpoint: endpointOptions(),
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

    expect(endpointFetch).not.toHaveBeenCalled();
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
    const endpointFetch = successfulEndpoint();
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      encryption: encryptionOptions(),
      endpoint: endpointOptions(),
    });
    const observed = pagent.observe(() => "failed", {
      event: defineEvent<{ reason: string }>({ name: "job.failed" }),
      on: "result",
      triggerWhen: () => true,
      context: () => ({ reason: "worker exited" }),
    });

    observed();
    await pagent.flush();
    const event = eventBody(endpointFetch);

    await expect(
      decryptEventContext(
        { ...event, environment: "tampered" },
        event.context,
        TEST_ENCRYPTION_KEY,
      ),
    ).rejects.toThrow("Pagent could not decrypt context");
  });

  it("rejects oversized event envelopes before sending them", async () => {
    const endpointFetch = vi.fn();
    const errors: unknown[] = [];
    vi.stubGlobal("fetch", endpointFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      endpoint: { ...endpointOptions(), maxEnvelopeBytes: 128 },
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

    expect(endpointFetch).not.toHaveBeenCalled();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      code: "payload_too_large",
      retryable: false,
    });
    expect((errors[0] as Error).message).toMatch(/the limit is 128 bytes/);
  });

  it("aborts endpoint requests after the configured timeout", async () => {
    vi.useFakeTimers();
    const errors: unknown[] = [];
    const endpointFetch = vi.fn(
      (_url: URL, request: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", endpointFetch);
    const pagent = createPagent({
      enabled: true,
      environment: "production",
      endpoint: { ...endpointOptions(), timeoutMs: 25 },
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
    await vi.waitFor(() => expect(endpointFetch).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(25);
    await pagent.flush();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      name: "PagentDeliveryError",
      code: "timeout",
      retryable: false,
    });
  });

  it("requires endpoint configuration when enabled", () => {
    expect(() =>
      createPagent({
        enabled: true,
        environment: "production",
        encryption: encryptionOptions(),
      }),
    ).toThrow("Pagent requires an endpoint when enabled.");
  });

  it.each([
    "http://public.example.test/v1/events",
    credentialedEndpoint(),
    "https://public.example.test/v1/events#secret",
  ])("rejects an unsafe endpoint URL %s", (url) => {
    expect(() => createPagent({
      enabled: true,
      environment: "production",
      endpoint: { url, token: "source-secret" },
      encryption: encryptionOptions(),
    })).toThrow("must use HTTPS");
  });

  it("allows HTTP only for local development loopback endpoints", () => {
    expect(() => createPagent({
      enabled: true,
      environment: "local",
      endpoint: {
        url: "http://127.0.0.1:43121/v1/events",
        token: "source-secret",
        transport: async () => ({ ok: true, status: 202 }),
      },
      encryption: encryptionOptions(),
    })).not.toThrow();
  });

  it("requires encryption configuration when enabled", () => {
    expect(() =>
      createPagent({
        enabled: true,
        environment: "production",
        endpoint: endpointOptions(),
      }),
    ).toThrow("Pagent requires encryption when enabled.");
  });

  it("rejects an invalid encryption key when enabled", () => {
    expect(() =>
      createPagent({
        enabled: true,
        environment: "production",
        endpoint: endpointOptions(),
        encryption: { keyId: "invalid", key: "AA" },
      }),
    ).toThrow("Pagent encryption key must decode to 32 bytes.");
  });

  it("does not require or validate endpoint configuration while inert", () => {
    expect(() => createPagent({ enabled: true })).not.toThrow();
    expect(() =>
      createPagent({
        enabled: false,
        environment: "production",
        endpoint: { url: "not a URL", token: "" },
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

function endpointOptions() {
  return {
    url: "https://endpoint.example.test/v1/events",
    token: "source-secret",
  };
}

function credentialedEndpoint(): string {
  const url = new URL("https://public.example.test/v1/events");
  url.username = "test-user";
  url.password = "synthetic-password";
  return url.toString();
}

function encryptionOptions() {
  return { keyId: "test-key", key: TEST_ENCRYPTION_KEY };
}

function successfulEndpoint() {
  const endpointFetch = vi.fn(
    async () => new Response(null, { status: 202 }),
  );
  vi.stubGlobal("fetch", endpointFetch);
  return endpointFetch;
}

function requestBody(endpointFetch: ReturnType<typeof vi.fn>) {
  const request = endpointFetch.mock.calls[0]?.[1] as RequestInit | undefined;
  if (typeof request?.body !== "string") {
    throw new Error("Expected a JSON request body");
  }
  return JSON.parse(request.body) as {
    version: number;
    event: EncryptedPagentEvent;
  };
}

function eventBody(endpointFetch: ReturnType<typeof vi.fn>): EncryptedPagentEvent {
  return requestBody(endpointFetch).event;
}

function decryptedPayload(event: EncryptedPagentEvent) {
  return decryptEventContext(event, event.context, TEST_ENCRYPTION_KEY);
}
