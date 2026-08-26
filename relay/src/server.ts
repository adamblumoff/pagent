import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import type { PagentClient } from "pagent";

import {
  assertEnvironmentAllowed,
  parseEnrollment,
  parseEnrollmentCodeRequest,
  parseEventEnvelope,
} from "./domain.js";
import { observeRelayRequests } from "./observability.js";
import { relayTaskErrorCodes } from "./types.js";
import { RELAY_METADATA } from "./version.js";
import type {
  ConnectorCredential,
  EventEnvelope,
  RelayConfig,
  RelayEventCursor,
  RelayEventSummary,
  RelayStore,
  RelayTask,
  RelayTaskProgress,
  SourceAuthorization,
  SourceRoute,
} from "./types.js";

const MAX_BODY_BYTES = 256 * 1024;
const REPLAY_BATCH_SIZE = 100;
const MAX_SEQUENCE_ID = 9_223_372_036_854_775_807n;
const MAX_RETENTION_SWEEP_MS = 60 * 60 * 1_000;
const DEFAULT_EVENT_HISTORY_LIMIT = 20;
const MAX_EVENT_HISTORY_LIMIT = 100;
const MAX_CURSOR_LENGTH = 1_024;

function bearerToken(request: IncomingMessage): string | undefined {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) {
    return undefined;
  }
  return header.slice("Bearer ".length);
}

function tokensEqual(actual: string | undefined, expected: string): boolean {
  if (actual === undefined) {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

async function findSource(
  request: IncomingMessage,
  sources: readonly SourceRoute[],
  store: RelayStore,
): Promise<SourceAuthorization | undefined> {
  const token = bearerToken(request);
  if (token === undefined) {
    return undefined;
  }
  const source = sources.find((candidate) =>
    tokensEqual(token, candidate.token),
  );
  if (source) {
    return {
      repositoryKey: source.repositoryKey,
      connectorId: source.connectorId,
      allowedEnvironments: source.allowedEnvironments,
    };
  }
  return store.findSource(tokenHash(token));
}

async function connectorIsAuthorized(
  request: IncomingMessage,
  connectorId: string,
  connectors: readonly ConnectorCredential[],
  store: RelayStore,
): Promise<boolean> {
  const token = bearerToken(request);
  if (token === undefined) {
    return false;
  }
  const connector = connectors.find(
    (connector) =>
      connector.id === connectorId && tokensEqual(token, connector.token),
  );
  if (connector) {
    return true;
  }
  return store.authorizeConnector(connectorId, tokenHash(token));
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function adminIsAuthorized(
  request: IncomingMessage,
  response: ServerResponse,
  adminToken: string | undefined,
): boolean {
  if (adminToken === undefined) {
    sendJson(response, 404, { error: "not found" });
    return false;
  }
  if (!tokensEqual(bearerToken(request), adminToken)) {
    sendJson(response, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("request body exceeds 256 KiB");
    }
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("request body must be valid JSON");
  }
}

function lastEventId(request: IncomingMessage): string {
  const value = request.headers["last-event-id"] ?? "0";
  const result = Array.isArray(value) ? value[0] : value;
  if (result === undefined || !isSequenceId(result, true)) {
    throw new Error("Last-Event-ID must be a non-negative integer");
  }
  return result;
}

function isSequenceId(value: string, allowZero = false): boolean {
  return (
    (allowZero ? /^(0|[1-9]\d*)$/u : /^[1-9]\d*$/u).test(value) &&
    BigInt(value) <= MAX_SEQUENCE_ID
  );
}

function eventHistoryLimit(url: URL): number {
  const value = url.searchParams.get("limit");
  if (value === null) return DEFAULT_EVENT_HISTORY_LIMIT;
  if (!/^[1-9]\d*$/u.test(value)) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  const limit = Number(value);
  if (limit > MAX_EVENT_HISTORY_LIMIT) {
    throw new Error("limit must be an integer from 1 to 100");
  }
  return limit;
}

function encodeEventCursor(event: RelayEventCursor): string {
  return Buffer.from(
    JSON.stringify([event.receivedAt, event.eventId]),
  ).toString("base64url");
}

function decodeEventCursor(value: string | null): RelayEventCursor | undefined {
  if (value === null) return undefined;
  if (
    value.length === 0 ||
    value.length > MAX_CURSOR_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("cursor is invalid");
  }
  try {
    const decoded: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    );
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      typeof decoded[0] !== "string" ||
      new Date(decoded[0]).toISOString() !== decoded[0] ||
      typeof decoded[1] !== "string" ||
      decoded[1].length === 0 ||
      decoded[1].length > 200
    ) {
      throw new Error("invalid cursor fields");
    }
    return { receivedAt: decoded[0], eventId: decoded[1] };
  } catch {
    throw new Error("cursor is invalid");
  }
}

function parseTaskProgress(value: unknown): RelayTaskProgress {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("progress must be an object");
  }
  const progress = value as Record<string, unknown>;
  const allowedKeys = new Set(["version", "status", "errorCode"]);
  if (Object.keys(progress).some((key) => !allowedKeys.has(key))) {
    throw new Error("progress contains an unexpected field");
  }
  if (
    progress.version !== 1 ||
    !["received", "started", "retrying"].includes(String(progress.status))
  ) {
    throw new Error("progress version or status is invalid");
  }
  const status = progress.status as RelayTaskProgress["status"];
  if (status === "retrying") {
    if (
      typeof progress.errorCode !== "string" ||
      !relayTaskErrorCodes.includes(
        progress.errorCode as (typeof relayTaskErrorCodes)[number],
      )
    ) {
      throw new Error("retrying progress requires a supported error code");
    }
    return {
      status,
      errorCode: progress.errorCode as (typeof relayTaskErrorCodes)[number],
    };
  }
  if (progress.errorCode !== undefined) {
    throw new Error("only retrying progress may include an error code");
  }
  return { status };
}

function writeTask(response: ServerResponse, task: RelayTask): void {
  response.write(`id: ${task.id}\n`);
  response.write("event: task\n");
  response.write(`data: ${JSON.stringify(task)}\n\n`);
}

function streamTasks(
  request: IncomingMessage,
  response: ServerResponse,
  store: RelayStore,
  connectorId: string,
  initialLastEventId: string,
  heartbeatMs: number,
): void {
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write("retry: 3000\n\n");

  let closed = false;
  let cursor = initialLastEventId;
  let pumping = false;
  let pumpAgain = false;

  const pump = async (): Promise<void> => {
    if (pumping) {
      pumpAgain = true;
      return;
    }
    pumping = true;
    try {
      do {
        pumpAgain = false;
        let batch: RelayTask[];
        do {
          batch = await store.tasksAfter(connectorId, cursor, REPLAY_BATCH_SIZE);
          for (const task of batch) {
            if (closed) {
              return;
            }
            writeTask(response, task);
            cursor = task.id;
          }
        } while (batch.length === REPLAY_BATCH_SIZE);
      } while (pumpAgain && !closed);
    } catch (error) {
      console.error("SSE task delivery failed", error);
      response.destroy(error instanceof Error ? error : undefined);
    } finally {
      pumping = false;
    }
  };

  const unsubscribe = store.subscribe(connectorId, () => void pump());
  const heartbeat = setInterval(() => {
    if (!closed) {
      response.write(": heartbeat\n\n");
    }
  }, heartbeatMs);
  heartbeat.unref();

  const close = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };
  request.once("aborted", close);
  response.once("close", close);
  void pump();
}

export function createRelayServer(options: {
  config: RelayConfig;
  store: RelayStore;
  pagent?: PagentClient;
}) {
  const { config, store } = options;
  const streams = new Map<string, Set<ServerResponse>>();
  const credentialChanged = (connectorId: string): void => {
    const targets =
      connectorId === "*"
        ? [...streams.values()].flatMap((responses) => [...responses])
        : [...(streams.get(connectorId) ?? [])];
    for (const response of targets) response.destroy();
  };
  const unsubscribeCredentialChanges =
    store.subscribeCredentialChanges(credentialChanged);
  const sweepAcknowledgedContext = (): void => {
    const before = new Date(
      Date.now() - config.acknowledgedContextRetentionMs,
    ).toISOString();
    void store.purgeExpiredContext(before).catch((error: unknown) => {
      console.error("Acknowledged context cleanup failed", error);
    });
  };
  const retentionSweep = setInterval(
    sweepAcknowledgedContext,
    Math.min(
      config.acknowledgedContextRetentionMs,
      MAX_RETENTION_SWEEP_MS,
    ),
  );
  retentionSweep.unref();

  const handleRequest = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", "http://relay.local");

      if (request.method === "GET" && url.pathname === "/health") {
        try {
          await store.health();
          sendJson(response, 200, { status: "ok" });
        } catch (error) {
          console.error("Relay health check failed", error);
          sendJson(response, 503, { status: "unavailable" });
        }
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/metadata") {
        sendJson(response, 200, RELAY_METADATA, {
          "cache-control": "public, max-age=300",
        });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/v1/admin/enrollment-codes"
      ) {
        if (!adminIsAuthorized(request, response, config.adminToken)) return;
        let enrollmentCodeRequest;
        try {
          enrollmentCodeRequest = parseEnrollmentCodeRequest(
            await readJson(request),
          );
        } catch (error) {
          sendJson(response, 400, {
            error:
              error instanceof Error ? error.message : "invalid expiration",
          });
          return;
        }
        const code = `pge_${randomBytes(32).toString("base64url")}`;
        const expiresAt = new Date(
          Date.now() + enrollmentCodeRequest.expiresInSeconds * 1_000,
        );
        await store.createEnrollmentCode({
          codeHash: tokenHash(code),
          expiresAt: expiresAt.toISOString(),
          ...(enrollmentCodeRequest.connectorId === undefined
            ? {}
            : { connectorId: enrollmentCodeRequest.connectorId }),
        });
        sendJson(
          response,
          201,
          { version: 1, code, expiresAt: expiresAt.toISOString() },
          { "cache-control": "no-store" },
        );
        return;
      }

      const revokeMatch =
        request.method === "DELETE"
          ? /^\/v1\/admin\/connectors\/([^/]+)$/.exec(url.pathname)
          : null;
      if (revokeMatch) {
        if (!adminIsAuthorized(request, response, config.adminToken)) return;
        const connectorId = decodeURIComponent(revokeMatch[1] ?? "");
        if (config.connectors.some(({ id }) => id === connectorId)) {
          sendJson(response, 409, {
            error: "static connector credentials must be removed from relay configuration",
          });
          return;
        }
        if (!(await store.revokeConnector(connectorId))) {
          sendJson(response, 404, { error: "connector not found" });
          return;
        }
        sendJson(response, 200, { status: "revoked", connectorId });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/enroll") {
        const code = bearerToken(request);
        if (!code) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        let enrollment;
        try {
          enrollment = parseEnrollment(await readJson(request));
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "invalid enrollment",
          });
          return;
        }
        if (config.connectors.some(({ id }) => id === enrollment.connectorId)) {
          sendJson(response, 409, {
            error: "connector ID is reserved by static relay configuration",
          });
          return;
        }
        const result = await store.enroll({
          codeHash: tokenHash(code),
          requestHash: tokenHash(
            JSON.stringify([
              enrollment.connectorId,
              enrollment.repositoryKey,
              enrollment.allowedEnvironments,
              enrollment.sourceTokenHash,
              enrollment.connectorTokenHash,
              enrollment.replace,
            ]),
          ),
          enrollment,
        });
        if (result.status === "invalid-code") {
          sendJson(response, 401, { error: "invalid or expired enrollment code" });
          return;
        }
        if (result.status === "conflict") {
          sendJson(response, 409, {
            error: enrollment.replace
              ? "connector rotation requires an existing dynamic connector"
              : "connector is already enrolled",
          });
          return;
        }
        sendJson(
          response,
          result.status === "enrolled" || result.status === "rotated"
            ? 201
            : 200,
          result,
          { "cache-control": "no-store" },
        );
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/events") {
        const source = await findSource(request, config.sources, store);
        if (!source) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        let envelope: EventEnvelope;
        try {
          envelope = parseEventEnvelope(await readJson(request));
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "invalid event",
          });
          return;
        }
        try {
          assertEnvironmentAllowed(source, envelope.event.environment);
        } catch (error) {
          sendJson(response, 422, {
            error: error instanceof Error ? error.message : "environment rejected",
          });
          return;
        }
        const result = await store.enqueue({
          source,
          event: envelope.event,
        });
        if (result.status === "retired-key") {
          sendJson(response, 409, { error: "context key has been retired" });
          return;
        }
        const body =
          "task" in result
            ? { status: result.status, taskId: result.task?.id }
            : { status: result.status };
        sendJson(response, result.status === "queued" ? 201 : 202, body);
        return;
      }

      const eventHistoryItemMatch =
        request.method === "GET"
          ? /^\/v1\/connectors\/([^/]+)\/event-history\/([^/]+)$/.exec(
              url.pathname,
            )
          : null;
      if (eventHistoryItemMatch) {
        const connectorId = decodeURIComponent(eventHistoryItemMatch[1] ?? "");
        const eventId = decodeURIComponent(eventHistoryItemMatch[2] ?? "");
        if (eventId === "" || eventId.length > 200) {
          sendJson(response, 400, { error: "event ID is invalid" });
          return;
        }
        if (
          !(await connectorIsAuthorized(
            request,
            connectorId,
            config.connectors,
            store,
          ))
        ) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        const eventSummary = await store.findEvent(connectorId, eventId);
        if (eventSummary === undefined) {
          sendJson(response, 404, { error: "event not found" });
          return;
        }
        sendJson(
          response,
          200,
          { version: 1, event: eventSummary },
          { "cache-control": "no-store" },
        );
        return;
      }

      const eventHistoryMatch =
        request.method === "GET"
          ? /^\/v1\/connectors\/([^/]+)\/event-history$/.exec(url.pathname)
          : null;
      if (eventHistoryMatch) {
        const connectorId = decodeURIComponent(eventHistoryMatch[1] ?? "");
        if (
          !(await connectorIsAuthorized(
            request,
            connectorId,
            config.connectors,
            store,
          ))
        ) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        let cursor: RelayEventCursor | undefined;
        let limit: number;
        try {
          cursor = decodeEventCursor(url.searchParams.get("cursor"));
          limit = eventHistoryLimit(url);
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "invalid pagination",
          });
          return;
        }
        const records = await store.eventsBefore(connectorId, cursor, limit + 1);
        const hasNextPage = records.length > limit;
        const page = records.slice(0, limit);
        const last = page.at(-1);
        sendJson(
          response,
          200,
          {
            version: 1,
            events: page.map((record) => record.event),
            ...(hasNextPage && last !== undefined
              ? { nextCursor: encodeEventCursor(last.cursor) }
              : {}),
          },
          { "cache-control": "no-store" },
        );
        return;
      }

      const progressMatch =
        request.method === "POST"
          ? /^\/v1\/connectors\/([^/]+)\/tasks\/([^/]+)\/progress$/.exec(
              url.pathname,
            )
          : null;
      if (progressMatch) {
        const connectorId = decodeURIComponent(progressMatch[1] ?? "");
        const taskId = decodeURIComponent(progressMatch[2] ?? "");
        if (!isSequenceId(taskId)) {
          sendJson(response, 400, { error: "task ID must be a positive integer" });
          return;
        }
        if (
          !(await connectorIsAuthorized(
            request,
            connectorId,
            config.connectors,
            store,
          ))
        ) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        let progress: RelayTaskProgress;
        try {
          progress = parseTaskProgress(await readJson(request));
        } catch (error) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : "invalid progress",
          });
          return;
        }
        if (!(await store.updateTaskProgress(connectorId, taskId, progress))) {
          sendJson(response, 404, { error: "pending task not found" });
          return;
        }
        sendJson(
          response,
          200,
          { version: 1, status: "recorded", taskId },
          { "cache-control": "no-store" },
        );
        return;
      }

      const acknowledgementMatch =
        request.method === "POST"
          ? /^\/v1\/connectors\/([^/]+)\/tasks\/([^/]+)\/ack$/.exec(
              url.pathname,
            )
          : null;
      if (acknowledgementMatch) {
        const connectorId = decodeURIComponent(acknowledgementMatch[1] ?? "");
        const taskId = decodeURIComponent(acknowledgementMatch[2] ?? "");
        if (!isSequenceId(taskId)) {
          sendJson(response, 400, { error: "task ID must be a positive integer" });
          return;
        }
        if (
          !(await connectorIsAuthorized(
            request,
            connectorId,
            config.connectors,
            store,
          ))
        ) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        if (!(await store.acknowledgeTask(connectorId, taskId))) {
          sendJson(response, 404, { error: "task not found" });
          return;
        }
        sendJson(
          response,
          200,
          { version: 1, status: "acknowledged", taskId },
          { "cache-control": "no-store" },
        );
        return;
      }

      const retirementMatch =
        request.method === "DELETE"
          ? /^\/v1\/connectors\/([^/]+)\/context-keys\/([^/]+)$/.exec(
              url.pathname,
            )
          : null;
      if (retirementMatch) {
        const connectorId = decodeURIComponent(retirementMatch[1] ?? "");
        const keyId = decodeURIComponent(retirementMatch[2] ?? "");
        if (keyId === "" || keyId !== keyId.trim() || keyId.length > 200) {
          sendJson(response, 400, { error: "context key ID is invalid" });
          return;
        }
        if (
          !(await connectorIsAuthorized(
            request,
            connectorId,
            config.connectors,
            store,
          ))
        ) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        if (!(await store.retireContextKey(connectorId, keyId))) {
          sendJson(response, 409, { error: "context key is still referenced" });
          return;
        }
        sendJson(
          response,
          200,
          { version: 1, status: "retired", keyId },
          { "cache-control": "no-store" },
        );
        return;
      }

      const match =
        request.method === "GET"
          ? /^\/v1\/connectors\/([^/]+)\/events$/.exec(url.pathname)
          : null;
      if (match) {
        const connectorId = decodeURIComponent(match[1] ?? "");
        const responses = streams.get(connectorId) ?? new Set();
        responses.add(response);
        streams.set(connectorId, responses);
        const unregister = (): void => {
          responses.delete(response);
          if (responses.size === 0) streams.delete(connectorId);
        };
        response.once("close", unregister);
        if (
          !(await connectorIsAuthorized(
            request,
            connectorId,
            config.connectors,
            store,
          ))
        ) {
          unregister();
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
        if (response.destroyed) return;
        let cursor: string;
        try {
          cursor = lastEventId(request);
        } catch (error) {
          sendJson(response, 400, {
            error:
              error instanceof Error ? error.message : "invalid Last-Event-ID",
          });
          return;
        }
        streamTasks(
          request,
          response,
          store,
          connectorId,
          cursor,
          config.heartbeatMs,
        );
        return;
      }

      sendJson(response, 404, { error: "not found" });
    } catch (error) {
      console.error("Relay request failed", error);
      if (!response.headersSent) {
        sendJson(response, 500, { error: "internal server error" });
      } else {
        response.destroy(error instanceof Error ? error : undefined);
      }
      throw error;
    }
  };
  const observedRequest = observeRelayRequests(options.pagent, handleRequest);
  const server = createServer((request, response) => {
    void observedRequest(request, response).catch(() => {
      // handleRequest already returned or closed the response.
    });
  });
  server.once("close", () => {
    clearInterval(retentionSweep);
    unsubscribeCredentialChanges();
  });
  return server;
}
