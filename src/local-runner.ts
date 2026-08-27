import { randomUUID } from "node:crypto";

import type { AgentResult } from "./agent.js";
import { codexAgent } from "./codex.js";
import type { ConnectorConfig } from "./config.js";
import { createEventContextEncryptor } from "./crypto.js";
import {
  FileHandoffHistory,
  type HandoffHistoryRecord,
  type HandoffStatus,
} from "./handoff-history.js";
import {
  startLocalControlServer,
  type LocalDaemonStatus,
} from "./local-control.js";
import {
  startLocalIngressServer,
  type LocalIngressLifecycleUpdate,
  type LocalIngressRoute,
  type LocalIngressServer,
} from "./local-ingress.js";
import {
  ensureLocalStateDirectory,
  type LocalStatePaths,
} from "./local-state.js";
import {
  startCloudflaredTunnel,
  type CloudflaredTunnelProcess,
} from "./tunnel-process.js";
import type { EncryptedPagentEvent, EventEnvelope } from "./types.js";
import { EVENT_PROTOCOL_VERSION } from "./version.js";

const STARTUP_TIMEOUT_MS = 20_000;
const HEALTH_POLL_MS = 250;

export interface LocalRunnerDependencies {
  startIngress?: typeof startLocalIngressServer | undefined;
  startTunnel?: typeof startCloudflaredTunnel | undefined;
  probe?: ((config: ConnectorConfig, signal: AbortSignal) => Promise<void>) | undefined;
}

export interface LocalRunnerOptions {
  config: ConnectorConfig;
  paths: LocalStatePaths;
  onReady?: (status: LocalDaemonStatus) => void | Promise<void>;
  log?: (message: string) => void;
  startupTimeoutMs?: number;
  dependencies?: LocalRunnerDependencies | undefined;
}

export async function runLocalConnector(
  options: LocalRunnerOptions,
): Promise<void> {
  const abort = new AbortController();
  const log = options.log ?? ((message: string) => console.log(message));
  const status: LocalDaemonStatus = {
    version: 1,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    controlEndpoint: options.paths.controlEndpoint,
    phase: "starting",
    ingressReady: false,
    ingressPort: options.config.ingress.port,
    tunnelConnected: false,
    tunnelHostname: options.config.tunnel.hostname,
  };
  const history = new FileHandoffHistory(options.paths.historyPath);
  const stop = () => {
    if (abort.signal.aborted) return;
    status.phase = "stopping";
    log("[pagent] stopping");
    abort.abort();
  };
  const onSignal = () => stop();

  await ensureLocalStateDirectory(options.paths);
  const control = await startLocalControlServer({
    endpoint: options.paths.controlEndpoint,
    getStatus: () => daemonStatus(status, history),
    onStop: stop,
  });
  let ingress: LocalIngressServer | undefined;
  let tunnel: CloudflaredTunnelProcess | undefined;

  try {
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    ingress = await (options.dependencies?.startIngress ?? startLocalIngressServer)({
      host: options.config.ingress.host,
      port: options.config.ingress.port,
      environmentId: options.config.tunnel.environmentId,
      source: {
        token: options.config.ingress.token,
        allowedEnvironments: options.config.environments,
      },
      repositories: options.config.repositories,
      encryption: options.config.encryption,
      agent: codexAgent(options.config.codex),
      onLifecycle: (update, event, route) =>
        recordLifecycle(history, update, event, route),
      onAgentResult: (result, event) => logAgentResult(log, result, event),
      onError: (error) => recordDaemonError(status, log, error),
    });
    status.ingressReady = true;
    status.ingressPort = ingress.port;
    log(`[pagent] local ingress listening on ${ingress.host}:${ingress.port}`);

    tunnel = await (options.dependencies?.startTunnel ?? startCloudflaredTunnel)({
      tokenFile: options.config.tunnel.tokenFile,
      binaryPath: options.config.tunnel.cloudflaredPath,
      log,
    });
    await within(
      tunnel.ready,
      options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      "Cloudflare Tunnel startup timed out.",
    );
    status.tunnelConnected = true;
    status.cloudflaredPid = tunnel.health().pid;

    await within(
      (options.dependencies?.probe ?? waitForTunnelProbe)(
        options.config,
        abort.signal,
      ),
      options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS,
      "Cloudflare Tunnel probe timed out.",
    );
    status.phase = "ready";
    log("[pagent] encrypted tunnel probe passed");
    await options.onReady?.(await daemonStatus(status, history));

    await monitorUntilStopped(tunnel, status, abort.signal);
  } finally {
    abort.abort();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await Promise.allSettled([tunnel?.stop(), ingress?.close()]);
    status.ingressReady = false;
    status.tunnelConnected = false;
    await control.close();
  }
}

async function daemonStatus(
  status: LocalDaemonStatus,
  history: FileHandoffHistory,
): Promise<LocalDaemonStatus> {
  const records = await history.list();
  const lastHandoff = records.find((record) => record.status === "completed");
  const lastFailure = records.find((record) => record.status === "failed");
  const handoffError =
    lastFailure?.errorMessage === undefined
      ? undefined
      : {
          message: lastFailure.errorMessage,
          occurredAt: lastFailure.completedAt ?? lastFailure.receivedAt,
        };
  const latestError = newerError(status.lastError, handoffError);
  return {
    ...status,
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

async function recordLifecycle(
  history: FileHandoffHistory,
  update: LocalIngressLifecycleUpdate,
  event: EncryptedPagentEvent,
  _route: LocalIngressRoute,
): Promise<void> {
  const current = await history.findByEventId(event.id);
  if (current === undefined) {
    await history.upsert({
      eventId: event.id,
      eventType: event.type,
      environment: event.environment,
      receivedAt: update.occurredAt,
      ...lifecyclePatch(update),
    });
    return;
  }
  await history.update(event.id, lifecyclePatch(update));
}

function lifecyclePatch(
  update: LocalIngressLifecycleUpdate,
): Partial<HandoffHistoryRecord> & { status: HandoffStatus } {
  if (update.status === "running") {
    return { status: "running", startedAt: update.occurredAt };
  }
  if (update.status === "completed") {
    return {
      status: "completed",
      completedAt: update.occurredAt,
      ...(update.threadId === undefined ? {} : { threadId: update.threadId }),
    };
  }
  if (update.status === "suppressed") {
    return {
      status: "suppressed",
      completedAt: update.occurredAt,
      ...(update.reason === undefined ? {} : { errorCode: update.reason }),
    };
  }
  if (update.status === "failed") {
    return {
      status: "failed",
      completedAt: update.occurredAt,
      ...(update.errorCode === undefined ? {} : { errorCode: update.errorCode }),
      ...(update.errorMessage === undefined
        ? {}
        : { errorMessage: update.errorMessage }),
    };
  }
  return { status: "received" };
}

async function waitForTunnelProbe(
  config: ConnectorConfig,
  signal: AbortSignal,
): Promise<void> {
  let lastError: unknown;
  while (!signal.aborted) {
    try {
      await probeTunnelOnce(config, signal);
      return;
    } catch (error) {
      lastError = error;
      await delay(250, signal);
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Cloudflare Tunnel probe was cancelled.");
}

async function probeTunnelOnce(
  config: ConnectorConfig,
  signal: AbortSignal,
): Promise<void> {
  const active = Object.entries(config.encryption.keys)[0];
  if (active === undefined) throw new Error("Pagent has no encryption key for its probe.");
  const [keyId, key] = active;
  const metadata = {
    id: randomUUID(),
    type: "pagent.probe",
    environment: config.environments[0]!,
    occurredAt: new Date().toISOString(),
    investigation: { cooldownMs: 0 },
  };
  const encrypt = createEventContextEncryptor({ keyId, key });
  const envelope: EventEnvelope = {
    version: EVENT_PROTOCOL_VERSION,
    event: {
      ...metadata,
      context: await encrypt(metadata, {
        probe: true,
        environmentId: config.tunnel.environmentId,
      }),
    },
  };
  const response = await fetch(`https://${config.tunnel.hostname}/v1/probe`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.ingress.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(envelope),
    signal,
  });
  if (!response.ok) {
    throw new Error(`Cloudflare Tunnel probe returned HTTP ${response.status}.`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== "object" ||
    body === null ||
    !("version" in body) ||
    body.version !== 1 ||
    !("status" in body) ||
    body.status !== "ready" ||
    !("environmentId" in body) ||
    body.environmentId !== config.tunnel.environmentId
  ) {
    throw new Error("Cloudflare Tunnel probe returned an invalid response.");
  }
}

async function monitorUntilStopped(
  tunnel: CloudflaredTunnelProcess,
  status: LocalDaemonStatus,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const health = tunnel.health();
    status.tunnelConnected = health.ready;
    status.cloudflaredPid = health.pid;
    if (health.state === "failed") {
      throw new Error(health.error ?? "cloudflared exited unexpectedly.");
    }
    await delay(HEALTH_POLL_MS, signal);
  }
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolveDelay) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolveDelay();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function within<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Pagent startup timeout must be a positive integer.");
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function logAgentResult(
  log: (message: string) => void,
  result: AgentResult,
  event: EncryptedPagentEvent,
): void {
  log(`[pagent] ${event.type} diagnosis thread: ${result.threadId ?? "unknown"}`);
}

function recordDaemonError(
  status: LocalDaemonStatus,
  log: (message: string) => void,
  error: unknown,
): void {
  const message = safeErrorMessage(error);
  status.lastError = { message, occurredAt: new Date().toISOString() };
  log(`[pagent] local ingress error: ${message}`);
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

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown Pagent error.";
  return error.message
    .replace(/Bearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/https?:\/\/[^\s]+/giu, "[tunnel URL]");
}
