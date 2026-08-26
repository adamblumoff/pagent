import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("events CLI", () => {
  it("joins relay metadata with local errors and gives a repair command", async () => {
    const summary = {
      eventId: "event-1",
      type: "worker.exception",
      environment: "staging",
      occurredAt: "2026-08-26T12:00:00.000Z",
      receivedAt: "2026-08-26T12:00:01.000Z",
      status: "retrying",
      attemptCount: 3,
      taskId: "9",
      receivedLocallyAt: "2026-08-26T12:00:02.000Z",
      startedAt: "2026-08-26T12:00:03.000Z",
      lastAttemptAt: "2026-08-26T12:00:04.000Z",
      lastErrorCode: "codex_failed",
    };
    const completedSummary = {
      eventId: "event-2",
      type: "job.completed",
      environment: "staging",
      occurredAt: "2026-08-26T11:00:00.000Z",
      receivedAt: "2026-08-26T11:00:01.000Z",
      status: "completed",
      attemptCount: 1,
      taskId: "8",
      completedAt: "2026-08-26T11:00:04.000Z",
    };
    const staleRetrySummary = {
      eventId: "event-4",
      type: "worker.recovered",
      environment: "staging",
      occurredAt: "2026-08-26T09:00:00.000Z",
      receivedAt: "2026-08-26T09:00:01.000Z",
      status: "retrying",
      attemptCount: 1,
      taskId: "6",
      lastAttemptAt: "2026-08-26T09:00:03.000Z",
      lastErrorCode: "codex_failed",
    };
    const relay = createServer((request, response) => {
      if (request.headers.authorization !== "Bearer connector-secret") {
        response.writeHead(401).end();
        return;
      }
      if (request.url?.startsWith("/v1/connectors/local/event-history")) {
        response.setHeader("content-type", "application/json");
        const url = new URL(request.url, "http://relay.test");
        response.end(
          JSON.stringify(
            url.pathname === "/v1/connectors/local/event-history/event-1"
              ? { version: 1, event: summary }
              : url.searchParams.has("cursor")
                ? { version: 1, events: [completedSummary] }
                : {
                    version: 1,
                    events: [summary, staleRetrySummary],
                    nextCursor: "page-2",
                  },
          ),
        );
        return;
      }
      response.writeHead(404).end();
    });
    relay.listen(0, "127.0.0.1");
    await new Promise<void>((resolveListen) =>
      relay.once("listening", resolveListen),
    );
    const address = relay.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test relay did not bind to a port.");
    }

    const root = await temporaryDirectory();
    const stateDirectory = join(root, "state");
    const configPath = join(root, "pagent.config.mjs");
    await writeFile(
      configPath,
      `export default {
        relay: { url: "http://127.0.0.1:${address.port}", token: "connector-secret", connectorId: "local" },
        repositories: { app: ${JSON.stringify(root)} },
        environments: ["staging"],
        encryption: { keys: { current: "${Buffer.alloc(32, 1).toString("base64url")}" } },
        codex: { sandboxMode: "read-only" },
        stateDirectory: ${JSON.stringify(stateDirectory)}
      };\n`,
    );
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      join(stateDirectory, "handoffs.json"),
      `${JSON.stringify({
        version: 1,
        records: [
          {
            taskId: "9",
            eventId: "event-1",
            eventType: "worker.exception",
            environment: "staging",
            status: "retrying",
            attempts: 3,
            receivedAt: "2026-08-26T12:00:02.000Z",
            startedAt: "2026-08-26T12:00:03.000Z",
            lastAttemptAt: "2026-08-26T12:00:04.000Z",
            lastErrorCode: "codex_failed",
            lastErrorMessage: "Codex app server is unavailable.",
          },
          {
            taskId: "7",
            eventId: "event-3",
            eventType: "local.completed",
            environment: "staging",
            status: "completed",
            attempts: 1,
            receivedAt: "2026-08-26T10:00:01.000Z",
            startedAt: "2026-08-26T10:00:02.000Z",
            lastAttemptAt: "2026-08-26T10:00:02.000Z",
            completedAt: "2026-08-26T10:00:04.000Z",
            threadId: "thread-local",
          },
          {
            taskId: "6",
            eventId: "event-4",
            eventType: "worker.recovered",
            environment: "staging",
            status: "running",
            attempts: 2,
            receivedAt: "2026-08-26T09:00:01.000Z",
            startedAt: "2026-08-26T09:00:02.000Z",
            lastAttemptAt: "2026-08-26T09:00:05.000Z",
          },
        ],
      })}\n`,
      { mode: 0o600 },
    );
    const environment = {
      ...process.env,
      PAGENT_CONFIG: configPath,
      PAGENT_STATE_DIR: stateDirectory,
    };

    try {
      const list = await runCli(["events"], environment, root);
      expect(list).toMatchObject({ code: 0, stderr: "" });
      expect(list.stdout).toContain("worker.exception");
      expect(list.stdout).toContain("local.completed");

      const jsonList = JSON.parse(
        (await runCli(["events", "--json"], environment, root)).stdout,
      ) as { events: Array<Record<string, unknown>> };
      expect(
        jsonList.events.find((event) => event.eventId === "event-4"),
      ).toMatchObject({ status: "running", attempts: 2 });
      expect(
        jsonList.events.find((event) => event.eventId === "event-4"),
      ).not.toHaveProperty("lastErrorCode");
      expect(list.stdout).toContain("needs-attention");

      const detail = await runCli(
        ["events", "show", "event-1"],
        environment,
        root,
      );
      expect(detail).toMatchObject({ code: 0, stderr: "" });
      expect(detail.stdout).toContain("Codex app server is unavailable.");
      expect(detail.stdout).toContain("Next action: Open Codex");
      expect(detail.stdout).toContain("Context: encrypted and not shown");

      const filtered = await runCli(
        ["events", "--status", "completed", "--json"],
        environment,
        root,
      );
      expect(
        JSON.parse(filtered.stdout).events.map(
          (event: { eventId: string }) => event.eventId,
        ),
      ).toEqual(["event-2", "event-3"]);

      relay.closeAllConnections();
      await new Promise<void>((resolveClose) => relay.close(() => resolveClose()));
      const offlineDetail = await runCli(
        ["events", "show", "event-1"],
        environment,
        root,
      );
      expect(offlineDetail.code).toBe(0);
      expect(offlineDetail.stdout).toContain("Event: event-1");
      expect(offlineDetail.stderr).toContain("Relay history unavailable");
    } finally {
      if (relay.listening) {
        relay.closeAllConnections();
        await new Promise<void>((resolveClose) =>
          relay.close(() => resolveClose()),
        );
      }
    }
  });
});

async function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    resolve("node_modules/.bin/tsx"),
    [resolve("src/cli.ts"), ...args],
    { cwd, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  child.stderr.on("data", (chunk: string) => (stderr += chunk));
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  return { code, stdout, stderr };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pagent-events-cli-test-"));
  temporaryDirectories.push(path);
  return path;
}
