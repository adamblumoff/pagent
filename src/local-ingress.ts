import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";

import type { AgentAdapter } from "./agent.js";
import {
  createEventContextDecryptor,
  type EventContextDecryptor,
} from "./crypto.js";
import type { ConnectorEncryptionConfig } from "./config.js";
import type {
  EncryptedContext,
  EncryptedPagentEvent,
  EventEnvelope,
  JsonValue,
  PagentEvent,
} from "./types.js";
import { EVENT_PROTOCOL_VERSION } from "./version.js";

const LOOPBACK_HOST = "127.0.0.1";
const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_STATE_LIMIT = 1_000;
const LIFECYCLE_TIMEOUT_MS = 500;

export type LocalIngressHost = "127.0.0.1" | "::1";

export interface LocalIngressSource {
  token: string;
  allowedEnvironments: readonly string[];
}

export interface LocalIngressRoute {
  repositoryKey: string;
}

export type LocalIngressStatus =
  | "received"
  | "thread-started"
  | "completed"
  | "failed"
  | "suppressed";

export interface LocalIngressLifecycleUpdate {
  status: LocalIngressStatus;
  occurredAt: string;
  reason?: "duplicate" | "cooldown" | undefined;
  errorCode?: "codex_failed" | "daemon_stopped" | undefined;
  errorMessage?: string | undefined;
  threadId?: string | undefined;
  threadName?: string | undefined;
}

export interface LocalIngressOptions {
  host?: LocalIngressHost | undefined;
  port?: number | undefined;
  environmentId: string;
  source: LocalIngressSource;
  repositories: Readonly<Record<string, string>>;
  encryption: ConnectorEncryptionConfig;
  agent: AgentAdapter;
  maxBodyBytes?: number | undefined;
  stateLimit?: number | undefined;
  now?: (() => number) | undefined;
  onLifecycle?: (
    update: LocalIngressLifecycleUpdate,
    event: EncryptedPagentEvent,
    route: LocalIngressRoute,
  ) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export interface LocalIngressServer {
  readonly host: LocalIngressHost;
  readonly port: number;
  readonly eventsUrl: string;
  readonly probeUrl: string;
  close(): Promise<void>;
}

interface PreparedOptions {
  host: LocalIngressHost;
  port: number;
  environmentId: string;
  source: LocalIngressSource;
  route: LocalIngressRoute;
  repositoryPath: string;
  decryptors: Map<string, EventContextDecryptor>;
  agent: AgentAdapter;
  maxBodyBytes: number;
  stateLimit: number;
  now: () => number;
  onLifecycle: LocalIngressOptions["onLifecycle"];
  onError: LocalIngressOptions["onError"];
}

class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

class LocalIngressHandler {
  readonly #abort = new AbortController();
  readonly #agent: AgentAdapter;
  readonly #cooldowns = new Map<string, number>();
  readonly #decryptors: Map<string, EventContextDecryptor>;
  readonly #dispatches = new Set<Promise<void>>();
  readonly #environmentId: string;
  readonly #maxBodyBytes: number;
  readonly #now: () => number;
  readonly #onError: LocalIngressOptions["onError"];
  readonly #onLifecycle: LocalIngressOptions["onLifecycle"];
  readonly #recentEventIds = new Map<string, true>();
  readonly #repositoryPath: string;
  readonly #route: LocalIngressRoute;
  readonly #source: LocalIngressSource;
  readonly #stateLimit: number;

  constructor(options: PreparedOptions) {
    this.#environmentId = options.environmentId;
    this.#source = options.source;
    this.#route = options.route;
    this.#repositoryPath = options.repositoryPath;
    this.#decryptors = options.decryptors;
    this.#agent = options.agent;
    this.#maxBodyBytes = options.maxBodyBytes;
    this.#stateLimit = options.stateLimit;
    this.#now = options.now;
    this.#onLifecycle = options.onLifecycle;
    this.#onError = options.onError;
  }

  async receive(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      if (request.url !== "/v1/events" && request.url !== "/v1/probe") {
        sendJson(response, 404, { error: "not found" });
        return;
      }
      if (request.method !== "POST") {
        sendJson(response, 405, { error: "method not allowed" }, { allow: "POST" });
        return;
      }

      if (!this.#authorized(request.headers.authorization)) {
        sendJson(response, 401, { error: "unauthorized" });
        return;
      }
      if (!isJsonContentType(request.headers["content-type"])) {
        sendJson(response, 415, { error: "content type must be application/json" });
        return;
      }

      const envelope = parseEventEnvelope(
        JSON.parse(await readBody(request, this.#maxBodyBytes)),
      );
      const event = envelope.event;
      if (!this.#source.allowedEnvironments.includes(event.environment)) {
        throw new HttpError(403, "event environment is not allowed");
      }

      const decrypt = this.#decryptors.get(event.context.keyId);
      if (decrypt === undefined) {
        throw new HttpError(422, "event context uses an unknown key");
      }
      const metadata = {
        id: event.id,
        type: event.type,
        environment: event.environment,
        occurredAt: event.occurredAt,
        investigation: event.investigation,
      };
      let payload: JsonValue;
      try {
        payload = await decrypt(metadata, event.context);
      } catch {
        throw new HttpError(422, "event context could not be decrypted");
      }

      if (request.url === "/v1/probe") {
        sendJson(response, 200, {
          version: 1,
          status: "ready",
          environmentId: this.#environmentId,
        });
        return;
      }

      if (this.#recentEventIds.has(event.id)) {
        sendJson(response, 202, { status: "duplicate", eventId: event.id });
        void this.#lifecycle(
          { status: "suppressed", reason: "duplicate" },
          event,
          this.#route,
        );
        return;
      }
      remember(this.#recentEventIds, event.id, true, this.#stateLimit);

      const acceptedAt = this.#now();
      const cooldownKey = JSON.stringify([
        this.#route.repositoryKey,
        event.type,
        event.environment,
        event.investigation.group ?? null,
      ]);
      const previousAcceptedAt = this.#cooldowns.get(cooldownKey);
      if (
        event.investigation.cooldownMs > 0 &&
        previousAcceptedAt !== undefined &&
        acceptedAt - previousAcceptedAt < event.investigation.cooldownMs
      ) {
        sendJson(response, 202, { status: "cooldown", eventId: event.id });
        void this.#lifecycle(
          { status: "suppressed", reason: "cooldown" },
          event,
          this.#route,
        );
        return;
      }
      remember(this.#cooldowns, cooldownKey, acceptedAt, this.#stateLimit);

      sendJson(response, 202, { status: "accepted", eventId: event.id });
      const dispatch = this.#dispatch(
        this.#route,
        event,
        { ...metadata, payload },
      )
        .catch((error) => this.#report(error))
        .finally(() => this.#dispatches.delete(dispatch));
      this.#dispatches.add(dispatch);
    } catch (error) {
      if (error instanceof SyntaxError) {
        sendJson(response, 400, { error: "body must contain valid JSON" });
        return;
      }
      if (error instanceof HttpError) {
        sendJson(response, error.statusCode, { error: error.message });
        return;
      }
      this.#report(error);
      sendJson(response, 500, { error: "local ingress failed" });
    }
  }

  async close(): Promise<void> {
    this.#abort.abort();
    await Promise.allSettled([...this.#dispatches]);
  }

  async #dispatch(
    route: LocalIngressRoute,
    encryptedEvent: EncryptedPagentEvent,
    event: PagentEvent,
  ): Promise<void> {
    await this.#lifecycle({ status: "received" }, encryptedEvent, route);
    let startedThread:
      | { threadId: string; threadName: string }
      | undefined;
    try {
      const threadName = investigationThreadName(route.repositoryKey, event);
      await this.#agent.run({
        cwd: this.#repositoryPath,
        prompt: investigationPrompt(route.repositoryKey, event),
        threadName,
        event,
        signal: this.#abort.signal,
        onThreadStarted: async (thread) => {
          startedThread = thread;
          await this.#lifecycle(
            {
              status: "thread-started",
              threadId: thread.threadId,
              threadName: thread.threadName,
            },
            encryptedEvent,
            route,
          );
        },
      });
      await this.#lifecycle(
        {
          status: "completed",
          ...(startedThread ?? {}),
        },
        encryptedEvent,
        route,
      );
    } catch (error) {
      await this.#lifecycle(
        {
          status: "failed",
          errorCode: this.#abort.signal.aborted
            ? "daemon_stopped"
            : "codex_failed",
          errorMessage: safeErrorMessage(error),
          ...(startedThread ?? {}),
        },
        encryptedEvent,
        route,
      );
      throw error;
    }
  }

  async #lifecycle(
    update: Omit<LocalIngressLifecycleUpdate, "occurredAt">,
    event: EncryptedPagentEvent,
    route: LocalIngressRoute,
  ): Promise<void> {
    if (this.#onLifecycle === undefined) return;
    await settleWithin(
      Promise.resolve().then(() =>
        this.#onLifecycle?.(
          { ...update, occurredAt: new Date(this.#now()).toISOString() },
          event,
          route,
        ),
      ),
      LIFECYCLE_TIMEOUT_MS,
    );
  }

  #authorized(authorization: string | undefined): boolean {
    if (!authorization?.startsWith("Bearer ")) return false;
    const actual = authorization.slice("Bearer ".length);
    return tokensEqual(actual, this.#source.token);
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Local callbacks cannot stop delivery or Codex execution.
    }
  }
}

export async function startLocalIngressServer(
  options: LocalIngressOptions,
): Promise<LocalIngressServer> {
  const prepared = prepareOptions(options);
  const handler = new LocalIngressHandler(prepared);
  const server = createServer((request, response) => {
    void handler.receive(request, response);
  });
  await listen(server, prepared.host, prepared.port);
  const address = server.address() as AddressInfo;
  const urlHost = prepared.host === "::1" ? "[::1]" : prepared.host;
  let closed = false;

  return {
    host: prepared.host,
    port: address.port,
    eventsUrl: `http://${urlHost}:${address.port}/v1/events`,
    probeUrl: `http://${urlHost}:${address.port}/v1/probe`,
    async close() {
      if (closed) return;
      closed = true;
      await closeServer(server);
      await handler.close();
    },
  };
}

function prepareOptions(options: LocalIngressOptions): PreparedOptions {
  const host = options.host ?? LOOPBACK_HOST;
  const port = options.port ?? 0;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const stateLimit = options.stateLimit ?? DEFAULT_STATE_LIMIT;
  if (host !== "127.0.0.1" && host !== "::1") {
    throw new Error("Local ingress host must be 127.0.0.1 or ::1.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Local ingress port must be an integer between 0 and 65535.");
  }
  requirePositiveInteger(maxBodyBytes, "body byte limit");
  requirePositiveInteger(stateLimit, "state limit");
  const repositories = new Map(
    Object.entries(options.repositories).map(([key, path]) => [key, resolve(path)]),
  );
  if (repositories.size !== 1) {
    throw new Error("Local ingress requires exactly one configured repository.");
  }
  const repositoryKey = repositories.keys().next().value!;
  const repositoryPath = repositories.get(repositoryKey)!;
  if (!trimmed(options.environmentId)) {
    throw new Error("Local ingress environment ID must be a non-empty string.");
  }
  if (!trimmed(options.source.token) || /[\r\n]/u.test(options.source.token)) {
    throw new Error("Local ingress source token must be a non-empty bearer token.");
  }
  if (
    options.source.allowedEnvironments.length === 0 ||
    !options.source.allowedEnvironments.every(trimmed) ||
    new Set(options.source.allowedEnvironments).size !==
      options.source.allowedEnvironments.length
  ) {
    throw new Error(
      "The local ingress source needs unique, non-empty allowed environments.",
    );
  }
  const source = {
    token: options.source.token,
    allowedEnvironments: [...options.source.allowedEnvironments],
  };
  const decryptors = new Map(
    Object.entries(options.encryption.keys).map(([keyId, key]) => [
      keyId,
      createEventContextDecryptor(key),
    ]),
  );
  if (decryptors.size === 0) {
    throw new Error("Local ingress requires at least one encryption key.");
  }
  if (typeof options.agent?.run !== "function") {
    throw new Error("Local ingress requires an agent.");
  }

  return {
    host,
    port,
    environmentId: options.environmentId,
    source,
    route: { repositoryKey },
    repositoryPath,
    decryptors,
    agent: options.agent,
    maxBodyBytes,
    stateLimit,
    now: options.now ?? Date.now,
    onLifecycle: options.onLifecycle,
    onError: options.onError,
  };
}

function parseEventEnvelope(value: unknown): EventEnvelope {
  const envelope = record(value);
  if (
    envelope === undefined ||
    envelope.version !== EVENT_PROTOCOL_VERSION ||
    !onlyKeys(envelope, ["version", "event"])
  ) {
    throw new HttpError(
      400,
      `body must contain only version ${EVENT_PROTOCOL_VERSION} and an event`,
    );
  }
  const event = record(envelope.event);
  if (
    event === undefined ||
    !onlyKeys(event, [
      "id",
      "type",
      "environment",
      "occurredAt",
      "investigation",
      "context",
    ])
  ) {
    throw new HttpError(400, "event has an invalid shape");
  }
  const investigation = record(event.investigation);
  if (
    investigation === undefined ||
    !onlyKeys(investigation, ["cooldownMs", "group"]) ||
    !Number.isSafeInteger(investigation.cooldownMs) ||
    (investigation.cooldownMs as number) < 0
  ) {
    throw new HttpError(400, "event investigation policy is invalid");
  }
  const group = investigation.group;
  if (group !== undefined && !boundedTrimmedString(group)) {
    throw new HttpError(400, "event investigation group is invalid");
  }
  const occurredAt = boundedTrimmed(event.occurredAt);
  if (
    occurredAt === undefined ||
    Number.isNaN(Date.parse(occurredAt)) ||
    new Date(occurredAt).toISOString() !== occurredAt
  ) {
    throw new HttpError(400, "event occurredAt must be an ISO timestamp");
  }
  const context = encryptedContext(event.context);

  return {
    version: EVENT_PROTOCOL_VERSION,
    event: {
      id: requireBoundedString(event.id, "event id"),
      type: requireBoundedString(event.type, "event type"),
      environment: requireBoundedString(event.environment, "event environment"),
      occurredAt,
      investigation: {
        cooldownMs: investigation.cooldownMs as number,
        ...(group === undefined ? {} : { group }),
      },
      context,
    },
  };
}

function encryptedContext(value: unknown): EncryptedContext {
  const context = record(value);
  if (
    context === undefined ||
    !onlyKeys(context, ["algorithm", "keyId", "iv", "ciphertext"]) ||
    context.algorithm !== "A256GCM" ||
    !boundedTrimmedString(context.keyId) ||
    typeof context.iv !== "string" ||
    !/^[A-Za-z0-9_-]{16}$/u.test(context.iv) ||
    typeof context.ciphertext !== "string" ||
    context.ciphertext.length < 22 ||
    !/^[A-Za-z0-9_-]+$/u.test(context.ciphertext)
  ) {
    throw new HttpError(400, "event context is invalid");
  }
  return {
    algorithm: "A256GCM",
    keyId: context.keyId,
    iv: context.iv,
    ciphertext: context.ciphertext,
  };
}

function investigationPrompt(repositoryKey: string, event: PagentEvent): string {
  return [
    `Investigate a ${event.environment} ${event.type} event in repository ${repositoryKey}.`,
    "Use the local checkout provided as your working directory; do not inspect a remote copy of the repository.",
    "Find the root cause and report the supporting evidence. Do not modify files.",
    "",
    `Event ID: ${event.id}`,
    `Occurred at: ${event.occurredAt}`,
    "Event context:",
    JSON.stringify(event.payload, null, 2),
  ].join("\n");
}

function investigationThreadName(
  repositoryKey: string,
  event: PagentEvent,
): string {
  const name = `Investigating ${event.type} in ${repositoryKey}`.replace(
    /\s+/gu,
    " ",
  );
  return name.length <= 200 ? name : `${name.slice(0, 197)}...`;
}

function readBody(request: IncomingMessage, limit: number): Promise<string> {
  const declaredLength = request.headers["content-length"];
  if (declaredLength !== undefined) {
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new HttpError(400, "content-length is invalid");
    }
    if (bytes > limit) {
      request.resume();
      throw new HttpError(413, `request body exceeds ${limit} bytes`);
    }
  }

  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    request.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.byteLength;
      if (bytes > limit) {
        settled = true;
        chunks.length = 0;
        rejectBody(new HttpError(413, `request body exceeds ${limit} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!settled) resolveBody(Buffer.concat(chunks).toString("utf8"));
    });
    request.on("aborted", () => {
      if (!settled) rejectBody(new HttpError(400, "request body was interrupted"));
    });
    request.on("error", (error) => {
      if (!settled) rejectBody(error);
    });
  });
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  if (response.headersSent) return;
  response.writeHead(statusCode, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function remember<TKey, TValue>(
  map: Map<TKey, TValue>,
  key: TKey,
  value: TValue,
  limit: number,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > limit) {
    const oldest = map.keys().next().value as TKey | undefined;
    if (oldest === undefined) return;
    map.delete(oldest);
  }
}

function boundedTrimmedString(value: unknown): value is string {
  return boundedTrimmed(value) !== undefined;
}

function boundedTrimmed(value: unknown): string | undefined {
  return typeof value === "string" &&
    value !== "" &&
    value === value.trim() &&
    value.length <= 200
    ? value
    : undefined;
}

function requireBoundedString(value: unknown, name: string): string {
  const parsed = boundedTrimmed(value);
  if (parsed === undefined) throw new HttpError(400, `${name} is invalid`);
  return parsed;
}

function onlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function trimmed(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim();
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Local ingress ${name} must be a positive integer.`);
  }
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown agent error.";
  return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]");
}

async function settleWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation.catch(() => undefined),
      new Promise<void>((resolveTimeout) => {
        timeout = setTimeout(resolveTimeout, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function listen(
  server: Server,
  host: LocalIngressHost,
  port: number,
): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose, rejectClose) => {
    server.close((error) => {
      if (error !== undefined) rejectClose(error);
      else resolveClose();
    });
    server.closeAllConnections();
  });
}
