import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import type { DaemonMetadata } from "./local-state.js";

const PROTOCOL_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_BYTES = 64 * 1024;

export type LocalDaemonPhase =
  | "starting"
  | "connecting"
  | "ready"
  | "reconnecting"
  | "stopping";

export interface LocalDaemonErrorSummary {
  message: string;
  occurredAt: string;
}

export interface LocalHandoffSummary {
  eventType: string;
  completedAt: string;
  threadId?: string | undefined;
}

export interface LocalDaemonStatus extends DaemonMetadata {
  phase: LocalDaemonPhase;
  relayConnected: boolean;
  pendingTasks: number;
  lastHandoff?: LocalHandoffSummary | undefined;
  lastError?: LocalDaemonErrorSummary | undefined;
}

export type LocalControlRequest =
  | { method: "status" }
  | { method: "stop" };

export interface LocalStopResult {
  stopping: true;
}

export interface LocalControlServerOptions {
  endpoint: string;
  getStatus(): LocalDaemonStatus | Promise<LocalDaemonStatus>;
  onStop(): void | Promise<void>;
}

export interface LocalControlServer {
  readonly endpoint: string;
  close(): Promise<void>;
}

export async function startLocalControlServer(
  options: LocalControlServerOptions,
): Promise<LocalControlServer> {
  let server = controlServer(options);

  try {
    await listen(server, options.endpoint);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EADDRINUSE") {
      throw error;
    }
    if (process.platform === "win32") {
      throw alreadyRunningError(options.endpoint);
    }

    const staleSocket = await staleSocketEvidence(options.endpoint);
    if (staleSocket === undefined) {
      throw alreadyRunningError(options.endpoint);
    }

    await unlinkUnchangedSocket(options.endpoint, staleSocket);
    server = controlServer(options);
    await listen(server, options.endpoint);
  }
  if (process.platform !== "win32") {
    try {
      await chmod(options.endpoint, 0o600);
    } catch (error) {
      await closeServer(server);
      throw error;
    }
  }

  let closed = false;
  return {
    endpoint: options.endpoint,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      await closeServer(server);
    },
  };
}

export function requestLocalControl(
  endpoint: string,
  request: { method: "status" },
  options?: { timeoutMs?: number | undefined },
): Promise<LocalDaemonStatus>;
export function requestLocalControl(
  endpoint: string,
  request: { method: "stop" },
  options?: { timeoutMs?: number | undefined },
): Promise<LocalStopResult>;
export async function requestLocalControl(
  endpoint: string,
  request: LocalControlRequest,
  options: { timeoutMs?: number | undefined } = {},
): Promise<LocalDaemonStatus | LocalStopResult> {
  const requestId = randomUUID();
  const response = await exchange(
    endpoint,
    {
      version: PROTOCOL_VERSION,
      requestId,
      method: request.method,
    },
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  if (!isRecord(response) || response.version !== PROTOCOL_VERSION) {
    throw new Error("Pagent control endpoint returned an unsupported response.");
  }
  if (response.requestId !== requestId) {
    throw new Error("Pagent control endpoint returned a mismatched response.");
  }
  if (response.ok === false) {
    const message =
      isRecord(response.error) && typeof response.error.message === "string"
        ? response.error.message
        : "Pagent control request failed.";
    throw new Error(message);
  }
  if (response.ok !== true || !("result" in response)) {
    throw new Error("Pagent control endpoint returned an invalid response.");
  }

  return request.method === "status"
    ? localDaemonStatus(response.result)
    : localStopResult(response.result);
}

function controlServer(options: LocalControlServerOptions): Server {
  return createServer((socket) => {
    void serveConnection(socket, options);
  });
}

async function serveConnection(
  socket: Socket,
  options: LocalControlServerOptions,
): Promise<void> {
  socket.setTimeout(DEFAULT_TIMEOUT_MS, () => socket.destroy());
  let requestId = "unknown";

  try {
    const request = await readMessage(socket);
    requestId =
      isRecord(request) && typeof request.requestId === "string"
        ? request.requestId
        : "unknown";
    if (
      !isRecord(request) ||
      request.version !== PROTOCOL_VERSION ||
      typeof request.requestId !== "string"
    ) {
      throw new Error("Invalid Pagent control request.");
    }

    let result: LocalDaemonStatus | LocalStopResult;
    if (request.method === "status") {
      result = localDaemonStatus(await options.getStatus());
    } else if (request.method === "stop") {
      await options.onStop();
      result = { stopping: true };
    } else {
      throw new Error("Unknown Pagent control method.");
    }

    socket.end(`${JSON.stringify({
      version: PROTOCOL_VERSION,
      requestId,
      ok: true,
      result,
    })}\n`);
  } catch (error) {
    if (!socket.destroyed && socket.writable && !socket.writableEnded) {
      socket.end(`${JSON.stringify({
        version: PROTOCOL_VERSION,
        requestId,
        ok: false,
        error: { message: errorMessage(error) },
      })}\n`);
    }
  }
}

function exchange(
  endpoint: string,
  message: object,
  timeoutMs: number,
): Promise<unknown> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new Error("Pagent control timeout must be positive."));
  }

  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let settled = false;

    const finish = (error?: Error, value?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error === undefined) {
        resolve(value);
      } else {
        reject(error);
      }
    };

    socket.setTimeout(timeoutMs, () => {
      finish(new Error("Pagent control request timed out."));
    });
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(message)}\n`);
      void readMessage(socket).then(
        (value) => finish(undefined, value),
        (error: Error) => finish(error),
      );
    });
  });
}

function readMessage(socket: Socket): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let received = Buffer.alloc(0);
    let settled = false;

    const cleanup = () => {
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.off("error", onError);
    };
    const finish = (error?: Error, value?: unknown) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error === undefined) {
        resolve(value);
      } else {
        reject(error);
      }
    };
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.byteLength > MAX_MESSAGE_BYTES) {
        finish(new Error("Pagent control message was too large."));
        return;
      }
      const newline = received.indexOf(0x0a);
      if (newline >= 0) {
        try {
          finish(undefined, JSON.parse(received.subarray(0, newline).toString("utf8")));
        } catch {
          finish(new Error("Pagent control message was not valid JSON."));
        }
      }
    };
    const onEnd = () => finish(new Error("Pagent control connection ended early."));
    const onError = (error: Error) => finish(error);

    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.once("error", onError);
  });
}

async function staleSocketEvidence(
  endpoint: string,
): Promise<{ dev: number; ino: number } | undefined> {
  const before = await lstat(endpoint).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (before === undefined) {
    return { dev: -1, ino: -1 };
  }

  try {
    await canConnect(endpoint);
    return undefined;
  } catch (error) {
    if (
      !isNodeError(error) ||
      (error.code !== "ECONNREFUSED" && error.code !== "ENOENT")
    ) {
      throw error;
    }
    return { dev: before.dev, ino: before.ino };
  }
}

async function unlinkUnchangedSocket(
  endpoint: string,
  evidence: { dev: number; ino: number },
): Promise<void> {
  if (evidence.ino === -1) {
    return;
  }
  const current = await lstat(endpoint);
  if (current.dev !== evidence.dev || current.ino !== evidence.ino) {
    throw new Error("Pagent control endpoint changed while checking for a stale socket.");
  }
  await unlink(endpoint);
}

function canConnect(endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    socket.once("connect", () => {
      socket.destroy();
      resolve();
    });
    socket.once("error", reject);
  });
}

function listen(server: Server, endpoint: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(endpoint);
  });
}

function closeServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function localDaemonStatus(value: unknown): LocalDaemonStatus {
  if (!isRecord(value) || value.version !== 1) {
    throw new Error("Pagent daemon returned an invalid status.");
  }
  if (!Number.isSafeInteger(value.pid) || (value.pid as number) <= 0) {
    throw new Error("Pagent daemon returned an invalid PID.");
  }
  if (!isIsoDate(value.startedAt)) {
    throw new Error("Pagent daemon returned an invalid start time.");
  }
  if (typeof value.controlEndpoint !== "string" || value.controlEndpoint === "") {
    throw new Error("Pagent daemon returned an invalid control endpoint.");
  }
  if (!isDaemonPhase(value.phase)) {
    throw new Error("Pagent daemon returned an invalid phase.");
  }
  if (typeof value.relayConnected !== "boolean") {
    throw new Error("Pagent daemon returned an invalid relay status.");
  }
  if (!Number.isSafeInteger(value.pendingTasks) || (value.pendingTasks as number) < 0) {
    throw new Error("Pagent daemon returned an invalid pending task count.");
  }

  return {
    version: 1,
    pid: value.pid as number,
    startedAt: value.startedAt,
    controlEndpoint: value.controlEndpoint,
    phase: value.phase,
    relayConnected: value.relayConnected,
    pendingTasks: value.pendingTasks as number,
    ...(value.lastHandoff === undefined
      ? {}
      : { lastHandoff: handoffSummary(value.lastHandoff) }),
    ...(value.lastError === undefined
      ? {}
      : { lastError: errorSummary(value.lastError) }),
  };
}

function handoffSummary(value: unknown): LocalHandoffSummary {
  if (
    !isRecord(value) ||
    typeof value.eventType !== "string" ||
    value.eventType === "" ||
    !isIsoDate(value.completedAt) ||
    (value.threadId !== undefined && typeof value.threadId !== "string")
  ) {
    throw new Error("Pagent daemon returned an invalid handoff summary.");
  }
  return {
    eventType: value.eventType,
    completedAt: value.completedAt,
    ...(value.threadId === undefined ? {} : { threadId: value.threadId }),
  };
}

function errorSummary(value: unknown): LocalDaemonErrorSummary {
  if (
    !isRecord(value) ||
    typeof value.message !== "string" ||
    !isIsoDate(value.occurredAt)
  ) {
    throw new Error("Pagent daemon returned an invalid error summary.");
  }
  return { message: value.message, occurredAt: value.occurredAt };
}

function localStopResult(value: unknown): LocalStopResult {
  if (!isRecord(value) || value.stopping !== true) {
    throw new Error("Pagent daemon returned an invalid stop response.");
  }
  return { stopping: true };
}

function isDaemonPhase(value: unknown): value is LocalDaemonPhase {
  return (
    value === "starting" ||
    value === "connecting" ||
    value === "ready" ||
    value === "reconnecting" ||
    value === "stopping"
  );
}

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const date = new Date(value);
  return !Number.isNaN(date.valueOf()) && date.toISOString() === value;
}

function alreadyRunningError(endpoint: string): Error {
  return new Error(`A process is already listening on Pagent control endpoint ${endpoint}.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
