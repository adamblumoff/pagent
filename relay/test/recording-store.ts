import type {
  EnqueueInput,
  EnqueueResult,
  RelayStore,
  RelayTask,
} from "../src/types.js";

interface StoredTask {
  connectorId: string;
  task: RelayTask;
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
  readonly enqueueResults: EnqueueResult[] = [];
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #tasks: StoredTask[] = [];
  healthError: Error | undefined;

  async initialize(): Promise<void> {}

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
