import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, isAbsolute, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_STOP_TIMEOUT_MS = 5_000;
const READY_MARKER = /Registered tunnel connection/i;
const OUTPUT_WINDOW_SIZE = 4_096;

export type TunnelProcessState =
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "failed";

export interface TunnelProcessHealth {
  state: TunnelProcessState;
  running: boolean;
  ready: boolean;
  pid?: number | undefined;
  startedAt: string;
  readyAt?: string | undefined;
  exitCode?: number | undefined;
  signal?: NodeJS.Signals | undefined;
  error?: string | undefined;
}

export interface TunnelChildProcess {
  readonly stdout: NodeJS.ReadableStream;
  readonly stderr: NodeJS.ReadableStream;
  readonly pid?: number | undefined;
  readonly exitCode: number | null;
  kill(signal?: NodeJS.Signals | number): boolean;
  once(event: "error", listener: (error: Error) => void): this;
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): this;
}

export interface TunnelSpawnOptions {
  env: NodeJS.ProcessEnv;
  stdio: ["ignore", "pipe", "pipe"];
}

export type SpawnTunnelProcess = (
  command: string,
  args: readonly string[],
  options: TunnelSpawnOptions,
) => TunnelChildProcess;

export interface TunnelProcessDependencies {
  spawn?: SpawnTunnelProcess | undefined;
  access?:
    | ((path: string, mode?: number | undefined) => Promise<void>)
    | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  platform?: NodeJS.Platform | undefined;
  cwd?: string | undefined;
  now?: (() => Date) | undefined;
}

export interface ResolveCloudflaredBinaryOptions {
  binaryPath?: string | undefined;
  dependencies?: Pick<
    TunnelProcessDependencies,
    "access" | "cwd" | "env" | "platform"
  > | undefined;
}

export interface StartCloudflaredTunnelOptions {
  tokenFile: string;
  binaryPath?: string | undefined;
  stopTimeoutMs?: number | undefined;
  log?: ((message: string) => void) | undefined;
  dependencies?: TunnelProcessDependencies | undefined;
}

export interface CloudflaredTunnelProcess {
  /** Resolves after cloudflared registers its first tunnel connection. */
  readonly ready: Promise<void>;
  health(): TunnelProcessHealth;
  stop(): Promise<void>;
}

/** Resolves an explicit cloudflared path or finds the executable on PATH. */
export async function resolveCloudflaredBinary(
  options: ResolveCloudflaredBinaryOptions = {},
): Promise<string> {
  const dependencies = options.dependencies ?? {};
  const checkAccess = dependencies.access ?? access;
  const environment = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const cwd = dependencies.cwd ?? process.cwd();
  const configuredValue = options.binaryPath?.trim();
  const configured = configuredValue === "" ? undefined : configuredValue;

  if (configured !== undefined && hasPathSeparator(configured, platform)) {
    const path = isAbsolute(configured) ? configured : resolve(cwd, configured);
    await requireExecutable(path, checkAccess, platform);
    return path;
  }

  const executable = configured ?? defaultExecutable(platform);
  for (const directory of pathDirectories(environment.PATH, platform)) {
    const candidate = resolve(directory, executable);
    try {
      await checkAccess(candidate, executableAccessMode(platform));
      return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }

  throw new Error(
    configured === undefined
      ? "cloudflared was not found on PATH. Install it or configure its binary path."
      : `The configured cloudflared executable ${JSON.stringify(executable)} was not found on PATH.`,
  );
}

/** Starts one remotely managed Cloudflare Tunnel without putting its token in argv. */
export async function startCloudflaredTunnel(
  options: StartCloudflaredTunnelOptions,
): Promise<CloudflaredTunnelProcess> {
  const dependencies = options.dependencies ?? {};
  const checkAccess = dependencies.access ?? access;
  const tokenFile = resolve(dependencies.cwd ?? process.cwd(), options.tokenFile);
  await requireReadable(tokenFile, checkAccess);

  const binary = await resolveCloudflaredBinary({
    binaryPath: options.binaryPath,
    dependencies,
  });
  const childEnvironment = { ...(dependencies.env ?? process.env) };
  delete childEnvironment.TUNNEL_TOKEN;
  childEnvironment.TUNNEL_TOKEN_FILE = tokenFile;

  const spawnProcess = dependencies.spawn ?? defaultSpawn;
  const child = spawnProcess(
    binary,
    ["tunnel", "--no-autoupdate", "run"],
    {
      env: childEnvironment,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return supervise(child, options, dependencies.now ?? (() => new Date()));
}

function supervise(
  child: TunnelChildProcess,
  options: StartCloudflaredTunnelOptions,
  now: () => Date,
): CloudflaredTunnelProcess {
  const log = options.log ?? (() => undefined);
  const stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  if (!Number.isFinite(stopTimeoutMs) || stopTimeoutMs <= 0) {
    child.kill("SIGTERM");
    throw new Error("The cloudflared stop timeout must be positive.");
  }

  const startedAt = now().toISOString();
  let state: TunnelProcessState = "starting";
  let readyAt: string | undefined;
  let exitCode: number | undefined;
  let signal: NodeJS.Signals | undefined;
  let failure: string | undefined;
  let didClose = false;
  let outputWindow = "";
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  let resolveClosed: (() => void) | undefined;
  const ready = new Promise<void>((resolvePromise, rejectPromise) => {
    resolveReady = resolvePromise;
    rejectReady = rejectPromise;
  });
  // A caller can inspect health before choosing to await readiness.
  void ready.catch(() => undefined);
  const closed = new Promise<void>((resolvePromise) => {
    resolveClosed = resolvePromise;
  });

  const inspectOutput = (chunk: unknown) => {
    if (state !== "starting") {
      return;
    }
    outputWindow = `${outputWindow}${String(chunk)}`.slice(-OUTPUT_WINDOW_SIZE);
    if (!READY_MARKER.test(outputWindow)) {
      return;
    }
    state = "ready";
    readyAt = now().toISOString();
    outputWindow = "";
    log("[pagent] Cloudflare Tunnel connected");
    resolveReady?.();
  };
  child.stdout.on("data", inspectOutput);
  child.stderr.on("data", inspectOutput);

  child.once("error", () => {
    if (state === "stopping" || state === "stopped") {
      return;
    }
    state = "failed";
    failure = "cloudflared could not be started.";
    log("[pagent] Cloudflare Tunnel failed to start");
    rejectReady?.(new Error(failure));
  });
  child.once("close", (code, closeSignal) => {
    didClose = true;
    exitCode = code ?? undefined;
    signal = closeSignal ?? undefined;
    if (state === "stopping") {
      state = "stopped";
      log("[pagent] Cloudflare Tunnel stopped");
    } else if (state === "failed") {
      resolveClosed?.();
      return;
    } else {
      state = "failed";
      failure =
        readyAt === undefined
          ? "cloudflared exited before the tunnel was ready."
          : "cloudflared exited unexpectedly.";
      log("[pagent] Cloudflare Tunnel exited unexpectedly");
      rejectReady?.(new Error(failure));
    }
    resolveClosed?.();
  });

  return {
    ready,
    health() {
      return {
        state,
        running:
          state === "starting" || state === "ready" || state === "stopping",
        ready: state === "ready",
        pid: child.pid,
        startedAt,
        readyAt,
        exitCode,
        signal,
        error: failure,
      };
    },
    async stop() {
      if (state === "stopped") {
        return;
      }
      if (state === "failed" && didClose) {
        await closed;
        return;
      }
      if (state !== "stopping") {
        if (state === "starting") {
          rejectReady?.(
            new Error("cloudflared was stopped before the tunnel was ready."),
          );
        }
        state = "stopping";
        child.kill("SIGTERM");
      }

      if (await closesWithin(closed, stopTimeoutMs)) {
        return;
      }
      child.kill("SIGKILL");
      if (!(await closesWithin(closed, stopTimeoutMs))) {
        throw new Error("cloudflared did not stop after SIGKILL.");
      }
    },
  };
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: TunnelSpawnOptions,
): TunnelChildProcess {
  return spawn(command, args, options);
}

async function requireExecutable(
  path: string,
  checkAccess: (path: string, mode?: number | undefined) => Promise<void>,
  platform: NodeJS.Platform,
): Promise<void> {
  try {
    await checkAccess(path, executableAccessMode(platform));
  } catch (cause) {
    throw new Error(
      `The configured cloudflared binary is not executable: ${path}`,
      { cause },
    );
  }
}

async function requireReadable(
  path: string,
  checkAccess: (path: string, mode?: number | undefined) => Promise<void>,
): Promise<void> {
  try {
    await checkAccess(path, constants.R_OK);
  } catch (cause) {
    throw new Error(
      `The Cloudflare Tunnel token file is not readable: ${path}`,
      { cause },
    );
  }
}

function executableAccessMode(platform: NodeJS.Platform): number {
  return platform === "win32" ? constants.F_OK : constants.X_OK;
}

function defaultExecutable(platform: NodeJS.Platform): string {
  return platform === "win32" ? "cloudflared.exe" : "cloudflared";
}

function pathDirectories(
  path: string | undefined,
  platform: NodeJS.Platform,
): string[] {
  if (path === undefined) {
    return [];
  }
  const pathDelimiter =
    platform === process.platform
      ? delimiter
      : platform === "win32"
        ? ";"
        : ":";
  return path.split(pathDelimiter).filter((entry) => entry.length > 0);
}

function hasPathSeparator(path: string, platform: NodeJS.Platform): boolean {
  return (
    isAbsolute(path) ||
    path.includes(sep) ||
    (platform === "win32" && /[\\/]/.test(path))
  );
}

function closesWithin(
  closed: Promise<void>,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const timeout = setTimeout(() => resolvePromise(false), timeoutMs);
    timeout.unref();
    void closed.then(() => {
      clearTimeout(timeout);
      resolvePromise(true);
    });
  });
}
