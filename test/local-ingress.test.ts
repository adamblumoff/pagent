import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentRequest } from "../src/agent.js";
import { encryptEventContext } from "../src/crypto.js";
import {
  startLocalIngressServer,
  type LocalIngressLifecycleUpdate,
  type LocalIngressServer,
} from "../src/local-ingress.js";
import type {
  EncryptedPagentEvent,
  EventEnvelope,
  InvestigationPolicy,
  PagentEventMetadata,
} from "../src/types.js";
import { EVENT_PROTOCOL_VERSION } from "../src/version.js";

const KEY = Buffer.alloc(32, 1).toString("base64url");
const WRONG_KEY = Buffer.alloc(32, 2).toString("base64url");
const TOKEN = "source-secret";
const servers: LocalIngressServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("local ingress", () => {
  it("accepts an encrypted event and dispatches Codex from the local repository", async () => {
    const requests: AgentRequest[] = [];
    const lifecycle: LocalIngressLifecycleUpdate[] = [];
    const results: string[] = [];
    const server = await start({
      agent: {
        async run(request) {
          requests.push(request);
          return { threadId: "thread-1" };
        },
      },
      onLifecycle: (update) => {
        lifecycle.push(update);
      },
      onAgentResult: (result) => {
        results.push(result.threadId ?? "unknown");
      },
    });

    const response = await post(server.eventsUrl, await envelope("event-1"));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: "accepted",
      eventId: "event-1",
    });
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      cwd: resolve("."),
      prompt: expect.stringContaining(
        "Find the root cause and report the supporting evidence. Do not modify files.",
      ),
      event: {
        id: "event-1",
        type: "health.failed",
        environment: "staging",
        occurredAt: "2026-08-27T12:00:00.000Z",
        investigation: { cooldownMs: 0 },
        payload: { reason: "pool exhausted" },
      },
      signal: expect.any(AbortSignal),
    });
    expect(requests[0]?.prompt).toContain("Event ID: event-1");
    await vi.waitFor(() =>
      expect(lifecycle.map((update) => update.status)).toEqual([
        "received",
        "running",
        "completed",
      ]),
    );
    expect(lifecycle[2]).toMatchObject({ threadId: "thread-1" });
    expect(results).toEqual(["thread-1"]);
  });

  it("proves encrypted readiness without dispatching or changing admission state", async () => {
    const run = vi.fn(async () => ({ threadId: "thread-probe" }));
    const lifecycle: LocalIngressLifecycleUpdate[] = [];
    const server = await start({
      agent: { run },
      onLifecycle: (update) => {
        lifecycle.push(update);
      },
    });
    const body = await envelope("probe-event");

    const first = await post(server.probeUrl, body);
    const second = await post(server.probeUrl, body);
    const delivery = await post(server.eventsUrl, body);

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({
      version: 1,
      status: "ready",
      environmentId: "env-test",
    });
    expect(second.status).toBe(200);
    expect(delivery.status).toBe(202);
    await expect(delivery.json()).resolves.toMatchObject({ status: "accepted" });
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(lifecycle.some((update) => update.status === "suppressed")).toBe(false);
  });

  it("rejects requests before Codex for route, method, auth, media, size, and policy failures", async () => {
    const run = vi.fn(async () => ({}));
    const server = await start({ agent: { run }, maxBodyBytes: 1_024 });
    const valid = await envelope("event-policy");

    const missing = await fetch(new URL("/not-events", server.eventsUrl));
    const wrongMethod = await fetch(server.eventsUrl, { method: "GET" });
    const unauthorized = await fetch(server.eventsUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(valid),
    });
    const wrongMedia = await fetch(server.eventsUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(valid),
    });
    const tooLarge = await fetch(server.eventsUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ padding: "x".repeat(2_000) }),
    });
    const disallowed = await post(
      server.eventsUrl,
      await envelope("event-prod", { environment: "production" }),
    );

    expect(missing.status).toBe(404);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
    expect(unauthorized.status).toBe(401);
    expect(wrongMedia.status).toBe(415);
    expect(tooLarge.status).toBe(413);
    expect(disallowed.status).toBe(403);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects unknown, malformed, and tampered encryption contexts", async () => {
    const run = vi.fn(async () => ({}));
    const server = await start({ agent: { run } });
    const unknownKey = await envelope("unknown-key", {
      keyId: "unknown",
      key: WRONG_KEY,
    });
    const tampered = await envelope("tampered");
    tampered.event.context.ciphertext = flipFirstCharacter(
      tampered.event.context.ciphertext,
    );

    const malformedResponse = await post(server.eventsUrl, {
      ...await envelope("malformed"),
      extra: true,
    });
    const unknownResponse = await post(server.eventsUrl, unknownKey);
    const tamperedResponse = await post(server.eventsUrl, tampered);

    expect(malformedResponse.status).toBe(400);
    expect(unknownResponse.status).toBe(422);
    expect(tamperedResponse.status).toBe(422);
    expect(run).not.toHaveBeenCalled();
  });

  it("deduplicates event IDs and applies cooldown by event route and group", async () => {
    let now = Date.parse("2026-08-27T12:00:00.000Z");
    const run = vi.fn(async () => ({}));
    const lifecycle: LocalIngressLifecycleUpdate[] = [];
    const server = await start({
      agent: { run },
      now: () => now,
      onLifecycle: (update) => {
        lifecycle.push(update);
      },
    });
    const first = await envelope("event-a", {
      investigation: { cooldownMs: 60_000, group: "us-east-1" },
    });
    const coolingDown = await envelope("event-b", {
      investigation: { cooldownMs: 60_000, group: "us-east-1" },
    });
    const otherGroup = await envelope("event-c", {
      investigation: { cooldownMs: 60_000, group: "us-west-2" },
    });

    expect(await statusOf(await post(server.eventsUrl, first))).toBe("accepted");
    expect(await statusOf(await post(server.eventsUrl, first))).toBe("duplicate");
    now += 1_000;
    expect(await statusOf(await post(server.eventsUrl, coolingDown))).toBe(
      "cooldown",
    );
    expect(await statusOf(await post(server.eventsUrl, coolingDown))).toBe(
      "duplicate",
    );
    expect(await statusOf(await post(server.eventsUrl, otherGroup))).toBe(
      "accepted",
    );

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        lifecycle.filter((update) => update.status === "suppressed"),
      ).toHaveLength(3),
    );
    expect(
      lifecycle
        .filter((update) => update.status === "suppressed")
        .map((update) => update.reason),
    ).toEqual(["duplicate", "cooldown", "duplicate"]);
  });

  it("records a failed dispatch without retrying it", async () => {
    const failure = new Error("Codex unavailable");
    const run = vi.fn(async () => Promise.reject(failure));
    const lifecycle: LocalIngressLifecycleUpdate[] = [];
    const errors: unknown[] = [];
    const server = await start({
      agent: { run },
      onLifecycle: (update) => {
        lifecycle.push(update);
      },
      onError: (error) => errors.push(error),
    });

    const response = await post(server.eventsUrl, await envelope("event-failed"));

    expect(response.status).toBe(202);
    await vi.waitFor(() =>
      expect(lifecycle.at(-1)).toMatchObject({
        status: "failed",
        errorCode: "codex_failed",
        errorMessage: "Codex unavailable",
      }),
    );
    expect(run).toHaveBeenCalledOnce();
    expect(errors).toEqual([failure]);
  });

  it("requires one repository and aborts an active dispatch when closed", async () => {
    await expect(
      startLocalIngressServer({
        environmentId: "env-test",
        source: { token: TOKEN, allowedEnvironments: ["staging"] },
        repositories: { first: ".", second: ".." },
        encryption: { keys: { current: KEY } },
        agent: { run: vi.fn(async () => ({})) },
      }),
    ).rejects.toThrow("exactly one configured repository");

    let receivedSignal: AbortSignal | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolveStarted) => {
      markStarted = resolveStarted;
    });
    const server = await start({
      agent: {
        async run(request) {
          receivedSignal = request.signal;
          markStarted?.();
          await new Promise<void>((_resolve, reject) => {
            request.signal?.addEventListener(
              "abort",
              () => reject(request.signal?.reason),
              { once: true },
            );
          });
          return {};
        },
      },
    });
    await post(server.eventsUrl, await envelope("event-aborted"));
    await started;

    await server.close();

    expect(receivedSignal?.aborted).toBe(true);
    servers.splice(servers.indexOf(server), 1);
  });
});

async function start(
  overrides: Partial<Parameters<typeof startLocalIngressServer>[0]> = {},
): Promise<LocalIngressServer> {
  const server = await startLocalIngressServer({
    environmentId: "env-test",
    source: { token: TOKEN, allowedEnvironments: ["staging"] },
    repositories: { pagent: "." },
    encryption: { keys: { current: KEY } },
    agent: { run: vi.fn(async () => ({})) },
    ...overrides,
  });
  servers.push(server);
  return server;
}

async function envelope(
  id: string,
  options: {
    environment?: string;
    investigation?: InvestigationPolicy;
    keyId?: string;
    key?: string;
  } = {},
): Promise<EventEnvelope> {
  const metadata: PagentEventMetadata = {
    id,
    type: "health.failed",
    environment: options.environment ?? "staging",
    occurredAt: "2026-08-27T12:00:00.000Z",
    investigation: options.investigation ?? { cooldownMs: 0 },
  };
  const event: EncryptedPagentEvent = {
    ...metadata,
    context: await encryptEventContext(
      metadata,
      { reason: "pool exhausted" },
      { keyId: options.keyId ?? "current", key: options.key ?? KEY },
    ),
  };
  return { version: EVENT_PROTOCOL_VERSION, event };
}

function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

async function statusOf(response: Response): Promise<string> {
  return ((await response.json()) as { status: string }).status;
}

function flipFirstCharacter(value: string): string {
  return `${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
}
