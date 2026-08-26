import type {
  EnrollmentAttempt,
  EnrollmentCodeInput,
  EnrollmentInput,
  EnrollmentResult,
  EnqueueInput,
  EnqueueResult,
  RelayEventCursor,
  RelayEventHistoryRecord,
  RelayEventSummary,
  RelayStore,
  RelayTask,
  RelayTaskProgress,
  SourceAuthorization,
} from "../src/types.js";

interface StoredTask {
  connectorId: string;
  task: RelayTask;
}

interface StoredEvent {
  connectorId: string;
  summary: RelayEventSummary;
}

function taskFor(input: EnqueueInput, id: string): RelayTask {
  return {
    id,
    eventId: input.event.id,
    type: input.event.type,
    environment: input.event.environment,
    occurredAt: input.event.occurredAt,
    investigation: input.event.investigation,
    repositoryKey: input.source.repositoryKey,
    context: input.event.context,
  };
}

export class RecordingRelayStore implements RelayStore {
  readonly enqueues: EnqueueInput[] = [];
  readonly enrollments: EnrollmentInput[] = [];
  readonly enqueueResults: EnqueueResult[] = [];
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #credentialListeners = new Set<(connectorId: string) => void>();
  readonly #codes = new Map<
    string,
    {
      expiresAt: number;
      connectorId?: string | undefined;
      requestHash?: string | undefined;
    }
  >();
  readonly #revoked = new Set<string>();
  readonly #tasks: StoredTask[] = [];
  readonly #events: StoredEvent[] = [];
  readonly #acknowledged = new Set<string>();
  readonly #retiredKeys = new Set<string>();
  healthError: Error | undefined;

  async initialize(): Promise<void> {}

  async createEnrollmentCode(input: EnrollmentCodeInput): Promise<void> {
    this.#codes.set(input.codeHash, {
      expiresAt: new Date(input.expiresAt).getTime(),
      ...(input.connectorId === undefined
        ? {}
        : { connectorId: input.connectorId }),
    });
  }

  async enroll(attempt: EnrollmentAttempt): Promise<EnrollmentResult> {
    const code = this.#codes.get(attempt.codeHash);
    if (!code) {
      return { status: "invalid-code" };
    }
    if (code.requestHash !== undefined) {
      const current = this.enrollments.find(
        (enrollment) => enrollment.connectorId === attempt.enrollment.connectorId,
      );
      return code.requestHash === attempt.requestHash &&
        current !== undefined &&
        !this.#revoked.has(current.connectorId) &&
        sameEnrollment(current, attempt.enrollment)
        ? { status: "existing" }
        : { status: "invalid-code" };
    }
    if (code.expiresAt <= Date.now()) {
      return { status: "invalid-code" };
    }
    const input = attempt.enrollment;
    const codeAllowsRequest = input.replace
      ? code.connectorId === input.connectorId
      : code.connectorId === undefined;
    if (!codeAllowsRequest) return { status: "invalid-code" };
    const existing = this.enrollments.find(
      (enrollment) => enrollment.connectorId === input.connectorId,
    );
    if ((existing !== undefined) !== input.replace) {
      return { status: "conflict" };
    }
    if (existing === undefined) {
      if (
        this.enrollments.some(
          (enrollment) =>
            enrollment.sourceTokenHash === input.sourceTokenHash ||
            enrollment.connectorTokenHash === input.connectorTokenHash,
        )
      ) {
        return { status: "conflict" };
      }
      this.enrollments.push(input);
      code.requestHash = attempt.requestHash;
      return { status: "enrolled" };
    }
    const index = this.enrollments.indexOf(existing);
    this.enrollments[index] = input;
    this.#revoked.delete(input.connectorId);
    code.requestHash = attempt.requestHash;
    this.#notifyCredentialChange(input.connectorId);
    return { status: "rotated" };
  }

  async revokeConnector(connectorId: string): Promise<boolean> {
    if (
      !this.enrollments.some(
        (enrollment) => enrollment.connectorId === connectorId,
      )
    ) {
      return false;
    }
    this.#revoked.add(connectorId);
    this.#notifyCredentialChange(connectorId);
    return true;
  }

  async findSource(
    sourceTokenHash: string,
  ): Promise<SourceAuthorization | undefined> {
    const enrollment = this.enrollments.find(
      (candidate) =>
        candidate.sourceTokenHash === sourceTokenHash &&
        !this.#revoked.has(candidate.connectorId),
    );
    return enrollment
      ? {
          connectorId: enrollment.connectorId,
          repositoryKey: enrollment.repositoryKey,
          allowedEnvironments: enrollment.allowedEnvironments,
        }
      : undefined;
  }

  async authorizeConnector(
    connectorId: string,
    connectorTokenHash: string,
  ): Promise<boolean> {
    return this.enrollments.some(
      (enrollment) =>
        enrollment.connectorId === connectorId &&
        enrollment.connectorTokenHash === connectorTokenHash &&
        !this.#revoked.has(connectorId),
    );
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    this.enqueues.push(input);
    if (
      this.#retiredKeys.has(
        contextKey(input.source.connectorId, input.event.context.keyId),
      )
    ) {
      return { status: "retired-key" };
    }
    const result =
      this.enqueueResults.shift() ?? {
        status: "queued",
        task: taskFor(input, String(this.enqueues.length)),
      };
    if (result.status === "queued" || result.status === "cooldown") {
      this.#events.push({
        connectorId: input.source.connectorId,
        summary: {
          eventId: input.event.id,
          type: input.event.type,
          environment: input.event.environment,
          occurredAt: input.event.occurredAt,
          receivedAt: receivedAt(this.#events.length),
          status: result.status === "cooldown" ? "suppressed" : "queued",
          attemptCount: 0,
          ...(result.status === "queued" ? { taskId: result.task.id } : {}),
        },
      });
    }
    return result;
  }

  async tasksAfter(
    connectorId: string,
    lastEventId: string,
    limit: number,
  ): Promise<RelayTask[]> {
    const cursor = BigInt(lastEventId);
    return this.#tasks
      .filter(
        (entry) =>
          entry.connectorId === connectorId &&
          BigInt(entry.task.id) > cursor &&
          !this.#acknowledged.has(taskKey(connectorId, entry.task.id)),
      )
      .slice(0, limit)
      .map((entry) => entry.task);
  }

  async acknowledgeTask(connectorId: string, taskId: string): Promise<boolean> {
    if (
      !this.#tasks.some(
        (entry) => entry.connectorId === connectorId && entry.task.id === taskId,
      )
    ) {
      return false;
    }
    this.#acknowledged.add(taskKey(connectorId, taskId));
    const stored = this.#events.find(
      (event) =>
        event.connectorId === connectorId && event.summary.taskId === taskId,
    );
    if (stored !== undefined) {
      stored.summary.status = "completed";
      stored.summary.completedAt = receivedAt(this.#events.length);
    }
    return true;
  }

  async eventsBefore(
    connectorId: string,
    cursor: RelayEventCursor | undefined,
    limit: number,
  ): Promise<RelayEventHistoryRecord[]> {
    return this.#events
      .filter(
        (entry) =>
          entry.connectorId === connectorId &&
          (cursor === undefined || beforeCursor(entry.summary, cursor)),
      )
      .sort((left, right) => compareEvents(right.summary, left.summary))
      .slice(0, limit)
      .map((entry) => ({
        event: { ...entry.summary },
        cursor: {
          receivedAt: entry.summary.receivedAt,
          eventId: entry.summary.eventId,
        },
      }));
  }

  async findEvent(
    connectorId: string,
    eventId: string,
  ): Promise<RelayEventSummary | undefined> {
    const stored = this.#events.find(
      (event) =>
        event.connectorId === connectorId && event.summary.eventId === eventId,
    );
    return stored === undefined ? undefined : { ...stored.summary };
  }

  async updateTaskProgress(
    connectorId: string,
    taskId: string,
    progress: RelayTaskProgress,
  ): Promise<boolean> {
    const stored = this.#events.find(
      (event) =>
        event.connectorId === connectorId &&
        event.summary.taskId === taskId &&
        event.summary.status !== "completed",
    );
    if (stored === undefined) return false;
    const now = receivedAt(this.#events.length + stored.summary.attemptCount);
    if (progress.status === "received") {
      stored.summary.receivedLocallyAt ??= now;
      if (stored.summary.status === "queued") stored.summary.status = "received";
    } else if (progress.status === "started") {
      stored.summary.receivedLocallyAt ??= now;
      stored.summary.startedAt ??= now;
      stored.summary.lastAttemptAt = now;
      stored.summary.attemptCount += 1;
      delete stored.summary.lastErrorCode;
      stored.summary.status = "running";
    } else {
      stored.summary.lastAttemptAt = now;
      stored.summary.lastErrorCode = progress.errorCode;
      stored.summary.status = "retrying";
    }
    return true;
  }

  async retireContextKey(connectorId: string, keyId: string): Promise<boolean> {
    const referenced = this.#tasks.some(
      (entry) =>
        entry.connectorId === connectorId &&
        entry.task.context.keyId === keyId &&
        !this.#acknowledged.has(taskKey(connectorId, entry.task.id)),
    );
    if (referenced) return false;
    this.#retiredKeys.add(contextKey(connectorId, keyId));
    return true;
  }

  async purgeAcknowledgedContext(_before: string): Promise<number> {
    return 0;
  }

  subscribe(connectorId: string, listener: () => void): () => void {
    const listeners = this.#listeners.get(connectorId) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(connectorId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
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

  publish(connectorId: string, task: RelayTask): void {
    this.#tasks.push({ connectorId, task });
    if (!this.#events.some((event) => event.summary.eventId === task.eventId)) {
      this.#events.push({
        connectorId,
        summary: {
          eventId: task.eventId,
          type: task.type,
          environment: task.environment,
          occurredAt: task.occurredAt,
          receivedAt: receivedAt(this.#events.length),
          status: "queued",
          attemptCount: 0,
          taskId: task.id,
        },
      });
    }
    for (const listener of this.#listeners.get(connectorId) ?? []) {
      queueMicrotask(listener);
    }
  }

  async health(): Promise<void> {
    if (this.healthError) {
      throw this.healthError;
    }
  }

  async close(): Promise<void> {
    this.#listeners.clear();
    this.#credentialListeners.clear();
  }

  #notifyCredentialChange(connectorId: string): void {
    for (const listener of this.#credentialListeners) {
      queueMicrotask(() => listener(connectorId));
    }
  }
}

function taskKey(connectorId: string, taskId: string): string {
  return `${connectorId}\0${taskId}`;
}

function contextKey(connectorId: string, keyId: string): string {
  return `${connectorId}\0${keyId}`;
}

function sameEnrollment(left: EnrollmentInput, right: EnrollmentInput): boolean {
  return (
    left.connectorId === right.connectorId &&
    left.repositoryKey === right.repositoryKey &&
    left.sourceTokenHash === right.sourceTokenHash &&
    left.connectorTokenHash === right.connectorTokenHash &&
    left.allowedEnvironments.length === right.allowedEnvironments.length &&
    left.allowedEnvironments.every(
      (environment, index) => environment === right.allowedEnvironments[index],
    )
  );
}

function receivedAt(index: number): string {
  return new Date(Date.UTC(2026, 7, 24, 12, 0, 0, index)).toISOString();
}

function compareEvents(left: RelayEventSummary, right: RelayEventSummary): number {
  return (
    left.receivedAt.localeCompare(right.receivedAt) ||
    left.eventId.localeCompare(right.eventId)
  );
}

function beforeCursor(
  event: RelayEventSummary,
  cursor: RelayEventCursor,
): boolean {
  return (
    event.receivedAt < cursor.receivedAt ||
    (event.receivedAt === cursor.receivedAt && event.eventId < cursor.eventId)
  );
}
