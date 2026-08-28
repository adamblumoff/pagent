import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseEnv, promisify } from "node:util";

import { parseConnectorKeyring } from "./config.js";
import { probeCodexAppServer } from "./codex.js";
import { ensureCloudflared } from "./cloudflared-install.js";
import { TunnelProvisioningClient } from "./tunnel-provisioning.js";
import {
  buildSetupFiles,
  setupPaths,
  writeSetupFiles,
  type ProjectSetupPaths,
} from "./init-files.js";

const execFileAsync = promisify(execFile);
const DEFAULT_ENVIRONMENTS = ["staging"] as const;
const CONFIG_NAMES = [
  "pagent.config.ts",
  "pagent.config.mts",
  "pagent.config.mjs",
  "pagent.config.js",
] as const;

export interface ProjectInitOptions {
  cwd?: string | undefined;
  provisionerUrl: string;
  enrollmentToken: string;
  environments?: readonly string[] | undefined;
  reset?: boolean | undefined;
  environmentId?: string | undefined;
  originPort?: number | undefined;
  managementToken?: string | undefined;
}

export interface ProjectInitResult {
  projectDirectory: string;
  repositoryKey: string;
  environmentId: string;
  tunnelId: string;
  eventOrigin: string;
  environments: readonly string[];
  configPath: string;
  localEnvironmentPath: string;
  cloudEnvironmentPath: string;
  tunnelTokenPath: string;
  gitIgnorePath: string;
}

export interface ProjectInitDependencies {
  provisioner?: Pick<TunnelProvisioningClient, "createOrResume" | "rotate"> | undefined;
  findGitRoot?: ((cwd: string) => Promise<string>) | undefined;
  findGitStateDirectory?: ((cwd: string) => Promise<string>) | undefined;
  findAvailablePort?: (() => Promise<number>) | undefined;
  ensureCloudflared?: (() => Promise<string>) | undefined;
  probeCodex?: (() => Promise<void>) | undefined;
  randomBytes?: ((size: number) => Uint8Array) | undefined;
  hostname?: (() => string) | undefined;
}

interface PendingInit {
  version: 2;
  projectDirectory: string;
  provisionerUrl: string;
  authorizationHash: string;
  environmentId: string;
  repositoryKey: string;
  environments: string[];
  reset: boolean;
  originPort: number;
  idempotencyKey: string;
  sourceToken: string;
  contextKey: string;
}

export async function runProjectInit(
  options: ProjectInitOptions,
  dependencies: ProjectInitDependencies = {},
): Promise<ProjectInitResult> {
  const provisionerUrl = normalizeProvisionerUrl(options.provisionerUrl);
  const environments = normalizeEnvironments(options.environments);
  const reset = options.reset === true;
  const authorization = requiredSecret(
    reset ? options.managementToken : options.enrollmentToken,
    reset ? "Management token" : "Enrollment token",
  );
  const requestedEnvironmentId = options.environmentId;
  if (reset && requestedEnvironmentId === undefined) {
    throw new Error(
      "Pagent reset needs the existing tunnel environment ID. Repair the config or revoke the tunnel before resetting it.",
    );
  }
  const cwd = resolve(options.cwd ?? process.cwd());
  const projectDirectory = resolve(
    await (dependencies.findGitRoot ?? defaultFindGitRoot)(cwd),
  );
  const gitStateDirectory = resolve(
    await (dependencies.findGitStateDirectory ?? defaultGitStateDirectory)(
      projectDirectory,
    ),
  );
  const repositoryKey = identifier(basename(projectDirectory), "repository");
  const paths = setupPaths(projectDirectory);
  const pendingPath = join(gitStateDirectory, "pending-init.json");

  await requireAvailableTargets(projectDirectory, paths, reset);
  await requireCodex(dependencies.probeCodex);
  const cloudflaredPath = await (
    dependencies.ensureCloudflared ?? (() => ensureCloudflared())
  )();
  const existingGitIgnore = await readOptionalText(paths.gitIgnorePath);
  const previousKeys = reset
    ? await readExistingContextKeys(paths.localEnvironmentPath)
    : {};
  const makeRandomBytes = dependencies.randomBytes ?? randomBytes;
  const previousPending = await readPendingInit(pendingPath);
  const originPort =
    options.originPort ??
    previousPending?.originPort ??
    (await (dependencies.findAvailablePort ?? findAvailableLoopbackPort)());
  requirePort(originPort);
  const pending: PendingInit =
    previousPending ?? {
      version: 2,
      projectDirectory,
      provisionerUrl,
      authorizationHash: tokenHash(authorization),
      environmentId:
        requestedEnvironmentId ??
        generatedEnvironmentId(
          repositoryKey,
          (dependencies.hostname ?? hostname)(),
          makeRandomBytes,
        ),
      repositoryKey,
      environments,
      reset,
      originPort,
      idempotencyKey: `pgi_${encode(makeRandomBytes(24))}`,
      sourceToken: `pgs_${encode(makeRandomBytes(32))}`,
      contextKey: encode(makeRandomBytes(32)),
    };
  assertPendingMatches(pending, {
    projectDirectory,
    provisionerUrl,
    authorization,
    environmentId: requestedEnvironmentId,
    repositoryKey,
    environments,
    reset,
    originPort,
  });
  if (previousPending === undefined) await writePendingInit(pendingPath, pending);

  const provisioner =
    dependencies.provisioner ?? new TunnelProvisioningClient({ serviceUrl: provisionerUrl });
  const tunnel = reset
    ? await provisioner.rotate({
        environmentId: pending.environmentId,
        managementToken: authorization,
        idempotencyKey: pending.idempotencyKey,
        originPort: pending.originPort,
      })
    : await provisioner.createOrResume({
        environmentId: pending.environmentId,
        enrollmentToken: authorization,
        idempotencyKey: pending.idempotencyKey,
        originPort: pending.originPort,
      });

  const contextKeyId = encryptionKeyId(pending.contextKey);
  const retainedKeys = Object.fromEntries(Object.entries(previousKeys).slice(-1));
  const keyring = JSON.stringify({
    ...retainedKeys,
    [contextKeyId]: pending.contextKey,
  });
  const files = buildSetupFiles({
    paths,
    provisionerUrl,
    environmentId: pending.environmentId,
    originPort: pending.originPort,
    sourceToken: pending.sourceToken,
    contextKey: pending.contextKey,
    tunnel,
    environments,
    repositoryKey,
    contextKeyId,
    keyring,
    existingGitIgnore,
    cloudflaredPath,
  });

  await writeSetupFiles(paths.setupDirectory, files);
  await rm(pendingPath, { force: true });

  return {
    projectDirectory,
    repositoryKey,
    environmentId: pending.environmentId,
    tunnelId: tunnel.tunnelId,
    eventOrigin: tunnel.eventOrigin,
    environments,
    configPath: paths.configPath,
    localEnvironmentPath: paths.localEnvironmentPath,
    cloudEnvironmentPath: paths.cloudEnvironmentPath,
    tunnelTokenPath: paths.tunnelTokenPath,
    gitIgnorePath: paths.gitIgnorePath,
  };
}

async function requireAvailableTargets(
  projectDirectory: string,
  paths: ProjectSetupPaths,
  reset: boolean,
): Promise<void> {
  for (const name of CONFIG_NAMES) {
    const path = join(projectDirectory, name);
    if (path !== paths.configPath && (await exists(path))) {
      throw new Error(
        `Pagent found ${name}. Remove or rename it before running \`pagent init\`.`,
      );
    }
  }
  const managed = [
    paths.configPath,
    paths.localEnvironmentPath,
    paths.cloudEnvironmentPath,
    paths.tunnelTokenPath,
  ];
  const existing = (
    await Promise.all(
      managed.map(async (path) => ((await exists(path)) ? path : undefined)),
    )
  ).filter((path): path is string => path !== undefined);
  if (existing.length > 0 && !reset) {
    throw new Error(
      `Pagent is already initialized at ${projectDirectory}. Run \`pagent init --reset\` to rotate this environment.`,
    );
  }
  for (const path of existing) {
    if (!(await stat(path)).isFile()) {
      throw new Error(`Pagent cannot replace ${path} because it is not a file.`);
    }
  }
}

async function readExistingContextKeys(path: string): Promise<Record<string, string>> {
  try {
    const serialized = parseEnv(await readFile(path, "utf8")).PAGENT_CONTEXT_KEYS;
    if (serialized === undefined) throw new Error();
    return { ...parseConnectorKeyring(JSON.parse(serialized)) };
  } catch {
    throw new Error(
      `Pagent cannot rotate credentials because ${path} has no valid PAGENT_CONTEXT_KEYS keyring. Restore it or revoke the tunnel.`,
    );
  }
}

async function defaultFindGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
    });
    if (stdout.trim() !== "") return stdout.trim();
  } catch {
    // Use the stable error below.
  }
  throw new Error(
    "Pagent init must run inside a Git repository. Create or clone one, then try again.",
  );
}

async function defaultGitStateDirectory(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "pagent"], {
      cwd,
      encoding: "utf8",
    });
    if (stdout.trim() !== "") return resolve(cwd, stdout.trim());
  } catch {
    // The Git-root check reports the common failure first.
  }
  throw new Error("Pagent could not find writable Git metadata for init recovery.");
}

async function requireCodex(probe: (() => Promise<void>) | undefined): Promise<void> {
  try {
    await (probe ?? (() => probeCodexAppServer({ timeoutMs: 5_000 })))();
  } catch {
    throw new Error(
      "Codex must be installed and signed in before Pagent can initialize. Run `codex login`, then try again.",
    );
  }
}

function findAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once("error", rejectPort);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        rejectPort(new Error("Pagent could not allocate a loopback port."));
        return;
      }
      server.close((error) => {
        if (error === undefined) resolvePort(address.port);
        else rejectPort(error);
      });
    });
  });
}

function normalizeProvisionerUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Provisioner URL must be a valid HTTPS origin.");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Provisioner URL must be an HTTPS origin.");
  }
  return url.origin;
}

function normalizeEnvironments(values: readonly string[] | undefined): string[] {
  const environments = values ?? DEFAULT_ENVIRONMENTS;
  if (
    environments.length === 0 ||
    environments.some(
      (value) => value.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value),
    ) ||
    new Set(environments).size !== environments.length
  ) {
    throw new Error(
      "Allowed environments must be unique names up to 100 characters using letters, numbers, periods, underscores, or hyphens.",
    );
  }
  return [...environments];
}

function generatedEnvironmentId(
  repositoryKey: string,
  machineName: string,
  makeRandomBytes: (size: number) => Uint8Array,
): string {
  const machine = identifier(machineName, "machine").slice(0, 40);
  return `${repositoryKey.slice(0, 80)}-${machine}-${encode(makeRandomBytes(6))}`;
}

function identifier(value: string, fallback: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "") || fallback
  );
}

function assertPendingMatches(
  pending: PendingInit,
  requested: {
    projectDirectory: string;
    provisionerUrl: string;
    authorization: string;
    environmentId: string | undefined;
    repositoryKey: string;
    environments: readonly string[];
    reset: boolean;
    originPort: number;
  },
): void {
  if (
    pending.projectDirectory !== requested.projectDirectory ||
    pending.provisionerUrl !== requested.provisionerUrl ||
    pending.authorizationHash !== tokenHash(requested.authorization) ||
    pending.repositoryKey !== requested.repositoryKey ||
    pending.reset !== requested.reset ||
    pending.originPort !== requested.originPort ||
    (requested.environmentId !== undefined &&
      pending.environmentId !== requested.environmentId) ||
    JSON.stringify(pending.environments) !== JSON.stringify(requested.environments)
  ) {
    throw new Error(
      "Pagent found an unfinished init with different options. Retry the original command before changing the setup.",
    );
  }
}

async function readPendingInit(path: string): Promise<PendingInit | undefined> {
  const contents = await readOptionalText(path);
  if (contents === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(contents);
    const candidate = record(value);
    if (
      candidate?.version !== 2 ||
      typeof candidate.projectDirectory !== "string" ||
      typeof candidate.provisionerUrl !== "string" ||
      typeof candidate.authorizationHash !== "string" ||
      typeof candidate.environmentId !== "string" ||
      typeof candidate.repositoryKey !== "string" ||
      !Array.isArray(candidate.environments) ||
      !candidate.environments.every((value) => typeof value === "string") ||
      typeof candidate.reset !== "boolean" ||
      !Number.isSafeInteger(candidate.originPort) ||
      typeof candidate.idempotencyKey !== "string" ||
      typeof candidate.sourceToken !== "string" ||
      typeof candidate.contextKey !== "string"
    ) {
      throw new Error();
    }
    return candidate as unknown as PendingInit;
  } catch {
    throw new Error(
      `Pagent cannot read its pending init at ${path}. Restore or remove that file after checking the provisioner.`,
    );
  }
}

async function writePendingInit(path: string, pending: PendingInit): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dirname(path), 0o700);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(pending)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function requiredSecret(value: string | undefined, name: string): string {
  if (value === undefined || value.trim() === "" || /[\r\n]/u.test(value)) {
    throw new Error(`${name} is required.`);
  }
  return value.trim();
}

function requirePort(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error("Pagent local ingress port must be from 1 to 65535.");
  }
}

function encryptionKeyId(key: string): string {
  return `key_${createHash("sha256").update(key).digest("base64url").slice(0, 16)}`;
}

function tokenHash(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
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

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
