export interface PagentEvent<TPayload = unknown> {
  id: string;
  type: string;
  environment: string;
  occurredAt: string;
  investigation: InvestigationPolicy;
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
  timeoutMs?: number | undefined;
  maxEnvelopeBytes?: number | undefined;
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

export interface RelayEventEnvelope<TPayload = unknown> {
  version: 1;
  event: PagentEvent<TPayload>;
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
  ): TPayload | Promise<TPayload>;
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
  ): TPayload | Promise<TPayload>;
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
