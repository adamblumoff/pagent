import { createServer } from "node:http";

import { createPagent, defineEvent } from "pagent";
import { checkHealth, type HealthResult } from "./health.js";

const port = readPositiveNumber("PORT", 3_000);
const enabled = process.env.PAGENT_ENABLED === "true";
const environment = process.env.PAGENT_ENV;
const active = enabled && Boolean(environment?.trim());
const triggerToken = requireEnvironment("DEMO_TRIGGER_TOKEN");

const healthFailed = defineEvent<HealthResult>({
  name: "health.failed",
  enabledIn: ["staging"],
});
const pagent = createPagent({
  enabled,
  environment,
  ...(active
    ? {
        encryption: {
          keyId: requireEnvironment("PAGENT_ENCRYPTION_KEY_ID"),
          key: requireEnvironment("PAGENT_ENCRYPTION_KEY"),
        },
        endpoint: {
          url: new URL(
            "/v1/events",
            requireEnvironment("PAGENT_ENDPOINT_URL"),
          ).toString(),
          token: requireEnvironment("PAGENT_SOURCE_TOKEN"),
        },
      }
    : {}),
  onDeliveryError: (error) =>
    console.error("[pagent] endpoint delivery failed", error),
});

const observedHealthCheck = pagent.observe(checkHealth, {
  event: healthFailed,
  on: "result",
  triggerWhen: ({ result }) => result.status === "unhealthy",
  context: ({ result }) => result,
});

const server = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/health") {
    respond(response, 200, { status: "ok" });
    return;
  }

  if (request.method === "POST" && request.url === "/demo/failure") {
    if (request.headers.authorization !== `Bearer ${triggerToken}`) {
      respond(response, 401, { error: "Unauthorized" });
      return;
    }
    const result = observeFailure();
    respond(response, 202, {
      accepted: true,
      result,
      note: "The application response does not wait for Pagent.",
    });
    return;
  }

  respond(response, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`[demo] listening on :${port}`);
});

async function shutdown(): Promise<void> {
  server.close();
  await pagent.flush();
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function observeFailure(): HealthResult {
  return observedHealthCheck(
    readPositiveNumber("SIMULATED_LATENCY_MS", 750),
    readPositiveNumber("HEALTH_THRESHOLD_MS", 500),
  );
}

function respond(
  response: import("node:http").ServerResponse,
  status: number,
  body: object,
): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(`${JSON.stringify(body)}\n`);
}

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function readPositiveNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
