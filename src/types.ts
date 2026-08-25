export interface PagentEvent<TPayload = unknown> {
  id: string;
  type: string;
  environment: string;
  occurredAt: string;
  payload: TPayload;
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

export interface EventDefinition<TPayload> {
  name: string;
  enabledIn?: readonly string[];
  cooldownMs?: number;
  prompt?(event: PagentEvent<TPayload>): string | Promise<string>;
}

export interface RelayOptions {
  url: string;
  token: string;
  timeoutMs?: number | undefined;
  maxEnvelopeBytes?: number | undefined;
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
  on?: "result";
  when(
    observation: ResultObservation<TArgs, TResult>,
  ): boolean | Promise<boolean>;
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
  when(observation: ErrorObservation<TArgs>): boolean | Promise<boolean>;
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

export interface PagentOptions {
  enabled?: boolean | undefined;
  environment?: string | undefined;
  cwd?: string | undefined;
  agent?: AgentAdapter | undefined;
  relay?: RelayOptions | undefined;
  onError?: ((error: unknown) => void) | undefined;
  onAgentResult?:
    | ((result: AgentResult, event: PagentEvent) => void | Promise<void>)
    | undefined;
}

export function defineEvent<TPayload>(
  definition: EventDefinition<TPayload>,
): EventDefinition<TPayload> {
  return definition;
}
