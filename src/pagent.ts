import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import { createRelayEmitter, type RelayEmitter } from "./relay.js";
import type {
  AgentAdapter,
  ErrorObservation,
  EventDefinition,
  ObserveErrorOptions,
  ObserveOptions,
  ObserveResultOptions,
  PagentEvent,
  PagentOptions,
  ResultObservation,
} from "./types.js";

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  );
}

export class Pagent {
  readonly #agent: AgentAdapter | undefined;
  readonly #cwd: string;
  readonly #enabled: boolean;
  readonly #environment: string | undefined;
  readonly #inFlightEvents = new Set<EventDefinition<unknown>>();
  readonly #lastTriggeredAt = new Map<EventDefinition<unknown>, number>();
  readonly #onAgentResult: PagentOptions["onAgentResult"];
  readonly #onError: PagentOptions["onError"];
  readonly #pending = new Set<Promise<void>>();
  readonly #relay: RelayEmitter | undefined;

  constructor(options: PagentOptions) {
    this.#agent = options.agent;
    this.#relay =
      options.relay === undefined ? undefined : createRelayEmitter(options.relay);
    this.#cwd = resolve(options.cwd ?? process.cwd());
    this.#enabled = options.enabled === true;
    this.#environment = options.environment?.trim() || undefined;
    this.#onAgentResult = options.onAgentResult;
    this.#onError = options.onError;

    if (this.#enabled && this.#agent === undefined && this.#relay === undefined) {
      throw new Error("Pagent requires an agent or relay when enabled.");
    }
    if (this.#agent !== undefined && this.#relay !== undefined) {
      throw new Error("Pagent accepts either an agent or relay, not both.");
    }
  }

  observe<
    TThis,
    TArgs extends unknown[],
    TResult,
    TPayload,
  >(
    fn: (this: TThis, ...args: TArgs) => TResult,
    options: ObserveOptions<TArgs, Awaited<TResult>, TPayload>,
  ): (this: TThis, ...args: TArgs) => TResult {
    const pagent = this;

    return function observed(this: TThis, ...args: TArgs): TResult {
      try {
        const result = fn.apply(this, args);

        if (isPromiseLike(result)) {
          return result.then(
            (value) => {
              if (options.on !== "error") {
                pagent.#scheduleResult(options, {
                  args,
                  result: value as Awaited<TResult>,
                });
              }
              return value;
            },
            (error: unknown) => {
              if (options.on === "error") {
                pagent.#scheduleError(options, { args, error });
              }
              throw error;
            },
          ) as TResult;
        }

        if (options.on !== "error") {
          pagent.#scheduleResult(options, {
            args,
            result: result as Awaited<TResult>,
          });
        }
        return result;
      } catch (error) {
        if (options.on === "error") {
          pagent.#scheduleError(options, { args, error });
        }
        throw error;
      }
    };
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.allSettled(this.#pending);
    }
  }

  #scheduleResult<TArgs extends unknown[], TResult, TPayload>(
    options: ObserveResultOptions<TArgs, TResult, TPayload>,
    observation: ResultObservation<TArgs, TResult>,
  ): void {
    this.#schedule(options, observation);
  }

  #scheduleError<TArgs extends unknown[], TPayload>(
    options: ObserveErrorOptions<TArgs, TPayload>,
    observation: ErrorObservation<TArgs>,
  ): void {
    this.#schedule(options, observation);
  }

  #schedule<TObservation, TPayload>(
    options: {
      event: EventDefinition<TPayload>;
      when(observation: TObservation): boolean | Promise<boolean>;
      context(observation: TObservation): TPayload | Promise<TPayload>;
    },
    observation: TObservation,
  ): void {
    if (!this.#shouldObserve(options.event)) {
      return;
    }

    let task: Promise<void>;
    task = Promise.resolve()
      .then(() => this.#dispatch(options, observation))
      .catch((error: unknown) => this.#reportError(error))
      .finally(() => this.#pending.delete(task));
    this.#pending.add(task);
  }

  #shouldObserve(event: EventDefinition<unknown>): boolean {
    return (
      this.#enabled &&
      this.#environment !== undefined &&
      (event.enabledIn === undefined ||
        event.enabledIn.includes(this.#environment))
    );
  }

  async #dispatch<TObservation, TPayload>(
    options: {
      event: EventDefinition<TPayload>;
      when(observation: TObservation): boolean | Promise<boolean>;
      context(observation: TObservation): TPayload | Promise<TPayload>;
    },
    observation: TObservation,
  ): Promise<void> {
    if (!(await options.when(observation))) {
      return;
    }

    const now = Date.now();
    const cooldownMs = options.event.cooldownMs ?? 0;
    const lastTriggeredAt = this.#lastTriggeredAt.get(options.event);

    if (
      this.#inFlightEvents.has(options.event) ||
      (cooldownMs > 0 &&
        lastTriggeredAt !== undefined &&
        now - lastTriggeredAt < cooldownMs)
    ) {
      return;
    }

    this.#inFlightEvents.add(options.event);

    try {
      const payload = await options.context(observation);
      const event: PagentEvent<TPayload> = {
        id: randomUUID(),
        type: options.event.name,
        environment: this.#environment!,
        occurredAt: new Date(now).toISOString(),
        payload,
      };
      if (this.#relay !== undefined) {
        await this.#relay(event);
      } else {
        const prompt = options.event.prompt;
        if (prompt === undefined) {
          throw new Error(
            `Pagent event ${options.event.name} requires a prompt when using an agent.`,
          );
        }
        const result = await this.#agent!.run({
          cwd: this.#cwd,
          prompt: await prompt(event),
          event,
        });

        if (this.#onAgentResult !== undefined) {
          await this.#onAgentResult(result, event);
        }
      }
    } finally {
      this.#lastTriggeredAt.set(options.event, Date.now());
      this.#inFlightEvents.delete(options.event);
    }
  }

  #reportError(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Pagent callbacks must not affect the observed application.
    }
  }
}

export function createPagent(options: PagentOptions): Pagent {
  return new Pagent(options);
}
