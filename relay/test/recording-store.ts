import type {
  EnrollmentInput,
  EnrollmentResult,
  EnqueueInput,
  EnqueueResult,
  RelayStore,
  RelayTask,
  SourceAuthorization,
} from "../src/types.js";

interface StoredTask {
  connectorId: string;
  task: RelayTask;
}

function enrollmentsEqual(
  left: EnrollmentInput,
  right: EnrollmentInput,
): boolean {
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
  readonly #tasks: StoredTask[] = [];
  healthError: Error | undefined;

  async initialize(): Promise<void> {}

  async enroll(input: EnrollmentInput): Promise<EnrollmentResult> {
    const existing = this.enrollments.find(
      (enrollment) => enrollment.connectorId === input.connectorId,
    );
    if (!existing) {
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
      return { status: "enrolled" };
    }
    return enrollmentsEqual(existing, input)
      ? { status: "existing" }
      : { status: "conflict" };
  }

  async findSource(
    sourceTokenHash: string,
  ): Promise<SourceAuthorization | undefined> {
    const enrollment = this.enrollments.find(
      (candidate) => candidate.sourceTokenHash === sourceTokenHash,
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
        enrollment.connectorTokenHash === connectorTokenHash,
    );
  }

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    this.enqueues.push(input);
    return (
      this.enqueueResults.shift() ?? {
        status: "queued",
        task: taskFor(input, String(this.enqueues.length)),
      }
    );
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
          entry.connectorId === connectorId && BigInt(entry.task.id) > cursor,
      )
      .slice(0, limit)
      .map((entry) => entry.task);
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

  publish(connectorId: string, task: RelayTask): void {
    this.#tasks.push({ connectorId, task });
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
  }
}
