import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { MemoryRelayStore } from "../src/memory-store.js";
import { createRelayServer } from "../src/server.js";
import type { RelayConfig } from "../src/types.js";

const config: RelayConfig = {
  port: 0,
  heartbeatMs: 100,
  sources: [
    {
      token: "source-secret",
      repositoryKey: "pagent-demo",
      connectorId: "local-1",
      allowedEnvironments: ["staging", "production"],
    },
  ],
  connectors: [{ id: "local-1", token: "connector-secret" }],
};

function event(id: string, overrides: Record<string, unknown> = {}) {
  return {
    version: 2,
    event: {
      id,
      type: "health.failed",
      environment: "staging",
      occurredAt: "2026-08-24T12:00:00.000Z",
      context: {
        algorithm: "A256GCM",
        keyId: "staging-2026-08",
        iv: "AAECAwQFBgcICQoL",
        ciphertext: "AAECAwQFBgcICQoLDA0ODw",
      },
      ...overrides,
    },
  };
}

async function encryptedContextFor(value: unknown) {
  const iv = Uint8Array.from({ length: 12 }, (_, index) => index);
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    "AES-GCM",
    false,
    ["encrypt"],
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return {
    algorithm: "A256GCM",
    keyId: "staging-2026-08",
    iv: Buffer.from(iv).toString("base64url"),
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
  };
}

describe("relay HTTP API", () => {
  let store: MemoryRelayStore;
  let server: ReturnType<typeof createRelayServer>;
  let baseUrl: string;

  beforeEach(async () => {
    store = new MemoryRelayStore();
    await store.initialize();
    server = createRelayServer({ config, store });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    server.close();
    await once(server, "close");
    await store.close();
  });

  it("rejects unauthenticated ingest without reading application data", async () => {
    const response = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(event("event-1")),
      headers: { "content-type": "application/json" },
    });

    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "unauthorized" });
  });

  it("routes encrypted context without constructing a prompt", async () => {
    const response = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(event("event-1")),
      headers: {
        authorization: "Bearer source-secret",
        "content-type": "application/json",
      },
    });

    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      status: string;
      taskId: string;
    };
    assert.equal(body.status, "queued");
    assert.equal(body.taskId, "1");
    const [task] = await store.tasksAfter("local-1", "0", 10);
    assert.equal(task?.repositoryKey, "pagent-demo");
    assert.equal(task?.eventId, "event-1");
    assert.deepEqual(task?.investigation, { cooldownMs: 0 });
    assert.deepEqual(task?.context, {
      algorithm: "A256GCM",
      keyId: "staging-2026-08",
      iv: "AAECAwQFBgcICQoL",
      ciphertext: "AAECAwQFBgcICQoLDA0ODw",
    });
    assert.doesNotMatch(JSON.stringify(task), /payload|prompt/);
  });

  it("fails closed for an environment outside the source policy", async () => {
    const response = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(event("event-local", { environment: "local" })),
      headers: {
        authorization: "Bearer source-secret",
        "content-type": "application/json",
      },
    });

    assert.equal(response.status, 422);
    assert.match(JSON.stringify(await response.json()), /not enabled/);
  });

  it("rejects malformed encrypted context", async () => {
    const invalidContexts = [
      undefined,
      {},
      {
        algorithm: "AES-GCM",
        keyId: "staging-2026-08",
        iv: "AAECAwQFBgcICQoL",
        ciphertext: "AAECAwQFBgcICQoLDA0ODw",
      },
      {
        algorithm: "A256GCM",
        keyId: " ",
        iv: "AAECAwQFBgcICQoL",
        ciphertext: "AAECAwQFBgcICQoLDA0ODw",
      },
      {
        algorithm: "A256GCM",
        keyId: " staging-2026-08 ",
        iv: "AAECAwQFBgcICQoL",
        ciphertext: "AAECAwQFBgcICQoLDA0ODw",
      },
      {
        algorithm: "A256GCM",
        keyId: "staging-2026-08",
        iv: "not+base64url",
        ciphertext: "AAECAwQFBgcICQoLDA0ODw",
      },
      {
        algorithm: "A256GCM",
        keyId: "staging-2026-08",
        iv: "AAECAwQFBgcICQo",
        ciphertext: "AAECAwQFBgcICQoLDA0ODw",
      },
      {
        algorithm: "A256GCM",
        keyId: "staging-2026-08",
        iv: "AAECAwQFBgcICQoL",
        ciphertext: "too-short",
      },
    ];

    for (const [index, context] of invalidContexts.entries()) {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: "POST",
        body: JSON.stringify(event(`invalid-context-${index}`, { context })),
        headers: {
          authorization: "Bearer source-secret",
          "content-type": "application/json",
        },
      });

      assert.equal(response.status, 400);
      assert.match(JSON.stringify(await response.json()), /context/);
    }
  });

  it("rejects version 1 envelopes", async () => {
    const body = event("legacy-event") as { version: number };
    body.version = 1;
    const response = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        authorization: "Bearer source-secret",
        "content-type": "application/json",
      },
    });

    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /version 2/);
  });

  it("rejects plaintext and unknown event fields", async () => {
    for (const overrides of [
      { payload: { reason: "plaintext must not reach the relay" } },
      { prompt: "plaintext must not reach the relay" },
      {
        context: {
          algorithm: "A256GCM",
          keyId: "staging-2026-08",
          iv: "AAECAwQFBgcICQoL",
          ciphertext: "AAECAwQFBgcICQoLDA0ODw",
          plaintext: "plaintext must not reach the relay",
        },
      },
    ]) {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: "POST",
        body: JSON.stringify(
          event(`unknown-${Object.keys(overrides)[0]}`, overrides),
        ),
        headers: {
          authorization: "Bearer source-secret",
          "content-type": "application/json",
        },
      });

      assert.equal(response.status, 400);
      assert.match(JSON.stringify(await response.json()), /not allowed/);
    }
  });

  it("rejects invalid investigation policies", async () => {
    for (const investigation of [
      { cooldownMs: -1 },
      { cooldownMs: 1.5 },
      { cooldownMs: 60_000, group: " " },
    ]) {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: "POST",
        body: JSON.stringify(event(`invalid-${JSON.stringify(investigation)}`, {
          investigation,
        })),
        headers: {
          authorization: "Bearer source-secret",
          "content-type": "application/json",
        },
      });

      assert.equal(response.status, 400);
    }
  });

  it("deduplicates event IDs and applies cooldown per developer-defined group", async () => {
    const ingest = (body: unknown) =>
      fetch(`${baseUrl}/v1/events`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          authorization: "Bearer source-secret",
          "content-type": "application/json",
        },
      });

    const eastPolicy = {
      investigation: { cooldownMs: 60_000, group: "us-east-1" },
    };
    assert.equal((await ingest(event("event-1", eastPolicy))).status, 201);
    const duplicate = await ingest(event("event-1", eastPolicy));
    assert.equal(duplicate.status, 202);
    assert.equal(((await duplicate.json()) as { status: string }).status, "duplicate");

    const cooldown = await ingest(event("event-2", eastPolicy));
    assert.equal(cooldown.status, 202);
    assert.equal(((await cooldown.json()) as { status: string }).status, "cooldown");

    const otherGroup = await ingest(
      event("event-3", {
        investigation: { cooldownMs: 60_000, group: "us-west-2" },
      }),
    );
    assert.equal(otherGroup.status, 201);

    assert.equal((await ingest(event("event-4"))).status, 201);
    assert.equal((await ingest(event("event-5"))).status, 201);
  });

  it("replays tasks over authenticated SSE using Last-Event-ID", async () => {
    for (const id of ["event-1", "event-2"]) {
      const response = await fetch(`${baseUrl}/v1/events`, {
        method: "POST",
        body: JSON.stringify(
          event(id, { type: id === "event-1" ? "first.failed" : "second.failed" }),
        ),
        headers: {
          authorization: "Bearer source-secret",
          "content-type": "application/json",
        },
      });
      assert.equal(response.status, 201);
    }

    const abort = new AbortController();
    const response = await fetch(
      `${baseUrl}/v1/connectors/local-1/events`,
      {
        headers: {
          authorization: "Bearer connector-secret",
          "last-event-id": "1",
        },
        signal: abort.signal,
      },
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

    const reader = response.body?.getReader();
    assert.ok(reader);
    let text = "";
    while (!text.includes("event: task")) {
      const result = await reader.read();
      assert.equal(result.done, false);
      text += new TextDecoder().decode(result.value);
    }
    abort.abort();

    assert.match(text, /id: 2/);
    assert.doesNotMatch(text, /id: 1\n/);
    const dataLine = text
      .split("\n")
      .find((line) => line.startsWith("data: "));
    assert.ok(dataLine);
    assert.deepEqual(Object.keys(JSON.parse(dataLine.slice(6))).sort(), [
      "context",
      "environment",
      "eventId",
      "id",
      "investigation",
      "occurredAt",
      "repositoryKey",
      "type",
    ]);
  });

  it("never exposes plaintext context and relays tampered ciphertext unchanged", async () => {
    const plaintextProbe = "relay-must-never-see-this-context-field-7f5a";
    const context = await encryptedContextFor({ plaintextProbe });
    const tamperedFirstByte = context.ciphertext.startsWith("A") ? "B" : "A";
    const tamperedCiphertext = `${tamperedFirstByte}${context.ciphertext.slice(1)}`;
    const response = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(
        event("opaque-event", {
          context: {
            ...context,
            ciphertext: tamperedCiphertext,
          },
        }),
      ),
      headers: {
        authorization: "Bearer source-secret",
        "content-type": "application/json",
      },
    });

    assert.equal(response.status, 201);
    const [task] = await store.tasksAfter("local-1", "0", 10);
    assert.equal(task?.context.ciphertext, tamperedCiphertext);
    const relayRepresentation = JSON.stringify(task);
    assert.doesNotMatch(relayRepresentation, new RegExp(plaintextProbe));
    assert.doesNotMatch(relayRepresentation, /payload|prompt/);
  });

  it("pushes a new task to an already-connected SSE client", async () => {
    const abort = new AbortController();
    const stream = await fetch(`${baseUrl}/v1/connectors/local-1/events`, {
      headers: { authorization: "Bearer connector-secret" },
      signal: abort.signal,
    });
    assert.equal(stream.status, 200);
    const reader = stream.body?.getReader();
    assert.ok(reader);

    let text = "";
    while (!text.includes(": heartbeat")) {
      const result = await reader.read();
      assert.equal(result.done, false);
      text += new TextDecoder().decode(result.value);
    }

    const ingested = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(event("live-event")),
      headers: {
        authorization: "Bearer source-secret",
        "content-type": "application/json",
      },
    });
    assert.equal(ingested.status, 201);

    while (!text.includes("event: task")) {
      const result = await reader.read();
      assert.equal(result.done, false);
      text += new TextDecoder().decode(result.value);
    }
    abort.abort();

    assert.match(text, /"id":"1"/);
    assert.match(text, /"repositoryKey":"pagent-demo"/);
  });

  it("reports store health", async () => {
    const response = await fetch(`${baseUrl}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });
});
