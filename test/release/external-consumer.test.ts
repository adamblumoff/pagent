import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const repositoryRoot = resolve(import.meta.dirname, "../..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const rootPackage = await readJson<{ version: string }>(
  join(repositoryRoot, "package.json"),
);
const releaseVersion = rootPackage.version;
const releaseTag = `v${releaseVersion}`;

let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "pagent-release-smoke-"));
});

afterAll(async () => {
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

describe("release artifact", () => {
  it(
    "runs the CLI and sends an SDK event from an unrelated project",
    async () => {
      const artifactsDirectory = join(temporaryDirectory, "artifacts");
      const consumerDirectory = join(temporaryDirectory, "consumer");
      await mkdir(consumerDirectory);

      await buildRelease(artifactsDirectory);
      const releaseArchive = join(
        artifactsDirectory,
        `pagent-${releaseTag}.tgz`,
      );
      await writeJson(join(consumerDirectory, "package.json"), {
        name: "unrelated-pagent-consumer",
        private: true,
        type: "module",
      });
      await install(consumerDirectory, releaseArchive);

      const installedManifest = await readJson<{ version: string }>(
        join(consumerDirectory, "node_modules", "pagent", "package.json"),
      );
      expect(installedManifest.version).toBe(releaseVersion);

      const installedCli = join(
        consumerDirectory,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "pagent.cmd" : "pagent",
      );
      const version = await run(installedCli, ["--version"], {
        cwd: consumerDirectory,
      });
      const help = await run(installedCli, ["--help"], {
        cwd: consumerDirectory,
      });
      expect(version.stdout.trim()).toBe(releaseVersion);
      expect(help.stdout).toContain("Usage: pagent <command> [options]");

      const capture = await startCaptureServer();
      try {
        await writeFile(
          join(consumerDirectory, "send-event.mjs"),
          consumerProgram(capture.url),
        );
        const result = await run(process.execPath, ["send-event.mjs"], {
          cwd: consumerDirectory,
        });

        expect(JSON.parse(result.stdout)).toEqual({
          status: "failed",
          reason: "database offline",
        });
        const capturedRequest = await capture.request;
        expect(capturedRequest).toMatchObject({
          method: "POST",
          url: "/events",
          authorization: "Bearer release-smoke-token",
          body: {
            version: 2,
            event: {
              type: "release.smoke",
              environment: "ci",
              investigation: { cooldownMs: 0 },
              context: {
                algorithm: "A256GCM",
                keyId: "release-smoke-key",
              },
            },
          },
        });
        expect(JSON.stringify(capturedRequest)).not.toContain("database offline");
      } finally {
        await closeServer(capture.server);
      }
    },
    120_000,
  );
});

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  body: unknown;
}

async function buildRelease(destination: string): Promise<void> {
  await run(
    process.execPath,
    [
      "scripts/release/build-release.mjs",
      "--tag",
      releaseTag,
      "--out-dir",
      destination,
    ],
    { cwd: repositoryRoot, maxBuffer: 10 * 1024 * 1024 },
  );
}

async function install(directory: string, archive: string): Promise<void> {
  await run(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      archive,
    ],
    { cwd: directory },
  );
}

function consumerProgram(relayUrl: string): string {
  return `import { createPagent, defineEvent } from "pagent";

const failure = defineEvent({
  name: "release.smoke",
  enabledIn: ["ci"],
});
const pagent = createPagent({
  enabled: true,
  environment: "ci",
  relay: {
    url: ${JSON.stringify(relayUrl)},
    token: "release-smoke-token",
  },
  encryption: {
    keyId: "release-smoke-key",
    key: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  },
});
const check = pagent.observe(
  () => ({ status: "failed", reason: "database offline" }),
  {
    event: failure,
    on: "result",
    triggerWhen: ({ result }) => result.status === "failed",
    context: ({ result }) => ({ reason: result.reason }),
  },
);

const result = check();
await pagent.flush();
process.stdout.write(JSON.stringify(result));
`;
}

async function startCaptureServer(): Promise<{
  server: Server;
  url: string;
  request: Promise<CapturedRequest>;
}> {
  let resolveRequest!: (request: CapturedRequest) => void;
  const request = new Promise<CapturedRequest>((resolve) => {
    resolveRequest = resolve;
  });
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      resolveRequest({
        method: incoming.method,
        url: incoming.url,
        authorization: incoming.headers.authorization,
        body,
      });
      response.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Release capture server did not bind to a TCP port.");
  }
  return {
    server,
    url: `http://127.0.0.1:${address.port}/events`,
    request,
  };
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
