#!/usr/bin/env node

import { spawn, type ChildProcess } from "node:child_process";
import { open, readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  CliUsageError,
  parseCliArgs,
  renderCliHelp,
  type CliCommand,
} from "./cli-args.js";
import { runDoctor, type DoctorReport } from "./doctor.js";
import { runProjectInit } from "./init.js";
import { loadConnectorConfig, type LoadedConnectorConfig } from "./local-config.js";
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

const VERSION = "0.0.0";
const DAEMON_ENVIRONMENT_KEY = "PAGENT_INTERNAL_DAEMON";
const START_RECEIPT_TIMEOUT_MS = 15_000;

interface DaemonReceipt {
  type: "ready" | "error";
  status?: LocalDaemonStatus;
  message?: string;
}

async function main(): Promise<void> {
  if (process.env[DAEMON_ENVIRONMENT_KEY] === "1") {
    await daemonMain();
    return;
  }

  let command: CliCommand;
  try {
    command = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      console.error("Run `pagent --help` for usage.");
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }

  switch (command.name) {
    case "help":
      console.log(renderCliHelp(command.command));
      return;
    case "version":
      console.log(VERSION);
      return;
    case "init":
      await initCommand(command);
      return;
    case "doctor":
      await doctorCommand(command.json);
      return;
    case "start":
      await startCommand(command.foreground, command.skipDoctor);
      return;
    case "stop":
      await stopCommand();
      return;
    case "status":
      await statusCommand(command.json);
      return;
    case "logs":
      await logsCommand(command.lines, command.follow);
      return;
  }
}

async function initCommand(
  command: Extract<CliCommand, { name: "init" }>,
): Promise<void> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  const relayUrl = await initValue({
    value: command.relay ?? process.env.PAGENT_RELAY_URL,
    interactive,
    prompt: "Relay URL: ",
    missing:
      "Relay URL is required. Pass `--relay <url>` or set PAGENT_RELAY_URL.",
  });
  const enrollmentToken = await initValue({
    value: command.enrollment ?? process.env.PAGENT_ENROLLMENT_TOKEN,
    interactive,
    prompt: "Enrollment token: ",
    hidden: true,
    missing:
      "Enrollment token is required. Pass `--enrollment <token>` or set PAGENT_ENROLLMENT_TOKEN.",
  });

  if (!command.yes) {
    if (!interactive) {
      throw new Error(
        "Pagent init needs confirmation in a non-interactive shell. Review the options, then add `--yes`.",
      );
    }
    const answer = await question(
      `Enroll this repository for ${command.environments.join(", ")} and ${
        command.noStart ? "leave the connector stopped" : "start the connector"
      }? [y/N] `,
    );
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Pagent init cancelled.");
      return;
    }
  }

  console.log("Checking Git, Codex, and relay enrollment.");
  const initialized = await runProjectInit({
    relayUrl,
    enrollmentToken,
    environments: command.environments,
    reset: command.reset,
  });
  process.chdir(initialized.projectDirectory);

  console.log(`\nPagent initialized for ${initialized.repositoryKey}.`);
  console.log(`Connector config: ${initialized.configPath}`);
  console.log(`Cloud environment: ${initialized.cloudEnvironmentPath}`);

  if (command.noStart) {
    await doctorCommand(false);
    if (process.exitCode === undefined) {
      console.log("\nThe connector is stopped. Run `pagent start` when you are ready.");
    }
    return;
  }
  await startCommand(false, false);
}

async function initValue(options: {
  value: string | undefined;
  interactive: boolean;
  prompt: string;
  missing: string;
  hidden?: boolean;
}): Promise<string> {
  const value = options.value?.trim();
  if (value) return value;
  if (!options.interactive) throw new Error(options.missing);
  const answer = (await question(options.prompt, options.hidden === true)).trim();
  if (!answer) throw new Error(options.missing);
  return answer;
}

async function question(prompt: string, hidden = false): Promise<string> {
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

async function doctorCommand(json: boolean): Promise<void> {
  let loaded: LoadedConnectorConfig;
  try {
    loaded = await loadConnectorConfig();
  } catch (error) {
    const detail = safeErrorMessage(error);
    if (json) {
      console.log(JSON.stringify({ ok: false, warnings: 0, checks: [{
        id: "config",
        label: "Connector configuration",
        status: "fail",
        detail,
      }] }, null, 2));
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
  if (!report.ok) {
    process.exitCode = 1;
  }
}

async function startCommand(
  foreground: boolean,
  skipDoctor: boolean,
): Promise<void> {
  const loaded = await loadConnectorConfig();
  const paths = localStatePaths({ stateDirectory: loaded.config.stateDirectory });
  const existing = await existingDaemon(paths);
  if (existing !== undefined) {
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

  const status = await startBackground(loaded, paths);
  console.log(
    `\nPagent started in the background (PID ${status.pid}, relay connected).`,
  );
}

async function startBackground(
  loaded: LoadedConnectorConfig,
  paths: LocalStatePaths,
): Promise<LocalDaemonStatus> {
  await ensureLocalStateDirectory(paths);
  const log = await open(paths.logPath, "a", 0o600);
  let child: ChildProcess | undefined;
  try {
    child = spawn(
      process.execPath,
      [...process.execArgv, fileURLToPath(import.meta.url)],
      {
      cwd: loaded.projectDirectory,
      detached: true,
      env: { ...process.env, [DAEMON_ENVIRONMENT_KEY]: "1" },
      stdio: ["ignore", log.fd, log.fd, "ipc"],
      },
    );
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

async function daemonMain(): Promise<void> {
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
    const message = safeErrorMessage(error);
    sendDaemonReceipt({ type: "error", message });
    console.error(`[pagent] startup failed: ${message}`);
    process.exitCode = 1;
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
      () => finish(new Error("Pagent daemon did not report ready before the timeout.")),
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

async function statusCommand(json: boolean): Promise<void> {
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
  console.log(`Relay: ${status.relayConnected ? "connected" : "disconnected"}`);
  console.log(`Pending tasks: ${status.pendingTasks}`);
  if (status.lastHandoff !== undefined) {
    console.log(
      `Last handoff: ${status.lastHandoff.eventType} → ${status.lastHandoff.threadId ?? "unknown thread"}`,
    );
  }
  if (status.lastError !== undefined) {
    console.log(`Last error: ${status.lastError.message}`);
  }
}

async function stopCommand(): Promise<void> {
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

async function logsCommand(lines: number, follow: boolean): Promise<void> {
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

async function doctorReport(
  loaded: LoadedConnectorConfig,
  paths: LocalStatePaths,
  includeAdvisories: boolean,
): Promise<DoctorReport> {
  return runDoctor({
    relayUrl: loaded.config.relay.url,
    connectorId: loaded.config.relay.connectorId,
    connectorToken: loaded.config.relay.token,
    inboxPath: paths.inboxPath,
    repositories: loaded.config.repositories,
    environments: loaded.config.environments,
    encryption: loaded.config.encryption,
    codex: loaded.config.codex,
    includeAdvisories,
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
      for (const step of steps) {
        console.log(`           ${step}`);
      }
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

function safeErrorMessage(error: unknown): string {
  const messages: string[] = [];
  let current: unknown = error;
  while (current instanceof Error && messages.length < 3) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages
    .join(" ")
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s]+/giu, "[relay URL]");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

main().catch((error: unknown) => {
  console.error(safeErrorMessage(error));
  process.exitCode = 1;
});
