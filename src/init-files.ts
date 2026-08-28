import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import type { ProvisionedTunnel } from "./tunnel-provisioning.js";

interface SetupFile {
  path: string;
  contents: string;
  mode: number;
}

interface FileSnapshot {
  path: string;
  contents?: Buffer | undefined;
  mode?: number | undefined;
}

export interface ProjectSetupPaths {
  setupDirectory: string;
  configPath: string;
  localEnvironmentPath: string;
  cloudEnvironmentPath: string;
  tunnelTokenPath: string;
  gitIgnorePath: string;
}

export function setupPaths(projectDirectory: string): ProjectSetupPaths {
  const setupDirectory = join(projectDirectory, ".pagent");
  return {
    setupDirectory,
    configPath: join(projectDirectory, "pagent.config.ts"),
    localEnvironmentPath: join(setupDirectory, "local.env"),
    cloudEnvironmentPath: join(setupDirectory, "cloud.env"),
    tunnelTokenPath: join(setupDirectory, "tunnel-token"),
    gitIgnorePath: join(projectDirectory, ".gitignore"),
  };
}

export function buildSetupFiles(input: {
  paths: ProjectSetupPaths;
  provisionerUrl: string;
  environmentId: string;
  originPort: number;
  sourceToken: string;
  contextKey: string;
  tunnel: ProvisionedTunnel;
  environments: readonly string[];
  repositoryKey: string;
  contextKeyId: string;
  keyring: string;
  existingGitIgnore: string | undefined;
  cloudflaredPath: string;
}): SetupFile[] {
  const hostname = new URL(input.tunnel.eventOrigin).hostname;
  return [
    {
      path: input.paths.configPath,
      contents: connectorConfig({
        environmentId: input.environmentId,
        tunnelId: input.tunnel.tunnelId,
        hostname,
        provisionerUrl: input.provisionerUrl,
        originPort: input.originPort,
        environments: input.environments,
        repositoryKey: input.repositoryKey,
        cloudflaredPath: input.cloudflaredPath,
      }),
      mode: 0o644,
    },
    {
      path: input.paths.localEnvironmentPath,
      contents: environmentFile({
        PAGENT_SOURCE_TOKEN: input.sourceToken,
        PAGENT_MANAGEMENT_TOKEN: input.tunnel.managementToken,
        PAGENT_CONTEXT_KEYS: input.keyring,
      }),
      mode: 0o600,
    },
    {
      path: input.paths.cloudEnvironmentPath,
      contents: environmentFile({
        PAGENT_ENABLED: "true",
        PAGENT_ENV: input.environments[0]!,
        PAGENT_ENDPOINT_URL: new URL(
          "/v1/events",
          input.tunnel.eventOrigin,
        ).toString(),
        PAGENT_SOURCE_TOKEN: input.sourceToken,
        PAGENT_ENCRYPTION_KEY_ID: input.contextKeyId,
        PAGENT_ENCRYPTION_KEY: input.contextKey,
      }),
      mode: 0o600,
    },
    {
      path: input.paths.tunnelTokenPath,
      contents: `${input.tunnel.tunnelToken}\n`,
      mode: 0o600,
    },
    {
      path: input.paths.gitIgnorePath,
      contents: addGitIgnoreEntry(input.existingGitIgnore),
      mode: 0o644,
    },
  ];
}

export async function writeSetupFiles(
  setupDirectory: string,
  files: readonly SetupFile[],
): Promise<void> {
  const setupDirectoryExisted = await exists(setupDirectory);
  await mkdir(setupDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(setupDirectory, 0o700);
  const snapshots = await Promise.all(files.map(snapshotFile));
  const staged = files.map((file) => ({
    ...file,
    temporaryPath: join(
      dirname(file.path),
      `.${basename(file.path)}.${randomUUID()}.tmp`,
    ),
  }));
  try {
    for (const file of staged) {
      await writeFile(file.temporaryPath, file.contents, {
        flag: "wx",
        mode: file.mode,
      });
    }
    for (const file of staged) {
      await rename(file.temporaryPath, file.path);
      if (process.platform !== "win32") await chmod(file.path, file.mode);
    }
  } catch {
    await Promise.allSettled(
      staged.map((file) => rm(file.temporaryPath, { force: true })),
    );
    await Promise.allSettled(snapshots.map(restoreSnapshot));
    if (!setupDirectoryExisted) {
      await rm(setupDirectory, { recursive: false, force: true }).catch(
        () => undefined,
      );
    }
    throw new Error(
      "Pagent provisioned the tunnel but could not write the local setup files. Check permissions, then run the same init command again.",
    );
  }
}

function connectorConfig(input: {
  environmentId: string;
  tunnelId: string;
  hostname: string;
  provisionerUrl: string;
  originPort: number;
  environments: readonly string[];
  repositoryKey: string;
  cloudflaredPath: string;
}): string {
  return `import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConnectorConfig } from "pagent/connector";

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConnectorConfig({
  ingress: {
    host: "127.0.0.1",
    port: ${input.originPort},
    token: required("PAGENT_SOURCE_TOKEN"),
  },
  tunnel: {
    environmentId: ${JSON.stringify(input.environmentId)},
    tunnelId: ${JSON.stringify(input.tunnelId)},
    hostname: ${JSON.stringify(input.hostname)},
    provisionerUrl: ${JSON.stringify(input.provisionerUrl)},
    tokenFile: join(repositoryDirectory, ".pagent", "tunnel-token"),
    cloudflaredPath: ${JSON.stringify(input.cloudflaredPath)},
  },
  repositories: {
    ${JSON.stringify(input.repositoryKey)}: repositoryDirectory,
  },
  environments: ${JSON.stringify(input.environments)},
  encryption: {
    keys: keyring(),
  },
  codex: {
    sandboxMode: "read-only",
  },
  stateDirectory: join(repositoryDirectory, ".pagent", "state"),
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(\`\${name} is required.\`);
  return value;
}

function keyring(): Record<string, string> {
  const value = JSON.parse(required("PAGENT_CONTEXT_KEYS")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PAGENT_CONTEXT_KEYS must be a JSON object.");
  }
  return value as Record<string, string>;
}
`;
}

async function snapshotFile(file: SetupFile): Promise<FileSnapshot> {
  try {
    const metadata = await stat(file.path);
    return {
      path: file.path,
      contents: await readFile(file.path),
      mode: metadata.mode & 0o777,
    };
  } catch (error) {
    if (isMissing(error)) return { path: file.path };
    throw error;
  }
}

async function restoreSnapshot(snapshot: FileSnapshot): Promise<void> {
  if (snapshot.contents === undefined) {
    await rm(snapshot.path, { force: true });
    return;
  }
  await writeFile(snapshot.path, snapshot.contents, {
    mode: snapshot.mode ?? 0o600,
  });
  if (process.platform !== "win32" && snapshot.mode !== undefined) {
    await chmod(snapshot.path, snapshot.mode);
  }
}

function environmentFile(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}='${value}'`)
    .join("\n")}\n`;
}

function addGitIgnoreEntry(current: string | undefined): string {
  if (current?.split(/\r?\n/u).some((line) => line.trim() === ".pagent/")) {
    return current;
  }
  if (current === undefined || current === "") return ".pagent/\n";
  return `${current.endsWith("\n") ? current : `${current}\n`}.pagent/\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
