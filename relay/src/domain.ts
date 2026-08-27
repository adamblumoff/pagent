import type {
  EncryptedContext,
  EnrollmentInput,
  EventEnvelope,
  SourceAuthorization,
} from "./types.js";
import { EVENT_PROTOCOL_VERSION } from "./version.js";

const MAX_NAME_LENGTH = 200;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const unexpected = Object.keys(value).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new Error(`${name}.${unexpected} is not allowed`);
  }
}

function boundedString(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_NAME_LENGTH
  ) {
    throw new Error(
      `${name} must be a non-empty string up to ${MAX_NAME_LENGTH} characters`,
    );
  }
  return value;
}

function canonicalBoundedString(value: unknown, name: string): string {
  const result = boundedString(value, name);
  if (result !== result.trim()) {
    throw new Error(`${name} must not contain surrounding whitespace`);
  }
  return result;
}

function nonNegativeInteger(value: unknown, name: string): number {
  if (value === undefined) {
    return 0;
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function parseBase64Url(
  value: unknown,
  name: string,
): { encoded: string; bytes: Buffer } {
  if (
    typeof value !== "string" ||
    value === "" ||
    value.includes("=") ||
    value.length % 4 === 1 ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new Error(`${name} must be unpadded base64url`);
  }
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) {
    throw new Error(`${name} must be canonical unpadded base64url`);
  }
  return { encoded: value, bytes };
}

function parseEncryptedContext(value: unknown): EncryptedContext {
  if (!isRecord(value)) {
    throw new Error("event.context must be an object");
  }
  assertOnlyKeys(
    value,
    ["algorithm", "keyId", "iv", "ciphertext"],
    "event.context",
  );
  if (value.algorithm !== "A256GCM") {
    throw new Error("event.context.algorithm must be A256GCM");
  }
  const keyId = boundedString(value.keyId, "event.context.keyId");
  if (keyId !== keyId.trim()) {
    throw new Error("event.context.keyId must not contain surrounding whitespace");
  }
  const iv = parseBase64Url(value.iv, "event.context.iv");
  if (iv.bytes.length !== AES_GCM_IV_BYTES) {
    throw new Error(
      `event.context.iv must encode ${AES_GCM_IV_BYTES} bytes`,
    );
  }
  const ciphertext = parseBase64Url(
    value.ciphertext,
    "event.context.ciphertext",
  );
  if (ciphertext.bytes.length < AES_GCM_TAG_BYTES) {
    throw new Error(
      `event.context.ciphertext must include a ${AES_GCM_TAG_BYTES}-byte authentication tag`,
    );
  }
  return {
    algorithm: "A256GCM",
    keyId,
    iv: iv.encoded,
    ciphertext: ciphertext.encoded,
  };
}

export function parseEventEnvelope(value: unknown): EventEnvelope {
  if (
    !isRecord(value) ||
    value.version !== EVENT_PROTOCOL_VERSION ||
    !isRecord(value.event)
  ) {
    throw new Error(
      `body must contain version ${EVENT_PROTOCOL_VERSION} and an event object`,
    );
  }
  assertOnlyKeys(value, ["version", "event"], "body");
  const event = value.event;
  assertOnlyKeys(
    event,
    ["id", "type", "environment", "occurredAt", "investigation", "context"],
    "event",
  );
  const occurredAt = boundedString(event.occurredAt, "event.occurredAt");
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new Error("event.occurredAt must be an ISO-8601 timestamp");
  }
  const investigation = event.investigation ?? {};
  if (!isRecord(investigation)) {
    throw new Error("event.investigation must be an object");
  }
  assertOnlyKeys(
    investigation,
    ["cooldownMs", "group"],
    "event.investigation",
  );
  const cooldownMs = nonNegativeInteger(
    investigation.cooldownMs,
    "event.investigation.cooldownMs",
  );
  const group =
    investigation.group === undefined
      ? undefined
      : boundedString(
          investigation.group,
          "event.investigation.group",
        ).trim();

  return {
    version: EVENT_PROTOCOL_VERSION,
    event: {
      id: boundedString(event.id, "event.id"),
      type: boundedString(event.type, "event.type"),
      environment: boundedString(event.environment, "event.environment"),
      occurredAt,
      investigation: {
        cooldownMs,
        ...(group === undefined ? {} : { group }),
      },
      context: parseEncryptedContext(event.context),
    },
  };
}

export function parseEnrollment(value: unknown): EnrollmentInput {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("body must contain enrollment version 1");
  }
  assertOnlyKeys(
    value,
    [
      "version",
      "connectorId",
      "repositoryKey",
      "allowedEnvironments",
      "sourceTokenHash",
      "connectorTokenHash",
      "replace",
    ],
    "body",
  );
  if (
    !Array.isArray(value.allowedEnvironments) ||
    value.allowedEnvironments.length === 0
  ) {
    throw new Error("body.allowedEnvironments must be a non-empty string array");
  }
  const allowedEnvironments = value.allowedEnvironments.map(
    (environment, index) =>
      canonicalBoundedString(
        environment,
        `body.allowedEnvironments[${index}]`,
      ),
  );
  if (new Set(allowedEnvironments).size !== allowedEnvironments.length) {
    throw new Error("body.allowedEnvironments values must be unique");
  }
  const sourceTokenHash = parseBase64Url(
    value.sourceTokenHash,
    "body.sourceTokenHash",
  );
  const connectorTokenHash = parseBase64Url(
    value.connectorTokenHash,
    "body.connectorTokenHash",
  );
  if (sourceTokenHash.bytes.length !== 32) {
    throw new Error("body.sourceTokenHash must be a SHA-256 hash");
  }
  if (connectorTokenHash.bytes.length !== 32) {
    throw new Error("body.connectorTokenHash must be a SHA-256 hash");
  }
  if (sourceTokenHash.encoded === connectorTokenHash.encoded) {
    throw new Error("source and connector credentials must be different");
  }
  if (typeof value.replace !== "boolean") {
    throw new Error("body.replace must be a boolean");
  }
  return {
    connectorId: canonicalBoundedString(value.connectorId, "body.connectorId"),
    repositoryKey: canonicalBoundedString(
      value.repositoryKey,
      "body.repositoryKey",
    ),
    allowedEnvironments,
    sourceTokenHash: sourceTokenHash.encoded,
    connectorTokenHash: connectorTokenHash.encoded,
    replace: value.replace,
  };
}

export function parseEnrollmentCodeRequest(value: unknown): {
  expiresInSeconds: number;
  connectorId?: string | undefined;
} {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("body must contain enrollment-code version 1");
  }
  assertOnlyKeys(
    value,
    ["version", "expiresInSeconds", "connectorId"],
    "body",
  );
  const expiresInSeconds = value.expiresInSeconds ?? 900;
  if (
    typeof expiresInSeconds !== "number" ||
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds < 60 ||
    expiresInSeconds > 86_400
  ) {
    throw new Error("body.expiresInSeconds must be an integer from 60 to 86400");
  }
  return {
    expiresInSeconds,
    ...(value.connectorId === undefined
      ? {}
      : {
          connectorId: canonicalBoundedString(
            value.connectorId,
            "body.connectorId",
          ),
        }),
  };
}

export function assertEnvironmentAllowed(
  source: SourceAuthorization,
  environment: string,
): void {
  if (!source.allowedEnvironments.includes(environment)) {
    throw new Error(`environment ${environment} is not enabled for this source`);
  }
}
