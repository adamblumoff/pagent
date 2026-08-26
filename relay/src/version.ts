export const PAGENT_VERSION = "0.1.0-rc.1";
export const EVENT_PROTOCOL_VERSION = 2;
export const RELAY_PROTOCOL_VERSION = 1;

export const RELAY_METADATA = {
  version: 1,
  serviceVersion: PAGENT_VERSION,
  relayProtocol: RELAY_PROTOCOL_VERSION,
  eventProtocol: {
    min: EVENT_PROTOCOL_VERSION,
    max: EVENT_PROTOCOL_VERSION,
  },
} as const;
