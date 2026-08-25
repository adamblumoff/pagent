export type JsonPrimitive = boolean | number | string | null;

export type JsonValue =
  | JsonPrimitive
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * Maps an application type to the shape JSON can preserve. Unsupported values
 * become `never`, so event context fails at the call site instead of silently
 * losing data during serialization.
 */
export type JsonCompatible<T> =
  T extends JsonPrimitive
    ? T
    : T extends (...args: never[]) => unknown
      ? never
      : T extends readonly (infer TValue)[]
        ? readonly JsonCompatible<TValue>[]
        : T extends object
          ? { [TKey in keyof T]: JsonCompatible<T[TKey]> }
          : never;

export interface PagentEventMetadata {
  id: string;
  type: string;
  environment: string;
  occurredAt: string;
  investigation: InvestigationPolicy;
}

export interface PagentEvent<TPayload = JsonValue>
  extends PagentEventMetadata {
  payload: TPayload;
}

export interface InvestigationPolicy {
  cooldownMs: number;
  group?: string | undefined;
}

export interface AgentRequest<TPayload = unknown> {
  cwd: string;
  prompt: string;
  event: PagentEvent<TPayload>;
  signal?: AgentAbortSignal | undefined;
}

/** Runtime-neutral subset of AbortSignal used to cancel a local agent run. */
export interface AgentAbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

export interface AgentResult {
  threadId?: string;
  finalResponse?: string;
}

export interface AgentAdapter {
  run(request: AgentRequest): Promise<AgentResult>;
}

declare const eventPayload: unique symbol;

export interface EventDefinition<TPayload> {
  name: string;
  enabledIn?: readonly string[];
  investigation?: {
    cooldownMs?: number | undefined;
  } | undefined;
  readonly [eventPayload]?: () => TPayload;
}

export interface RelayOptions {
  url: string;
  token: string;
  transport?: RelayTransport | undefined;
  timeoutMs?: number | undefined;
  maxEnvelopeBytes?: number | undefined;
}

export interface RelayTransportRequest {
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface RelayTransportResponse {
  readonly ok: boolean;
  readonly status: number;
}

export type RelayTransport = (
  url: string,
  request: RelayTransportRequest,
) => Promise<RelayTransportResponse>;

export interface PagentEncryptionOptions {
  keyId: string;
  /** A raw 32-byte AES key encoded as unpadded base64url. */
  key: string;
}

export type PagentDeliveryErrorCode =
  | "event_preparation_failed"
  | "payload_too_large"
  | "relay_rejected"
  | "timeout"
  | "network";

export interface PagentDeliveryError extends Error {
  name: "PagentDeliveryError";
  code: PagentDeliveryErrorCode;
  retryable: boolean;
  statusCode?: number | undefined;
}

export interface EncryptedContext {
  algorithm: "A256GCM";
  keyId: string;
  iv: string;
  ciphertext: string;
}

export interface EncryptedRelayEvent extends PagentEventMetadata {
  context: EncryptedContext;
}

export interface RelayEventEnvelope {
  version: 2;
  event: EncryptedRelayEvent;
}

export interface ResultObservation<
  TArgs extends readonly unknown[],
  TResult,
> {
  args: TArgs;
  result: TResult;
}

export interface ErrorObservation<TArgs extends readonly unknown[]> {
  args: TArgs;
  error: unknown;
}

export interface ObserveResultOptions<
  TArgs extends readonly unknown[],
  TResult,
  TPayload,
> {
  event: EventDefinition<TPayload>;
  on: "result";
  triggerWhen(
    observation: ResultObservation<TArgs, TResult>,
  ): boolean | Promise<boolean>;
  group?(
    observation: ResultObservation<TArgs, TResult>,
  ): string | undefined | Promise<string | undefined>;
  context(
    observation: ResultObservation<TArgs, TResult>,
  ): JsonCompatible<TPayload> | Promise<JsonCompatible<TPayload>>;
}

export interface ObserveErrorOptions<
  TArgs extends readonly unknown[],
  TPayload,
> {
  event: EventDefinition<TPayload>;
  on: "error";
  triggerWhen(
    observation: ErrorObservation<TArgs>,
  ): boolean | Promise<boolean>;
  group?(
    observation: ErrorObservation<TArgs>,
  ): string | undefined | Promise<string | undefined>;
  context(
    observation: ErrorObservation<TArgs>,
  ): JsonCompatible<TPayload> | Promise<JsonCompatible<TPayload>>;
}

export type ObserveOptions<
  TArgs extends readonly unknown[],
  TResult,
  TPayload,
> =
  | ObserveResultOptions<TArgs, TResult, TPayload>
  | ObserveErrorOptions<TArgs, TPayload>;

export interface PagentClient {
  observe<TThis, TArgs extends unknown[], TResult, TPayload>(
    fn: (this: TThis, ...args: TArgs) => TResult,
    options: ObserveOptions<TArgs, Awaited<TResult>, TPayload>,
  ): (this: TThis, ...args: TArgs) => TResult;
  flush(): Promise<void>;
}

export interface PagentOptions {
  enabled?: boolean | undefined;
  environment?: string | undefined;
  relay?: RelayOptions | undefined;
  encryption?: PagentEncryptionOptions | undefined;
  onDeliveryError?: ((error: PagentDeliveryError) => void) | undefined;
}

export function defineEvent<TPayload = never>(
  definition: EventDefinition<TPayload>,
): EventDefinition<TPayload> {
  if (
    definition.name.trim() === "" ||
    definition.name !== definition.name.trim() ||
    definition.name.length > 200
  ) {
    throw new Error(
      "Pagent event name must be a trimmed, non-empty string up to 200 characters.",
    );
  }
  const cooldownMs = definition.investigation?.cooldownMs;
  if (
    cooldownMs !== undefined &&
    (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0)
  ) {
    throw new Error("Pagent event cooldownMs must be a non-negative integer.");
  }
  return definition;
}
