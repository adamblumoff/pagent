import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { probeCodexAppServer, type CodexAgentOptions } from "./codex.js";
import type {
  ConnectorEncryptionConfig,
  LocalIngressConfig,
  TunnelConfig,
} from "./config.js";
import { resolveCloudflaredBinary } from "./tunnel-process.js";

const execFileAsync = promisify(execFile);

export type DoctorCheckStatus = "pass" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  detail: string;
  remediation?: string | undefined;
}

export interface DoctorReport {
  ok: boolean;
  warnings: number;
  checks: DoctorCheck[];
}

export interface DoctorOptions {
  ingress: LocalIngressConfig;
  tunnel: TunnelConfig;
  repositories: Readonly<Record<string, string>>;
  environments: readonly string[];
  encryption: ConnectorEncryptionConfig;
  codex?: CodexAgentOptions | undefined;
  includeAdvisories?: boolean | undefined;
  ingressPortInUseByPagent?: boolean | undefined;
  dependencies?: {
    resolveCloudflared?: typeof resolveCloudflaredBinary | undefined;
    cloudflaredVersion?: ((binary: string) => Promise<string>) | undefined;
    probeCodex?: (() => Promise<void>) | undefined;
    checkPort?: ((host: string, port: number) => Promise<void>) | undefined;
  } | undefined;
}

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const checks = await Promise.all([
    checkRepositories(options.repositories),
    checkEnvironments(options.environments),
    checkKeyring(options.encryption),
    checkTunnelTokenFile(options.tunnel.tokenFile),
    checkCloudflared(options),
    checkCodex(options),
    checkIngressPort(options),
    checkTunnelHostname(options.tunnel.hostname),
  ]);
  const flat = checks.flat().filter(
    (check) => options.includeAdvisories !== false || check.status !== "warn",
  );
  return {
    ok: flat.every((check) => check.status !== "fail"),
    warnings: flat.filter((check) => check.status === "warn").length,
    checks: flat,
  };
}

async function checkRepositories(
  repositories: Readonly<Record<string, string>>,
): Promise<DoctorCheck> {
  const entries = Object.entries(repositories);
  if (entries.length !== 1) {
    return fail(
      "repositories",
      "Local repository",
      "Direct tunnel delivery requires exactly one repository.",
      "Keep only this initialized repository in pagent.config.ts.",
    );
  }
  const [key, path] = entries[0]!;
  try {
    const metadata = await stat(resolve(path));
    if (!metadata.isDirectory()) throw new Error();
    await access(resolve(path), constants.R_OK);
    return pass("repositories", "Local repository", `${key} at ${resolve(path)}`);
  } catch {
    return fail(
      "repositories",
      "Local repository",
      `${key} is not a readable directory at ${resolve(path)}.`,
      "Fix the repository path in pagent.config.ts.",
    );
  }
}

async function checkEnvironments(
  environments: readonly string[],
): Promise<DoctorCheck> {
  return environments.length > 0
    ? pass("environments", "Allowed environments", environments.join(", "))
    : fail(
        "environments",
        "Allowed environments",
        "No environments are allowed.",
        "Add at least one environment to pagent.config.ts.",
      );
}

async function checkKeyring(
  encryption: ConnectorEncryptionConfig,
): Promise<DoctorCheck> {
  const count = Object.keys(encryption.keys).length;
  return count > 0
    ? pass("encryption", "Encryption keyring", `${count} local key${count === 1 ? "" : "s"}`)
    : fail(
        "encryption",
        "Encryption keyring",
        "No context decryption key is configured.",
        "Run `pagent init --reset`.",
      );
}

async function checkTunnelTokenFile(path: string): Promise<DoctorCheck> {
  try {
    const metadata = await stat(resolve(path));
    await access(resolve(path), constants.R_OK);
    if (!metadata.isFile()) throw new Error();
    if (process.platform !== "win32" && (metadata.mode & 0o077) !== 0) {
      return warn(
        "tunnel.token",
        "Tunnel token file",
        `${resolve(path)} is readable outside its owner.`,
        `Run \`chmod 600 ${resolve(path)}\`.`,
      );
    }
    return pass("tunnel.token", "Tunnel token file", resolve(path));
  } catch {
    return fail(
      "tunnel.token",
      "Tunnel token file",
      `${resolve(path)} is missing or unreadable.`,
      "Run `pagent init --reset` to rotate and rewrite tunnel credentials.",
    );
  }
}

async function checkCloudflared(options: DoctorOptions): Promise<DoctorCheck> {
  try {
    const binary = await (
      options.dependencies?.resolveCloudflared ?? resolveCloudflaredBinary
    )({ binaryPath: options.tunnel.cloudflaredPath });
    const version = await (
      options.dependencies?.cloudflaredVersion ?? defaultCloudflaredVersion
    )(binary);
    return pass("cloudflared", "cloudflared", version);
  } catch {
    return fail(
      "cloudflared",
      "cloudflared",
      "cloudflared is unavailable or could not report its version.",
      "Install cloudflared or set tunnel.cloudflaredPath in pagent.config.ts.",
    );
  }
}

async function defaultCloudflaredVersion(binary: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(binary, ["--version"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  const version = `${stdout}${stderr}`.trim().split(/\r?\n/u)[0];
  if (!version) throw new Error("cloudflared returned no version.");
  return version;
}

async function checkCodex(options: DoctorOptions): Promise<DoctorCheck> {
  try {
    await (
      options.dependencies?.probeCodex ??
      (() => probeCodexAppServer({ ...options.codex, timeoutMs: 5_000 }))
    )();
    return pass("codex", "Codex login", "Codex app server is available.");
  } catch {
    return fail(
      "codex",
      "Codex login",
      "Codex is unavailable or signed out.",
      "Run `codex login`, then retry `pagent doctor`.",
    );
  }
}

async function checkIngressPort(options: DoctorOptions): Promise<DoctorCheck> {
  const host = options.ingress.host ?? "127.0.0.1";
  if (options.ingressPortInUseByPagent === true) {
    return pass(
      "ingress.port",
      "Local ingress port",
      `${host}:${options.ingress.port} is owned by the running Pagent daemon.`,
    );
  }
  try {
    await (options.dependencies?.checkPort ?? checkLoopbackPort)(
      host,
      options.ingress.port,
    );
    return pass(
      "ingress.port",
      "Local ingress port",
      `${host}:${options.ingress.port} is available.`,
    );
  } catch {
    return fail(
      "ingress.port",
      "Local ingress port",
      `${host}:${options.ingress.port} is already in use.`,
      "Stop the process using that port or run `pagent init --reset`.",
    );
  }
}

function checkLoopbackPort(host: string, port: number): Promise<void> {
  return new Promise((resolveCheck, rejectCheck) => {
    const server = createServer();
    server.once("error", rejectCheck);
    server.listen(port, host, () => {
      server.close((error) => {
        if (error === undefined) resolveCheck();
        else rejectCheck(error);
      });
    });
  });
}

async function checkTunnelHostname(hostname: string): Promise<DoctorCheck> {
  return /^[a-z0-9.-]+$/u.test(hostname)
    ? pass("tunnel.hostname", "Tunnel hostname", `https://${hostname}`)
    : fail(
        "tunnel.hostname",
        "Tunnel hostname",
        "The configured hostname is invalid.",
        "Run `pagent init --reset`.",
      );
}

function pass(id: string, label: string, detail: string): DoctorCheck {
  return { id, label, status: "pass", detail };
}

function warn(
  id: string,
  label: string,
  detail: string,
  remediation: string,
): DoctorCheck {
  return { id, label, status: "warn", detail, remediation };
}

function fail(
  id: string,
  label: string,
  detail: string,
  remediation: string,
): DoctorCheck {
  return { id, label, status: "fail", detail, remediation };
}
