import type {
  PagentEvent,
  RelayEventEnvelope,
  RelayOptions,
} from "./types.js";

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_ENVELOPE_BYTES = 64 * 1024;

export type RelayEmitter = (event: PagentEvent) => Promise<void>;

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
    const body = JSON.stringify(envelope);
    const byteLength = Buffer.byteLength(body);

    if (byteLength > maxEnvelopeBytes) {
      throw new Error(
        `Pagent relay event is ${byteLength} bytes; the limit is ${maxEnvelopeBytes} bytes.`,
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
        throw new Error(`Pagent relay rejected the event with HTTP ${response.status}.`);
      }
    } finally {
      clearTimeout(timeout);
    }
  };
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
