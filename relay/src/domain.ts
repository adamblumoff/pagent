import type { EventEnvelope, SourceRoute } from "./types.js";

const MAX_NAME_LENGTH = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > MAX_NAME_LENGTH
  ) {
    throw new Error(`${name} must be a non-empty string up to ${MAX_NAME_LENGTH} characters`);
  }
  return value;
}

export function parseEventEnvelope(value: unknown): EventEnvelope {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.event)) {
    throw new Error("body must contain version 1 and an event object");
  }
  const event = value.event;
  if (!("payload" in event)) {
    throw new Error("event.payload is required");
  }
  const occurredAt = boundedString(event.occurredAt, "event.occurredAt");
  if (Number.isNaN(Date.parse(occurredAt))) {
    throw new Error("event.occurredAt must be an ISO-8601 timestamp");
  }

  return {
    version: 1,
    event: {
      id: boundedString(event.id, "event.id"),
      type: boundedString(event.type, "event.type"),
      environment: boundedString(event.environment, "event.environment"),
      occurredAt,
      payload: event.payload,
    },
  };
}

export function assertEnvironmentAllowed(
  source: SourceRoute,
  environment: string,
): void {
  if (!source.allowedEnvironments.includes(environment)) {
    throw new Error(`environment ${environment} is not enabled for this source`);
  }
}

export function buildPrompt(
  source: SourceRoute,
  event: EventEnvelope["event"],
): string {
  const payload = JSON.stringify(event.payload, null, 2) ?? "null";
  return [
    `Investigate a ${event.environment} ${event.type} event in repository ${source.repositoryKey}.`,
    "Use the local checkout provided as your working directory; do not inspect a remote copy of the repository.",
    "Find the root cause and report the supporting evidence. Do not modify files.",
    "",
    `Event ID: ${event.id}`,
    `Occurred at: ${event.occurredAt}`,
    "Event context:",
    payload,
  ].join("\n");
}
