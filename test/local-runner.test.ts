import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  requestLocalControl,
  type LocalDaemonStatus,
} from "../src/local-control.js";
import { runLocalConnector } from "../src/local-runner.js";
import { localStatePaths, readDaemonMetadata } from "../src/local-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("local connector runner", () => {
  it("reports ready only after SSE connects and stops through local control", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/v1/connectors/local/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write(": connected\n\n");
        return;
      }
      response.writeHead(404).end();
    });
    server.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test relay did not bind to a port.");
    }

    const directory = await temporaryDirectory();
    const paths = localStatePaths({ stateDirectory: join(directory, "state") });
    let readyStatus: LocalDaemonStatus | undefined;
    const runner = runLocalConnector({
      config: {
        relay: {
          url: `http://127.0.0.1:${address.port}`,
          token: "connector-token",
          connectorId: "local",
        },
        repositories: { pagent: process.cwd() },
        environments: ["staging"],
        encryption: {
          keys: {
            current: Buffer.alloc(32, 1).toString("base64url"),
          },
        },
        codex: { sandboxMode: "read-only" },
      },
      paths,
      startupTimeoutMs: 1_000,
      log: () => undefined,
      onReady: (status) => {
        readyStatus = status;
      },
    });

    try {
      await waitFor(() => readyStatus !== undefined);
      await expect(
        requestLocalControl(paths.controlEndpoint, { method: "status" }),
      ).resolves.toMatchObject({
        phase: "ready",
        relayConnected: true,
        pendingTasks: 0,
      });
      await requestLocalControl(paths.controlEndpoint, { method: "stop" });
      await runner;
      await expect(readDaemonMetadata(paths)).resolves.toBeUndefined();
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pagent-runner-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for local runner readiness.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
