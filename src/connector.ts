import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AgentAdapter, AgentResult, PagentEvent } from "./types.js";

export {
  codexAgent,
  type CodexAgentOptions,
  type CodexApprovalPolicy,
  type CodexSandboxMode,
} from "./codex.js";
export {
  defineConnectorConfig,
  type ConnectorConfig,
} from "./config.js";
export type { AgentAdapter, AgentRequest, AgentResult } from "./types.js";

export interface RelayTask<TPayload = unknown> {
  id: string;
  type: string;
  environment: string;
  occurredAt: string;
  investigation: {
    cooldownMs: number;
    group?: string | undefined;
  };
  repositoryKey: string;
  prompt: string;
  payload: TPayload;
}

export interface RelayConnectorOptions {
  url: string;
  token: string;
  inboxPath: string;
  repositories: Readonly<Record<string, string>>;
  environments: readonly string[];
  agent: AgentAdapter;
  fetch?: typeof fetch;
  reconnectDelayMs?: number;
  onError?: (error: unknown) => void;
  onAgentResult?: (
    result: AgentResult,
    task: RelayTask,
  ) => void | Promise<void>;
}

export interface RelayConnector {
  run(options?: { signal?: AbortSignal }): Promise<void>;
  runOnce(options?: { signal?: AbortSignal }): Promise<void>;
}

interface InboxState {
  version: 1;
  cursor?: string;
  pending: RelayTask[];
  completed: string[];
}

interface SseMessage {
  id: string;
  event?: string;
  data: string;
}

class FileInbox {
  readonly #path: string;
  #state: InboxState | undefined;

  constructor(path: string) {
    this.#path = resolve(path);
  }

  async cursor(): Promise<string | undefined> {
    return (await this.#load()).cursor;
  }

  async receive(task: RelayTask): Promise<void> {
    const state = await this.#load();
    state.cursor = task.id;

    if (
      !state.completed.includes(task.id) &&
      !state.pending.some((pending) => pending.id === task.id)
    ) {
      state.pending.push(task);
    }

    await this.#save();
  }

  async skip(id: string): Promise<void> {
    const state = await this.#load();
    state.cursor = id;
    state.pending = state.pending.filter((task) => task.id !== id);
    if (!state.completed.includes(id)) {
      state.completed.push(id);
    }
    await this.#save();
  }

  async next(): Promise<RelayTask | undefined> {
    return (await this.#load()).pending[0];
  }

  async complete(id: string): Promise<void> {
    const state = await this.#load();
    state.pending = state.pending.filter((task) => task.id !== id);
    if (!state.completed.includes(id)) {
      state.completed.push(id);
    }
    await this.#save();
  }

  async #load(): Promise<InboxState> {
    if (this.#state !== undefined) {
      return this.#state;
    }

    try {
      const parsed: unknown = JSON.parse(await readFile(this.#path, "utf8"));
      this.#state = inboxState(parsed);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      this.#state = { version: 1, pending: [], completed: [] };
    }

    return this.#state;
  }

  async #save(): Promise<void> {
    const state = await this.#load();
    const directory = dirname(this.#path);
    const temporaryPath = `${this.#path}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });

    try {
      await writeFile(temporaryPath, `${JSON.stringify(state)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      await rename(temporaryPath, this.#path);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

class DefaultRelayConnector implements RelayConnector {
  readonly #agent: AgentAdapter;
  readonly #environments: Set<string>;
  readonly #fetch: typeof fetch;
  readonly #inbox: FileInbox;
  readonly #onAgentResult: RelayConnectorOptions["onAgentResult"];
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #reconnectDelayMs: number;
  readonly #repositories: Map<string, string>;
  readonly #token: string;
  readonly #url: string;
  #active = false;

  constructor(options: RelayConnectorOptions) {
    this.#url = relayUrl(options.url);
    this.#token = bearerToken(options.token);
    this.#inbox = new FileInbox(options.inboxPath);
    this.#repositories = repositoryAllowlist(options.repositories);
    this.#environments = environmentAllowlist(options.environments);
    this.#agent = options.agent;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.#onAgentResult = options.onAgentResult;
    this.#onError = options.onError;

    if (!Number.isFinite(this.#reconnectDelayMs) || this.#reconnectDelayMs < 0) {
      throw new Error("Relay reconnect delay must be a non-negative number.");
    }
  }

  async run(options: { signal?: AbortSignal } = {}): Promise<void> {
    while (!options.signal?.aborted) {
      try {
        await this.runOnce(options);
      } catch (error) {
        if (options.signal?.aborted) {
          return;
        }
        this.#report(error);
      }

      await abortableDelay(this.#reconnectDelayMs, options.signal);
    }
  }

  async runOnce(options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#active) {
      throw new Error("The relay connector is already running.");
    }
    this.#active = true;

    try {
      await this.#drainInbox();
      const cursor = await this.#inbox.cursor();
      const headers = new Headers({
        accept: "text/event-stream",
        authorization: `Bearer ${this.#token}`,
        ...(cursor === undefined ? {} : { "last-event-id": cursor }),
      });
      const response = await this.#fetch(this.#url, {
        method: "GET",
        headers,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });

      if (!response.ok) {
        throw new Error(`Relay SSE request failed with status ${response.status}.`);
      }
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        throw new Error("Relay response was not an SSE stream.");
      }
      if (response.body === null) {
        throw new Error("Relay SSE response had no body.");
      }

      for await (const message of readSse(response.body)) {
        await this.#receive(message);
      }
    } finally {
      this.#active = false;
    }
  }

  async #receive(message: SseMessage): Promise<void> {
    try {
      const task = relayTask(message);
      await this.#inbox.receive(task);
    } catch (error) {
      await this.#inbox.skip(message.id);
      this.#report(error);
      return;
    }

    await this.#drainInbox();
  }

  async #drainInbox(): Promise<void> {
    let task = await this.#inbox.next();

    while (task !== undefined) {
      const rejection = this.#policyRejection(task);
      if (rejection !== undefined) {
        await this.#inbox.complete(task.id);
        this.#report(rejection);
        task = await this.#inbox.next();
        continue;
      }

      const event: PagentEvent = {
        id: task.id,
        type: task.type,
        environment: task.environment,
        occurredAt: task.occurredAt,
        investigation: task.investigation,
        payload: task.payload,
      };
      const result = await this.#agent.run({
        cwd: this.#repositories.get(task.repositoryKey)!,
        prompt: task.prompt,
        event,
      });
      await this.#inbox.complete(task.id);
      if (this.#onAgentResult !== undefined) {
        try {
          await this.#onAgentResult(result, task);
        } catch (error) {
          this.#report(error);
        }
      }
      task = await this.#inbox.next();
    }
  }

  #policyRejection(task: RelayTask): Error | undefined {
    if (!this.#environments.has(task.environment)) {
      return new Error(
        `Relay task ${task.id} uses disallowed environment ${task.environment}.`,
      );
    }
    if (!this.#repositories.has(task.repositoryKey)) {
      return new Error(
        `Relay task ${task.id} uses unknown repository ${task.repositoryKey}.`,
      );
    }
    return undefined;
  }

  #report(error: unknown): void {
    try {
      this.#onError?.(error);
    } catch {
      // Connector callbacks must not stop delivery or agent execution.
    }
  }
}

export function createRelayConnector(
  options: RelayConnectorOptions,
): RelayConnector {
  return new DefaultRelayConnector(options);
}

async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  let fields = emptySseFields();

  const consume = (line: string): SseMessage | undefined => {
    if (line === "") {
      const message = sseMessage(fields);
      fields = emptySseFields();
      return message;
    }
    if (line.startsWith(":")) {
      return undefined;
    }

    const separator = line.indexOf(":");
    const name = separator < 0 ? line : line.slice(0, separator);
    let value = separator < 0 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (name === "data") {
      fields.data.push(value);
    } else if (name === "event") {
      fields.event = value;
    } else if (name === "id" && !value.includes("\0")) {
      fields.id = value;
    }
    return undefined;
  };

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });

      let line = takeLine(buffer);
      while (line !== undefined) {
        buffer = line.rest;
        const message = consume(line.value);
        if (message !== undefined) {
          yield message;
        }
        line = takeLine(buffer);
      }
    }

    let finalLine = takeLine(buffer, true);
    while (finalLine !== undefined) {
      buffer = finalLine.rest;
      const message = consume(finalLine.value);
      if (message !== undefined) {
        yield message;
      }
      finalLine = takeLine(buffer, true);
    }
    if (buffer !== "") {
      const message = consume(buffer);
      if (message !== undefined) {
        yield message;
      }
    }
    const finalMessage = consume("");
    if (finalMessage !== undefined) {
      yield finalMessage;
    }
  } finally {
    reader.releaseLock();
  }
}

function emptySseFields(): { id?: string; event?: string; data: string[] } {
  return { data: [] };
}

function sseMessage(fields: {
  id?: string;
  event?: string;
  data: string[];
}): SseMessage | undefined {
  if (fields.data.length === 0) {
    return undefined;
  }
  if (fields.id === undefined || fields.id === "") {
    throw new Error("Relay SSE task is missing an event ID.");
  }
  return {
    id: fields.id,
    ...(fields.event === undefined ? {} : { event: fields.event }),
    data: fields.data.join("\n"),
  };
}

function takeLine(
  input: string,
  atEnd = false,
): { value: string; rest: string } | undefined {
  const carriageReturn = input.indexOf("\r");
  const lineFeed = input.indexOf("\n");
  const positions = [carriageReturn, lineFeed].filter((value) => value >= 0);
  if (positions.length === 0) {
    return undefined;
  }
  const end = Math.min(...positions);

  if (input[end] === "\r" && end === input.length - 1 && !atEnd) {
    return undefined;
  }

  const terminatorLength =
    input[end] === "\r" && input[end + 1] === "\n" ? 2 : 1;
  return {
    value: input.slice(0, end),
    rest: input.slice(end + terminatorLength),
  };
}

function relayTask(message: SseMessage): RelayTask {
  if (message.event !== undefined && message.event !== "task") {
    throw new Error(`Unsupported relay SSE event ${message.event}.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(message.data);
  } catch {
    throw new Error(`Relay task ${message.id} contains invalid JSON.`);
  }

  const value = record(parsed);
  if (
    value === undefined ||
    value.id !== message.id ||
    !nonempty(value.type) ||
    !nonempty(value.environment) ||
    !nonempty(value.occurredAt) ||
    !isInvestigationPolicy(value.investigation) ||
    !nonempty(value.repositoryKey) ||
    !nonempty(value.prompt) ||
    !("payload" in value)
  ) {
    throw new Error(`Relay task ${message.id} has an invalid shape.`);
  }

  return {
    id: message.id,
    type: value.type,
    environment: value.environment,
    occurredAt: value.occurredAt,
    investigation: value.investigation,
    repositoryKey: value.repositoryKey,
    prompt: value.prompt,
    payload: value.payload,
  };
}

function inboxState(value: unknown): InboxState {
  const state = record(value);
  if (
    state?.version !== 1 ||
    !Array.isArray(state.pending) ||
    !state.pending.every(isRelayTask) ||
    !Array.isArray(state.completed) ||
    !state.completed.every((id) => typeof id === "string") ||
    (state.cursor !== undefined && typeof state.cursor !== "string")
  ) {
    throw new Error("Relay connector inbox is invalid.");
  }

  return {
    version: 1,
    ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
    pending: state.pending,
    completed: state.completed,
  };
}

function isRelayTask(value: unknown): value is RelayTask {
  const task = record(value);
  return (
    task !== undefined &&
    nonempty(task.id) &&
    nonempty(task.type) &&
    nonempty(task.environment) &&
    nonempty(task.occurredAt) &&
    isInvestigationPolicy(task.investigation) &&
    nonempty(task.repositoryKey) &&
    nonempty(task.prompt) &&
    "payload" in task
  );
}

function isInvestigationPolicy(
  value: unknown,
): value is RelayTask["investigation"] {
  const policy = record(value);
  return (
    policy !== undefined &&
    typeof policy.cooldownMs === "number" &&
    Number.isSafeInteger(policy.cooldownMs) &&
    policy.cooldownMs >= 0 &&
    (policy.group === undefined ||
      (nonempty(policy.group) &&
        policy.group === policy.group.trim() &&
        policy.group.length <= 200))
  );
}

function relayUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Relay URL must be a valid HTTP or HTTPS URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Relay URL must be a valid HTTP or HTTPS URL.");
  }
  return url.toString();
}

function bearerToken(value: string): string {
  const token = value.trim();
  if (token === "" || token !== value || /[\r\n]/u.test(token)) {
    throw new Error("Relay token must be a non-empty bearer token.");
  }
  return token;
}

function repositoryAllowlist(
  values: Readonly<Record<string, string>>,
): Map<string, string> {
  const repositories = new Map<string, string>();
  for (const [key, path] of Object.entries(values)) {
    if (!nonempty(key) || !nonempty(path)) {
      throw new Error("Repository keys and paths must be non-empty strings.");
    }
    repositories.set(key, resolve(path));
  }
  return repositories;
}

function environmentAllowlist(values: readonly string[]): Set<string> {
  const environments = new Set<string>();
  for (const environment of values) {
    if (!nonempty(environment)) {
      throw new Error("Allowed environments must be non-empty strings.");
    }
    environments.add(environment);
  }
  return environments;
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted || milliseconds === 0) {
    return;
  }

  await new Promise<void>((resolveDelay) => {
    const timeout = setTimeout(done, milliseconds);
    signal?.addEventListener("abort", done, { once: true });

    function done() {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", done);
      resolveDelay();
    }
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
