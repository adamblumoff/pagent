import type {
  EnvironmentRecord,
  EnrollmentTokenRecord,
  IdempotencyRecord,
  KvNamespace,
} from "./types.js";

const IDEMPOTENCY_TTL_SECONDS = 7 * 24 * 60 * 60;
const ENROLLMENT_REPLAY_TTL_SECONDS = IDEMPOTENCY_TTL_SECONDS;

export class ProvisionerStore {
  constructor(private readonly kv: KvNamespace) {}

  async getEnvironment(environmentId: string): Promise<EnvironmentRecord | null> {
    return parseStored<EnvironmentRecord>(
      await this.kv.get(environmentKey(environmentId)),
    );
  }

  async putEnvironment(record: EnvironmentRecord): Promise<void> {
    await this.kv.put(environmentKey(record.environmentId), JSON.stringify(record));
  }

  async getEnrollmentToken(tokenHash: string): Promise<EnrollmentTokenRecord | null> {
    return parseStored<EnrollmentTokenRecord>(
      await this.kv.get(enrollmentTokenKey(tokenHash)),
    );
  }

  async putEnrollmentToken(record: EnrollmentTokenRecord): Promise<void> {
    const expiresInSeconds = Math.max(
      60,
      Math.ceil((Date.parse(record.expiresAt) - Date.now()) / 1_000),
    );
    await this.kv.put(
      enrollmentTokenKey(record.tokenHash),
      JSON.stringify(record),
      { expirationTtl: expiresInSeconds + ENROLLMENT_REPLAY_TTL_SECONDS },
    );
  }

  async getIdempotency(
    operation: string,
    environmentId: string,
    key: string,
  ): Promise<IdempotencyRecord | null> {
    return parseStored<IdempotencyRecord>(
      await this.kv.get(idempotencyKey(operation, environmentId, key)),
    );
  }

  async putIdempotency(
    operation: string,
    environmentId: string,
    key: string,
    record: IdempotencyRecord,
  ): Promise<void> {
    await this.kv.put(
      idempotencyKey(operation, environmentId, key),
      JSON.stringify(record),
      { expirationTtl: IDEMPOTENCY_TTL_SECONDS },
    );
  }
}

function environmentKey(environmentId: string): string {
  return `environment:v1:${environmentId}`;
}

function enrollmentTokenKey(tokenHash: string): string {
  return `enrollment-token:v1:${tokenHash}`;
}

function idempotencyKey(
  operation: string,
  environmentId: string,
  key: string,
): string {
  return `idempotency:v1:${operation}:${environmentId}:${key}`;
}

function parseStored<T>(value: string | null): T | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error("Provisioner storage contains invalid JSON.");
  }
}
