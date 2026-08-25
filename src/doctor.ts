import { constants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";

import {
  CodexSandboxProbeError,
  probeCodexAppServer,
  type CodexAgentOptions,
  type CodexProbeOptions,
} from "./codex.js";
import {
  connectorConfigIssue,
  type ConnectorEncryptionConfig,
} from "./config.js";

export type DoctorStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: DoctorCheckId;
  label: string;
  status: DoctorStatus;
  detail: string;
  remediation?: string | undefined;
}

export type DoctorCheckId =
  | "runtime"
  | "config"
  | "repositories"
  | "inbox"
  | "relay.health"
  | "relay.sse"
  | "codex"
  | "sandbox.runtime"
  | "sandbox";

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
  warnings: number;
}

/** Flattened, resolved settings used by both `doctor` and the `start` preflight. */
export interface DoctorInput {
  relayUrl: string;
  connectorId: string;
  connectorToken: string;
  inboxPath: string;
  repositories: Readonly<Record<string, string>>;
  environments: readonly string[];
  encryption: ConnectorEncryptionConfig;
  codex?: CodexAgentOptions | undefined;
  timeoutMs?: number | undefined;
  includeAdvisories?: boolean | undefined;
}

interface FileInfo {
  isDirectory(): boolean;
  isFile(): boolean;
}

export interface DoctorDependencies {
  fetch: typeof fetch;
  runtimeCapabilities(): readonly string[];
  stat(path: string): Promise<FileInfo>;
  access(path: string, mode: number): Promise<void>;
  readFile(path: string): Promise<string>;
  probeCodex(options?: CodexProbeOptions): Promise<void>;
}

const defaultDependencies: DoctorDependencies = {
  fetch: globalThis.fetch,
  runtimeCapabilities,
  stat,
  access: (path, mode) => access(path, mode),
  readFile: (path) => readFile(path, "utf8"),
  probeCodex: probeCodexAppServer,
};

/** Runs a non-destructive connector preflight. Result details never contain credentials. */
export async function runDoctor(
  input: DoctorInput,
  dependencies: Partial<DoctorDependencies> = {},
): Promise<DoctorReport> {
  const deps = { ...defaultDependencies, ...dependencies };
  const timeoutMs = validTimeout(input.timeoutMs) ? input.timeoutMs : 5_000;
  const checks: DoctorCheck[] = [];

  const missingCapabilities = deps.runtimeCapabilities();
  checks.push(
    missingCapabilities.length === 0
      ? check("runtime", "Runtime APIs", "pass", "Required Web APIs are available.")
      : check(
          "runtime",
          "Runtime APIs",
          "fail",
          `Missing required runtime APIs: ${missingCapabilities.join(", ")}.`,
        ),
  );

  const configValid =
    connectorConfigIssue({
      relay: {
        url: input.relayUrl,
        connectorId: input.connectorId,
        token: input.connectorToken,
      },
      repositories: input.repositories,
      environments: input.environments,
      encryption: input.encryption,
      ...(input.codex === undefined ? {} : { codex: input.codex }),
    }) === undefined;
  checks.push(
    configValid
      ? check(
          "config",
          "Connector configuration",
          "pass",
          "Relay, policy, and encryption settings are valid.",
        )
      : check(
          "config",
          "Connector configuration",
          "fail",
          "Connector settings are incomplete or invalid.",
        ),
  );

  const repositories = await checkRepositories(input.repositories, deps);
  checks.push(repositories);
  checks.push(await checkInbox(input.inboxPath, deps));

  if (configValid && missingCapabilities.length === 0) {
    checks.push(await checkRelayHealth(input.relayUrl, timeoutMs, deps));
    checks.push(await checkRelaySse(input, timeoutMs, deps));
  } else {
    checks.push(
      check(
        "relay.health",
        "Relay health",
        "warn",
        "Skipped until the runtime and connector configuration are valid.",
      ),
      check(
        "relay.sse",
        "Relay authentication",
        "warn",
        "Skipped until the runtime and connector configuration are valid.",
      ),
    );
  }

  checks.push(
    ...(await checkCodex(
      input,
      timeoutMs,
      repositories.status === "pass",
      deps,
    )),
  );
  if (input.includeAdvisories !== false) {
    checks.push(checkSandbox(input.codex));
  }

  return {
    checks,
    ok: !checks.some(({ status }) => status === "fail"),
    warnings: checks.filter(({ status }) => status === "warn").length,
  };
}

function check(
  id: DoctorCheckId,
  label: string,
  status: DoctorStatus,
  detail: string,
  remediation?: string,
): DoctorCheck {
  return {
    id,
    label,
    status,
    detail,
    ...(remediation === undefined ? {} : { remediation }),
  };
}

async function checkRepositories(
  repositories: Readonly<Record<string, string>>,
  deps: DoctorDependencies,
): Promise<DoctorCheck> {
  const paths = Object.values(record(repositories) ?? {}).filter(
    (value): value is string => typeof value === "string",
  );
  if (paths.length === 0) {
    return check(
      "repositories",
      "Local repositories",
      "fail",
      "At least one local repository mapping is required.",
    );
  }

  let valid = 0;
  for (const path of paths) {
    try {
      const info = await deps.stat(resolve(path));
      if (!info.isDirectory()) {
        continue;
      }
      await deps.access(resolve(path), constants.R_OK | constants.X_OK);
      valid += 1;
    } catch {
      // The aggregate result avoids disclosing paths from shared diagnostics.
    }
  }
  return valid === paths.length
    ? check(
        "repositories",
        "Local repositories",
        "pass",
        `${valid} local repository mapping${valid === 1 ? " is" : "s are"} accessible.`,
      )
    : check(
        "repositories",
        "Local repositories",
        "fail",
        `${paths.length - valid} of ${paths.length} repository mappings are missing or inaccessible.`,
      );
}

async function checkInbox(
  inboxPath: string,
  deps: DoctorDependencies,
): Promise<DoctorCheck> {
  const storage = await inspectJsonFile(inboxPath, deps);
  if (storage.kind === "missing") {
    return storage.parentWritable
      ? check(
          "inbox",
          "Encrypted inbox",
          "pass",
          "Inbox will be created in an accessible location.",
        )
      : check(
          "inbox",
          "Encrypted inbox",
          "fail",
          "Inbox location is not writable.",
        );
  }
  if (storage.kind === "inaccessible") {
    return check(
      "inbox",
      "Encrypted inbox",
      "fail",
      "Inbox is not a readable and writable regular file.",
    );
  }
  const value = record(storage.value);
  if (value?.version !== 2 && value?.version !== 3) {
    return check(
      "inbox",
      "Encrypted inbox",
      "fail",
      value?.version === 1
        ? "Inbox uses v1; archive or remove it before starting Pagent."
        : "Inbox has an unsupported or invalid format.",
    );
  }
  if (
    !Array.isArray(value.pending) ||
    (value.version === 2 && !Array.isArray(value.completed))
  ) {
    return check(
      "inbox",
      "Encrypted inbox",
      "fail",
      `Inbox v${value.version} is malformed.`,
    );
  }
  return check(
    "inbox",
    "Encrypted inbox",
    "pass",
    value.version === 2
      ? "Inbox v2 is readable and writable and will migrate to v3 on startup."
      : "Inbox v3 is readable and writable.",
  );
}

type InspectedJsonFile =
  | { kind: "missing"; parentWritable: boolean }
  | { kind: "inaccessible" }
  | { kind: "json"; value: unknown };

async function inspectJsonFile(
  path: string,
  deps: DoctorDependencies,
): Promise<InspectedJsonFile> {
  const absolute = resolve(path);
  try {
    const info = await deps.stat(absolute);
    if (!info.isFile()) {
      return { kind: "inaccessible" };
    }
    await deps.access(absolute, constants.R_OK | constants.W_OK);
    try {
      return { kind: "json", value: JSON.parse(await deps.readFile(absolute)) };
    } catch {
      return { kind: "json", value: undefined };
    }
  } catch (error) {
    if (!isMissing(error)) {
      return { kind: "inaccessible" };
    }
    return {
      kind: "missing",
      parentWritable: await nearestParentIsWritable(absolute, deps),
    };
  }
}

async function nearestParentIsWritable(
  path: string,
  deps: DoctorDependencies,
): Promise<boolean> {
  let candidate = dirname(path);
  const root = parse(candidate).root;

  while (true) {
    try {
      const info = await deps.stat(candidate);
      if (!info.isDirectory()) {
        return false;
      }
      await deps.access(candidate, constants.R_OK | constants.W_OK | constants.X_OK);
      return true;
    } catch (error) {
      if (!isMissing(error)) {
        return false;
      }
      if (candidate === root) {
        return false;
      }
      candidate = dirname(candidate);
    }
  }
}

async function checkRelayHealth(
  relayUrl: string,
  timeoutMs: number,
  deps: DoctorDependencies,
): Promise<DoctorCheck> {
  try {
    const response = await fetchWithTimeout(
      deps.fetch,
      new URL("/health", relayUrl),
      { method: "GET", headers: { accept: "application/json" } },
      timeoutMs,
    );
    const result = response.ok
      ? check("relay.health", "Relay health", "pass", "Relay is healthy.")
      : check(
          "relay.health",
          "Relay health",
          "fail",
          `Relay health returned HTTP ${response.status}.`,
        );
    await response.body?.cancel().catch(() => undefined);
    return result;
  } catch {
    return check(
      "relay.health",
      "Relay health",
      "fail",
      "Relay health could not be reached before the timeout.",
    );
  }
}

async function checkRelaySse(
  input: DoctorInput,
  timeoutMs: number,
  deps: DoctorDependencies,
): Promise<DoctorCheck> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    timeout = setTimeout(() => controller.abort(), timeoutMs);
    const url = new URL(
      `/v1/connectors/${encodeURIComponent(input.connectorId)}/events`,
      input.relayUrl,
    );
    const response = await deps.fetch(url, {
      method: "GET",
      headers: {
        accept: "text/event-stream",
        authorization: `Bearer ${input.connectorToken}`,
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      return check(
        "relay.sse",
        "Relay authentication",
        "fail",
        `Relay connector authentication returned HTTP ${response.status}.`,
      );
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
      return check(
        "relay.sse",
        "Relay authentication",
        "fail",
        "Relay connector endpoint did not return an SSE stream.",
      );
    }
    if (response.body === null) {
      return check(
        "relay.sse",
        "Relay authentication",
        "fail",
        "Relay connector endpoint returned no SSE body.",
      );
    }
    return check(
      "relay.sse",
      "Relay authentication",
      "pass",
      "Connector credentials opened an SSE stream.",
    );
  } catch {
    return check(
      "relay.sse",
      "Relay authentication",
      "fail",
      "Relay connector stream could not be opened before the timeout.",
    );
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
    controller.abort();
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function checkCodex(
  input: DoctorInput,
  timeoutMs: number,
  repositoriesReady: boolean,
  deps: DoctorDependencies,
): Promise<DoctorCheck[]> {
  const cwd =
    Object.values(record(input.repositories) ?? {}).find(
      (value): value is string => typeof value === "string" && value !== "",
    ) ?? process.cwd();
  try {
    await deps.probeCodex(
      repositoriesReady
        ? {
            timeoutMs,
            sandbox: { cwd, mode: input.codex?.sandboxMode },
          }
        : { timeoutMs },
    );
    return [
      check(
        "codex",
        "Codex app server",
        "pass",
        "Installed Codex app server initialized without creating a thread.",
      ),
      check(
        "sandbox.runtime",
        "Codex sandbox runtime",
        repositoriesReady ? "pass" : "warn",
        repositoriesReady
          ? "Codex ran a no-thread command with the configured sandbox."
          : "Skipped until the local repository mapping is accessible.",
      ),
    ];
  } catch (error) {
    if (error instanceof CodexSandboxProbeError) {
      const failure = sandboxFailure(error.causeText);
      return [
        check(
          "codex",
          "Codex app server",
          "pass",
          "Installed Codex app server initialized without creating a thread.",
        ),
        check(
          "sandbox.runtime",
          "Codex sandbox runtime",
          "fail",
          failure.detail,
          failure.remediation,
        ),
      ];
    }
    return [
      check(
        "codex",
        "Codex app server",
        "fail",
        "Codex app server could not be found or initialized.",
        "Install or update Codex, run `codex login`, then rerun `pagent doctor`.",
      ),
      check(
        "sandbox.runtime",
        "Codex sandbox runtime",
        "warn",
        "Skipped until the Codex app server can initialize.",
      ),
    ];
  }
}

function sandboxFailure(causeText: string): {
  detail: string;
  remediation: string;
} {
  if (
    /bwrap|bubblewrap/iu.test(causeText) &&
    /RTM_NEWADDR|uid_map|user namespace|operation not permitted/iu.test(causeText)
  ) {
    return {
      detail:
        "Bubblewrap cannot create Codex's Linux sandbox because the host blocked its user or network namespace.",
      remediation: [
        "On Ubuntu 24.04, load the scoped Bubblewrap AppArmor profile documented by OpenAI:",
        "sudo apt update",
        "sudo apt install apparmor-profiles apparmor-utils",
        "sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict",
        "sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict",
        "Then rerun `pagent doctor`. Do not disable AppArmor globally or enable Codex's deprecated `use_legacy_landlock` fallback.",
        "OpenAI docs: https://learn.chatgpt.com/docs/sandboxing",
      ].join("\n"),
    };
  }
  if (
    /bwrap|bubblewrap/iu.test(causeText) &&
    /ENOENT|not found|no such file/iu.test(causeText)
  ) {
    return {
      detail: "Codex cannot find its Bubblewrap sandbox helper.",
      remediation:
        "Install your Linux distribution's `bubblewrap` package (`sudo apt install bubblewrap` on Ubuntu/Debian or `sudo dnf install bubblewrap` on Fedora), then rerun `pagent doctor`.",
    };
  }
  return {
    detail: "Codex could not run a command inside the configured sandbox.",
    remediation:
      "Update Codex, check the host's sandbox and namespace permissions, then rerun `pagent doctor`.",
  };
}

function checkSandbox(codex: CodexAgentOptions | undefined): DoctorCheck {
  const mode = codex?.sandboxMode;
  if (mode === "read-only") {
    return check(
      "sandbox",
      "Codex sandbox",
      "pass",
      "Codex investigations are explicitly read-only.",
    );
  }
  if (mode === "danger-full-access") {
    return check(
      "sandbox",
      "Codex sandbox",
      "warn",
      "Codex investigations have unrestricted filesystem access.",
    );
  }
  if (mode === "workspace-write") {
    return check(
      "sandbox",
      "Codex sandbox",
      "warn",
      "Codex investigations can modify the mapped repository.",
    );
  }
  return check(
    "sandbox",
    "Codex sandbox",
    "warn",
    "Codex sandbox inherits the local Codex default; set read-only explicitly.",
  );
}

function runtimeCapabilities(): readonly string[] {
  const missing: string[] = [];
  if (typeof globalThis.fetch !== "function") missing.push("fetch");
  if (typeof globalThis.crypto?.subtle !== "object") missing.push("Web Crypto");
  if (typeof globalThis.AbortController !== "function") missing.push("AbortController");
  if (typeof globalThis.Headers !== "function") missing.push("Headers");
  if (typeof globalThis.TextDecoder !== "function") missing.push("TextDecoder");
  if (typeof globalThis.ReadableStream !== "function") missing.push("ReadableStream");
  return missing;
}

function validTimeout(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
