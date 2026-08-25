import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createRelayServer } from "../src/server.js";
import type { RelayConfig, RelayTask } from "../src/types.js";
import { RecordingRelayStore } from "./recording-store.js";

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
  adminToken: "admin-secret",
};

const dynamicSourceToken = "dynamic-source-secret";
const dynamicConnectorToken = "dynamic-connector-secret";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function enrollment(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    connectorId: "dynamic-1",
    repositoryKey: "dynamic-repo",
    allowedEnvironments: ["staging"],
    sourceTokenHash: sha256(dynamicSourceToken),
    connectorTokenHash: sha256(dynamicConnectorToken),
    replace: false,
    ...overrides,
  };
}

async function issueEnrollmentCode(
  baseUrl: string,
  connectorId?: string,
): Promise<string> {
  const response = await fetch(`${baseUrl}/v1/admin/enrollment-codes`, {
    method: "POST",
    body: JSON.stringify({
      version: 1,
      expiresInSeconds: 900,
      ...(connectorId === undefined ? {} : { connectorId }),
    }),
    headers: {
      authorization: "Bearer admin-secret",
      "content-type": "application/json",
    },
  });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = (await response.json()) as { code: string };
  assert.match(body.code, /^pge_/u);
  return body.code;
}

function postEnrollment(
  baseUrl: string,
  code: string,
  body: unknown = enrollment(),
): Promise<Response> {
  return fetch(`${baseUrl}/v1/enroll`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${code}`,
      "content-type": "application/json",
    },
  });
}

async function waitForStreamClose(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        try {
          while (!(await reader.read()).done) {
            // Drain frames already buffered before the credential change.
          }
        } catch {
          // Undici reports a destroyed SSE response as a rejected read.
        }
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("SSE stream stayed open")),
          2_000,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

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

function task(
  id: string,
  eventId: string,
  overrides: Partial<RelayTask> = {},
): RelayTask {
  return {
    id,
    eventId,
    type: "health.failed",
    environment: "staging",
    occurredAt: "2026-08-24T12:00:00.000Z",
    investigation: { cooldownMs: 0 },
    repositoryKey: "pagent-demo",
    context: {
      algorithm: "A256GCM",
      keyId: "staging-2026-08",
      iv: "AAECAwQFBgcICQoL",
      ciphertext: "AAECAwQFBgcICQoLDA0ODw",
    },
    ...overrides,
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
  let store: RecordingRelayStore;
  let server: ReturnType<typeof createRelayServer>;
  let baseUrl: string;

  beforeEach(async () => {
    store = new RecordingRelayStore();
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

  it("issues and consumes a single-use enrollment code", async () => {
    const unauthorizedIssue = await fetch(
      `${baseUrl}/v1/admin/enrollment-codes`,
      {
        method: "POST",
        body: JSON.stringify({ version: 1 }),
        headers: {
          authorization: "Bearer wrong",
          "content-type": "application/json",
        },
      },
    );
    assert.equal(unauthorizedIssue.status, 401);

    const code = await issueEnrollmentCode(baseUrl);

    const unauthorized = await postEnrollment(baseUrl, "wrong");
    assert.equal(unauthorized.status, 401);
    assert.equal(store.enrollments.length, 0);

    const first = await postEnrollment(baseUrl, code);
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { status: "enrolled" });
    assert.deepEqual(store.enrollments, [
      {
        connectorId: "dynamic-1",
        repositoryKey: "dynamic-repo",
        allowedEnvironments: ["staging"],
        sourceTokenHash: sha256(dynamicSourceToken),
        connectorTokenHash: sha256(dynamicConnectorToken),
        replace: false,
      },
    ]);

    const repeated = await postEnrollment(baseUrl, code);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), { status: "existing" });
    assert.equal(store.enrollments.length, 1);

    const reused = await postEnrollment(
      baseUrl,
      code,
      enrollment({ repositoryKey: "other-repo" }),
    );
    assert.equal(reused.status, 401);

    const staticCollisionCode = await issueEnrollmentCode(baseUrl);
    const staticCollision = await postEnrollment(
      baseUrl,
      staticCollisionCode,
      enrollment({ connectorId: "local-1" }),
    );
    assert.equal(staticCollision.status, 409);

    const unscopedRotationCode = await issueEnrollmentCode(baseUrl);
    const unscopedRotation = await postEnrollment(
      baseUrl,
      unscopedRotationCode,
      enrollment({ replace: true }),
    );
    assert.equal(unscopedRotation.status, 401);

    const scopedCreateCode = await issueEnrollmentCode(baseUrl, "dynamic-4");
    const scopedCreate = await postEnrollment(
      baseUrl,
      scopedCreateCode,
      enrollment({
        connectorId: "dynamic-4",
        sourceTokenHash: sha256("dynamic-4-source"),
        connectorTokenHash: sha256("dynamic-4-connector"),
      }),
    );
    assert.equal(scopedCreate.status, 401);

    const conflictCode = await issueEnrollmentCode(baseUrl);
    const conflict = await postEnrollment(baseUrl, conflictCode);
    assert.equal(conflict.status, 409);
    const recovered = await postEnrollment(
      baseUrl,
      conflictCode,
      enrollment({
        connectorId: "dynamic-2",
        sourceTokenHash: sha256("dynamic-2-source"),
        connectorTokenHash: sha256("dynamic-2-connector"),
      }),
    );
    assert.equal(recovered.status, 201);

    const expiredCode = "pge_expired";
    await store.createEnrollmentCode({
      codeHash: sha256(expiredCode),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const expired = await postEnrollment(
      baseUrl,
      expiredCode,
      enrollment({
        connectorId: "dynamic-3",
        sourceTokenHash: sha256("dynamic-3-source"),
        connectorTokenHash: sha256("dynamic-3-connector"),
      }),
    );
    assert.equal(expired.status, 401);
  });

  it("does not expose administrator routes when they are not configured", async () => {
    const disabledConfig = { ...config };
    delete disabledConfig.adminToken;
    const disabledServer = createRelayServer({ config: disabledConfig, store });
    disabledServer.listen(0, "127.0.0.1");
    await once(disabledServer, "listening");
    const address = disabledServer.address() as AddressInfo;
    try {
      const response = await fetch(
        `http://127.0.0.1:${address.port}/v1/admin/enrollment-codes`,
        {
          method: "POST",
          body: JSON.stringify({ version: 1 }),
          headers: {
            authorization: "Bearer admin-secret",
            "content-type": "application/json",
          },
        },
      );
      assert.equal(response.status, 404);
      assert.equal(store.enrollments.length, 0);
    } finally {
      disabledServer.close();
      await once(disabledServer, "close");
    }
  });

  it("rejects malformed enrollment fields", async () => {
    const code = await issueEnrollmentCode(baseUrl);
    const invalidBodies = [
      { ...enrollment(), version: 2 },
      { ...enrollment(), unexpected: true },
      enrollment({ connectorId: " dynamic-1" }),
      enrollment({ allowedEnvironments: [] }),
      enrollment({ allowedEnvironments: ["staging", "staging"] }),
      enrollment({ sourceTokenHash: "not-a-sha256-hash" }),
      enrollment({ connectorTokenHash: Buffer.alloc(31).toString("base64url") }),
      enrollment({ connectorTokenHash: sha256(dynamicSourceToken) }),
      enrollment({ replace: "yes" }),
    ];

    for (const body of invalidBodies) {
      const response = await postEnrollment(baseUrl, code, body);
      assert.equal(response.status, 400);
    }
    assert.equal(store.enrollments.length, 0);
  });

  it("accepts events and SSE connections with enrolled credentials", async () => {
    const code = await issueEnrollmentCode(baseUrl);
    const enrolled = await postEnrollment(baseUrl, code);
    assert.equal(enrolled.status, 201);

    const ingested = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(event("dynamic-event")),
      headers: {
        authorization: `Bearer ${dynamicSourceToken}`,
        "content-type": "application/json",
      },
    });
    assert.equal(ingested.status, 201);
    assert.equal(store.enqueues[0]?.source.connectorId, "dynamic-1");
    assert.equal(store.enqueues[0]?.source.repositoryKey, "dynamic-repo");

    const rejectedEnvironment = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(
        event("dynamic-production-event", { environment: "production" }),
      ),
      headers: {
        authorization: `Bearer ${dynamicSourceToken}`,
        "content-type": "application/json",
      },
    });
    assert.equal(rejectedEnvironment.status, 422);

    const wrongSource = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(event("wrong-source-event")),
      headers: {
        authorization: "Bearer wrong-dynamic-source",
        "content-type": "application/json",
      },
    });
    assert.equal(wrongSource.status, 401);

    const wrongConnector = await fetch(
      `${baseUrl}/v1/connectors/dynamic-1/events`,
      { headers: { authorization: "Bearer wrong-dynamic-connector" } },
    );
    assert.equal(wrongConnector.status, 401);

    store.publish(
      "dynamic-1",
      task("1", "dynamic-event", { repositoryKey: "dynamic-repo" }),
    );
    const abort = new AbortController();
    const stream = await fetch(
      `${baseUrl}/v1/connectors/dynamic-1/events`,
      {
        headers: { authorization: `Bearer ${dynamicConnectorToken}` },
        signal: abort.signal,
      },
    );
    assert.equal(stream.status, 200);
    const reader = stream.body?.getReader();
    assert.ok(reader);
    let text = "";
    while (!text.includes("event: task")) {
      const result = await reader.read();
      assert.equal(result.done, false);
      text += new TextDecoder().decode(result.value);
    }
    abort.abort();
    assert.match(text, /"repositoryKey":"dynamic-repo"/);
  });

  it("rotates credentials and revokes active connector streams", async () => {
    const firstCode = await issueEnrollmentCode(baseUrl);
    const first = await postEnrollment(baseUrl, firstCode);
    assert.equal(first.status, 201);

    const oldStream = await fetch(
      `${baseUrl}/v1/connectors/dynamic-1/events`,
      { headers: { authorization: `Bearer ${dynamicConnectorToken}` } },
    );
    assert.equal(oldStream.status, 200);
    const oldReader = oldStream.body?.getReader();
    assert.ok(oldReader);

    const rotatedSourceToken = "rotated-source-secret";
    const rotatedConnectorToken = "rotated-connector-secret";
    const rotationCode = await issueEnrollmentCode(baseUrl, "dynamic-1");
    const rotationBody = enrollment({
      sourceTokenHash: sha256(rotatedSourceToken),
      connectorTokenHash: sha256(rotatedConnectorToken),
      replace: true,
    });
    const rotate = () =>
      postEnrollment(baseUrl, rotationCode, rotationBody);
    const rotated = await rotate();
    assert.equal(rotated.status, 201);
    assert.deepEqual(await rotated.json(), { status: "rotated" });
    const rotationRetry = await rotate();
    assert.equal(rotationRetry.status, 200);
    assert.deepEqual(await rotationRetry.json(), { status: "existing" });
    await waitForStreamClose(oldReader);

    const staleRetry = await postEnrollment(baseUrl, firstCode);
    assert.equal(staleRetry.status, 401);

    const oldAuthorization = await fetch(
      `${baseUrl}/v1/connectors/dynamic-1/events`,
      { headers: { authorization: `Bearer ${dynamicConnectorToken}` } },
    );
    assert.equal(oldAuthorization.status, 401);

    const newStream = await fetch(
      `${baseUrl}/v1/connectors/dynamic-1/events`,
      { headers: { authorization: `Bearer ${rotatedConnectorToken}` } },
    );
    assert.equal(newStream.status, 200);
    const newReader = newStream.body?.getReader();
    assert.ok(newReader);

    const revoked = await fetch(
      `${baseUrl}/v1/admin/connectors/dynamic-1`,
      {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      },
    );
    assert.equal(revoked.status, 200);
    assert.deepEqual(await revoked.json(), {
      status: "revoked",
      connectorId: "dynamic-1",
    });
    const revokedRetry = await rotate();
    assert.equal(revokedRetry.status, 401);
    await waitForStreamClose(newReader);

    const revokedSource = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(event("revoked-source")),
      headers: {
        authorization: `Bearer ${rotatedSourceToken}`,
        "content-type": "application/json",
      },
    });
    assert.equal(revokedSource.status, 401);

    const staticRevoke = await fetch(
      `${baseUrl}/v1/admin/connectors/local-1`,
      {
        method: "DELETE",
        headers: { authorization: "Bearer admin-secret" },
      },
    );
    assert.equal(staticRevoke.status, 409);
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
    const [input] = store.enqueues;
    assert.equal(input?.source.repositoryKey, "pagent-demo");
    assert.equal(input?.event.id, "event-1");
    assert.deepEqual(input?.event.investigation, { cooldownMs: 0 });
    assert.deepEqual(input?.event.context, {
      algorithm: "A256GCM",
      keyId: "staging-2026-08",
      iv: "AAECAwQFBgcICQoL",
      ciphertext: "AAECAwQFBgcICQoLDA0ODw",
    });
    assert.doesNotMatch(JSON.stringify(input), /payload|prompt/);
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

  it("maps duplicate and cooldown store outcomes to accepted responses", async () => {
    const ingest = (body: unknown) =>
      fetch(`${baseUrl}/v1/events`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          authorization: "Bearer source-secret",
          "content-type": "application/json",
        },
      });

    store.enqueueResults.push({ status: "duplicate" }, { status: "cooldown" });

    const duplicate = await ingest(event("event-1"));
    assert.equal(duplicate.status, 202);
    assert.equal(((await duplicate.json()) as { status: string }).status, "duplicate");

    const cooldown = await ingest(event("event-2"));
    assert.equal(cooldown.status, 202);
    assert.equal(((await cooldown.json()) as { status: string }).status, "cooldown");
  });

  it("replays tasks over authenticated SSE using Last-Event-ID", async () => {
    store.publish("local-1", task("1", "event-1", { type: "first.failed" }));
    store.publish("local-1", task("2", "event-2", { type: "second.failed" }));

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
    const [input] = store.enqueues;
    assert.equal(input?.event.context.ciphertext, tamperedCiphertext);
    const relayRepresentation = JSON.stringify(input);
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

    store.publish("local-1", task("1", "live-event"));

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
