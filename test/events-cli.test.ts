import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  it("reads, filters, and explains local handoff history", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = join(root, "state");
    const configPath = join(root, "pagent.config.mjs");
    await writeFile(configPath, `export default {
      ingress: { host: "127.0.0.1", port: 43121, token: "source-secret" },
      tunnel: {
        environmentId: "dev-machine",
        tunnelId: "tunnel-1",
        hostname: "env-dev.dev.example.test",
        provisionerUrl: "https://provisioner.example.test",
        tokenFile: ${JSON.stringify(join(root, ".pagent", "tunnel-token"))}
      },
      repositories: { app: ${JSON.stringify(root)} },
      environments: ["staging"],
      encryption: { keys: { current: "${Buffer.alloc(32, 1).toString("base64url")}" } },
      codex: { sandboxMode: "read-only" },
      stateDirectory: ${JSON.stringify(stateDirectory)}
    };\n`);
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(
      join(stateDirectory, "handoffs.json"),
      `${JSON.stringify({
        version: 1,
        records: [
          {
            eventId: "event-active",
            eventType: "checkout.failure-rate",
            environment: "staging",
            status: "running",
            receivedAt: "2026-08-26T12:01:00.000Z",
            startedAt: "2026-08-26T12:01:01.000Z",
            threadId: "thread-active",
            threadName: "Investigating checkout.failure-rate in app",
          },
          {
            eventId: "event-1",
            eventType: "worker.exception",
            environment: "staging",
            status: "failed",
            receivedAt: "2026-08-26T12:00:02.000Z",
            startedAt: "2026-08-26T12:00:03.000Z",
            completedAt: "2026-08-26T12:00:04.000Z",
            errorCode: "codex_failed",
            errorMessage: "Codex app server is unavailable.",
          },
          {
            eventId: "event-2",
            eventType: "job.completed",
            environment: "staging",
            status: "completed",
            receivedAt: "2026-08-26T11:00:01.000Z",
            startedAt: "2026-08-26T11:00:02.000Z",
            completedAt: "2026-08-26T11:00:04.000Z",
            threadId: "thread-local",
            threadName: "Investigating job.completed in app",
          },
          {
            eventId: "event-3",
            eventType: "worker.duplicate",
            environment: "staging",
            status: "suppressed",
            receivedAt: "2026-08-26T10:00:01.000Z",
            completedAt: "2026-08-26T10:00:01.000Z",
            errorCode: "duplicate",
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

    const list = await runCli(["events"], environment, root);
    expect(list).toMatchObject({ code: 0, stderr: "" });
    expect(list.stdout).toContain("worker.exception");
    expect(list.stdout).toContain("job.completed");
    expect(list.stdout).toContain("checkout.failure-rate");
    expect(list.stdout).toContain("thread-active");
    expect(list.stdout).toContain("failed");

    const jsonList = JSON.parse(
      (await runCli(["events", "--json"], environment, root)).stdout,
    ) as { events: Array<Record<string, unknown>> };
    expect(jsonList.events).toHaveLength(4);
    expect(jsonList.events[0]).toMatchObject({
      eventId: "event-active",
      status: "running",
      threadId: "thread-active",
      threadName: "Investigating checkout.failure-rate in app",
    });

    const detail = await runCli(["events", "show", "event-1"], environment, root);
    expect(detail).toMatchObject({ code: 0, stderr: "" });
    expect(detail.stdout).toContain("Codex app server is unavailable.");
    expect(detail.stdout).toContain("Next action: Open Codex");
    expect(detail.stdout).toContain("Context: encrypted and not shown");

    const active = await runCli(
      ["events", "show", "event-active"],
      environment,
      root,
    );
    expect(active).toMatchObject({ code: 0, stderr: "" });
    expect(active.stdout).toContain("Status: running");
    expect(active.stdout).toContain("Codex thread: thread-active");
    expect(active.stdout).toContain(
      "Thread name: Investigating checkout.failure-rate in app",
    );

    const activeOnly = await runCli(
      ["events", "--status", "running", "--json"],
      environment,
      root,
    );
    expect(JSON.parse(activeOnly.stdout).events).toEqual([
      expect.objectContaining({
        eventId: "event-active",
        threadId: "thread-active",
        threadName: "Investigating checkout.failure-rate in app",
      }),
    ]);

    const filtered = await runCli(
      ["events", "--status", "completed", "--json"],
      environment,
      root,
    );
    expect(JSON.parse(filtered.stdout).events).toEqual([
      expect.objectContaining({ eventId: "event-2", status: "completed" }),
    ]);

    const missing = await runCli(["events", "show", "missing"], environment, root);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("was not found in local history");
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
