export const PAGENT_VERSION = "0.1.0";
export const EVENT_PROTOCOL_VERSION = 2;
export const RELAY_PROTOCOL_VERSION = 1;
export const SUPPORTED_RELAY_PROTOCOL = {
  min: RELAY_PROTOCOL_VERSION,
  max: RELAY_PROTOCOL_VERSION,
} as const;

export interface RelayMetadata {
  version: 1;
  serviceVersion: string;
  relayProtocol: number;
  eventProtocol: {
    min: number;
    max: number;
  };
}

export function parseRelayMetadata(value: unknown): RelayMetadata | undefined {
  if (!isRecord(value) || value.version !== 1) return undefined;
  if (
    typeof value.serviceVersion !== "string" ||
    value.serviceVersion.trim() === "" ||
    !isProtocolVersion(value.relayProtocol) ||
    !isRecord(value.eventProtocol) ||
    !isProtocolVersion(value.eventProtocol.min) ||
    !isProtocolVersion(value.eventProtocol.max) ||
    value.eventProtocol.min > value.eventProtocol.max
  ) {
    return undefined;
  }
  return {
    version: 1,
    serviceVersion: value.serviceVersion,
    relayProtocol: value.relayProtocol,
    eventProtocol: {
      min: value.eventProtocol.min,
      max: value.eventProtocol.max,
    },
  };
}

function isProtocolVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
