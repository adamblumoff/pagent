import type {
  PagentDeliveryError,
  PagentDeliveryErrorCode,
  PagentEvent,
  RelayEventEnvelope,
  RelayOptions,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ENVELOPE_BYTES = 64 * 1024;

export type RelayEmitter = (event: PagentEvent) => Promise<void>;

export function asDeliveryError(error: unknown): PagentDeliveryError {
  if (isDeliveryError(error)) {
    return error;
  }
  return deliveryError(
    "event_preparation_failed",
    "Pagent could not prepare the event for delivery.",
    false,
    error,
  );
}

export function createRelayEmitter(options: RelayOptions): RelayEmitter {
  const url = requireHttpUrl(options.url);
  const token = options.token.trim();
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "relay.timeoutMs",
  );
  const maxEnvelopeBytes = positiveInteger(
    options.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES,
    "relay.maxEnvelopeBytes",
  );

  if (token.length === 0) {
    throw new Error("Pagent relay token is required.");
  }

  return async (event) => {
    const envelope: RelayEventEnvelope = { version: 1, event };
    let body: string;
    try {
      body = JSON.stringify(envelope);
    } catch (error) {
      throw deliveryError(
        "event_preparation_failed",
        "Pagent could not serialize the event for delivery.",
        false,
        error,
      );
    }
    const byteLength = Buffer.byteLength(body);

    if (byteLength > maxEnvelopeBytes) {
      throw deliveryError(
        "payload_too_large",
        `Pagent relay event is ${byteLength} bytes; the limit is ${maxEnvelopeBytes} bytes.`,
        false,
      );
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    timeout.unref();

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw deliveryError(
          "relay_rejected",
          `Pagent relay rejected the event with HTTP ${response.status}.`,
          response.status === 408 ||
            response.status === 429 ||
            response.status >= 500,
          undefined,
          response.status,
        );
      }
    } catch (error) {
      if (isDeliveryError(error)) {
        throw error;
      }
      if (controller.signal.aborted) {
        throw deliveryError(
          "timeout",
          `Pagent relay delivery timed out after ${timeoutMs}ms.`,
          true,
          error,
        );
      }
      throw deliveryError(
        "network",
        "Pagent could not reach the relay.",
        true,
        error,
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}

function deliveryError(
  code: PagentDeliveryErrorCode,
  message: string,
  retryable: boolean,
  cause?: unknown,
  statusCode?: number,
): PagentDeliveryError {
  const error = new Error(message, cause === undefined ? {} : { cause });
  return Object.assign(error, {
    name: "PagentDeliveryError" as const,
    code,
    retryable,
    ...(statusCode === undefined ? {} : { statusCode }),
  });
}

function isDeliveryError(error: unknown): error is PagentDeliveryError {
  return (
    error instanceof Error &&
    error.name === "PagentDeliveryError" &&
    "code" in error &&
    isDeliveryErrorCode(error.code) &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  );
}

function isDeliveryErrorCode(value: unknown): value is PagentDeliveryErrorCode {
  return (
    value === "event_preparation_failed" ||
    value === "payload_too_large" ||
    value === "relay_rejected" ||
    value === "timeout" ||
    value === "network"
  );
}

function requireHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pagent relay URL must be a valid HTTP or HTTPS URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Pagent relay URL must be a valid HTTP or HTTPS URL.");
  }
  return url;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Pagent ${name} must be a positive integer.`);
  }
  return value;
}
