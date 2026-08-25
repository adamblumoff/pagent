import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, it } from "node:test";

import pg from "pg";

import { PostgresRelayStore } from "../src/postgres-store.js";
import type { EnqueueInput, SourceRoute } from "../src/types.js";

const { Pool } = pg;
const databaseUrl = process.env.PAGENT_TEST_DATABASE_URL?.trim();

const source: SourceRoute = {
  token: "source-secret",
  repositoryKey: "pagent-demo",
  connectorId: "local-1",
  allowedEnvironments: ["staging"],
};

function input(
  id: string,
  options: {
    cooldownMs?: number;
    group?: string;
    route?: SourceRoute;
  } = {},
): EnqueueInput {
  return {
    source: options.route ?? source,
    event: {
      id,
      type: "health.failed",
      environment: "staging",
      occurredAt: "2026-08-24T12:00:00.000Z",
      investigation: {
        cooldownMs: options.cooldownMs ?? 0,
        ...(options.group === undefined ? {} : { group: options.group }),
      },
      context: {
        algorithm: "A256GCM",
        keyId: "staging-2026-08",
        iv: "AAECAwQFBgcICQoL",
        ciphertext: "AAECAwQFBgcICQoLDA0ODw",
      },
    },
  };
}

function schemaConnectionString(connectionString: string, schema: string): string {
  const url = new URL(connectionString);
  url.searchParams.set("options", `-csearch_path=${schema}`);
  return url.toString();
}

async function withStore(
  run: (store: PostgresRelayStore) => Promise<void>,
  seed?: (pool: pg.Pool, schema: string) => Promise<void>,
): Promise<void> {
  assert.ok(databaseUrl);
  const schema = `pagent_test_${process.pid}_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  let store: PostgresRelayStore | undefined;
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await seed?.(admin, schema);
    store = new PostgresRelayStore(
      schemaConnectionString(databaseUrl, schema),
    );
    await store.initialize();
    await run(store);
  } finally {
    await store?.close().catch(() => undefined);
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}

describe(
  "PostgresRelayStore integration",
  {
    skip:
      databaseUrl === undefined || databaseUrl.length === 0
        ? "set PAGENT_TEST_DATABASE_URL to run PostgreSQL integration tests"
        : false,
  },
  () => {
    it("owns deduplication and developer-defined cooldown policy", async () => {
      await withStore(async (store) => {
        const first = await store.enqueue(
          input("event-1", { cooldownMs: 60_000, group: "us-east-1" }),
        );
        assert.equal(first.status, "queued");

        const duplicate = await store.enqueue(
          input("event-1", { cooldownMs: 60_000, group: "us-east-1" }),
        );
        assert.equal(duplicate.status, "duplicate");
        assert.equal(
          duplicate.status === "duplicate" ? duplicate.task?.id : undefined,
          first.status === "queued" ? first.task.id : undefined,
        );

        const cooldown = await store.enqueue(
          input("event-2", { cooldownMs: 60_000, group: "us-east-1" }),
        );
        assert.equal(cooldown.status, "cooldown");

        const otherGroup = await store.enqueue(
          input("event-3", { cooldownMs: 60_000, group: "us-west-2" }),
        );
        assert.equal(otherGroup.status, "queued");

        assert.deepEqual(
          (await store.tasksAfter("local-1", "0", 10)).map(
            (task) => task.eventId,
          ),
          ["event-1", "event-3"],
        );
      });
    });

    it("replays each connector in ascending global sequence", async () => {
      await withStore(async (store) => {
        const secondSource: SourceRoute = {
          ...source,
          connectorId: "local-2",
        };
        const first = await store.enqueue(input("event-1"));
        const second = await store.enqueue(input("event-2"));
        const third = await store.enqueue(
          input("event-3", { route: secondSource }),
        );
        assert.equal(first.status, "queued");
        assert.equal(second.status, "queued");
        assert.equal(third.status, "queued");

        const localOne = await store.tasksAfter("local-1", "1", 10);
        assert.deepEqual(
          localOne.map((task) => [task.id, task.eventId]),
          [["2", "event-2"]],
        );
        const localTwo = await store.tasksAfter("local-2", "0", 10);
        assert.deepEqual(
          localTwo.map((task) => [task.id, task.eventId]),
          [["3", "event-3"]],
        );
      });
    });

    it("keeps task IDs moving forward when migrating the plaintext schema", async () => {
      await withStore(
        async (store) => {
          assert.deepEqual(await store.tasksAfter("local-1", "0", 10), []);

          const queued = await store.enqueue(input("encrypted-event"));
          assert.equal(queued.status, "queued");
          assert.equal(
            queued.status === "queued" ? queued.task.id : undefined,
            "4",
          );
        },
        async (pool, schema) => {
          await pool.query(`
            CREATE TABLE ${schema}.pagent_events (
              event_id TEXT PRIMARY KEY,
              event_type TEXT NOT NULL,
              environment TEXT NOT NULL,
              occurred_at TIMESTAMPTZ NOT NULL,
              repository_key TEXT NOT NULL,
              connector_id TEXT NOT NULL,
              investigation_cooldown_ms BIGINT NOT NULL DEFAULT 0,
              investigation_group TEXT,
              payload JSONB NOT NULL,
              outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'queued', 'cooldown')),
              received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            CREATE TABLE ${schema}.pagent_tasks (
              id BIGSERIAL PRIMARY KEY,
              event_id TEXT NOT NULL UNIQUE REFERENCES ${schema}.pagent_events(event_id),
              connector_id TEXT NOT NULL,
              repository_key TEXT NOT NULL,
              prompt TEXT NOT NULL,
              created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            );

            INSERT INTO ${schema}.pagent_events (
              event_id, event_type, environment, occurred_at, repository_key,
              connector_id, payload, outcome
            ) VALUES (
              'plaintext-event', 'health.failed', 'staging',
              '2026-08-24T12:00:00.000Z', 'pagent-demo', 'local-1',
              '{"reason":"plaintext"}', 'queued'
            );

            INSERT INTO ${schema}.pagent_tasks (
              id, event_id, connector_id, repository_key, prompt
            ) VALUES (
              3, 'plaintext-event', 'local-1', 'pagent-demo', 'investigate'
            );

            SELECT setval('${schema}.pagent_tasks_id_seq', 3, true);
          `);
        },
      );
    });
  },
);
