import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { it } from "node:test";

import { createPagent } from "pagent";

import { createRelayServer } from "../src/server.js";
import type {
  EnqueueInput,
  EnqueueResult,
  RelayEventCursor,
  RelayEventHistoryRecord,
} from "../src/types.js";
import { RecordingRelayStore } from "./recording-store.js";
import {
  relayTestConfig as config,
  relayTestEvent as event,
} from "./relay-test-fixture.js";

class FailingRelayStore extends RecordingRelayStore {
  override async eventsBefore(
    _connectorId: string,
    _cursor: RelayEventCursor | undefined,
    _limit: number,
  ): Promise<RelayEventHistoryRecord[]> {
    throw new Error("history query failed");
  }

  override async enqueue(_input: EnqueueInput): Promise<EnqueueResult> {
    throw new Error("event ingest failed");
  }
}

it("uses Pagent for unexpected relay failures without observing ingest", async (t) => {
  t.mock.method(console, "error", () => undefined);
  const deliveries: string[] = [];
  const pagent = createPagent({
    enabled: true,
    environment: "staging",
    encryption: {
      keyId: "test-key",
      key: Buffer.alloc(32).toString("base64url"),
    },
    relay: {
      url: "https://relay.example.test/v1/events",
      token: "self-observation-source-token",
      transport: async (_url, request) => {
        deliveries.push(request.body);
        return { ok: true, status: 201 };
      },
    },
  });
  const store = new FailingRelayStore();
  const server = createRelayServer({ config, store, pagent });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const failure = await fetch(
      `${baseUrl}/v1/connectors/local-1/event-history`,
      { headers: { authorization: "Bearer connector-secret" } },
    );
    assert.equal(failure.status, 500);
    await pagent.flush();

    assert.equal(deliveries.length, 1);
    const envelope = JSON.parse(deliveries[0] ?? "") as {
      event: {
        type: string;
        environment: string;
        investigation: { group?: string };
        context: { ciphertext: string };
      };
    };
    assert.equal(envelope.event.type, "relay.request.failed");
    assert.equal(envelope.event.environment, "staging");
    assert.equal(
      envelope.event.investigation.group,
      "GET /v1/connectors/local-1/event-history",
    );
    assert.doesNotMatch(envelope.event.context.ciphertext, /history query failed/u);

    const ingestFailure = await fetch(`${baseUrl}/v1/events`, {
      method: "POST",
      body: JSON.stringify(event("self-observation-loop")),
      headers: {
        authorization: "Bearer source-secret",
        "content-type": "application/json",
      },
    });
    assert.equal(ingestFailure.status, 500);
    await pagent.flush();
    assert.equal(deliveries.length, 1);
  } finally {
    server.close();
    await once(server, "close");
    await store.close();
  }
});
