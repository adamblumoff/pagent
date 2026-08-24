import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

import type { AgentAdapter, AgentResult } from "./types.js";

export type CodexApprovalPolicy = "never" | "on-request" | "untrusted";
export type CodexSandboxMode =
  | "danger-full-access"
  | "read-only"
  | "workspace-write";

export interface CodexAgentOptions {
  approvalPolicy?: CodexApprovalPolicy;
  sandboxMode?: CodexSandboxMode;
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

export function codexAgent(options: CodexAgentOptions = {}): AgentAdapter {
  return {
    run: (request) => runCodex(request.cwd, request.prompt, options),
  };
}

async function runCodex(
  requestedCwd: string,
  prompt: string,
  options: CodexAgentOptions,
): Promise<AgentResult> {
  const cwd = resolve(requestedCwd);
  await requireLocalDirectory(cwd);

  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  const messages = lines[Symbol.asyncIterator]();
  let stderr = "";

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdin.on("error", (error) => {
    stderr ||= error.message;
  });

  try {
    await waitForSpawn(child);

    send(child, {
      method: "initialize",
      id: 1,
      params: {
        clientInfo: {
          name: "pagent",
          title: "Pagent",
          version: "0.0.0",
        },
      },
    });
    await waitForResponse(messages, 1, "initialize", () => stderr);
    send(child, { method: "initialized", params: {} });

    const threadParams: Record<string, unknown> = { cwd };
    if (options.approvalPolicy !== undefined) {
      threadParams.approvalPolicy = options.approvalPolicy;
    }
    if (options.sandboxMode !== undefined) {
      threadParams.sandbox = options.sandboxMode;
    }

    send(child, { method: "thread/start", id: 2, params: threadParams });
    const thread = await waitForResponse<ThreadStartResponse>(
      messages,
      2,
      "thread/start",
      () => stderr,
    );
    const threadId = thread.thread.id;

    send(child, {
      method: "turn/start",
      id: 3,
      params: {
        threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
      },
    });

    let finalResponse: string | undefined;

    while (true) {
      const message = await nextMessage(messages, () => stderr);

      if (message.id === 3 && message.error !== undefined) {
        throw requestError("turn/start", message.error);
      }

      const item = agentMessageFrom(message, threadId);
      if (item !== undefined) {
        finalResponse = item;
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

      finalResponse = lastAgentMessage(completed.items) ?? finalResponse;
      return finalResponse === undefined
        ? { threadId }
        : { threadId, finalResponse };
    }
  } finally {
    lines.close();
    child.stdin.end();
    child.kill();
  }
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
): Promise<TResult> {
  while (true) {
    const message = await nextMessage(messages, stderr);
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
): Promise<AppServerMessage> {
  const next = await messages.next();
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

function send(child: ChildProcessWithoutNullStreams, message: object): void {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function agentMessageFrom(
  message: AppServerMessage,
  threadId: string,
): string | undefined {
  if (message.method !== "item/completed") {
    return undefined;
  }
  const params = record(message.params);
  const item = record(params?.item);
  return params?.threadId === threadId &&
    item?.type === "agentMessage" &&
    typeof item.text === "string"
    ? item.text
    : undefined;
}

function completedTurnFrom(
  message: AppServerMessage,
  threadId: string,
):
  | { status: string; errorMessage?: string; items: unknown[] }
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
    items: Array.isArray(turn.items) ? turn.items : [],
  };
}

function lastAgentMessage(items: unknown[]): string | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = record(items[index]);
    if (item?.type === "agentMessage" && typeof item.text === "string") {
      return item.text;
    }
  }
  return undefined;
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
