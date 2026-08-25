import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LocalStatePaths {
  directory: string;
  daemonMetadataPath: string;
  inboxPath: string;
  logPath: string;
  controlEndpoint: string;
}

export interface LocalStatePathOptions {
  stateDirectory?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  homeDirectory?: string | undefined;
}

/** Diagnostic process metadata. A successful control handshake is authoritative. */
export interface DaemonMetadata {
  version: 1;
  pid: number;
  startedAt: string;
  controlEndpoint: string;
}

export function localStatePaths(
  options: LocalStatePathOptions = {},
): LocalStatePaths {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homeDirectory ?? homedir();
  const explicitDirectory =
    options.stateDirectory ?? environment.PAGENT_STATE_DIR;
  if (explicitDirectory !== undefined && explicitDirectory.trim() === "") {
    throw new Error("Pagent state directory must not be empty.");
  }
  const directory = resolve(
    explicitDirectory ?? defaultStateDirectory(platform, environment, home),
  );

  return {
    directory,
    daemonMetadataPath: join(directory, "daemon.json"),
    inboxPath: join(directory, "inbox.json"),
    logPath: join(directory, "connector.log"),
    controlEndpoint:
      platform === "win32"
        ? windowsPipeName(directory)
        : join(directory, "control.sock"),
  };
}

export async function ensureLocalStateDirectory(
  paths: Pick<LocalStatePaths, "directory">,
): Promise<void> {
  await mkdir(paths.directory, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") {
    await chmod(paths.directory, 0o700);
  }
}

export async function readDaemonMetadata(
  paths: Pick<LocalStatePaths, "daemonMetadataPath">,
): Promise<DaemonMetadata | undefined> {
  try {
    return daemonMetadata(JSON.parse(await readFile(paths.daemonMetadataPath, "utf8")));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

export async function writeDaemonMetadata(
  paths: Pick<LocalStatePaths, "directory" | "daemonMetadataPath">,
  metadata: DaemonMetadata,
): Promise<void> {
  const validated = daemonMetadata(metadata);
  await ensureLocalStateDirectory(paths);
  const temporaryPath = `${paths.daemonMetadataPath}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryPath, `${JSON.stringify(validated)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, paths.daemonMetadataPath);
    if (process.platform !== "win32") {
      await chmod(paths.daemonMetadataPath, 0o600);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

/** Removes metadata only when it still describes the expected daemon. */
export async function removeDaemonMetadata(
  paths: Pick<LocalStatePaths, "daemonMetadataPath">,
  expectedPid: number,
): Promise<boolean> {
  const metadata = await readDaemonMetadata(paths);
  if (metadata === undefined || metadata.pid !== expectedPid) {
    return false;
  }

  try {
    await unlink(paths.daemonMetadataPath);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function defaultStateDirectory(
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  home: string,
): string {
  if (platform === "win32") {
    return join(environment.LOCALAPPDATA ?? join(home, "AppData", "Local"), "Pagent");
  }
  if (platform === "darwin") {
    return join(home, "Library", "Application Support", "Pagent");
  }
  return join(environment.XDG_STATE_HOME ?? join(home, ".local", "state"), "pagent");
}

function windowsPipeName(directory: string): string {
  const hash = createHash("sha256")
    .update(directory.toLowerCase())
    .digest("hex")
    .slice(0, 16);
  return `\\\\.\\pipe\\pagent-${hash}`;
}

function daemonMetadata(value: unknown): DaemonMetadata {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Pagent daemon metadata has an unsupported format.");
  }
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    throw new Error("Pagent daemon metadata has an invalid PID.");
  }
  if (!isIsoDate(value.startedAt)) {
    throw new Error("Pagent daemon metadata has an invalid start time.");
  }
  if (typeof value.controlEndpoint !== "string" || value.controlEndpoint === "") {
    throw new Error("Pagent daemon metadata has an invalid control endpoint.");
  }

  return {
    version: 1,
    pid: value.pid as number,
    startedAt: value.startedAt,
    controlEndpoint: value.controlEndpoint,
  };
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
