import { describe, expect, it } from "vitest";

import * as cloudSdk from "../src/index.js";
import * as localConnector from "../src/connector.js";
import type { ObserveResultOptions } from "../src/index.js";

type CloudExports = typeof import("../src/index.js");

// @ts-expect-error Codex execution is local-only and must use pagent/connector.
type RootMustNotExportCodex = CloudExports["codexAgent"];

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

  it("exposes local runtime APIs from the connector entry point", () => {
    expect(localConnector).toMatchObject({
      codexAgent: expect.any(Function),
      createRelayConnector: expect.any(Function),
      defineConnectorConfig: expect.any(Function),
    });
  });
});
