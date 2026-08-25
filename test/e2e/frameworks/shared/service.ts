import {
  createPagent,
  defineEvent,
  type PagentClient,
  type PagentOptions,
} from "pagent";

const failureEvent = defineEvent<FixtureContext>({
  name: "fixture.failure",
  enabledIn: ["e2e"],
  investigation: { cooldownMs: 1_000 },
});

const errorEvent = defineEvent<FixtureContext>({
  name: "fixture.error",
  enabledIn: ["e2e"],
  investigation: { cooldownMs: 1_000 },
});

export interface FixtureContext {
  framework: string;
  route: string;
  message: string;
}

export interface FixtureResult {
  status: "unhealthy";
  statusCode: 503;
  framework: string;
  route: string;
}

export interface FixtureService {
  flush(): Promise<void>;
  healthy(): { status: "ok"; framework: string };
  fail(route?: string): FixtureResult;
  throw(route?: string): never;
}

export class FixtureFailure extends Error {
  constructor(framework: string, route: string) {
    super(`${framework} threw from ${route}`);
    this.name = "FixtureFailure";
  }
}

export function createFixtureService(
  framework: string,
  options: PagentOptions,
): FixtureService {
  const pagent = createPagent(options);
  const fail = pagent.observe<
    unknown,
    [route?: string],
    FixtureResult,
    FixtureContext
  >(
    (route = "failure"): FixtureResult => ({
      status: "unhealthy",
      statusCode: 503,
      framework,
      route,
    }),
    {
      event: failureEvent,
      on: "result",
      triggerWhen: ({ result }) => result.statusCode >= 500,
      group: ({ args }) => `${framework}:${args[0] ?? "failure"}`,
      context: ({ args }) => ({
        framework,
        route: args[0] ?? "failure",
        message: `${framework} reported failure`,
      }),
    },
  );
  const throwFailure = pagent.observe<
    unknown,
    [route?: string],
    never,
    FixtureContext
  >(
    (route = "throw"): never => {
      throw new FixtureFailure(framework, route);
    },
    {
      event: errorEvent,
      on: "error",
      triggerWhen: () => true,
      group: ({ args }) => `${framework}:${args[0] ?? "throw"}`,
      context: ({ args, error }) => ({
        framework,
        route: args[0] ?? "throw",
        message: error instanceof Error ? error.message : "unknown error",
      }),
    },
  );

  return {
    flush: () => pagent.flush(),
    healthy: () => ({ status: "ok", framework }),
    fail,
    throw: throwFailure,
  };
}

export function pagentOptions(config: {
  enabled?: string | undefined;
  environment?: string | undefined;
  encryptionKey?: string | undefined;
  encryptionKeyId?: string | undefined;
  relayToken?: string | undefined;
  relayUrl?: string | undefined;
}): PagentOptions {
  const enabled = config.enabled === "true";
  const environment = config.environment?.trim() || undefined;
  const active = enabled && environment !== undefined;

  return {
    enabled,
    environment,
    ...(active
      ? {
          encryption: {
            key: required(config.encryptionKey, "PAGENT_ENCRYPTION_KEY"),
            keyId: required(
              config.encryptionKeyId,
              "PAGENT_ENCRYPTION_KEY_ID",
            ),
          },
          relay: {
            timeoutMs: 5_000,
            token: required(config.relayToken, "PAGENT_RELAY_TOKEN"),
            url: required(config.relayUrl, "PAGENT_RELAY_URL"),
          },
        }
      : {}),
    onDeliveryError: (error) => {
      console.error("[pagent-e2e] relay delivery failed", error);
    },
  };
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed === "") {
    throw new Error(`${name} is required.`);
  }
  return trimmed;
}
