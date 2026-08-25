import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import {
  assertEnvironmentAllowed,
  buildPrompt,
  parseEventEnvelope,
} from "./domain.js";
import type {
  ConnectorCredential,
  EventEnvelope,
  RelayConfig,
  RelayStore,
  RelayTask,
  SourceRoute,
} from "./types.js";

const MAX_BODY_BYTES = 256 * 1024;
const REPLAY_BATCH_SIZE = 100;
const MAX_SEQUENCE_ID = 9_223_372_036_854_775_807n;

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

function findSource(
  request: IncomingMessage,
  sources: readonly SourceRoute[],
): SourceRoute | undefined {
  const token = bearerToken(request);
  return sources.find((source) => tokensEqual(token, source.token));
}

function findConnector(
  request: IncomingMessage,
  connectorId: string,
  connectors: readonly ConnectorCredential[],
): ConnectorCredential | undefined {
  const token = bearerToken(request);
  return connectors.find(
    (connector) =>
      connector.id === connectorId && tokensEqual(token, connector.token),
  );
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
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
  if (
    result === undefined ||
    !/^(0|[1-9]\d*)$/.test(result) ||
    BigInt(result) > MAX_SEQUENCE_ID
  ) {
    throw new Error("Last-Event-ID must be a non-negative integer");
  }
  return result;
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
}) {
  const { config, store } = options;

  return createServer(async (request, response) => {
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

      if (request.method === "POST" && url.pathname === "/v1/events") {
        const source = findSource(request, config.sources);
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
          prompt: buildPrompt(source, envelope.event),
        });
        const body =
          "task" in result
            ? { status: result.status, taskId: result.task?.id }
            : { status: result.status };
        sendJson(response, result.status === "queued" ? 201 : 202, body);
        return;
      }

      const match =
        request.method === "GET"
          ? /^\/v1\/connectors\/([^/]+)\/events$/.exec(url.pathname)
          : null;
      if (match) {
        const connectorId = decodeURIComponent(match[1] ?? "");
        if (!findConnector(request, connectorId, config.connectors)) {
          sendJson(response, 401, { error: "unauthorized" });
          return;
        }
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
    }
  });
}
