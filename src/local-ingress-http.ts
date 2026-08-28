import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { EncryptedContext, EventEnvelope } from "./types.js";
import { EVENT_PROTOCOL_VERSION } from "./version.js";

export class HttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
  }
}

export function parseEventEnvelope(value: unknown): EventEnvelope {
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
      context: encryptedContext(event.context),
    },
  };
}

export function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<string> {
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

export function sendJson(
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

export function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

export function tokensEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.byteLength === expectedBuffer.byteLength &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
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
