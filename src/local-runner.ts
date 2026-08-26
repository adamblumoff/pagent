import { readFile } from "node:fs/promises";

import { codexAgent } from "./codex.js";
import type { ConnectorConfig } from "./config.js";
import { createRelayConnector } from "./connector.js";
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
    getStatus: async () => ({
      ...status,
      pendingTasks: await pendingTaskCount(options.paths.inboxPath),
    }),
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
        status.lastHandoff = {
          eventType: task.type,
          completedAt: new Date().toISOString(),
          ...(result.threadId === undefined ? {} : { threadId: result.threadId }),
        };
        log(
          `[pagent] ${task.type} diagnosis thread: ${result.threadId ?? "unknown"}`,
        );
      },
      onError: (error) => {
        const message = safeErrorMessage(error);
        status.lastError = { message, occurredAt: new Date().toISOString() };
        log(`[pagent] connector error: ${message}`);
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
      await options.onReady?.({
        ...status,
        pendingTasks: await pendingTaskCount(options.paths.inboxPath),
      });
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
