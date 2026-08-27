import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createPagent,
  defineEvent,
  type PagentClient,
} from "pagent";

const relayRequestFailed = defineEvent<{
  method: string;
  path: string;
  error: {
    name: string;
    message: string;
    stack?: string;
  };
}>({
  name: "relay.request.failed",
  investigation: { cooldownMs: 5 * 60 * 1_000 },
});

type RelayRequestHandler = (
  request: IncomingMessage,
  response: ServerResponse,
) => Promise<void>;

export function createRelayPagent(
  env: NodeJS.ProcessEnv = process.env,
): PagentClient {
  const enabled = env.PAGENT_ENABLED === "true";
  const environment = env.PAGENT_ENV?.trim() || undefined;
  const active = enabled && environment !== undefined;

  return createPagent({
    enabled,
    environment,
    ...(active
      ? {
          encryption: {
            keyId: required(env, "PAGENT_ENCRYPTION_KEY_ID"),
            key: required(env, "PAGENT_ENCRYPTION_KEY"),
          },
          relay: {
            url: new URL(
              "/v1/events",
              required(env, "PAGENT_RELAY_URL"),
            ).toString(),
            token: required(env, "PAGENT_RELAY_TOKEN"),
          },
        }
      : {}),
    onDeliveryError: (error) =>
      console.error("[pagent] relay self-observation failed", error),
  });
}

export function observeRelayRequests(
  pagent: PagentClient | undefined,
  handler: RelayRequestHandler,
): RelayRequestHandler {
  if (pagent === undefined) return handler;

  return pagent.observe(handler, {
    event: relayRequestFailed,
    on: "error",
    triggerWhen: ({ args: [request] }) => requestPath(request) !== "/v1/events",
    group: ({ args: [request] }) => requestGroup(request),
    context: ({ args: [request], error }) => ({
      method: request.method ?? "UNKNOWN",
      path: requestPath(request),
      error: errorDetails(error),
    }),
  });
}

function requestGroup(request: IncomingMessage): string {
  const segments = requestPath(request).split("/").slice(0, 5);
  return `${request.method ?? "UNKNOWN"} ${segments.join("/")}`.slice(0, 200);
}

function requestPath(request: IncomingMessage): string {
  return new URL(request.url ?? "/", "http://relay.local").pathname;
}

function errorDetails(error: unknown): {
  name: string;
  message: string;
  stack?: string;
} {
  if (!(error instanceof Error)) {
    return { name: "UnknownError", message: String(error) };
  }
  return {
    name: error.name,
    message: error.message,
    ...(error.stack === undefined ? {} : { stack: error.stack }),
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required when Pagent is enabled`);
  return value;
}
