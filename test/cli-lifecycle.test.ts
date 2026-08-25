import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(process.platform === "win32")("CLI lifecycle", () => {
  it("starts in the background, reports live state, logs, and stops", async () => {
    const root = await temporaryDirectory();
    const stateDirectory = join(root, "state");
    const binDirectory = join(root, "bin");
    await mkdir(binDirectory, { recursive: true });
    await fakeCodex(join(binDirectory, "codex"));

    const relay = createServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}\n');
        return;
      }
      if (request.url === "/v1/connectors/local/events") {
        if (request.headers.authorization !== "Bearer connector-secret") {
          response.writeHead(401).end();
          return;
        }
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        });
        response.write(": connected\n\n");
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
    const environment = {
      ...process.env,
      PAGENT_CONFIG: configPath,
      PAGENT_STATE_DIR: stateDirectory,
      PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
    };

    try {
      const started = await runCli(["start"], environment);
      expect(started.code).toBe(0);
      expect(started.stdout).toContain("Pagent started in the background");

      const status = await runCli(["status", "--json"], environment);
      expect(status.code).toBe(0);
      expect(JSON.parse(status.stdout)).toMatchObject({
        running: true,
        phase: "ready",
        relayConnected: true,
        pendingTasks: 0,
      });

      const duplicate = await runCli(["start"], environment);
      expect(duplicate.stdout).toContain("Pagent is already running");

      const logs = await runCli(["logs", "--lines", "10"], environment);
      expect(logs.stdout).toContain("[pagent] relay connected");

      const stopped = await runCli(["stop"], environment);
      expect(stopped.stdout).toContain("Stopping Pagent");
      await waitForStopped(environment);

      const persisted = [
        await readFile(join(stateDirectory, "connector.log"), "utf8"),
        await readFile(join(stateDirectory, "inbox.json"), "utf8").catch(
          () => "",
        ),
      ].join("\n");
      expect(persisted).not.toContain("connector-secret");
      expect(persisted).not.toContain(Buffer.alloc(32, 1).toString("base64url"));
    } finally {
      await runCli(["stop"], environment).catch(() => undefined);
      relay.closeAllConnections();
      await new Promise<void>((resolveClose) => relay.close(() => resolveClose()));
    }
  }, 30_000);
});

async function runCli(
  args: string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const child = spawn(
    resolve("node_modules/.bin/tsx"),
    [resolve("src/cli.ts"), ...args],
    { cwd: process.cwd(), env: environment, stdio: ["ignore", "pipe", "pipe"] },
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

async function fakeCodex(path: string): Promise<void> {
  await writeFile(
    path,
    `#!/usr/bin/env node
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline = input.indexOf("\\n");
  while (newline >= 0) {
    const message = JSON.parse(input.slice(0, newline));
    input = input.slice(newline + 1);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    }
    newline = input.indexOf("\\n");
  }
});
`,
    { mode: 0o700 },
  );
  await chmod(path, 0o700);
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pagent-cli-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function waitForStopped(environment: NodeJS.ProcessEnv): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const status = await runCli(["status", "--json"], environment);
    if (JSON.parse(status.stdout).running === false) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error("Pagent CLI did not stop before the timeout.");
}
