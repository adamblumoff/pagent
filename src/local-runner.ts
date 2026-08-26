import { readFile } from "node:fs/promises";

import { codexAgent } from "./codex.js";
import type { ConnectorConfig } from "./config.js";
import {
  createRelayConnector,
  type RelayTask,
  type RelayTaskLifecycleUpdate,
} from "./connector.js";
import {
  FileHandoffHistory,
  type HandoffHistoryRecord,
} from "./handoff-history.js";
import {
  startLocalControlServer,
  type LocalDaemonStatus,
} from "./local-control.js";
import {
  ensureLocalStateDirectory,
  type LocalStatePaths,
} from "./local-state.js";

const STARTUP_TIMEOUT_MS = 10_000;

export interface LocalRunnerOptions {
  config: ConnectorConfig;
  paths: LocalStatePaths;
  onReady?: (status: LocalDaemonStatus) => void | Promise<void>;
  log?: (message: string) => void;
  startupTimeoutMs?: number;
}

export async function runLocalConnector(
  options: LocalRunnerOptions,
): Promise<void> {
  const startedAt = new Date().toISOString();
  const abort = new AbortController();
  const log = options.log ?? ((message: string) => console.log(message));
  const status: LocalDaemonStatus = {
    version: 1,
    pid: process.pid,
    startedAt,
    controlEndpoint: options.paths.controlEndpoint,
    phase: "starting",
    relayConnected: false,
    pendingTasks: 0,
  };
  const history = new FileHandoffHistory(options.paths.historyPath);
  let ready = false;
  let resolveReady: (() => void) | undefined;
  let rejectReady: ((error: Error) => void) | undefined;
  const firstConnection = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const stop = () => {
    if (abort.signal.aborted) {
      return;
    }
    status.phase = "stopping";
    log("[pagent] stopping");
    abort.abort();
  };
  const onSignal = () => stop();

  await ensureLocalStateDirectory(options.paths);
  const control = await startLocalControlServer({
    endpoint: options.paths.controlEndpoint,
    getStatus: () => daemonStatus(status, options.paths.inboxPath, history),
    onStop: stop,
  });

  try {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    status.phase = "connecting";
    const connector = createRelayConnector({
      url: connectorEventsUrl(
        options.config.relay.url,
        options.config.relay.connectorId,
      ),
      token: options.config.relay.token,
      inboxPath: options.paths.inboxPath,
      repositories: options.config.repositories,
      environments: options.config.environments,
      encryption: options.config.encryption,
      agent: codexAgent(options.config.codex),
      onTaskLifecycle: (update, task) =>
        recordTaskLifecycle(history, update, task),
      onConnectionChange: (connected) => {
        status.relayConnected = connected;
        if (connected) {
          log("[pagent] relay connected");
          status.phase = "ready";
          if (!ready) {
            ready = true;
            resolveReady?.();
          }
        } else if (!abort.signal.aborted) {
          log("[pagent] relay disconnected; reconnecting");
          status.phase = "reconnecting";
        }
      },
      onAgentResult: (result, task) => {
        log(
          `[pagent] ${task.type} diagnosis thread: ${result.threadId ?? "unknown"}`,
        );
      },
      onError: (error) => {
        const message = safeErrorMessage(error);
        log(`[pagent] connector error: ${message}`);
        status.lastError = {
          message,
          occurredAt: new Date().toISOString(),
        };
        if (!ready) {
          rejectReady?.(new Error(message));
        }
      },
    });
    const connectorRun = connector.run({ signal: abort.signal });

    try {
      await waitForStartup(
        firstConnection,
        options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      );
      await options.onReady?.(
        await daemonStatus(status, options.paths.inboxPath, history),
      );
      await connectorRun;
    } catch (error) {
      abort.abort();
      await connectorRun;
      throw error;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await control.close();
  }
}

async function daemonStatus(
  status: LocalDaemonStatus,
  inboxPath: string,
  history: FileHandoffHistory,
): Promise<LocalDaemonStatus> {
  const records = await history.list();
  const lastHandoff = records.find((record) => record.status === "completed");
  const lastError = records.find(
    (record) =>
      record.status === "retrying" && record.lastErrorMessage !== undefined,
  );
  const handoffError =
    lastError?.lastErrorMessage === undefined
      ? undefined
      : {
          message: lastError.lastErrorMessage,
          occurredAt: lastError.lastAttemptAt ?? lastError.receivedAt,
        };
  const latestError = newerError(status.lastError, handoffError);
  return {
    ...status,
    pendingTasks: await pendingTaskCount(inboxPath),
    ...(lastHandoff?.completedAt === undefined
      ? {}
      : {
          lastHandoff: {
            eventType: lastHandoff.eventType,
            completedAt: lastHandoff.completedAt,
            ...(lastHandoff.threadId === undefined
              ? {}
              : { threadId: lastHandoff.threadId }),
          },
        }),
    ...(latestError === undefined ? {} : { lastError: latestError }),
  };
}

function newerError(
  first: LocalDaemonStatus["lastError"],
  second: LocalDaemonStatus["lastError"],
): LocalDaemonStatus["lastError"] {
  if (first === undefined) return second;
  if (second === undefined) return first;
  return Date.parse(first.occurredAt) >= Date.parse(second.occurredAt)
    ? first
    : second;
}

async function recordTaskLifecycle(
  history: FileHandoffHistory,
  update: RelayTaskLifecycleUpdate,
  task: RelayTask,
): Promise<void> {
  let record = await history.findByEventId(task.eventId);
  if (record === undefined) {
    record = await history.upsert({
      taskId: task.id,
      eventId: task.eventId,
      eventType: task.type,
      environment: task.environment,
      status: "received",
      attempts: 0,
      receivedAt: update.occurredAt,
    });
  }

  const patch = lifecyclePatch(record, update);
  if (patch !== undefined) {
    await history.update(task.id, patch);
  }
}

function lifecyclePatch(
  record: HandoffHistoryRecord,
  update: RelayTaskLifecycleUpdate,
): Parameters<FileHandoffHistory["update"]>[1] | undefined {
  if (update.status === "received") {
    return undefined;
  }
  if (update.status === "running") {
    return {
      status: "running",
      attempts: record.attempts + 1,
      startedAt: record.startedAt ?? update.occurredAt,
      lastAttemptAt: update.occurredAt,
      lastErrorCode: undefined,
      lastErrorMessage: undefined,
    };
  }
  if (update.status === "retrying") {
    return {
      status: "retrying",
      lastAttemptAt: update.occurredAt,
      lastErrorCode: update.errorCode,
      lastErrorMessage: update.errorMessage,
    };
  }
  return {
    status: "completed",
    completedAt: update.occurredAt,
    lastErrorCode: undefined,
    lastErrorMessage: undefined,
    ...(update.threadId === undefined ? {} : { threadId: update.threadId }),
  };
}

function connectorEventsUrl(baseUrl: string, connectorId: string): string {
  return new URL(
    `/v1/connectors/${encodeURIComponent(connectorId)}/events`,
    baseUrl,
  ).toString();
}

async function waitForStartup(
  connection: Promise<void>,
  timeoutMs: number,
): Promise<void> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Pagent startup timeout must be positive.");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      connection,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Pagent relay connection timed out.")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

async function pendingTaskCount(inboxPath: string): Promise<number> {
  try {
    const value: unknown = JSON.parse(await readFile(inboxPath, "utf8"));
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      (value.version === 2 || value.version === 3 || value.version === 4) &&
      "pending" in value &&
      Array.isArray(value.pending)
    ) {
      return value.pending.length;
    }
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") {
      return 0;
    }
  }
  return 0;
}

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unknown connector error.";
  }
  return error.message
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s]+/giu, "[relay URL]");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
