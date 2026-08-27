import type {
  DeliveryTransportRequest,
  DeliveryTransportResponse,
  EncryptedPagentEvent,
  EndpointOptions,
  EventEnvelope,
  PagentDeliveryError,
  PagentDeliveryErrorCode,
} from "./types.js";
import { EVENT_PROTOCOL_VERSION } from "./version.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ENVELOPE_BYTES = 64 * 1024;

export type EndpointEmitter = (event: EncryptedPagentEvent) => Promise<void>;

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

export function createEndpointEmitter(options: EndpointOptions): EndpointEmitter {
  const url = requireHttpUrl(options.url);
  const token = options.token.trim();
  const timeoutMs = positiveInteger(
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    "endpoint.timeoutMs",
  );
  const maxEnvelopeBytes = positiveInteger(
    options.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE_BYTES,
    "endpoint.maxEnvelopeBytes",
  );

  if (token.length === 0 || /[\r\n]/u.test(token)) {
    throw new Error("Pagent endpoint token is required.");
  }
  if (
    options.transport !== undefined &&
    typeof options.transport !== "function"
  ) {
    throw new Error("Pagent endpoint transport must be a function.");
  }

  return async (event) => {
    const envelope: EventEnvelope = {
      version: EVENT_PROTOCOL_VERSION,
      event,
    };
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
    const byteLength = new TextEncoder().encode(body).byteLength;

    if (byteLength > maxEnvelopeBytes) {
      throw deliveryError(
        "payload_too_large",
        `Pagent event is ${byteLength} bytes; the limit is ${maxEnvelopeBytes} bytes.`,
        false,
      );
    }

    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;

    try {
      const request: DeliveryTransportRequest = {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body,
      };
      const delivery =
        options.transport === undefined
          ? nativeTransport(url, request, controller.signal)
          : options.transport(url.toString(), request);
      const response = await Promise.race([
        delivery,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            controller.abort();
            reject(
              deliveryError(
                "timeout",
                `Pagent endpoint delivery timed out after ${timeoutMs}ms.`,
                false,
              ),
            );
          }, timeoutMs);
        }),
      ]);

      if (!response.ok) {
        throw deliveryError(
          "endpoint_rejected",
          `Pagent endpoint rejected the event with HTTP ${response.status}.`,
          false,
          undefined,
          response.status,
        );
      }
    } catch (error) {
      if (isDeliveryError(error)) {
        throw error;
      }
      throw deliveryError(
        "network",
        "Pagent could not reach the endpoint.",
        false,
        error,
      );
    } finally {
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
    }
  };
}

async function nativeTransport(
  url: URL,
  request: DeliveryTransportRequest,
  signal: AbortSignal,
): Promise<DeliveryTransportResponse> {
  if (typeof globalThis.fetch !== "function") {
    throw new Error(
      "This runtime does not provide fetch; configure endpoint.transport.",
    );
  }
  return globalThis.fetch(url, { ...request, signal });
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
    value === "endpoint_rejected" ||
    value === "timeout" ||
    value === "network"
  );
}

function requireHttpUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Pagent endpoint URL must be a valid HTTP or HTTPS URL.");
  }
  const loopback =
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]" ||
    url.hostname === "localhost";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "Pagent endpoint URL must use HTTPS, except for an HTTP loopback address, and must not contain credentials or a fragment.",
    );
  }
  return url;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Pagent ${name} must be a positive integer.`);
  }
  return value;
}
