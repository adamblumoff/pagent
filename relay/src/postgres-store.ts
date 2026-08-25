import pg from "pg";

import type {
  EncryptedContext,
  EnrollmentAttempt,
  EnrollmentCodeInput,
  EnrollmentResult,
  EnqueueInput,
  EnqueueResult,
  RelayStore,
  RelayTask,
  SourceAuthorization,
} from "./types.js";

const { Pool } = pg;
const TASK_NOTIFY_CHANNEL = "pagent_tasks";
const CREDENTIAL_NOTIFY_CHANNEL = "pagent_credentials";

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
}

interface EnrollmentCodeRow {
  active: boolean;
  used_request_hash: string | null;
  connector_id: string | null;
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
  readonly #credentialListeners = new Set<(connectorId: string) => void>();
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
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (cardinality(allowed_environments) > 0)
      );

      ALTER TABLE pagent_enrollments
        ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS pagent_enrollment_codes (
        code_hash TEXT PRIMARY KEY CHECK (length(code_hash) = 43),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        used_request_hash TEXT CHECK (
          used_request_hash IS NULL OR length(used_request_hash) = 43
        ),
        connector_id TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (
          (used_at IS NULL AND used_request_hash IS NULL) OR
          (used_at IS NOT NULL AND used_request_hash IS NOT NULL)
        )
      );

      ALTER TABLE pagent_enrollment_codes
        ADD COLUMN IF NOT EXISTS connector_id TEXT;

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

  async createEnrollmentCode(input: EnrollmentCodeInput): Promise<void> {
    await this.#pool.query(
      `INSERT INTO pagent_enrollment_codes (
         code_hash, expires_at, connector_id
       ) VALUES ($1, $2, $3)`,
      [input.codeHash, input.expiresAt, input.connectorId ?? null],
    );
  }

  async enroll(attempt: EnrollmentAttempt): Promise<EnrollmentResult> {
    try {
      return await this.#transaction(async (client) => {
        const codes = await client.query<EnrollmentCodeRow>(
          `SELECT expires_at > NOW() AS active, used_request_hash, connector_id
             FROM pagent_enrollment_codes
            WHERE code_hash = $1
            FOR UPDATE`,
          [attempt.codeHash],
        );
        const code = codes.rows[0];
        if (code === undefined) {
          return { status: "invalid-code" };
        }
        if (code.used_request_hash !== null) {
          if (code.used_request_hash !== attempt.requestHash) {
            return { status: "invalid-code" };
          }
          const input = attempt.enrollment;
          const current = await client.query(
            `SELECT 1
               FROM pagent_enrollments
              WHERE connector_id = $1
                AND repository_key = $2
                AND allowed_environments = $3::text[]
                AND source_token_hash = $4
                AND connector_token_hash = $5
                AND revoked_at IS NULL`,
            [
              input.connectorId,
              input.repositoryKey,
              input.allowedEnvironments,
              input.sourceTokenHash,
              input.connectorTokenHash,
            ],
          );
          return (current.rowCount ?? 0) > 0
            ? { status: "existing" }
            : { status: "invalid-code" };
        }
        if (!code.active) {
          return { status: "invalid-code" };
        }

        const input = attempt.enrollment;
        const codeAllowsRequest = input.replace
          ? code.connector_id === input.connectorId
          : code.connector_id === null;
        if (!codeAllowsRequest) {
          return { status: "invalid-code" };
        }
        const existing = await client.query<{ connector_id: string }>(
          `SELECT connector_id
             FROM pagent_enrollments
            WHERE connector_id = $1
            FOR UPDATE`,
          [input.connectorId],
        );
        const exists = (existing.rowCount ?? 0) > 0;
        if (exists !== input.replace) {
          return { status: "conflict" };
        }

        let status: "enrolled" | "rotated";
        if (exists) {
          await client.query(
            `UPDATE pagent_enrollments
                SET repository_key = $2,
                    allowed_environments = $3,
                    source_token_hash = $4,
                    connector_token_hash = $5,
                    revoked_at = NULL
              WHERE connector_id = $1`,
            [
              input.connectorId,
              input.repositoryKey,
              input.allowedEnvironments,
              input.sourceTokenHash,
              input.connectorTokenHash,
            ],
          );
          status = "rotated";
        } else {
          await client.query(
            `INSERT INTO pagent_enrollments (
               connector_id, repository_key, allowed_environments,
               source_token_hash, connector_token_hash
             ) VALUES ($1, $2, $3, $4, $5)`,
            [
              input.connectorId,
              input.repositoryKey,
              input.allowedEnvironments,
              input.sourceTokenHash,
              input.connectorTokenHash,
            ],
          );
          status = "enrolled";
        }
        await client.query(
          `UPDATE pagent_enrollment_codes
              SET used_at = NOW(), used_request_hash = $2
            WHERE code_hash = $1`,
          [attempt.codeHash, attempt.requestHash],
        );
        if (status === "rotated") {
          await client.query("SELECT pg_notify($1, $2)", [
            CREDENTIAL_NOTIFY_CHANNEL,
            input.connectorId,
          ]);
        }
        return { status };
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { status: "conflict" };
      throw error;
    }
  }

  async revokeConnector(connectorId: string): Promise<boolean> {
    return this.#transaction(async (client) => {
      const result = await client.query(
        `UPDATE pagent_enrollments
            SET revoked_at = COALESCE(revoked_at, NOW())
          WHERE connector_id = $1`,
        [connectorId],
      );
      if ((result.rowCount ?? 0) === 0) return false;
      await client.query("SELECT pg_notify($1, $2)", [
        CREDENTIAL_NOTIFY_CHANNEL,
        connectorId,
      ]);
      return true;
    });
  }

  async findSource(
    sourceTokenHash: string,
  ): Promise<SourceAuthorization | undefined> {
    const result = await this.#pool.query<EnrollmentRow>(
      `SELECT connector_id, repository_key, allowed_environments
         FROM pagent_enrollments
        WHERE source_token_hash = $1 AND revoked_at IS NULL`,
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
        WHERE connector_id = $1
          AND connector_token_hash = $2
          AND revoked_at IS NULL`,
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
        TASK_NOTIFY_CHANNEL,
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

  subscribeCredentialChanges(
    listener: (connectorId: string) => void,
  ): () => void {
    this.#credentialListeners.add(listener);
    return () => this.#credentialListeners.delete(listener);
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
    this.#credentialListeners.clear();
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = undefined;
    }
    if (this.#listenerClient) {
      const client = this.#listenerClient;
      this.#listenerClient = undefined;
      client.removeAllListeners();
      await client.query("UNLISTEN *").catch(() => undefined);
      client.release();
    }
    await this.#pool.end();
  }

  async #transaction<T>(run: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await run(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async #connectListener(): Promise<void> {
    const client = await this.#pool.connect();
    if (this.#closed) {
      client.release();
      return;
    }
    try {
      await client.query(`LISTEN ${TASK_NOTIFY_CHANNEL}`);
      await client.query(`LISTEN ${CREDENTIAL_NOTIFY_CHANNEL}`);
    } catch (error) {
      client.release(true);
      throw error;
    }

    this.#listenerClient = client;
    client.on("notification", (notification) => {
      if (!notification.payload) {
        return;
      }
      if (notification.channel === TASK_NOTIFY_CHANNEL) {
        for (const listener of this.#listeners.get(notification.payload) ?? []) {
          listener();
        }
      } else if (notification.channel === CREDENTIAL_NOTIFY_CHANNEL) {
        for (const listener of this.#credentialListeners) {
          listener(notification.payload);
        }
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
    for (const listener of this.#credentialListeners) {
      listener("*");
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

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "23505";
}
