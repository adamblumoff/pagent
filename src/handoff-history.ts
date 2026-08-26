import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type HandoffStatus =
  | "received"
  | "running"
  | "retrying"
  | "completed";

export interface HandoffHistoryRecord {
  taskId: string;
  eventId: string;
  eventType: string;
  environment: string;
  status: HandoffStatus;
  attempts: number;
  receivedAt: string;
  startedAt?: string | undefined;
  lastAttemptAt?: string | undefined;
  completedAt?: string | undefined;
  lastErrorCode?: string | undefined;
  lastErrorMessage?: string | undefined;
  threadId?: string | undefined;
}

export type HandoffHistoryPatch = Partial<
  Pick<
    HandoffHistoryRecord,
    | "status"
    | "attempts"
    | "startedAt"
    | "lastAttemptAt"
    | "completedAt"
    | "lastErrorCode"
    | "lastErrorMessage"
    | "threadId"
  >
>;

interface HandoffHistoryState {
  version: 1;
  records: HandoffHistoryRecord[];
}

export interface FileHandoffHistoryOptions {
  limit?: number | undefined;
}

const DEFAULT_HISTORY_LIMIT = 100;

export class FileHandoffHistory {
  readonly #limit: number;
  readonly #path: string;
  #state: HandoffHistoryState | undefined;

  constructor(path: string, options: FileHandoffHistoryOptions = {}) {
    this.#path = resolve(path);
    this.#limit = options.limit ?? DEFAULT_HISTORY_LIMIT;
    if (
      !Number.isSafeInteger(this.#limit) ||
      this.#limit < 1 ||
      this.#limit > DEFAULT_HISTORY_LIMIT
    ) {
      throw new Error("Handoff history limit must be between 1 and 100.");
    }
  }

  async upsert(record: HandoffHistoryRecord): Promise<HandoffHistoryRecord> {
    const next = requireRecord(record);
    const state = await this.#load();
    state.records = [
      next,
      ...state.records.filter((entry) => entry.taskId !== next.taskId),
    ].slice(0, this.#limit);
    await this.#save();
    return copyRecord(next);
  }

  async update(
    taskId: string,
    patch: HandoffHistoryPatch,
  ): Promise<HandoffHistoryRecord | undefined> {
    const state = await this.#load();
    const index = state.records.findIndex((record) => record.taskId === taskId);
    const current = state.records[index];
    if (current === undefined) {
      return undefined;
    }

    const next = requireRecord({ ...current, ...patch });
    state.records[index] = next;
    await this.#save();
    return copyRecord(next);
  }

  async list(): Promise<HandoffHistoryRecord[]> {
    return (await this.#load()).records.map(copyRecord);
  }

  async findByEventId(
    eventId: string,
  ): Promise<HandoffHistoryRecord | undefined> {
    const record = (await this.#load()).records.find(
      (entry) => entry.eventId === eventId,
    );
    return record === undefined ? undefined : copyRecord(record);
  }

  async #load(): Promise<HandoffHistoryState> {
    if (this.#state !== undefined) {
      return this.#state;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#path, "utf8"));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        this.#state = emptyState();
        return this.#state;
      }
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      this.#state = emptyState();
      await this.#save();
      return this.#state;
    }

    const loaded = historyState(parsed, this.#limit);
    this.#state = loaded.state;
    if (loaded.migrated) {
      await this.#save();
    }
    return this.#state;
  }

  async #save(): Promise<void> {
    const state = await this.#load();
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    await mkdir(dirname(this.#path), { recursive: true });

    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

function historyState(
  value: unknown,
  limit: number,
): { state: HandoffHistoryState; migrated: boolean } {
  const root = record(value);
  const source = Array.isArray(value)
    ? value
    : Array.isArray(root?.records)
      ? root.records
      : [];
  const records = source
    .map(parseRecord)
    .filter((entry): entry is HandoffHistoryRecord => entry !== undefined)
    .slice(0, limit);
  const state: HandoffHistoryState = { version: 1, records };

  return {
    state,
    migrated: JSON.stringify(value) !== JSON.stringify(state),
  };
}

function parseRecord(value: unknown): HandoffHistoryRecord | undefined {
  const candidate = record(value);
  if (
    candidate === undefined ||
    !nonEmptyString(candidate.taskId) ||
    !nonEmptyString(candidate.eventId) ||
    !nonEmptyString(candidate.eventType) ||
    !nonEmptyString(candidate.environment) ||
    !handoffStatus(candidate.status) ||
    !Number.isSafeInteger(candidate.attempts) ||
    (candidate.attempts as number) < 0 ||
    !isoDate(candidate.receivedAt) ||
    !optionalIsoDate(candidate.startedAt) ||
    !optionalIsoDate(candidate.lastAttemptAt) ||
    !optionalIsoDate(candidate.completedAt) ||
    !optionalString(candidate.lastErrorCode) ||
    !optionalString(candidate.lastErrorMessage) ||
    !optionalString(candidate.threadId)
  ) {
    return undefined;
  }

  return {
    taskId: candidate.taskId,
    eventId: candidate.eventId,
    eventType: candidate.eventType,
    environment: candidate.environment,
    status: candidate.status,
    attempts: candidate.attempts as number,
    receivedAt: candidate.receivedAt,
    ...(candidate.startedAt === undefined
      ? {}
      : { startedAt: candidate.startedAt }),
    ...(candidate.lastAttemptAt === undefined
      ? {}
      : { lastAttemptAt: candidate.lastAttemptAt }),
    ...(candidate.completedAt === undefined
      ? {}
      : { completedAt: candidate.completedAt }),
    ...(candidate.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: candidate.lastErrorCode }),
    ...(candidate.lastErrorMessage === undefined
      ? {}
      : { lastErrorMessage: candidate.lastErrorMessage }),
    ...(candidate.threadId === undefined
      ? {}
      : { threadId: candidate.threadId }),
  };
}

function requireRecord(value: unknown): HandoffHistoryRecord {
  const parsed = parseRecord(value);
  if (parsed === undefined) {
    throw new Error("Handoff history record is invalid.");
  }
  return parsed;
}

function emptyState(): HandoffHistoryState {
  return { version: 1, records: [] };
}

function copyRecord(record: HandoffHistoryRecord): HandoffHistoryRecord {
  return { ...record };
}

function handoffStatus(value: unknown): value is HandoffStatus {
  return (
    value === "received" ||
    value === "running" ||
    value === "retrying" ||
    value === "completed"
  );
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function optionalIsoDate(value: unknown): value is string | undefined {
  return value === undefined || isoDate(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
