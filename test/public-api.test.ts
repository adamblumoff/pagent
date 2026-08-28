import { describe, expect, it } from "vitest";

import * as cloudSdk from "../src/index.js";
import * as localConnector from "../src/connector-entry.js";
import type {
  ObserveOptions,
  ObserveResultAndErrorOptions,
  ObserveResultOptions,
} from "../src/index.js";

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

const validResultAndErrorObservation = {
  event: typedEvent,
  on: ["result", "error"],
  triggerWhen: (observation) =>
    observation.kind === "error" || observation.result === "failed",
  context: (observation) => ({
    reason:
      observation.kind === "error" ? "request threw" : observation.result,
  }),
} satisfies ObserveResultAndErrorOptions<[], string, { reason: string }>;

void validResultAndErrorObservation;

const storedObservation: ObserveOptions<[], string, { reason: string }> =
  Math.random() < 0.5
    ? validObservation
    : {
        event: typedEvent,
        on: "error",
        triggerWhen: () => true,
        context: () => ({ reason: "request threw" }),
      };

const observedFromStoredOptions = cloudSdk
  .createPagent({})
  .observe(() => "ok", storedObservation);

void observedFromStoredOptions;

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
