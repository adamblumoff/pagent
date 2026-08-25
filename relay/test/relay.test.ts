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
    version: 1,
    event: {
      id,
      type: "health.failed",
      environment: "staging",
      occurredAt: "2026-08-24T12:00:00.000Z",
      payload: { reason: "database pool exhausted" },
      ...overrides,
    },
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

  it("routes an event and constructs the read-only investigation task", async () => {
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
    assert.deepEqual(task?.investigation, { cooldownMs: 0 });
    assert.match(task?.prompt ?? "", /Find the root cause/);
    assert.match(task?.prompt ?? "", /Do not modify files/);
    assert.match(task?.prompt ?? "", /database pool exhausted/);
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

  it("rejects an event without an explicit payload", async () => {
    const body = event("event-without-payload");
    delete (body.event as { payload?: unknown }).payload;
    const response = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(body),
      headers: {
        authorization: "Bearer source-secret",
        "content-type": "application/json",
      },
    });

    assert.equal(response.status, 400);
    assert.match(JSON.stringify(await response.json()), /payload is required/);
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
      "environment",
      "id",
      "investigation",
      "occurredAt",
      "payload",
      "prompt",
      "repositoryKey",
      "type",
    ]);
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
