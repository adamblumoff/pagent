import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createRelayServer } from "../src/server.js";
import { RecordingRelayStore } from "./recording-store.js";
import {
  relayTestConfig as config,
  relayTestEvent as event,
  relayTestTask as task,
} from "./relay-test-fixture.js";

describe("relay event history API", () => {
  let store: RecordingRelayStore;
  let server: ReturnType<typeof createRelayServer>;
  let baseUrl: string;

  beforeEach(async () => {
    store = new RecordingRelayStore();
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

  it("lists paginated event metadata and looks up one event", async () => {
    const ingest = (body: unknown) =>
      fetch(`${baseUrl}/v1/events`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          authorization: "Bearer source-secret",
          "content-type": "application/json",
        },
      });
    assert.equal((await ingest(event("queued-event"))).status, 201);
    store.enqueueResults.push({ status: "cooldown" });
    assert.equal((await ingest(event("suppressed-event"))).status, 202);

    const unauthorized = await fetch(
      `${baseUrl}/v1/connectors/local-1/event-history`,
      { headers: { authorization: "Bearer wrong" } },
    );
    assert.equal(unauthorized.status, 401);

    const first = await fetch(
      `${baseUrl}/v1/connectors/local-1/event-history?limit=1`,
      { headers: { authorization: "Bearer connector-secret" } },
    );
    assert.equal(first.status, 200);
    assert.equal(first.headers.get("cache-control"), "no-store");
    const firstPage = (await first.json()) as {
      version: number;
      events: Array<Record<string, unknown>>;
      nextCursor: string;
    };
    assert.equal(firstPage.version, 1);
    assert.deepEqual(firstPage.events, [
      {
        eventId: "suppressed-event",
        type: "health.failed",
        environment: "staging",
        occurredAt: "2026-08-24T12:00:00.000Z",
        receivedAt: "2026-08-24T12:00:00.001Z",
        status: "suppressed",
        attemptCount: 0,
      },
    ]);
    assert.equal(typeof firstPage.nextCursor, "string");

    const second = await fetch(
      `${baseUrl}/v1/connectors/local-1/event-history?limit=1&cursor=${firstPage.nextCursor}`,
      { headers: { authorization: "Bearer connector-secret" } },
    );
    assert.deepEqual(await second.json(), {
      version: 1,
      events: [
        {
          eventId: "queued-event",
          type: "health.failed",
          environment: "staging",
          occurredAt: "2026-08-24T12:00:00.000Z",
          receivedAt: "2026-08-24T12:00:00.000Z",
          status: "queued",
          attemptCount: 0,
          taskId: "1",
        },
      ],
    });

    const detail = await fetch(
      `${baseUrl}/v1/connectors/local-1/event-history/queued-event`,
      { headers: { authorization: "Bearer connector-secret" } },
    );
    assert.equal(detail.status, 200);
    const detailText = await detail.text();
    assert.doesNotMatch(
      detailText,
      /context|ciphertext|repositoryKey|thread|prompt|payload|errorMessage/u,
    );
    assert.equal(
      (JSON.parse(detailText) as { event: { eventId: string } }).event.eventId,
      "queued-event",
    );

    const missing = await fetch(
      `${baseUrl}/v1/connectors/local-1/event-history/missing`,
      { headers: { authorization: "Bearer connector-secret" } },
    );
    assert.equal(missing.status, 404);
    for (const query of ["limit=0", "limit=101", "cursor=not-json"]) {
      const invalid = await fetch(
        `${baseUrl}/v1/connectors/local-1/event-history?${query}`,
        { headers: { authorization: "Bearer connector-secret" } },
      );
      assert.equal(invalid.status, 400);
    }
  });

  it("records coarse task progress without completing pending work", async () => {
    store.publish("local-1", task("1", "event-1"));
    const postProgress = (body: unknown, token = "connector-secret") =>
      fetch(`${baseUrl}/v1/connectors/local-1/tasks/1/progress`, {
        method: "POST",
        body: JSON.stringify(body),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
      });

    assert.equal(
      (await postProgress({ version: 1, status: "received" }, "wrong")).status,
      401,
    );
    assert.equal(
      (await postProgress({ version: 1, status: "received" })).status,
      200,
    );
    assert.equal(
      (await postProgress({ version: 1, status: "started" })).status,
      200,
    );
    assert.equal(
      (
        await postProgress({
          version: 1,
          status: "retrying",
          errorCode: "codex_failed",
        })
      ).status,
      200,
    );
    assert.deepEqual(await store.tasksAfter("local-1", "0", 10), [
      task("1", "event-1"),
    ]);

    const retrying = await fetch(
      `${baseUrl}/v1/connectors/local-1/event-history/event-1`,
      { headers: { authorization: "Bearer connector-secret" } },
    );
    const retryingEvent = (await retrying.json()) as {
      event: Record<string, unknown>;
    };
    assert.equal(retryingEvent.event.status, "retrying");
    assert.equal(retryingEvent.event.attemptCount, 1);
    assert.equal(retryingEvent.event.lastErrorCode, "codex_failed");
    assert.equal(typeof retryingEvent.event.receivedLocallyAt, "string");
    assert.equal(typeof retryingEvent.event.startedAt, "string");
    assert.equal(typeof retryingEvent.event.lastAttemptAt, "string");

    assert.equal(
      (await postProgress({ version: 1, status: "started" })).status,
      200,
    );
    const acknowledged = await fetch(
      `${baseUrl}/v1/connectors/local-1/tasks/1/ack`,
      {
        method: "POST",
        headers: { authorization: "Bearer connector-secret" },
      },
    );
    assert.equal(acknowledged.status, 200);
    assert.deepEqual(await store.tasksAfter("local-1", "0", 10), []);

    const completed = await fetch(
      `${baseUrl}/v1/connectors/local-1/event-history/event-1`,
      { headers: { authorization: "Bearer connector-secret" } },
    );
    const completedEvent = (await completed.json()) as {
      event: Record<string, unknown>;
    };
    assert.equal(completedEvent.event.status, "completed");
    assert.equal(completedEvent.event.attemptCount, 2);
    assert.equal(completedEvent.event.lastErrorCode, undefined);
    assert.equal(typeof completedEvent.event.completedAt, "string");

    for (const invalidBody of [
      { version: 1, status: "retrying", errorCode: "secret local failure" },
      { version: 1, status: "retrying" },
      { version: 1, status: "received", errorCode: "unknown" },
      { version: 1, status: "started", error: "Codex unavailable" },
    ]) {
      assert.equal((await postProgress(invalidBody)).status, 400);
    }
    assert.equal(
      (
        await fetch(`${baseUrl}/v1/connectors/local-1/tasks/1/progress`, {
          method: "POST",
          body: JSON.stringify({ version: 1, status: "received" }),
          headers: {
            authorization: "Bearer connector-secret",
            "content-type": "application/json",
          },
        })
      ).status,
      404,
    );
  });
});
