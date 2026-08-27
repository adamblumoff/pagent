import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  EVENT_PROTOCOL_VERSION,
  PAGENT_VERSION,
  parseRelayMetadata,
  RELAY_PROTOCOL_VERSION,
  SUPPORTED_RELAY_PROTOCOL,
} from "../src/version.js";

describe("release compatibility contract", () => {
  it("keeps the release and protocol values explicit", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    expect(PAGENT_VERSION).toBe(packageJson.version);
    expect(EVENT_PROTOCOL_VERSION).toBe(2);
    expect(RELAY_PROTOCOL_VERSION).toBe(1);
    expect(SUPPORTED_RELAY_PROTOCOL).toEqual({ min: 1, max: 1 });
  });

  it("accepts bounded relay metadata", () => {
    expect(
      parseRelayMetadata({
        version: 1,
        serviceVersion: "0.1.0",
        relayProtocol: 1,
        eventProtocol: { min: 2, max: 2 },
      }),
    ).toEqual({
      version: 1,
      serviceVersion: "0.1.0",
      relayProtocol: 1,
      eventProtocol: { min: 2, max: 2 },
    });
  });

  it.each([
    null,
    {},
    { version: 2 },
    {
      version: 1,
      serviceVersion: "",
      relayProtocol: 1,
      eventProtocol: { min: 2, max: 2 },
    },
    {
      version: 1,
      serviceVersion: "0.1.0",
      relayProtocol: 0,
      eventProtocol: { min: 2, max: 2 },
    },
    {
      version: 1,
      serviceVersion: "0.1.0",
      relayProtocol: 1,
      eventProtocol: { min: 3, max: 2 },
    },
  ])("rejects malformed metadata", (value) => {
    expect(parseRelayMetadata(value)).toBeUndefined();
  });
});
