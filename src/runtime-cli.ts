import { spawn, type ChildProcess } from "node:child_process";
import { watch } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

import type { CliCommand } from "./cli-args.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import {
  loadConnectorConfig,
  type LoadedConnectorConfig,
} from "./local-config.js";
import {
  requestLocalControl,
  type LocalDaemonStatus,
} from "./local-control.js";
import { runLocalConnector } from "./local-runner.js";
import {
  ensureLocalStateDirectory,
  localStatePaths,
  type LocalStatePaths,
} from "./local-state.js";
import {
  installStartupService,
  removeStartupService,
  type StartupServiceOptions,
  type StartupServiceRegistration,
} from "./startup-service.js";
import { TunnelProvisioningClient } from "./tunnel-provisioning.js";

const DAEMON_ENVIRONMENT_KEY = "PAGENT_INTERNAL_DAEMON";
const START_RECEIPT_TIMEOUT_MS = 15_000;
const MANAGED_START_TIMEOUT_MS = 30_000;

interface DaemonReceipt {
  type: "ready" | "error";
  status?: LocalDaemonStatus;
  message?: string;
}

export function isDaemonInvocation(): boolean {
  return process.env[DAEMON_ENVIRONMENT_KEY] === "1";
}

export function isInteractive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export async function question(
  prompt: string,
  hidden = false,
): Promise<string> {
  let muted = false;
  const output = hidden
    ? new Writable({
        write(chunk, _encoding, callback) {
          if (!muted) process.stdout.write(chunk);
          callback();
        },
      })
    : process.stdout;
  const input = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = input.question(prompt);
    muted = hidden;
    const value = await answer;
    if (hidden) process.stdout.write("\n");
    return value;
  } finally {
    input.close();
  }
}

export async function runTunnelCommand(
  command: Extract<CliCommand, { name: "tunnel" }>,
  cliPath: string,
): Promise<void> {
  const loaded = await loadConnectorConfig();
  if (!command.yes) {
    if (!isInteractive()) {
      throw new Error(
        "Tunnel revocation needs confirmation in a non-interactive shell. Review the environment, then add `--yes`.",
      );
    }
    const answer = await question(
      `Delete tunnel ${loaded.config.tunnel.environmentId}? This environment will stop receiving events. [y/N] `,
    );
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Tunnel revocation cancelled.");
      return;
    }
  }
  const paths = localStatePaths({ stateDirectory: loaded.config.stateDirectory });
  const managementToken = process.env.PAGENT_MANAGEMENT_TOKEN?.trim();
  if (!managementToken) {
    throw new Error("PAGENT_MANAGEMENT_TOKEN is required to revoke this tunnel.");
  }
  const provisioner = new TunnelProvisioningClient({
    serviceUrl: loaded.config.tunnel.provisionerUrl,
  });
  await provisioner.delete({
    environmentId: loaded.config.tunnel.environmentId,
    managementToken,
    idempotencyKey: `revoke-${loaded.config.tunnel.environmentId}`,
  });
  const running = await existingDaemon(paths);
  if (running !== undefined) {
    await requestLocalControl(paths.controlEndpoint, { method: "stop" });
  }
  await removeStartupService(startupServiceOptions(loaded, paths, cliPath));
  console.log(`Revoked tunnel ${loaded.config.tunnel.environmentId}.`);
}

export async function stopConnectorForRotation(): Promise<void> {
  const loaded = await loadConnectorConfig();
  const paths = localStatePaths({ stateDirectory: loaded.config.stateDirectory });
  const running = await existingDaemon(paths);
  if (running === undefined) return;

  await requestLocalControl(paths.controlEndpoint, { method: "stop" });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await existingDaemon(paths)) === undefined) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(
    "The old connector did not stop after credential rotation. Run `pagent stop`, then `pagent start`.",
  );
}

export async function runDoctorCommand(json: boolean): Promise<void> {
  let loaded: LoadedConnectorConfig;
  try {
    loaded = await loadConnectorConfig();
  } catch (error) {
    const detail = safeCliErrorMessage(error);
    if (json) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            warnings: 0,
            checks: [
              {
                id: "config",
                label: "Connector configuration",
                status: "fail",
                detail,
              },
            ],
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`FAIL  Connector configuration  ${detail}`);
      console.log("\n0 passed · 0 warnings · 1 failed");
    }
    process.exitCode = 1;
    return;
  }

  const paths = localStatePaths({ stateDirectory: loaded.config.stateDirectory });
  const report = await doctorReport(loaded, paths, true);
  if (json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printDoctorReport(report);
  }
  if (!report.ok) process.exitCode = 1;
}

export async function runStartCommand(
  foreground: boolean,
  skipDoctor: boolean,
  cliPath: string,
): Promise<void> {
  const loaded = await loadConnectorConfig();
  const paths = localStatePaths({ stateDirectory: loaded.config.stateDirectory });
  const existing = await existingDaemon(paths);
  if (existing !== undefined) {
    if (!foreground) await enableStartup(loaded, paths, cliPath, false);
    console.log(
      `Pagent is already running (PID ${existing.pid}, ${existing.phase}).`,
    );
    return;
  }

  const report = await doctorReport(loaded, paths, !skipDoctor);
  printDoctorReport(report);
  if (!report.ok) {
    throw new Error("Pagent was not started. Fix the failed doctor checks first.");
  }

  if (foreground) {
    console.log("\nStarting Pagent in the foreground. Press Ctrl-C to stop.");
    await runLocalConnector({ config: loaded.config, paths });
    return;
  }

  const managed = await enableStartup(loaded, paths, cliPath, true);
  if (managed !== undefined) {
    const status = await waitForManagedStart(paths, managed.manager);
    console.log(
      `\nPagent started with ${managed.manager} (PID ${status.pid}, tunnel connected).`,
    );
    return;
  }

  const status = await startBackground(loaded, paths, cliPath);
  console.log(
    `\nPagent started in the background (PID ${status.pid}, tunnel connected).`,
  );
}

export async function runDaemonMain(): Promise<void> {
  delete process.env[DAEMON_ENVIRONMENT_KEY];
  try {
    const loaded = await loadConnectorConfig();
    const paths = localStatePaths({ stateDirectory: loaded.config.stateDirectory });
    await runLocalConnector({
      config: loaded.config,
      paths,
      onReady: (status) => sendDaemonReceipt({ type: "ready", status }),
    });
  } catch (error) {
    const message = safeCliErrorMessage(error);
    sendDaemonReceipt({ type: "error", message });
    console.error(`[pagent] startup failed: ${message}`);
    process.exitCode = 1;
  }
}

export async function runStatusCommand(json: boolean): Promise<void> {
  const paths = await commandStatePaths();
  const status = await existingDaemon(paths);
  if (status === undefined) {
    const stopped = { running: false, state: "stopped" };
    console.log(json ? JSON.stringify(stopped, null, 2) : "Pagent is stopped.");
    return;
  }
  if (json) {
    console.log(JSON.stringify({ running: true, ...status }, null, 2));
    return;
  }
  console.log(`Pagent is ${status.phase}.`);
  console.log(`PID: ${status.pid}`);
  console.log(
    `Ingress: ${status.ingressReady ? `listening on 127.0.0.1:${status.ingressPort}` : "stopped"}`,
  );
  console.log(`Tunnel: ${status.tunnelConnected ? "connected" : "disconnected"}`);
  console.log(`Hostname: ${status.tunnelHostname}`);
  if (status.lastHandoff !== undefined) {
    console.log(
      `Last handoff: ${status.lastHandoff.eventType} → ${status.lastHandoff.threadId ?? "unknown thread"}`,
    );
  }
  if (status.lastError !== undefined) {
    console.log(`Last error: ${status.lastError.message}`);
  }
}

export async function runStopCommand(): Promise<void> {
  const paths = await commandStatePaths();
  try {
    const status = await requestLocalControl(paths.controlEndpoint, {
      method: "status",
    });
    await requestLocalControl(paths.controlEndpoint, { method: "stop" });
    console.log(`Stopping Pagent (PID ${status.pid}).`);
  } catch (error) {
    if (isNoDaemonError(error)) {
      console.log("Pagent is already stopped.");
      return;
    }
    throw error;
  }
}

export async function runLogsCommand(
  lines: number,
  follow: boolean,
): Promise<void> {
  const paths = await commandStatePaths();
  const initial = await readLog(paths.logPath);
  const initialLines = initial.split(/\r?\n/u);
  if (initialLines.at(-1) === "") initialLines.pop();
  console.log(initialLines.slice(-lines).join("\n"));
  if (!follow) return;

  await ensureLocalStateDirectory(paths);
  let previous = initial;
  await new Promise<void>((resolve) => {
    let reading = false;
    let rerun = false;
    const printChanges = async () => {
      if (reading) {
        rerun = true;
        return;
      }
      reading = true;
      try {
        do {
          rerun = false;
          const current = await readLog(paths.logPath);
          const addition = current.startsWith(previous)
            ? current.slice(previous.length)
            : current;
          if (addition !== "") process.stdout.write(addition);
          previous = current;
        } while (rerun);
      } finally {
        reading = false;
      }
    };
    const watcher = watch(paths.directory, (_event, filename) => {
      if (filename?.toString() === "connector.log") void printChanges();
    });
    const stop = () => {
      watcher.close();
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

export function safeCliErrorMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 3) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages
    .join(" ")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s]+/giu, "[endpoint URL]");
}

async function enableStartup(
  loaded: LoadedConnectorConfig,
  paths: LocalStatePaths,
  cliPath: string,
  startImmediately: boolean,
): Promise<StartupServiceRegistration | undefined> {
  try {
    const options = {
      ...startupServiceOptions(loaded, paths, cliPath),
      startImmediately,
    };
    const service = await installStartupService(options);
    if (service === undefined) {
      console.warn(
        `Automatic startup is not supported on ${process.platform}. Start Pagent again after reboot.`,
      );
      return undefined;
    }
    console.log(`Automatic startup enabled with ${service.manager}.`);
    return service;
  } catch (error) {
    if (startImmediately) {
      try {
        await removeStartupService(startupServiceOptions(loaded, paths, cliPath));
      } catch {
        // The original installation error is more useful than cleanup failure here.
      }
    }
    console.warn(
      `Automatic startup could not be enabled: ${safeCliErrorMessage(error)}`,
    );
    return undefined;
  }
}

async function waitForManagedStart(
  paths: LocalStatePaths,
  manager: string,
): Promise<LocalDaemonStatus> {
  const deadline = Date.now() + MANAGED_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const status = await existingDaemon(paths);
    if (status?.phase === "ready") return status;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(
    `Pagent is registered with ${manager}, but it has not connected yet. The service will keep retrying; run \`pagent status\` to check it.`,
  );
}

function startupServiceOptions(
  loaded: LoadedConnectorConfig,
  paths: LocalStatePaths,
  cliPath: string,
): StartupServiceOptions {
  return {
    projectDirectory: loaded.projectDirectory,
    stateDirectory: paths.directory,
    logPath: paths.logPath,
    executablePath: process.execPath,
    cliPath,
    ...(typeof process.getuid === "function" ? { userId: process.getuid() } : {}),
  };
}

async function startBackground(
  loaded: LoadedConnectorConfig,
  paths: LocalStatePaths,
  cliPath: string,
): Promise<LocalDaemonStatus> {
  await ensureLocalStateDirectory(paths);
  const log = await open(paths.logPath, "a", 0o600);
  let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, [...process.execArgv, cliPath], {
      cwd: loaded.projectDirectory,
      detached: true,
      env: { ...process.env, [DAEMON_ENVIRONMENT_KEY]: "1" },
      stdio: ["ignore", log.fd, log.fd, "ipc"],
    });
    const receipt = await waitForDaemonReceipt(child, START_RECEIPT_TIMEOUT_MS);
    if (receipt.type === "error" || receipt.status === undefined) {
      throw new Error(receipt.message ?? "Pagent daemon failed during startup.");
    }
    const status = await requestLocalControl(paths.controlEndpoint, {
      method: "status",
    });
    if (status.pid !== child.pid || status.pid !== receipt.status.pid) {
      throw new Error("Pagent daemon returned inconsistent startup state.");
    }
    child.disconnect();
    child.unref();
    return status;
  } catch (error) {
    child?.kill();
    throw error;
  } finally {
    await log.close();
  }
}

function waitForDaemonReceipt(
  child: ChildProcess,
  timeoutMs: number,
): Promise<DaemonReceipt> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, receipt?: DaemonReceipt) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
      if (error === undefined && receipt !== undefined) resolve(receipt);
      else reject(error ?? new Error("Pagent daemon returned no startup receipt."));
    };
    const onError = (error: Error) => finish(error);
    const onExit = (code: number | null) =>
      finish(new Error(`Pagent daemon exited during startup with code ${code}.`));
    const onMessage = (message: unknown) => {
      if (isDaemonReceipt(message)) finish(undefined, message);
      else finish(new Error("Pagent daemon returned an invalid startup receipt."));
    };
    const timeout = setTimeout(
      () =>
        finish(
          new Error("Pagent daemon did not report ready before the timeout."),
        ),
      timeoutMs,
    );
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("message", onMessage);
  });
}

function sendDaemonReceipt(receipt: DaemonReceipt): void {
  if (typeof process.send === "function" && process.connected) {
    process.send(receipt);
  }
}

async function doctorReport(
  loaded: LoadedConnectorConfig,
  paths: LocalStatePaths,
  includeAdvisories: boolean,
): Promise<DoctorReport> {
  const daemon = await existingDaemon(paths);
  return runDoctor({
    ingress: loaded.config.ingress,
    tunnel: loaded.config.tunnel,
    repositories: loaded.config.repositories,
    environments: loaded.config.environments,
    encryption: loaded.config.encryption,
    codex: loaded.config.codex,
    includeAdvisories,
    ingressPortInUseByPagent: daemon !== undefined,
  });
}

function printDoctorReport(report: DoctorReport): void {
  for (const check of report.checks) {
    console.log(
      `${check.status.toUpperCase().padEnd(5)} ${check.label.padEnd(25)} ${check.detail}`,
    );
    if (check.remediation !== undefined) {
      const [summary, ...steps] = check.remediation.split("\n");
      console.log(`      Fix: ${summary}`);
      for (const step of steps) console.log(`           ${step}`);
    }
  }
  const passed = report.checks.filter(({ status }) => status === "pass").length;
  const failed = report.checks.filter(({ status }) => status === "fail").length;
  console.log(
    `\n${passed} passed · ${report.warnings} warning${report.warnings === 1 ? "" : "s"} · ${failed} failed`,
  );
}

async function commandStatePaths(): Promise<LocalStatePaths> {
  try {
    const loaded = await loadConnectorConfig();
    return localStatePaths({ stateDirectory: loaded.config.stateDirectory });
  } catch {
    return localStatePaths();
  }
}

async function existingDaemon(
  paths: LocalStatePaths,
): Promise<LocalDaemonStatus | undefined> {
  try {
    return await requestLocalControl(paths.controlEndpoint, { method: "status" });
  } catch (error) {
    if (isNoDaemonError(error)) return undefined;
    throw error;
  }
}

async function readLog(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return "";
    throw error;
  }
}

function isDaemonReceipt(value: unknown): value is DaemonReceipt {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    (value.type === "ready" || value.type === "error")
  );
}

function isNoDaemonError(error: unknown): boolean {
  return (
    isNodeError(error) &&
    (error.code === "ENOENT" ||
      error.code === "ECONNREFUSED" ||
      error.code === "ECONNRESET" ||
      error.code === "EPIPE")
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
