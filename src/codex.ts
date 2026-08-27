import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import type { AgentAdapter, AgentResult } from "./agent.js";
import { PAGENT_VERSION } from "./version.js";

export type CodexApprovalPolicy = "never" | "on-request" | "untrusted";
export type CodexSandboxMode =
  | "danger-full-access"
  | "read-only"
  | "workspace-write";

export interface CodexAgentOptions {
  approvalPolicy?: CodexApprovalPolicy;
  sandboxMode?: CodexSandboxMode;
}

export interface CodexProbeOptions {
  timeoutMs?: number;
  sandbox?: {
    cwd: string;
    mode?: CodexSandboxMode | undefined;
  } | undefined;
}

export class CodexSandboxProbeError extends Error {
  readonly causeText: string;

  constructor(causeText: string) {
    super("Codex sandbox command could not run.");
    this.name = "CodexSandboxProbeError";
    this.causeText = causeText;
  }
}

interface AppServerMessage {
  id?: number;
  result?: unknown;
  error?: { message?: string };
  method?: string;
  params?: unknown;
}

interface ThreadStartResponse {
  thread: { id: string };
}

interface CommandExecResponse {
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface AppServerConnection {
  child: ChildProcessWithoutNullStreams;
  lines: ReturnType<typeof createInterface>;
  messages: AsyncIterator<string>;
  stderr(): string;
}

export function codexAgent(options: CodexAgentOptions = {}): AgentAdapter {
  return {
    run: (request) =>
      runCodex(request.cwd, request.prompt, options, request.signal),
  };
}

/** Verifies app-server initialization and, when requested, its real sandbox without creating a thread. */
export async function probeCodexAppServer(
  options: CodexProbeOptions = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Codex probe timeout must be a positive number.");
  }

  const appServer = startAppServer();

  let timeout: ReturnType<typeof setTimeout> | undefined;
  let initialized = false;
  try {
    await Promise.race([
      (async () => {
        await initializeAppServer(appServer, {
          name: "pagent-doctor",
          title: "Pagent Doctor",
        });
        initialized = true;

        if (options.sandbox !== undefined) {
          send(appServer.child, {
            method: "command/exec",
            id: 2,
            params: {
              command: sandboxProbeCommand(),
              cwd: resolve(options.sandbox.cwd),
              timeoutMs,
              outputBytesCap: 4_096,
              ...(options.sandbox.mode === undefined
                ? {}
                : {
                    sandboxPolicy: sandboxPolicy(
                      options.sandbox.mode,
                      options.sandbox.cwd,
                    ),
                  }),
            },
          });
          let result: CommandExecResponse;
          try {
            result = await waitForResponse<CommandExecResponse>(
              appServer.messages,
              2,
              "command/exec",
              appServer.stderr,
            );
          } catch (error) {
            throw new CodexSandboxProbeError(errorMessage(error));
          }
          if (result.exitCode !== 0) {
            throw new CodexSandboxProbeError(
              result.stderr.trim() ||
                `Sandbox command exited ${result.exitCode}.`,
            );
          }
        }
      })(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new Error(
                initialized
                  ? "Codex sandbox command timed out."
                  : "Codex app server initialization timed out.",
              ),
            ),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    if (initialized && !(error instanceof CodexSandboxProbeError)) {
      throw new CodexSandboxProbeError(errorMessage(error));
    }
    throw error;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    closeAppServer(appServer);
  }
}

function sandboxProbeCommand(): string[] {
  return process.platform === "win32"
    ? ["cmd.exe", "/d", "/c", "exit", "0"]
    : [process.platform === "darwin" ? "/usr/bin/true" : "/bin/true"];
}

function sandboxPolicy(
  mode: CodexSandboxMode,
  cwd: string,
): Record<string, unknown> {
  if (mode === "danger-full-access") {
    return { type: "dangerFullAccess" };
  }
  if (mode === "workspace-write") {
    return {
      type: "workspaceWrite",
      writableRoots: [resolve(cwd)],
      networkAccess: false,
    };
  }
  return { type: "readOnly", networkAccess: false };
}

async function runCodex(
  requestedCwd: string,
  prompt: string,
  options: CodexAgentOptions,
  signal: AbortSignal | undefined,
): Promise<AgentResult> {
  const cwd = resolve(requestedCwd);
  await requireLocalDirectory(cwd);
  throwIfAborted(signal);

  const appServer = startAppServer();
  const abort = () => appServer.child.kill();
  signal?.addEventListener("abort", abort, { once: true });

  try {
    await initializeAppServer(
      appServer,
      { name: "pagent", title: "Pagent" },
      signal,
    );

    const threadParams: Record<string, unknown> = { cwd };
    if (options.approvalPolicy !== undefined) {
      threadParams.approvalPolicy = options.approvalPolicy;
    }
    if (options.sandboxMode !== undefined) {
      threadParams.sandbox = options.sandboxMode;
    }

    send(appServer.child, {
      method: "thread/start",
      id: 2,
      params: threadParams,
    });
    const thread = await waitForResponse<ThreadStartResponse>(
      appServer.messages,
      2,
      "thread/start",
      appServer.stderr,
      signal,
    );
    const threadId = thread.thread.id;

    send(appServer.child, {
      method: "turn/start",
      id: 3,
      params: {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      },
    });

    while (true) {
      const message = await nextMessage(
        appServer.messages,
        appServer.stderr,
        signal,
      );

      if (message.id === 3 && message.error !== undefined) {
        throw requestError("turn/start", message.error);
      }

      const completed = completedTurnFrom(message, threadId);
      if (completed === undefined) {
        continue;
      }
      if (completed.status !== "completed") {
        throw new Error(
          completed.errorMessage ??
            `Codex turn ended with status ${completed.status}.`,
        );
      }
      return { threadId };
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    closeAppServer(appServer);
  }
}

function startAppServer(): AppServerConnection {
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.on("error", (error) => {
    stderr ||= error.message;
  });

  return {
    child,
    lines,
    messages: lines[Symbol.asyncIterator](),
    stderr: () => stderr,
  };
}

async function initializeAppServer(
  appServer: AppServerConnection,
  clientInfo: { name: string; title: string },
  signal?: AbortSignal,
): Promise<void> {
  await waitForSpawn(appServer.child);
  send(appServer.child, {
    method: "initialize",
    id: 1,
    params: { clientInfo: { ...clientInfo, version: PAGENT_VERSION } },
  });
  await waitForResponse(
    appServer.messages,
    1,
    "initialize",
    appServer.stderr,
    signal,
  );
  send(appServer.child, { method: "initialized", params: {} });
}

function closeAppServer(appServer: AppServerConnection): void {
  appServer.lines.close();
  appServer.child.stdin.end();
  appServer.child.kill();
}

async function waitForSpawn(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  return new Promise((resolveSpawn, rejectSpawn) => {
    child.once("spawn", resolveSpawn);
    child.once("error", (error) => rejectSpawn(codexLaunchError(error)));
  });
}

async function waitForResponse<TResult>(
  messages: AsyncIterator<string>,
  id: number,
  method: string,
  stderr: () => string,
  signal?: AbortSignal,
): Promise<TResult> {
  while (true) {
    const message = await nextMessage(messages, stderr, signal);
    if (message.id !== id) {
      continue;
    }
    if (message.error !== undefined) {
      throw requestError(method, message.error);
    }
    return message.result as TResult;
  }
}

async function nextMessage(
  messages: AsyncIterator<string>,
  stderr: () => string,
  signal?: AbortSignal,
): Promise<AppServerMessage> {
  const next = await abortable(messages.next(), signal);
  if (next.done) {
    const detail = stderr().trim();
    throw new Error(
      `Codex app server exited before the run completed${detail ? `: ${detail}` : "."}`,
    );
  }

  try {
    return JSON.parse(next.value) as AppServerMessage;
  } catch {
    throw new Error("Codex app server returned invalid JSON.");
  }
}

async function abortable<T>(
  operation: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return operation;
  }
  throwIfAborted(signal);
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const abort = () => rejectPromise(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    operation.then(resolvePromise, rejectPromise).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason;
  }
}

function send(child: ChildProcessWithoutNullStreams, message: object): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function completedTurnFrom(
  message: AppServerMessage,
  threadId: string,
):
  | { status: string; errorMessage?: string }
  | undefined {
  if (message.method !== "turn/completed") {
    return undefined;
  }
  const params = record(message.params);
  const turn = record(params?.turn);
  if (params?.threadId !== threadId || typeof turn?.status !== "string") {
    return undefined;
  }

  const error = record(turn.error);
  const errorMessage =
    typeof error?.message === "string" ? error.message : undefined;
  return {
    status: turn.status,
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

async function requireLocalDirectory(cwd: string): Promise<void> {
  try {
    if ((await stat(cwd)).isDirectory()) {
      return;
    }
    throw new Error(`Pagent working directory is not a directory: ${cwd}`);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      throw new Error(
        `Local repository not found at ${cwd}. Clone or download it before starting Pagent.`,
      );
    }
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function requestError(
  method: string,
  error: { message?: string },
): Error {
  return new Error(
    `Codex app server ${method} failed: ${error.message ?? "Unknown error"}`,
  );
}

function codexLaunchError(error: Error): Error {
  return isNodeError(error) && error.code === "ENOENT"
    ? new Error(
        'Codex CLI was not found on PATH. Install Codex and run "codex login" before starting Pagent.',
      )
    : error;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown sandbox error.";
}
