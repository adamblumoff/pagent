import {
  createEventContextEncryptor,
  type EventContextEncryptor,
} from "./crypto.js";
import {
  asDeliveryError,
  createEndpointEmitter,
  type EndpointEmitter,
} from "./delivery.js";
import type {
  ErrorObservation,
  EventDefinition,
  JsonCompatible,
  ObserveErrorOptions,
  ObserveOptions,
  ObserveResultAndErrorOptions,
  ObserveResultOptions,
  PagentClient,
  PagentEventMetadata,
  PagentOptions,
  ResultObservation,
} from "./types.js";

const LOCAL_COOLDOWN_LIMIT = 1_000;

interface CooldownPreparationState {
  deliveryGeneration: number;
  pending: number;
}

interface CooldownPreparation {
  generation: number;
  state: CooldownPreparationState;
}

function isNativePromise(value: unknown): value is Promise<unknown> {
  return value instanceof Promise;
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
  readonly #encrypt: EventContextEncryptor | undefined;
  readonly #onDeliveryError: PagentOptions["onDeliveryError"];
  readonly #onDelivery: PagentOptions["onDelivery"];
  readonly #pending = new Set<Promise<void>>();
  readonly #inFlightCooldowns = new Set<string>();
  readonly #cooldownExpirations = new Map<string, number>();
  readonly #cooldownPreparations = new Map<
    string,
    CooldownPreparationState
  >();
  readonly #endpoint: EndpointEmitter | undefined;

  constructor(options: PagentOptions) {
    this.#environment = options.environment?.trim() || undefined;
    this.#enabled = options.enabled === true && this.#environment !== undefined;
    this.#encrypt =
      this.#enabled && options.encryption !== undefined
        ? createEventContextEncryptor(options.encryption)
        : undefined;
    this.#endpoint =
      !this.#enabled || options.endpoint === undefined
        ? undefined
        : createEndpointEmitter(options.endpoint);
    this.#onDeliveryError = options.onDeliveryError;
    this.#onDelivery = options.onDelivery;

    if (this.#enabled && this.#endpoint === undefined) {
      throw new Error("Pagent requires an endpoint when enabled.");
    }
    if (this.#enabled && this.#encrypt === undefined) {
      throw new Error("Pagent requires encryption when enabled.");
    }
  }

  observe<TThis, TArgs extends unknown[], TResult, TPayload>(
    fn: (this: TThis, ...args: TArgs) => TResult,
    options: ObserveResultAndErrorOptions<
      TArgs,
      Awaited<TResult>,
      TPayload
    >,
  ): (this: TThis, ...args: TArgs) => TResult;
  observe<TThis, TArgs extends unknown[], TResult, TPayload>(
    fn: (this: TThis, ...args: TArgs) => TResult,
    options: ObserveResultOptions<TArgs, Awaited<TResult>, TPayload>,
  ): (this: TThis, ...args: TArgs) => TResult;
  observe<TThis, TArgs extends unknown[], TResult, TPayload>(
    fn: (this: TThis, ...args: TArgs) => TResult,
    options: ObserveErrorOptions<TArgs, TPayload>,
  ): (this: TThis, ...args: TArgs) => TResult;
  observe<TThis, TArgs extends unknown[], TResult, TPayload>(
    fn: (this: TThis, ...args: TArgs) => TResult,
    options: ObserveOptions<TArgs, Awaited<TResult>, TPayload>,
  ): (this: TThis, ...args: TArgs) => TResult;
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

        if (isNativePromise(result)) {
          return result.then(
            (value) => {
              pagent.#scheduleResult(options, {
                kind: "result",
                args,
                result: value as Awaited<TResult>,
              });
              return value;
            },
            (error: unknown) => {
              pagent.#scheduleError(options, { kind: "error", args, error });
              throw error;
            },
          ) as TResult;
        }

        pagent.#scheduleResult(options, {
          kind: "result",
          args,
          result: result as Awaited<TResult>,
        });
        return result;
      } catch (error) {
        pagent.#scheduleError(options, { kind: "error", args, error });
        throw error;
      }
    };
  }

  async flush(): Promise<void> {
    const snapshot = [...this.#pending];
    await Promise.allSettled(snapshot);
  }

  #scheduleResult<TArgs extends unknown[], TResult, TPayload>(
    options: ObserveOptions<TArgs, TResult, TPayload>,
    observation: ResultObservation<TArgs, TResult>,
  ): void {
    if (options.on === "error") {
      return;
    }
    if (options.on === "result") {
      this.#schedule(options, observation);
      return;
    }
    this.#schedule(options, observation);
  }

  #scheduleError<TArgs extends unknown[], TResult, TPayload>(
    options: ObserveOptions<TArgs, TResult, TPayload>,
    observation: ErrorObservation<TArgs>,
  ): void {
    if (options.on === "result") {
      return;
    }
    if (options.on === "error") {
      this.#schedule(options, observation);
      return;
    }
    this.#schedule(options, observation);
  }

  #schedule<TObservation, TPayload>(
    options: {
      event: EventDefinition<TPayload>;
      triggerWhen(observation: TObservation): boolean | Promise<boolean>;
      group?(
        observation: TObservation,
      ): string | undefined | Promise<string | undefined>;
      context(
        observation: TObservation,
      ): JsonCompatible<TPayload> | Promise<JsonCompatible<TPayload>>;
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
      context(
        observation: TObservation,
      ): JsonCompatible<TPayload> | Promise<JsonCompatible<TPayload>>;
    },
    observation: TObservation,
  ): Promise<void> {
    if (!(await options.triggerWhen(observation))) {
      return;
    }

    const group = investigationGroup(await options.group?.(observation));
    const cooldownMs = options.event.investigation?.cooldownMs ?? 0;
    const cooldownKey =
      cooldownMs === 0
        ? undefined
        : JSON.stringify([
            options.event.name,
            this.#environment,
            group ?? null,
          ]);
    const now = Date.now();
    if (
      cooldownKey !== undefined &&
      !cooldownAvailable(
        this.#cooldownExpirations,
        this.#inFlightCooldowns,
        cooldownKey,
        now,
      )
    ) {
      return;
    }

    const investigation = {
      cooldownMs,
      ...(group === undefined ? {} : { group }),
    };
    const preparation =
      cooldownKey === undefined
        ? undefined
        : beginCooldownPreparation(this.#cooldownPreparations, cooldownKey);
    try {
      const payload = await options.context(observation);
      if (
        preparation !== undefined &&
        preparation.state.deliveryGeneration !== preparation.generation
      ) {
        return;
      }
      if (
        cooldownKey !== undefined &&
        !reserveCooldown(
          this.#cooldownExpirations,
          this.#inFlightCooldowns,
          cooldownKey,
          Date.now(),
        )
      ) {
        return;
      }
      try {
        const metadata: PagentEventMetadata = {
          id: crypto.randomUUID(),
          type: options.event.name,
          environment: this.#environment!,
          occurredAt: new Date(now).toISOString(),
          investigation,
        };
        const event = {
          ...metadata,
          context: await this.#encrypt!(metadata, payload),
        };
        await this.#endpoint!(event);
        if (cooldownKey !== undefined) {
          rememberCooldown(
            this.#cooldownExpirations,
            cooldownKey,
            Date.now(),
            cooldownMs,
          );
          preparation!.state.deliveryGeneration += 1;
        }
        try {
          this.#onDelivery?.({
            eventId: metadata.id,
            deliveredAt: new Date().toISOString(),
          });
        } catch {
          // Pagent callbacks must not affect the observed application.
        }
      } finally {
        if (cooldownKey !== undefined) {
          this.#inFlightCooldowns.delete(cooldownKey);
        }
      }
    } finally {
      if (cooldownKey !== undefined && preparation !== undefined) {
        endCooldownPreparation(
          this.#cooldownPreparations,
          cooldownKey,
          preparation.state,
        );
      }
    }
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

function rememberCooldown(
  expirations: Map<string, number>,
  key: string,
  deliveredAt: number,
  cooldownMs: number,
): void {
  const expiresAt = Math.min(
    Number.MAX_SAFE_INTEGER,
    deliveredAt + cooldownMs,
  );
  expirations.delete(key);
  expirations.set(key, expiresAt);
}

function beginCooldownPreparation(
  preparations: Map<string, CooldownPreparationState>,
  key: string,
): CooldownPreparation {
  const state = preparations.get(key) ?? {
    deliveryGeneration: 0,
    pending: 0,
  };
  state.pending += 1;
  preparations.set(key, state);
  return { generation: state.deliveryGeneration, state };
}

function endCooldownPreparation(
  preparations: Map<string, CooldownPreparationState>,
  key: string,
  state: CooldownPreparationState,
): void {
  state.pending -= 1;
  if (state.pending === 0 && preparations.get(key) === state) {
    preparations.delete(key);
  }
}

function pruneExpiredCooldowns(
  expirations: Map<string, number>,
  now: number,
): void {
  for (const [storedKey, storedExpiresAt] of expirations) {
    if (storedExpiresAt <= now) {
      expirations.delete(storedKey);
    }
  }
}

function cooldownAvailable(
  expirations: Map<string, number>,
  inFlight: Set<string>,
  key: string,
  now: number,
): boolean {
  const expiresAt = expirations.get(key);
  if (inFlight.has(key) || (expiresAt !== undefined && expiresAt > now)) {
    return false;
  }
  if (expirations.size + inFlight.size < LOCAL_COOLDOWN_LIMIT) {
    return true;
  }
  pruneExpiredCooldowns(expirations, now);
  return expirations.size + inFlight.size < LOCAL_COOLDOWN_LIMIT;
}

function reserveCooldown(
  expirations: Map<string, number>,
  inFlight: Set<string>,
  key: string,
  now: number,
): boolean {
  if (!cooldownAvailable(expirations, inFlight, key, now)) {
    return false;
  }
  inFlight.add(key);
  return true;
}
