import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";

import { parseEnv } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { createRelayServer } from "../relay/src/server.js";
import type { RelayConfig } from "../relay/src/types.js";
import { RecordingRelayStore } from "../relay/test/recording-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe.skipIf(process.platform === "win32")("CLI lifecycle", () => {
  it("enrolls a repository, writes private settings, and runs doctor", async () => {
    const root = await temporaryDirectory();
    const binDirectory = join(root, "bin");
    await mkdir(binDirectory, { recursive: true });
    await fakeCodex(join(binDirectory, "codex"));
    await runProcess("git", ["init", "--quiet"], root);
    await fakeInstalledPackage(root);

    const store = new RecordingRelayStore();
    const relay = createRelayServer({
      config: {
        port: 0,
        heartbeatMs: 100,
        sources: [],
        connectors: [],
        adminToken: "admin-secret",
      } satisfies RelayConfig,
      store,
    });
    relay.listen(0, "127.0.0.1");
    await new Promise<void>((resolveListen) =>
      relay.once("listening", resolveListen),
    );
    const address = relay.address();
    if (address === null || typeof address === "string") {
      throw new Error("Test relay did not bind to a port.");
    }

    try {
      const code = await runCli(
        [
          "enrollment",
          "create",
          "--relay",
          `http://127.0.0.1:${address.port}`,
          "--admin-token",
          "admin-secret",
          "--ttl",
          "15",
        ],
        process.env,
        root,
      );
      expect(code.code).toBe(0);
      expect(code.stdout.trim()).toMatch(/^pge_[A-Za-z0-9_-]{43}$/u);
      expect(code.stdout).not.toContain("admin-secret");

      const result = await runCli(
        [
          "init",
          "--relay",
          `http://127.0.0.1:${address.port}`,
          "--enrollment",
          code.stdout.trim(),
          "--yes",
          "--no-start",
        ],
        {
          ...process.env,
          PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
        },
        root,
      );

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Pagent initialized for");
      expect(result.stdout).toContain("Relay authentication");
      expect(result.stdout).toContain("The connector is stopped");
      expect(result.stdout).not.toContain("enrollment-secret");
      expect(result.stderr).toBe("");

      const local = parseEnv(await readFile(join(root, ".pagent/local.env"), "utf8"));
      const cloud = parseEnv(await readFile(join(root, ".pagent/cloud.env"), "utf8"));
      const enrolled = store.enrollments[0];
      expect(enrolled).toMatchObject({
        repositoryKey: basename(root).toLowerCase(),
        allowedEnvironments: ["staging"],
        sourceTokenHash: sha256(cloud.PAGENT_RELAY_TOKEN!),
        connectorTokenHash: sha256(local.PAGENT_CONNECTOR_TOKEN!),
      });
      expect(await readFile(join(root, ".gitignore"), "utf8")).toContain(
        ".pagent/",
      );

      const originalConnectorId = enrolled!.connectorId;
      const originalSourceHash = enrolled!.sourceTokenHash;
      const originalKeyring = JSON.parse(local.PAGENT_CONTEXT_KEYS!) as Record<
        string,
        string
      >;
      const originalKeyId = cloud.PAGENT_ENCRYPTION_KEY_ID!;
      const rotationCode = await runCli(
        [
          "enrollment",
          "create",
          "--relay",
          `http://127.0.0.1:${address.port}`,
          "--admin-token",
          "admin-secret",
          "--connector",
          originalConnectorId,
        ],
        process.env,
        root,
      );
      const rotated = await runCli(
        [
          "init",
          "--relay",
          `http://127.0.0.1:${address.port}`,
          "--enrollment",
          rotationCode.stdout.trim(),
          "--yes",
          "--no-start",
          "--reset",
        ],
        {
          ...process.env,
          PATH: `${binDirectory}${delimiter}${process.env.PATH ?? ""}`,
        },
        root,
      );
      expect(rotated.code, JSON.stringify(rotated)).toBe(0);
      const rotatedEnrollment = store.enrollments[0];
      expect(rotatedEnrollment).toMatchObject({
        connectorId: originalConnectorId,
        replace: true,
      });
      expect(rotatedEnrollment?.sourceTokenHash).not.toBe(originalSourceHash);
      const rotatedLocal = parseEnv(
        await readFile(join(root, ".pagent/local.env"), "utf8"),
      );
      const rotatedCloud = parseEnv(
        await readFile(join(root, ".pagent/cloud.env"), "utf8"),
      );
      const rotatedKeyring = JSON.parse(
        rotatedLocal.PAGENT_CONTEXT_KEYS!,
      ) as Record<string, string>;
      const rotatedKeyId = rotatedCloud.PAGENT_ENCRYPTION_KEY_ID!;
      expect(rotatedKeyId).not.toBe(originalKeyId);
      expect(rotatedKeyring).toEqual({
        [originalKeyId]: originalKeyring[originalKeyId],
        [rotatedKeyId]: rotatedCloud.PAGENT_ENCRYPTION_KEY,
      });

      const revoke = await runCli(
        [
          "connector",
          "revoke",
          originalConnectorId,
          "--relay",
          `http://127.0.0.1:${address.port}`,
          "--admin-token",
          "admin-secret",
          "--yes",
        ],
        process.env,
        root,
      );
      expect(revoke.code).toBe(0);
      expect(revoke.stdout).toContain("Revoked connector");
      expect(
        await store.authorizeConnector(
          originalConnectorId,
          rotatedEnrollment!.connectorTokenHash,
        ),
      ).toBe(false);
    } finally {
      relay.closeAllConnections();
      await new Promise<void>((resolveClose) => relay.close(() => resolveClose()));
      await store.close();
    }
  }, 30_000);

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
  cwd = process.cwd(),
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

async function fakeInstalledPackage(root: string): Promise<void> {
  const directory = join(root, "node_modules", "pagent");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({
      name: "pagent",
      type: "module",
      exports: { "./connector": "./connector.mjs" },
    }),
  );
  await writeFile(
    join(directory, "connector.mjs"),
    "export const defineConnectorConfig = (config) => config;\n",
  );
}

async function runProcess(command: string, args: string[], cwd: string): Promise<void> {
  const child = spawn(command, args, { cwd, stdio: "ignore" });
  const code = await new Promise<number | null>((resolveExit, rejectExit) => {
    child.once("error", rejectExit);
    child.once("exit", resolveExit);
  });
  if (code !== 0) throw new Error(`${command} exited with code ${code}.`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
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
    } else if (message.method === "command/exec") {
      process.stdout.write(
        JSON.stringify({
          id: message.id,
          result: { exitCode: 0, stdout: "", stderr: "" },
        }) + "\\n",
      );
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
