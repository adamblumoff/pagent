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
import { hostname } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { probeCodexAppServer } from "./codex.js";

const execFileAsync = promisify(execFile);
const DEFAULT_ENVIRONMENTS = ["staging"] as const;
const DEFAULT_TIMEOUT_MS = 10_000;
const KEY_ID = "current";
const CONFIG_NAMES = [
  "pagent.config.ts",
  "pagent.config.mts",
  "pagent.config.mjs",
  "pagent.config.js",
] as const;

export interface ProjectInitOptions {
  cwd?: string | undefined;
  relayUrl: string;
  enrollmentToken: string;
  environments?: readonly string[] | undefined;
  reset?: boolean | undefined;
  /** Intended for controlled tests and migrations, not the public CLI. */
  connectorId?: string | undefined;
}

export interface ProjectInitResult {
  projectDirectory: string;
  repositoryKey: string;
  connectorId: string;
  relayUrl: string;
  environments: readonly string[];
  configPath: string;
  localEnvironmentPath: string;
  cloudEnvironmentPath: string;
  gitIgnorePath: string;
}

export interface ProjectInitDependencies {
  fetch?: EnrollmentFetch | undefined;
  findGitRoot?: ((cwd: string) => Promise<string>) | undefined;
  probeCodex?: (() => Promise<void>) | undefined;
  randomBytes?: ((size: number) => Uint8Array) | undefined;
  hostname?: (() => string) | undefined;
  timeoutMs?: number | undefined;
}

export type EnrollmentFetch = (
  input: string | URL,
  init: RequestInit,
) => Promise<Pick<Response, "json" | "ok" | "status">>;

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

export async function runProjectInit(
  options: ProjectInitOptions,
  dependencies: ProjectInitDependencies = {},
): Promise<ProjectInitResult> {
  const relayUrl = normalizeRelayUrl(options.relayUrl);
  const enrollmentToken = requiredSecret(
    options.enrollmentToken,
    "Enrollment token",
  );
  const environments = normalizeEnvironments(options.environments);
  const cwd = resolve(options.cwd ?? process.cwd());
  const findGitRoot = dependencies.findGitRoot ?? defaultFindGitRoot;
  const projectDirectory = resolve(await findGitRoot(cwd));
  const repositoryKey = identifier(basename(projectDirectory), "repository");
  const paths = setupPaths(projectDirectory);

  await requireAvailableTargets(projectDirectory, paths, options.reset === true);
  const existingGitIgnore = await readOptionalText(paths.gitIgnorePath);
  await requireCodex(dependencies.probeCodex);

  const makeRandomBytes = dependencies.randomBytes ?? randomBytes;
  const connectorId =
    options.connectorId === undefined
      ? generatedConnectorId(
          repositoryKey,
          (dependencies.hostname ?? hostname)(),
          makeRandomBytes,
        )
      : requiredIdentifier(options.connectorId, "Connector ID");
  const sourceToken = `pgsrc_${encode(makeRandomBytes(32))}`;
  const connectorToken = `pgcon_${encode(makeRandomBytes(32))}`;
  const contextKey = encode(makeRandomBytes(32));

  await enroll(
    {
      relayUrl,
      enrollmentToken,
      connectorId,
      repositoryKey,
      environments,
      sourceToken,
      connectorToken,
    },
    dependencies.fetch ?? defaultFetch,
    dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const keyring = JSON.stringify({ [KEY_ID]: contextKey });
  const files: SetupFile[] = [
    {
      path: paths.configPath,
      contents: connectorConfig({
        connectorId,
        environments,
        relayUrl,
        repositoryKey,
      }),
      mode: 0o644,
    },
    {
      path: paths.localEnvironmentPath,
      contents: environmentFile({
        PAGENT_CONNECTOR_TOKEN: connectorToken,
        PAGENT_CONTEXT_KEYS: keyring,
      }),
      mode: 0o600,
    },
    {
      path: paths.cloudEnvironmentPath,
      contents: environmentFile({
        PAGENT_ENABLED: "true",
        PAGENT_ENV: environments[0]!,
        PAGENT_RELAY_URL: relayUrl,
        PAGENT_RELAY_TOKEN: sourceToken,
        PAGENT_ENCRYPTION_KEY_ID: KEY_ID,
        PAGENT_ENCRYPTION_KEY: contextKey,
      }),
      mode: 0o600,
    },
    {
      path: paths.gitIgnorePath,
      contents: addGitIgnoreEntry(existingGitIgnore),
      mode: 0o644,
    },
  ];

  await writeSetupFiles(paths.setupDirectory, files);

  return {
    projectDirectory,
    repositoryKey,
    connectorId,
    relayUrl,
    environments,
    configPath: paths.configPath,
    localEnvironmentPath: paths.localEnvironmentPath,
    cloudEnvironmentPath: paths.cloudEnvironmentPath,
    gitIgnorePath: paths.gitIgnorePath,
  };
}

async function defaultFindGitRoot(cwd: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["rev-parse", "--show-toplevel"],
      { cwd, encoding: "utf8" },
    );
    const root = stdout.trim();
    if (root !== "") {
      return root;
    }
  } catch {
    // Replaced with a stable, actionable error below.
  }
  throw new Error(
    "Pagent init must run inside a Git repository. Create or clone the repository, then run `pagent init` again.",
  );
}

async function requireCodex(probe: (() => Promise<void>) | undefined): Promise<void> {
  try {
    await (probe ?? (() => probeCodexAppServer({ timeoutMs: 5_000 })))();
  } catch {
    throw new Error(
      "Codex must be installed and signed in before Pagent can initialize. Run `codex login`, then run `pagent init` again.",
    );
  }
}

async function enroll(
  input: {
    relayUrl: string;
    enrollmentToken: string;
    connectorId: string;
    repositoryKey: string;
    environments: readonly string[];
    sourceToken: string;
    connectorToken: string;
  },
  fetchEnrollment: EnrollmentFetch,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Enrollment timeout must be a positive integer.");
  }

  let response: Pick<Response, "json" | "ok" | "status">;
  try {
    response = await fetchEnrollment(new URL("/v1/enroll", input.relayUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.enrollmentToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 1,
        connectorId: input.connectorId,
        repositoryKey: input.repositoryKey,
        allowedEnvironments: input.environments,
        sourceTokenHash: tokenHash(input.sourceToken),
        connectorTokenHash: tokenHash(input.connectorToken),
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error(
      "Pagent could not reach the relay enrollment endpoint. Check the relay URL and network connection, then run `pagent init` again.",
    );
  }

  if (!response.ok) {
    throw new Error(
      `Relay enrollment failed with HTTP ${response.status}. Check the enrollment code and relay configuration, then run \`pagent init\` again.`,
    );
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch {
    throw invalidEnrollmentResponse(response.status);
  }
  if (
    typeof result !== "object" ||
    result === null ||
    !("status" in result) ||
    (result.status !== "enrolled" && result.status !== "existing")
  ) {
    throw invalidEnrollmentResponse(response.status);
  }
}

function invalidEnrollmentResponse(status: number): Error {
  return new Error(
    `Relay enrollment returned an invalid response with HTTP ${status}. Check that the relay supports enrollment, then run \`pagent init\` again.`,
  );
}

async function defaultFetch(
  input: string | URL,
  init: RequestInit,
): Promise<Response> {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("This Node.js installation does not provide fetch.");
  }
  return globalThis.fetch(input, init);
}

function setupPaths(projectDirectory: string): {
  setupDirectory: string;
  configPath: string;
  localEnvironmentPath: string;
  cloudEnvironmentPath: string;
  gitIgnorePath: string;
} {
  const setupDirectory = join(projectDirectory, ".pagent");
  return {
    setupDirectory,
    configPath: join(projectDirectory, "pagent.config.ts"),
    localEnvironmentPath: join(setupDirectory, "local.env"),
    cloudEnvironmentPath: join(setupDirectory, "cloud.env"),
    gitIgnorePath: join(projectDirectory, ".gitignore"),
  };
}

async function requireAvailableTargets(
  projectDirectory: string,
  paths: ReturnType<typeof setupPaths>,
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
  ];
  const existing = (
    await Promise.all(
      managed.map(async (path) => ((await exists(path)) ? path : undefined)),
    )
  ).filter((path): path is string => path !== undefined);

  if (existing.length > 0 && !reset) {
    throw new Error(
      `Pagent is already initialized at ${projectDirectory}. Run \`pagent init --reset\` to replace only pagent.config.ts and the managed .pagent environment files.`,
    );
  }

  for (const path of existing) {
    if (!(await stat(path)).isFile()) {
      throw new Error(`Pagent cannot replace ${path} because it is not a file.`);
    }
  }
}

async function writeSetupFiles(
  setupDirectory: string,
  files: readonly SetupFile[],
): Promise<void> {
  const setupDirectoryExisted = await exists(setupDirectory);
  await mkdir(setupDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(setupDirectory, 0o700);
  }

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
      if (process.platform !== "win32") {
        await chmod(file.path, file.mode);
      }
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
      "Pagent enrolled the repository but could not write the local setup files. Check repository permissions, then run `pagent init --reset`.",
    );
  }
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
    if (isMissing(error)) {
      return { path: file.path };
    }
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

function connectorConfig(input: {
  connectorId: string;
  environments: readonly string[];
  relayUrl: string;
  repositoryKey: string;
}): string {
  return `import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConnectorConfig } from "pagent/connector";

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConnectorConfig({
  relay: {
    url: ${JSON.stringify(input.relayUrl)},
    token: required("PAGENT_CONNECTOR_TOKEN"),
    connectorId: ${JSON.stringify(input.connectorId)},
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

function environmentFile(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values)
    .map(([name, value]) => `${name}='${value}'`)
    .join("\n")}\n`;
}

function addGitIgnoreEntry(current: string | undefined): string {
  if (current?.split(/\r?\n/u).some((line) => line.trim() === ".pagent/")) {
    return current;
  }
  if (current === undefined || current === "") {
    return ".pagent/\n";
  }
  return `${current.endsWith("\n") ? current : `${current}\n`}.pagent/\n`;
}

function normalizeRelayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Relay URL must be a valid HTTPS URL.");
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Relay URL cannot contain credentials, a query, or a fragment.");
  }
  if (url.pathname !== "/") {
    throw new Error("Relay URL must be an origin without a path.");
  }

  const localHost =
    url.hostname === "localhost" ||
    url.hostname === "127.0.0.1" ||
    url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost)) {
    throw new Error(
      "Relay URL must use HTTPS. Plain HTTP is allowed only for localhost, 127.0.0.1, or ::1.",
    );
  }
  return url.origin;
}

function normalizeEnvironments(values: readonly string[] | undefined): string[] {
  const environments = values ?? DEFAULT_ENVIRONMENTS;
  if (
    environments.length === 0 ||
    environments.some(
      (value) =>
        value.length > 100 ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value),
    )
  ) {
    throw new Error(
      "Allowed environments must use letters, numbers, periods, underscores, or hyphens and be at most 100 characters.",
    );
  }
  if (new Set(environments).size !== environments.length) {
    throw new Error("Allowed environments cannot contain duplicates.");
  }
  return [...environments];
}

function generatedConnectorId(
  repositoryKey: string,
  machineName: string,
  makeRandomBytes: (size: number) => Uint8Array,
): string {
  const machine = identifier(machineName, "machine").slice(0, 40);
  return `${repositoryKey.slice(0, 80)}-${machine}-${encode(makeRandomBytes(6))}`;
}

function requiredIdentifier(value: string, name: string): string {
  if (
    value === "" ||
    value !== value.trim() ||
    value.length > 200 ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)
  ) {
    throw new Error(
      `${name} must use letters, numbers, periods, underscores, or hyphens and be at most 200 characters.`,
    );
  }
  return value;
}

function identifier(value: string, fallback: string): string {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 80) || fallback
  );
}

function requiredSecret(value: string, name: string): string {
  if (value === "" || value !== value.trim() || /[\r\n]/u.test(value)) {
    throw new Error(
      `${name} must be a non-empty value without surrounding whitespace.`,
    );
  }
  return value;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function encode(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

async function readOptionalText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    throw error;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
