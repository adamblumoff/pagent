import { createHash } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface LocalStatePaths {
  directory: string;
  historyPath: string;
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
    historyPath: join(directory, "handoffs.json"),
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
