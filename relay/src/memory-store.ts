import type {
  EnqueueInput,
  EnqueueResult,
  RelayStore,
  RelayTask,
} from "./types.js";

interface StoredEvent {
  result: EnqueueResult;
}

interface StoredTask {
  task: RelayTask;
  connectorId: string;
  receivedAt: number;
}

export class MemoryRelayStore implements RelayStore {
  readonly #events = new Map<string, StoredEvent>();
  readonly #listeners = new Map<string, Set<() => void>>();
  readonly #tasks: StoredTask[] = [];
  #nextId = 1n;

  async initialize(): Promise<void> {}

  async enqueue(input: EnqueueInput): Promise<EnqueueResult> {
    const previous = this.#events.get(input.event.id);
    if (previous) {
      return previous.result.status === "queued"
        ? { status: "duplicate", task: previous.result.task }
        : { status: "duplicate" };
    }

    const receivedAt = Date.now();
    const { cooldownMs, group } = input.event.investigation;
    const cooldownStart = receivedAt - cooldownMs;
    const isCoolingDown =
      cooldownMs > 0 &&
      this.#tasks.some(
        (task) =>
          task.receivedAt > cooldownStart &&
          task.connectorId === input.source.connectorId &&
          task.task.repositoryKey === input.source.repositoryKey &&
          task.task.type === input.event.type &&
          task.task.environment === input.event.environment &&
          task.task.investigation.group === group,
      );

    if (isCoolingDown) {
      const result: EnqueueResult = { status: "cooldown" };
      this.#events.set(input.event.id, { result });
      return result;
    }

    const task: RelayTask = {
      id: String(this.#nextId++),
      type: input.event.type,
      environment: input.event.environment,
      occurredAt: input.event.occurredAt,
      investigation: input.event.investigation,
      repositoryKey: input.source.repositoryKey,
      prompt: input.prompt,
      payload: input.event.payload,
    };
    const storedTask: StoredTask = {
      task,
      connectorId: input.source.connectorId,
      receivedAt,
    };
    const result: EnqueueResult = { status: "queued", task };
    this.#tasks.push(storedTask);
    this.#events.set(input.event.id, { result });
    for (const listener of this.#listeners.get(storedTask.connectorId) ?? []) {
      queueMicrotask(listener);
    }
    return result;
  }

  async tasksAfter(
    connectorId: string,
    lastEventId: string,
    limit: number,
  ): Promise<RelayTask[]> {
    const after = BigInt(lastEventId);
    return this.#tasks
      .filter(
        (task) =>
          task.connectorId === connectorId && BigInt(task.task.id) > after,
      )
      .slice(0, limit)
      .map((task) => task.task);
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

  async health(): Promise<void> {}

  async close(): Promise<void> {
    this.#listeners.clear();
  }
}
