import pg from "pg";

import type {
  EncryptedContext,
  EnrollmentInput,
  EnrollmentResult,
  EnqueueInput,
  EnqueueResult,
  RelayStore,
  RelayTask,
  SourceAuthorization,
} from "./types.js";

const { Pool } = pg;
const NOTIFY_CHANNEL = "pagent_tasks";

interface TaskRow {
  id: string;
  event_id: string;
  event_type: string;
  environment: string;
  occurred_at: Date;
  investigation_cooldown_ms: string;
  investigation_group: string | null;
  repository_key: string;
  encrypted_context: EncryptedContext;
}

interface EnrollmentRow {
  connector_id: string;
  repository_key: string;
  allowed_environments: string[];
  source_token_hash: string;
  connector_token_hash: string;
}

function taskFromRow(row: TaskRow): RelayTask {
  return {
    id: row.id,
    eventId: row.event_id,
    type: row.event_type,
    environment: row.environment,
    occurredAt: row.occurred_at.toISOString(),
    investigation: {
      cooldownMs: Number(row.investigation_cooldown_ms),
      ...(row.investigation_group === null
        ? {}
        : { group: row.investigation_group }),
    },
    repositoryKey: row.repository_key,
    context: row.encrypted_context,
  };
}

export class PostgresRelayStore implements RelayStore {
  readonly #pool: pg.Pool;
  readonly #listeners = new Map<string, Set<() => void>>();
  #closed = false;
  #listenerClient: pg.PoolClient | undefined;
  #reconnectTimer: NodeJS.Timeout | undefined;

  constructor(connectionString: string) {
    this.#pool = new Pool({ connectionString });
  }

  async initialize(): Promise<void> {
    await this.#pool.query(`
      CREATE TABLE IF NOT EXISTS pagent_enrollments (
        connector_id TEXT PRIMARY KEY,
        repository_key TEXT NOT NULL,
        allowed_environments TEXT[] NOT NULL,
        source_token_hash TEXT NOT NULL UNIQUE CHECK (length(source_token_hash) = 43),
        connector_token_hash TEXT NOT NULL UNIQUE CHECK (length(connector_token_hash) = 43),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (cardinality(allowed_environments) > 0)
      );

      CREATE TABLE IF NOT EXISTS pagent_events (
        event_id TEXT PRIMARY KEY,
        event_type TEXT NOT NULL,
        environment TEXT NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        repository_key TEXT NOT NULL,
        connector_id TEXT NOT NULL,
        investigation_cooldown_ms BIGINT NOT NULL DEFAULT 0,
        investigation_group TEXT,
        encrypted_context JSONB NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('pending', 'queued', 'cooldown')),
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS pagent_tasks (
        id BIGSERIAL PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES pagent_events(event_id),
        connector_id TEXT NOT NULL,
        repository_key TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS pagent_tasks_connector_id_id_idx
        ON pagent_tasks (connector_id, id);

      ALTER TABLE pagent_events
        ADD COLUMN IF NOT EXISTS investigation_cooldown_ms BIGINT NOT NULL DEFAULT 0;

      ALTER TABLE pagent_events
        ADD COLUMN IF NOT EXISTS investigation_group TEXT;

      ALTER TABLE pagent_events
        ADD COLUMN IF NOT EXISTS encrypted_context JSONB;

      DO $migration$
      BEGIN
        IF EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'pagent_events'
             AND column_name = 'payload'
        ) OR EXISTS (
          SELECT 1
            FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'pagent_tasks'
             AND column_name = 'prompt'
        ) THEN
          -- SSE clients persist Last-Event-ID locally, so task IDs must never
          -- move backward across a schema migration.
          TRUNCATE pagent_tasks, pagent_events CONTINUE IDENTITY;
        END IF;
      END
      $migration$;

      ALTER TABLE pagent_events
        DROP COLUMN IF EXISTS payload;

      ALTER TABLE pagent_events
        ALTER COLUMN encrypted_context SET NOT NULL;

      ALTER TABLE pagent_tasks
        DROP COLUMN IF EXISTS prompt;

      DROP INDEX IF EXISTS pagent_events_cooldown_idx;

      CREATE INDEX IF NOT EXISTS pagent_events_policy_cooldown_idx
        ON pagent_events (
          connector_id,
          repository_key,
          event_type,
          environment,
          investigation_group,
          received_at DESC
        )
        WHERE outcome = 'queued';
    `);

    await this.#connectListener();
  }

  async enroll(input: EnrollmentInput): Promise<EnrollmentResult> {
    const inserted = await this.#pool.query<{ connector_id: string }>(
      `INSERT INTO pagent_enrollments (
         connector_id, repository_key, allowed_environments,
         source_token_hash, connector_token_hash
       ) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING connector_id`,
      [
        input.connectorId,
        input.repositoryKey,
        input.allowedEnvironments,
        input.sourceTokenHash,
        input.connectorTokenHash,
      ],
    );
    if ((inserted.rowCount ?? 0) > 0) {
      return { status: "enrolled" };
    }

    const existing = await this.#pool.query<EnrollmentRow>(
      `SELECT connector_id, repository_key, allowed_environments,
              source_token_hash, connector_token_hash
         FROM pagent_enrollments
        WHERE connector_id = $1`,
      [input.connectorId],
    );
    const row = existing.rows[0];
    if (
      row &&
      row.repository_key === input.repositoryKey &&
      row.source_token_hash === input.sourceTokenHash &&
      row.connector_token_hash === input.connectorTokenHash &&
      row.allowed_environments.length === input.allowedEnvironments.length &&
      row.allowed_environments.every(
        (environment, index) => environment === input.allowedEnvironments[index],
      )
    ) {
      return { status: "existing" };
    }
    return { status: "conflict" };
  }

  async findSource(
    sourceTokenHash: string,
  ): Promise<SourceAuthorization | undefined> {
    const result = await this.#pool.query<EnrollmentRow>(
      `SELECT connector_id, repository_key, allowed_environments,
              source_token_hash, connector_token_hash
         FROM pagent_enrollments
        WHERE source_token_hash = $1`,
      [sourceTokenHash],
    );
    const row = result.rows[0];
    return row
      ? {
          connectorId: row.connector_id,
          repositoryKey: row.repository_key,
          allowedEnvironments: row.allowed_environments,
        }
      : undefined;
  }

  async authorizeConnector(
    connectorId: string,
    connectorTokenHash: string,
  ): Promise<boolean> {
    const result = await this.#pool.query(
      `SELECT 1
         FROM pagent_enrollments
        WHERE connector_id = $1 AND connector_token_hash = $2`,
      [connectorId, connectorTokenHash],
    );
    return (result.rowCount ?? 0) > 0;
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const routeKey = JSON.stringify([
        input.source.connectorId,
        input.source.repositoryKey,
        input.event.type,
        input.event.environment,
        input.event.investigation.group ?? null,
      ]);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [routeKey]);

      const inserted = await client.query<{ event_id: string }>(
        `INSERT INTO pagent_events (
          event_id, event_type, environment, occurred_at, repository_key,
          connector_id, investigation_cooldown_ms, investigation_group,
          encrypted_context,
          outcome
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
        ON CONFLICT (event_id) DO NOTHING
        RETURNING event_id`,
        [
          input.event.id,
          input.event.type,
          input.event.environment,
          input.event.occurredAt,
          input.source.repositoryKey,
          input.source.connectorId,
          input.event.investigation.cooldownMs,
          input.event.investigation.group ?? null,
          JSON.stringify(input.event.context),
        ],
      );

      if (inserted.rowCount === 0) {
        const existing = await client.query<TaskRow>(
          `SELECT t.id::text, e.event_id, e.event_type, e.environment, e.occurred_at,
                  e.investigation_cooldown_ms::text, e.investigation_group,
                  e.repository_key, e.encrypted_context
             FROM pagent_events e
             JOIN pagent_tasks t ON t.event_id = e.event_id
            WHERE e.event_id = $1`,
          [input.event.id],
        );
        await client.query("COMMIT");
        const row = existing.rows[0];
        return row
          ? { status: "duplicate", task: taskFromRow(row) }
          : { status: "duplicate" };
      }

      if (input.event.investigation.cooldownMs > 0) {
        const coolingDown = await client.query(
          `SELECT 1
             FROM pagent_events
            WHERE connector_id = $1
              AND repository_key = $2
              AND event_type = $3
              AND environment = $4
              AND investigation_group IS NOT DISTINCT FROM $5::text
              AND outcome = 'queued'
              AND received_at > NOW() - ($6::bigint * INTERVAL '1 millisecond')
            LIMIT 1`,
          [
            input.source.connectorId,
            input.source.repositoryKey,
            input.event.type,
            input.event.environment,
            input.event.investigation.group ?? null,
            input.event.investigation.cooldownMs,
          ],
        );
        if ((coolingDown.rowCount ?? 0) > 0) {
          await client.query(
            "UPDATE pagent_events SET outcome = 'cooldown' WHERE event_id = $1",
            [input.event.id],
          );
          await client.query("COMMIT");
          return { status: "cooldown" };
        }
      }

      const created = await client.query<TaskRow>(
        `INSERT INTO pagent_tasks (
           event_id, connector_id, repository_key
         ) VALUES ($1, $2, $3)
         RETURNING id::text,
           event_id,
           $4::text AS event_type,
           $5::text AS environment,
           $6::timestamptz AS occurred_at,
           $7::bigint::text AS investigation_cooldown_ms,
           $8::text AS investigation_group,
           repository_key,
           $9::jsonb AS encrypted_context`,
        [
          input.event.id,
          input.source.connectorId,
          input.source.repositoryKey,
          input.event.type,
          input.event.environment,
          input.event.occurredAt,
          input.event.investigation.cooldownMs,
          input.event.investigation.group ?? null,
          JSON.stringify(input.event.context),
        ],
      );
      await client.query(
        "UPDATE pagent_events SET outcome = 'queued' WHERE event_id = $1",
        [input.event.id],
      );
      await client.query("SELECT pg_notify($1, $2)", [
        NOTIFY_CHANNEL,
        input.source.connectorId,
      ]);
      await client.query("COMMIT");
      const task = created.rows[0];
      if (!task) {
        throw new Error("Postgres did not return the created task");
      }
      return { status: "queued", task: taskFromRow(task) };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async tasksAfter(
    connectorId: string,
    lastEventId: string,
    limit: number,
  ): Promise<RelayTask[]> {
    const result = await this.#pool.query<TaskRow>(
      `SELECT t.id::text, e.event_id, e.event_type, e.environment, e.occurred_at,
              e.investigation_cooldown_ms::text, e.investigation_group,
              e.repository_key, e.encrypted_context
         FROM pagent_tasks t
         JOIN pagent_events e ON e.event_id = t.event_id
        WHERE t.connector_id = $1 AND t.id > $2::bigint
        ORDER BY t.id ASC
        LIMIT $3`,
      [connectorId, lastEventId, limit],
    );
    return result.rows.map(taskFromRow);
  }

  subscribe(connectorId: string, listener: () => void): () => void {
    let listeners = this.#listeners.get(connectorId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(connectorId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) {
        this.#listeners.delete(connectorId);
      }
    };
  }

  async health(): Promise<void> {
    if (!this.#listenerClient) {
      throw new Error("Postgres notification connection is unavailable");
    }
    await this.#pool.query("SELECT 1");
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#listeners.clear();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.#listenerClient) {
      const client = this.#listenerClient;
      this.#listenerClient = undefined;
      client.removeAllListeners();
      await client.query(`UNLISTEN ${NOTIFY_CHANNEL}`).catch(() => undefined);
      client.release();
    }
    await this.#pool.end();
  }

  async #connectListener(): Promise<void> {
    const client = await this.#pool.connect();
    if (this.#closed) {
      client.release();
      return;
    }
    try {
      await client.query(`LISTEN ${NOTIFY_CHANNEL}`);
    } catch (error) {
      client.release(true);
      throw error;
    }

    this.#listenerClient = client;
    client.on("notification", (notification) => {
      if (notification.channel !== NOTIFY_CHANNEL || !notification.payload) {
        return;
      }
      for (const listener of this.#listeners.get(notification.payload) ?? []) {
        listener();
      }
    });
    client.once("error", (error) => this.#listenerFailed(client, error));
    client.once("end", () => this.#listenerFailed(client));

    // A notification may have been missed while reconnecting. Each stream uses
    // its own sequence cursor, so one catch-up pump restores it without polling.
    for (const listeners of this.#listeners.values()) {
      for (const listener of listeners) {
        listener();
      }
    }
  }

  #listenerFailed(client: pg.PoolClient, error?: Error): void {
    if (this.#listenerClient !== client) {
      return;
    }
    this.#listenerClient = undefined;
    client.removeAllListeners();
    client.release(true);
    if (error) {
      console.error("Postgres notification connection failed", error);
    }
    this.#scheduleListenerReconnect();
  }

  #scheduleListenerReconnect(): void {
    if (this.#closed || this.#reconnectTimer) {
      return;
    }
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = undefined;
      void this.#connectListener().catch((error: unknown) => {
        console.error("Postgres notification reconnect failed", error);
        this.#scheduleListenerReconnect();
      });
    }, 1_000);
    this.#reconnectTimer.unref();
  }
}
