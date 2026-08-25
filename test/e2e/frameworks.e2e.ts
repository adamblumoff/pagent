import { spawn, type ChildProcessByStdio } from "node:child_process";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { resolve } from "node:path";
import type { Readable } from "node:stream";

import { afterEach, describe, expect, it } from "vitest";

import type { RelayEventEnvelope } from "../../src/index.js";

const ROOT = resolve(import.meta.dirname, "../..");
const TEST_ENCRYPTION_KEY =
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const TEST_RELAY_TOKEN = "e2e-relay-token";
type FixtureProcess = ChildProcessByStdio<null, Readable, Readable>;
const children = new Set<FixtureProcess>();

interface CapturedRequest {
  authorization: string | undefined;
  body: string;
  envelope: RelayEventEnvelope;
  method: string | undefined;
  url: string | undefined;
}

interface FrameworkFixture {
  name: "fastify" | "hono" | "next";
  packageName: string;
}

const fixtures: readonly FrameworkFixture[] = [
  { name: "fastify", packageName: "@pagent/e2e-fastify" },
  { name: "next", packageName: "@pagent/e2e-next" },
  { name: "hono", packageName: "@pagent/e2e-hono" },
];

afterEach(async () => {
  await Promise.all([...children].map(stopFixture));
});

describe.each(fixtures)("$name framework fixture", (fixture) => {
  it("preserves HTTP behavior and sends encrypted relay events", async () => {
    const relay = await startRelayCapture();
    const port = await availablePort();
    const process = startFixture(fixture, port, relay.url);

    try {
      await waitForHealthy(process, port);

      const healthy = await getJson(port, "/healthy");
      expect(healthy).toEqual({
        status: 200,
        body: { status: "ok", framework: fixture.name },
      });
      await delay(100);
      expect(relay.requests).toHaveLength(0);

      const failure = await resolvesWithin(getJson(port, "/failure"), 2_000);
      expect(failure).toEqual({
        status: 503,
        body: {
          status: "unhealthy",
          statusCode: 503,
          framework: fixture.name,
          route: "failure",
        },
      });
      await waitForRequests(relay.requests, 1);
      expectRelayEvent(relay.requests[0], fixture.name, "fixture.failure", "failure");
      relay.releaseAll();

      const thrown = await resolvesWithin(getJson(port, "/throw"), 2_000);
      expect(thrown).toEqual({
        status: 500,
        body: {
          name: "FixtureFailure",
          message: `${fixture.name} threw from throw`,
          sameError: true,
        },
      });
      await waitForRequests(relay.requests, 2);
      expectRelayEvent(relay.requests[1], fixture.name, "fixture.error", "throw");
      relay.releaseAll();

      const burst = await resolvesWithin(getJson(port, "/burst"), 2_000);
      expect(burst).toEqual({
        status: 503,
        body: { status: "unhealthy", framework: fixture.name, count: 3 },
      });
      await waitForRequests(relay.requests, 5);
      for (const request of relay.requests.slice(2)) {
        expectRelayEvent(request, fixture.name, "fixture.failure", "burst");
      }
      relay.releaseAll();
    } finally {
      relay.releaseAll();
      await stopFixture(process);
      await relay.close();
    }
  });
});

function expectRelayEvent(
  request: CapturedRequest | undefined,
  framework: FrameworkFixture["name"],
  type: string,
  route: string,
): void {
  expect(request).toBeDefined();
  expect(request).toMatchObject({
    authorization: `Bearer ${TEST_RELAY_TOKEN}`,
    method: "POST",
    url: "/v1/events",
  });
  expect(request!.envelope).toMatchObject({
    version: 2,
    event: {
      type,
      environment: "e2e",
      investigation: {
        cooldownMs: 1_000,
        group: `${framework}:${route}`,
      },
      context: {
        algorithm: "A256GCM",
        keyId: "e2e-key",
      },
    },
  });
  expect(request!.envelope.event.context.iv).not.toBe("");
  expect(request!.envelope.event.context.ciphertext).not.toBe("");
  expect(request!.body).not.toContain(`${framework} reported failure`);
  expect(request!.body).not.toContain(`${framework} threw from ${route}`);
}

function startFixture(
  fixture: FrameworkFixture,
  port: number,
  relayUrl: string,
): FixtureProcess {
  const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const commonEnvironment = {
    ...process.env,
    PAGENT_ENABLED: "true",
    PAGENT_ENV: "e2e",
    PAGENT_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    PAGENT_ENCRYPTION_KEY_ID: "e2e-key",
    PAGENT_RELAY_TOKEN: TEST_RELAY_TOKEN,
    PAGENT_RELAY_URL: relayUrl,
    PORT: String(port),
  };
  const args =
    fixture.name === "hono"
      ? [
          "--filter",
          fixture.packageName,
          "exec",
          "wrangler",
          "dev",
          "--local",
          "--ip",
          "127.0.0.1",
          "--show-interactive-dev-session=false",
          "--port",
          String(port),
          "--var",
          "PAGENT_ENABLED:true",
          "--var",
          "PAGENT_ENV:e2e",
          "--var",
          `PAGENT_ENCRYPTION_KEY:${TEST_ENCRYPTION_KEY}`,
          "--var",
          "PAGENT_ENCRYPTION_KEY_ID:e2e-key",
          "--var",
          `PAGENT_RELAY_TOKEN:${TEST_RELAY_TOKEN}`,
          "--var",
          `PAGENT_RELAY_URL:${relayUrl}`,
        ]
      : ["--filter", fixture.packageName, "start"];
  const child = spawn(command, args, {
    cwd: ROOT,
    env: commonEnvironment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  return child;
}

async function waitForHealthy(
  child: FixtureProcess,
  port: number,
): Promise<void> {
  const output: string[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Fixture exited with ${child.exitCode}.\n${output.join("")}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthy`, {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // The process is still starting.
    }
    await delay(100);
  }
  throw new Error(`Fixture did not start.\n${output.join("")}`);
}

async function getJson(
  port: number,
  path: string,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    signal: AbortSignal.timeout(5_000),
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function startRelayCapture(): Promise<{
  close(): Promise<void>;
  releaseAll(): void;
  requests: CapturedRequest[];
  url: string;
}> {
  const pendingResponses: ServerResponse[] = [];
  const requests: CapturedRequest[] = [];
  const server = createServer(async (request, response) => {
    try {
      const body = await readBody(request);
      requests.push({
        authorization: request.headers.authorization,
        body,
        envelope: JSON.parse(body) as RelayEventEnvelope,
        method: request.method,
        url: request.url,
      });
      pendingResponses.push(response);
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Relay capture did not bind to a TCP port.");
  }
  return {
    requests,
    url: `http://127.0.0.1:${address.port}/v1/events`,
    releaseAll: () => {
      for (const response of pendingResponses.splice(0)) {
        response.writeHead(202).end();
      }
    },
    close: () =>
      new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      }),
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Could not allocate a TCP port.");
  }
  const { port } = address;
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
  return port;
}

async function waitForRequests(
  requests: readonly CapturedRequest[],
  count: number,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (requests.length < count && Date.now() < deadline) {
    await delay(20);
  }
  expect(requests).toHaveLength(count);
}

async function resolvesWithin<T>(
  promise: Promise<T>,
  milliseconds: number,
): Promise<T> {
  return Promise.race([
    promise,
    delay(milliseconds).then(() => {
      throw new Error(
        `Application response waited longer than ${milliseconds}ms for Pagent delivery.`,
      );
    }),
  ]);
}

async function stopFixture(
  child: FixtureProcess,
): Promise<void> {
  children.delete(child);
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await Promise.race([
    new Promise<void>((resolveExit) => child.once("exit", () => resolveExit())),
    delay(5_000).then(() => {
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
