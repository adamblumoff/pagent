export const relayEventStatuses = [
  "suppressed",
  "queued",
  "received",
  "running",
  "retrying",
  "completed",
] as const;

export type RelayEventStatus = (typeof relayEventStatuses)[number];

export const relayEventErrorCodes = [
  "policy_rejected",
  "context_unavailable",
  "codex_failed",
  "connector_stopped",
  "unknown",
] as const;

export type RelayEventErrorCode = (typeof relayEventErrorCodes)[number];

export interface RelayEventSummary {
  eventId: string;
  type: string;
  environment: string;
  occurredAt: string;
  receivedAt: string;
  status: RelayEventStatus;
  attemptCount: number;
  taskId?: string | undefined;
  receivedLocallyAt?: string | undefined;
  startedAt?: string | undefined;
  lastAttemptAt?: string | undefined;
  lastErrorCode?: RelayEventErrorCode | undefined;
  completedAt?: string | undefined;
}

export interface RelayEventHistoryPage {
  events: RelayEventSummary[];
  nextCursor?: string | undefined;
}

interface RelayEventHistoryClientOptions {
  relayUrl: string;
  connectorId: string;
  token: string;
  fetch?: typeof fetch | undefined;
  timeoutMs?: number | undefined;
}

interface ListRelayEventHistoryOptions extends RelayEventHistoryClientOptions {
  limit: number;
  cursor?: string | undefined;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export async function listRelayEventHistory(
  options: ListRelayEventHistoryOptions,
): Promise<RelayEventHistoryPage> {
  if (
    !Number.isSafeInteger(options.limit) ||
    options.limit < 1 ||
    options.limit > 100
  ) {
    throw new Error("Pagent event history limit must be between 1 and 100.");
  }
  const url = eventHistoryUrl(options);
  url.searchParams.set("limit", String(options.limit));
  if (options.cursor !== undefined) {
    url.searchParams.set("cursor", options.cursor);
  }
  const body = await requestHistory(url, options);
  const root = record(body);
  if (
    root?.version !== 1 ||
    !Array.isArray(root.events) ||
    (root.nextCursor !== undefined && !nonempty(root.nextCursor))
  ) {
    throw invalidHistoryResponse();
  }
  const events = root.events.map(eventSummary);
  return {
    events,
    ...(root.nextCursor === undefined
      ? {}
      : { nextCursor: root.nextCursor as string }),
  };
}

export async function getRelayEventHistory(
  options: RelayEventHistoryClientOptions & { eventId: string },
): Promise<RelayEventSummary | undefined> {
  const eventId = options.eventId.trim();
  if (eventId === "") {
    throw new Error("Pagent event ID must not be empty.");
  }
  const url = eventHistoryUrl(options);
  url.pathname = `${url.pathname}/${encodeURIComponent(eventId)}`;
  const body = await requestHistory(url, options, true);
  if (body === undefined) {
    return undefined;
  }
  const root = record(body);
  if (root?.version !== 1 || root.event === undefined) {
    throw invalidHistoryResponse();
  }
  return eventSummary(root.event);
}

function eventHistoryUrl(options: RelayEventHistoryClientOptions): URL {
  const connectorId = options.connectorId.trim();
  const token = options.token.trim();
  if (connectorId === "") {
    throw new Error("Pagent connector ID is required to read event history.");
  }
  if (token === "") {
    throw new Error("Pagent connector token is required to read event history.");
  }
  return new URL(
    `/v1/connectors/${encodeURIComponent(connectorId)}/event-history`,
    options.relayUrl,
  );
}

async function requestHistory(
  url: URL,
  options: RelayEventHistoryClientOptions,
  allowNotFound = false,
): Promise<unknown | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Pagent event history timeout must be positive.");
  }
  const request = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await request(url, {
      method: "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${options.token.trim()}`,
        "cache-control": "no-store",
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(
        `Pagent event history request timed out after ${timeoutMs}ms. ` +
          "Run `pagent doctor`, then retry the command.",
        { cause: error },
      );
    }
    throw new Error(
      "Pagent could not reach the relay for event history. " +
        "Run `pagent doctor`, then retry the command.",
      { cause: error },
    );
  } finally {
    clearTimeout(timeout);
  }

  if (allowNotFound && response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(
      `Pagent relay event history failed with HTTP ${response.status}. ` +
        "Run `pagent doctor`, then retry the command.",
    );
  }
  try {
    return await response.json();
  } catch (error) {
    throw new Error(
      "Pagent relay returned invalid event history JSON. Update the relay and retry the command.",
      { cause: error },
    );
  }
}

function eventSummary(value: unknown): RelayEventSummary {
  const event = record(value);
  if (
    event === undefined ||
    !nonempty(event.eventId) ||
    !nonempty(event.type) ||
    !nonempty(event.environment) ||
    !isoDate(event.occurredAt) ||
    !isoDate(event.receivedAt) ||
    !relayStatus(event.status) ||
    !Number.isSafeInteger(event.attemptCount) ||
    (event.attemptCount as number) < 0 ||
    !optionalString(event.taskId) ||
    !optionalIsoDate(event.receivedLocallyAt) ||
    !optionalIsoDate(event.startedAt) ||
    !optionalIsoDate(event.lastAttemptAt) ||
    !optionalErrorCode(event.lastErrorCode) ||
    !optionalIsoDate(event.completedAt)
  ) {
    throw invalidHistoryResponse();
  }
  return {
    eventId: event.eventId,
    type: event.type,
    environment: event.environment,
    occurredAt: event.occurredAt,
    receivedAt: event.receivedAt,
    status: event.status,
    attemptCount: event.attemptCount as number,
    ...(event.taskId === undefined ? {} : { taskId: event.taskId }),
    ...(event.receivedLocallyAt === undefined
      ? {}
      : { receivedLocallyAt: event.receivedLocallyAt }),
    ...(event.startedAt === undefined ? {} : { startedAt: event.startedAt }),
    ...(event.lastAttemptAt === undefined
      ? {}
      : { lastAttemptAt: event.lastAttemptAt }),
    ...(event.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: event.lastErrorCode }),
    ...(event.completedAt === undefined
      ? {}
      : { completedAt: event.completedAt }),
  };
}

function invalidHistoryResponse(): Error {
  return new Error(
    "Pagent relay returned invalid event history. Update the relay and retry the command.",
  );
}

function relayStatus(value: unknown): value is RelayEventStatus {
  return relayEventStatuses.some((status) => status === value);
}

function optionalErrorCode(
  value: unknown,
): value is RelayEventErrorCode | undefined {
  return (
    value === undefined || relayEventErrorCodes.some((code) => code === value)
  );
}

function isoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function optionalIsoDate(value: unknown): value is string | undefined {
  return value === undefined || isoDate(value);
}

function optionalString(value: unknown): value is string | undefined {
  return value === undefined || nonempty(value);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
