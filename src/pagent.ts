import { randomUUID } from "node:crypto";

import {
  asDeliveryError,
  createRelayEmitter,
  type RelayEmitter,
} from "./relay.js";
import type {
  ErrorObservation,
  EventDefinition,
  ObserveErrorOptions,
  ObserveOptions,
  ObserveResultOptions,
  PagentClient,
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

function investigationGroup(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const group = value.trim();
  if (group === "" || group.length > 200) {
    throw new Error(
      "Pagent investigation group must be a non-empty string up to 200 characters.",
    );
  }
  return group;
}

class Pagent implements PagentClient {
  readonly #enabled: boolean;
  readonly #environment: string | undefined;
  readonly #onDeliveryError: PagentOptions["onDeliveryError"];
  readonly #pending = new Set<Promise<void>>();
  readonly #relay: RelayEmitter | undefined;

  constructor(options: PagentOptions) {
    this.#environment = options.environment?.trim() || undefined;
    this.#enabled = options.enabled === true && this.#environment !== undefined;
    this.#relay =
      !this.#enabled || options.relay === undefined
        ? undefined
        : createRelayEmitter(options.relay);
    this.#onDeliveryError = options.onDeliveryError;

    if (this.#enabled && this.#relay === undefined) {
      throw new Error("Pagent requires a relay when enabled.");
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
              if (options.on === "result") {
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

        if (options.on === "result") {
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

  async flush(): Promise<void> {
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
      triggerWhen(observation: TObservation): boolean | Promise<boolean>;
      group?(
        observation: TObservation,
      ): string | undefined | Promise<string | undefined>;
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
      triggerWhen(observation: TObservation): boolean | Promise<boolean>;
      group?(
        observation: TObservation,
      ): string | undefined | Promise<string | undefined>;
      context(observation: TObservation): TPayload | Promise<TPayload>;
    },
    observation: TObservation,
  ): Promise<void> {
    if (!(await options.triggerWhen(observation))) {
      return;
    }

    const now = Date.now();
    const group = investigationGroup(await options.group?.(observation));
    const payload = await options.context(observation);
    const investigation = {
      cooldownMs: options.event.investigation?.cooldownMs ?? 0,
      ...(group === undefined ? {} : { group }),
    };
    const event: PagentEvent<TPayload> = {
      id: randomUUID(),
      type: options.event.name,
      environment: this.#environment!,
      occurredAt: new Date(now).toISOString(),
      investigation,
      payload,
    };
    await this.#relay!(event);
  }

  #reportError(error: unknown): void {
    try {
      this.#onDeliveryError?.(asDeliveryError(error));
    } catch {
      // Pagent callbacks must not affect the observed application.
    }
  }
}

export function createPagent(options: PagentOptions): PagentClient {
  return new Pagent(options);
}
