import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  createEventContextDecryptor,
  type EventContextDecryptor,
} from "./crypto.js";
import type { AgentAdapter, AgentResult } from "./agent.js";
import type { ConnectorEncryptionConfig } from "./config.js";
import type {
  EncryptedContext,
  JsonValue,
  PagentEvent,
  PagentEventMetadata,
} from "./types.js";

export interface RelayTask {
  id: string;
  eventId: string;
  type: string;
  environment: string;
  occurredAt: string;
  investigation: {
    cooldownMs: number;
    group?: string | undefined;
  };
  repositoryKey: string;
  context: EncryptedContext;
}

export interface RelayConnectorOptions {
  url: string;
  token: string;
  inboxPath: string;
  repositories: Readonly<Record<string, string>>;
  environments: readonly string[];
  encryption: ConnectorEncryptionConfig;
  agent: AgentAdapter;
  fetch?: typeof fetch;
  reconnectDelayMs?: number;
  onError?: (error: unknown) => void;
  onConnectionChange?: (connected: boolean) => void;
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
  version: 4;
  cursor?: string;
  pending: RelayTask[];
  acknowledgements: string[];
}

const MAX_SEQUENCE_ID = 9_223_372_036_854_775_807n;

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
    if (state.cursor !== undefined && !sequenceAfter(task.id, state.cursor)) {
      return;
    }

    state.cursor = task.id;
    if (!state.pending.some((pending) => pending.id === task.id)) {
      state.pending.push(task);
    }

    await this.#save();
  }

  async skip(id: string): Promise<void> {
    if (!isTaskId(id)) {
      throw new Error("Relay task IDs must be positive 64-bit integers.");
    }
    const state = await this.#load();
    if (state.cursor === undefined || sequenceAfter(id, state.cursor)) {
      state.cursor = id;
    }
    state.pending = state.pending.filter((task) => task.id !== id);
    await this.#save();
  }

  async next(): Promise<RelayTask | undefined> {
    return (await this.#load()).pending[0];
  }

  async markAgentCompleted(id: string): Promise<void> {
    const state = await this.#load();
    state.pending = state.pending.filter((task) => task.id !== id);
    if (!state.acknowledgements.includes(id)) {
      state.acknowledgements.push(id);
    }
    await this.#save();
  }

  async nextAcknowledgement(): Promise<string | undefined> {
    return (await this.#load()).acknowledgements[0];
  }

  async markAcknowledged(id: string): Promise<void> {
    const state = await this.#load();
    state.acknowledgements = state.acknowledgements.filter(
      (acknowledgement) => acknowledgement !== id,
    );
    await this.#save();
  }

  async #load(): Promise<InboxState> {
    if (this.#state !== undefined) {
      return this.#state;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.#path, "utf8"));
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
      this.#state = { version: 4, pending: [], acknowledgements: [] };
      return this.#state;
    }

    this.#state = inboxState(parsed);
    if (record(parsed)?.version === 2 || record(parsed)?.version === 3) {
      await this.#save();
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
  readonly #decryptors: Map<string, EventContextDecryptor>;
  readonly #onAgentResult: RelayConnectorOptions["onAgentResult"];
  readonly #onConnectionChange: RelayConnectorOptions["onConnectionChange"];
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #reconnectDelayMs: number;
  readonly #repositories: Map<string, string>;
  readonly #token: string;
  readonly #url: string;
  #active = false;

  constructor(options: RelayConnectorOptions) {
    this.#url = options.url;
    this.#token = options.token;
    this.#inbox = new FileInbox(options.inboxPath);
    this.#repositories = new Map(
      Object.entries(options.repositories).map(([key, path]) => [
        key,
        resolve(path),
      ]),
    );
    this.#environments = new Set(options.environments);
    this.#decryptors = new Map(
      Object.entries(options.encryption.keys).map(([keyId, key]) => [
        keyId,
        createEventContextDecryptor(key),
      ]),
    );
    this.#agent = options.agent;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#reconnectDelayMs = options.reconnectDelayMs ?? 1_000;
    this.#onAgentResult = options.onAgentResult;
    this.#onConnectionChange = options.onConnectionChange;
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

    let connected = false;
    try {
      await this.#drainAcknowledgements(options.signal);
      await this.#drainInbox(options.signal);
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
      connected = true;
      this.#reportConnection(true);

      for await (const message of readSse(response.body)) {
        await this.#receive(message, options.signal);
      }
    } finally {
      if (connected) {
        this.#reportConnection(false);
      }
      this.#active = false;
    }
  }

  async #receive(
    message: SseMessage,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    try {
      const task = relayTask(message);
      await this.#inbox.receive(task);
    } catch (error) {
      await this.#inbox.skip(message.id);
      this.#report(error);
      return;
    }

    await this.#drainInbox(signal);
  }

  async #drainInbox(signal: AbortSignal | undefined): Promise<void> {
    let task = await this.#inbox.next();

    while (task !== undefined) {
      const rejection = this.#policyRejection(task);
      if (rejection !== undefined) {
        throw rejection;
      }

      const metadata: PagentEventMetadata = {
        id: task.eventId,
        type: task.type,
        environment: task.environment,
        occurredAt: task.occurredAt,
        investigation: task.investigation,
      };
      const decrypt = this.#decryptors.get(task.context.keyId);
      if (decrypt === undefined) {
        throw new Error(
          `Relay task ${task.id} uses unknown context key ${task.context.keyId}.`,
        );
      }

      let payload: JsonValue;
      try {
        payload = await decrypt(metadata, task.context);
      } catch (cause) {
        throw new Error(`Relay task ${task.id} context could not be decrypted.`, {
          cause,
        });
      }

      const event: PagentEvent = {
        ...metadata,
        payload,
      };
      const result = await this.#agent.run({
        cwd: this.#repositories.get(task.repositoryKey)!,
        prompt: investigationPrompt(task.repositoryKey, event),
        event,
        ...(signal === undefined ? {} : { signal }),
      });
      await this.#inbox.markAgentCompleted(task.id);
      if (this.#onAgentResult !== undefined) {
        try {
          await this.#onAgentResult(result, task);
        } catch (error) {
          this.#report(error);
        }
      }
      await this.#acknowledge(task.id, signal);
      await this.#inbox.markAcknowledged(task.id);
      task = await this.#inbox.next();
    }
  }

  async #drainAcknowledgements(
    signal: AbortSignal | undefined,
  ): Promise<void> {
    let taskId = await this.#inbox.nextAcknowledgement();
    while (taskId !== undefined) {
      await this.#acknowledge(taskId, signal);
      await this.#inbox.markAcknowledged(taskId);
      taskId = await this.#inbox.nextAcknowledgement();
    }
  }

  async #acknowledge(
    taskId: string,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    const response = await this.#fetch(taskAcknowledgementUrl(this.#url, taskId), {
      method: "POST",
      headers: { authorization: `Bearer ${this.#token}` },
      ...(signal === undefined ? {} : { signal }),
    });
    if (!response.ok) {
      throw new Error(
        `Relay acknowledgement failed with status ${response.status}.`,
      );
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

  #reportConnection(connected: boolean): void {
    try {
      this.#onConnectionChange?.(connected);
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
    !isTaskId(message.id) ||
    value.id !== message.id ||
    !nonempty(value.type) ||
    !nonempty(value.eventId) ||
    !nonempty(value.environment) ||
    !nonempty(value.occurredAt) ||
    !isInvestigationPolicy(value.investigation) ||
    !nonempty(value.repositoryKey) ||
    !isEncryptedContext(value.context)
  ) {
    throw new Error(`Relay task ${message.id} has an invalid shape.`);
  }

  return {
    id: message.id,
    eventId: value.eventId,
    type: value.type,
    environment: value.environment,
    occurredAt: value.occurredAt,
    investigation: value.investigation,
    repositoryKey: value.repositoryKey,
    context: value.context,
  };
}

function inboxState(value: unknown): InboxState {
  const state = record(value);
  if (
    (state?.version !== 2 && state?.version !== 3 && state?.version !== 4) ||
    !Array.isArray(state.pending) ||
    !state.pending.every(isRelayTask) ||
    (state.cursor !== undefined && !isTaskId(state.cursor)) ||
    (state.version === 4 &&
      (!Array.isArray(state.acknowledgements) ||
        !state.acknowledgements.every(isTaskId))) ||
    (state.version === 2 &&
      (!Array.isArray(state.completed) ||
        !state.completed.every((id) => typeof id === "string")))
  ) {
    throw new Error("Relay connector inbox is invalid.");
  }

  return {
    version: 4,
    ...(state.cursor === undefined ? {} : { cursor: state.cursor }),
    pending: state.pending,
    acknowledgements:
      state.version === 4 ? state.acknowledgements as string[] : [],
  };
}

function taskAcknowledgementUrl(eventsUrl: string, taskId: string): string {
  const url = new URL(eventsUrl);
  if (!url.pathname.endsWith("/events")) {
    throw new Error("Relay connector URL must end with /events.");
  }
  url.pathname = `${url.pathname.slice(0, -"/events".length)}/tasks/${encodeURIComponent(taskId)}/ack`;
  return url.toString();
}

function isRelayTask(value: unknown): value is RelayTask {
  const task = record(value);
  return (
    task !== undefined &&
    isTaskId(task.id) &&
    nonempty(task.eventId) &&
    nonempty(task.type) &&
    nonempty(task.environment) &&
    nonempty(task.occurredAt) &&
    isInvestigationPolicy(task.investigation) &&
    nonempty(task.repositoryKey) &&
    isEncryptedContext(task.context)
  );
}

function isTaskId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9]\d*$/u.test(value) &&
    BigInt(value) <= MAX_SEQUENCE_ID
  );
}

function sequenceAfter(candidate: string, cursor: string): boolean {
  if (!isTaskId(candidate) || !isTaskId(cursor)) {
    throw new Error("Relay task IDs must be positive 64-bit integers.");
  }
  return BigInt(candidate) > BigInt(cursor);
}

function isEncryptedContext(value: unknown): value is EncryptedContext {
  const context = record(value);
  return (
    context !== undefined &&
    context.algorithm === "A256GCM" &&
    nonempty(context.keyId) &&
    context.keyId === context.keyId.trim() &&
    context.keyId.length <= 200 &&
    typeof context.iv === "string" &&
    /^[A-Za-z0-9_-]{16}$/u.test(context.iv) &&
    typeof context.ciphertext === "string" &&
    context.ciphertext.length >= 22 &&
    /^[A-Za-z0-9_-]+$/u.test(context.ciphertext)
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

function investigationPrompt(
  repositoryKey: string,
  event: PagentEvent,
): string {
  return [
    `Investigate a ${event.environment} ${event.type} event in repository ${repositoryKey}.`,
    "Use the local checkout provided as your working directory; do not inspect a remote copy of the repository.",
    "Find the root cause and report the supporting evidence. Do not modify files.",
    "",
    `Event ID: ${event.id}`,
    `Occurred at: ${event.occurredAt}`,
    "Event context:",
    JSON.stringify(event.payload, null, 2),
  ].join("\n");
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
