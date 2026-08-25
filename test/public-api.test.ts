import { describe, expect, it } from "vitest";

import * as cloudSdk from "../src/index.js";
import * as localConnector from "../src/connector-entry.js";
import type { ObserveResultOptions } from "../src/index.js";

type CloudExports = typeof import("../src/index.js");

// @ts-expect-error Codex execution belongs to the Pagent CLI.
type RootMustNotExportCodex = CloudExports["codexAgent"];

type ConnectorExports = typeof import("../src/connector-entry.js");

// @ts-expect-error Connector process lifecycle belongs to the Pagent CLI.
type ConnectorMustNotExportFactory = ConnectorExports["createRelayConnector"];

// @ts-expect-error Direct Codex execution belongs to the Pagent CLI.
type ConnectorMustNotExportCodex = ConnectorExports["codexAgent"];

const typedEvent = cloudSdk.defineEvent<{ reason: string }>({
  name: "typed.failed",
});

const validObservation = {
  event: typedEvent,
  on: "result",
  triggerWhen: () => true,
  context: () => ({ reason: "expected" }),
} satisfies ObserveResultOptions<[], string, { reason: string }>;

void validObservation;

const invalidObservation = {
  event: typedEvent,
  on: "result",
  triggerWhen: () => true,
  // @ts-expect-error The event's declared payload shape must match context.
  context: () => ({ statusCode: 500 }),
} satisfies ObserveResultOptions<[], string, { reason: string }>;

void invalidObservation;

const bigintEvent = cloudSdk.defineEvent<{ value: bigint }>({
  name: "typed.bigint",
});

const invalidBigintContext = {
  event: bigintEvent,
  on: "result",
  triggerWhen: () => true,
  // @ts-expect-error BigInt cannot be preserved in JSON event context.
  context: () => ({ value: 1n }),
} satisfies ObserveResultOptions<[], string, { value: bigint }>;

void invalidBigintContext;

describe("public API boundaries", () => {
  it("keeps the cloud entry point minimal", () => {
    expect(Object.keys(cloudSdk).sort()).toEqual([
      "createPagent",
      "defineEvent",
    ]);
  });

  it("limits the connector entry point to configuration", () => {
    expect(Object.keys(localConnector)).toEqual(["defineConnectorConfig"]);
  });
});
