import type { CodexAgentOptions } from "./codex.js";
import { decodeBase64Url } from "./encoding.js";
import {
  slackNotificationConfigIssue,
  type SlackNotificationConfig,
} from "./slack-notifications.js";

export type { SlackNotificationConfig } from "./slack-notifications.js";

/** AES-256-GCM decryption keys indexed by the public ID in each event. */
export type ConnectorKeyring = Readonly<Record<string, string>>;

export interface ConnectorEncryptionConfig {
  keys: ConnectorKeyring;
}

export interface LocalIngressConfig {
  host?: "127.0.0.1" | "::1" | undefined;
  port: number;
  token: string;
}

export interface TunnelConfig {
  environmentId: string;
  tunnelId: string;
  hostname: string;
  provisionerUrl: string;
  tokenFile: string;
  cloudflaredPath?: string | undefined;
}

export interface ConnectorNotificationsConfig {
  slack?: SlackNotificationConfig | undefined;
}

/** Local settings for the connector process that launches Codex. */
export interface ConnectorConfig {
  ingress: LocalIngressConfig;
  tunnel: TunnelConfig;
  repositories: Readonly<Record<string, string>>;
  environments: readonly string[];
  codex?: CodexAgentOptions | undefined;
  notifications?: ConnectorNotificationsConfig | undefined;
  encryption: ConnectorEncryptionConfig;
  stateDirectory?: string | undefined;
}

/** Defines local connector settings without widening their inferred types. */
export function defineConnectorConfig<const TConfig extends ConnectorConfig>(
  config: TConfig,
): TConfig {
  return config;
}

export function parseConnectorConfig(value: unknown): ConnectorConfig {
  const issue = connectorConfigIssue(value);
  if (issue !== undefined) {
    throw new Error(issue);
  }
  return value as ConnectorConfig;
}

export function parseConnectorKeyring(value: unknown): ConnectorKeyring {
  const issue = connectorKeyringIssue(value);
  if (issue !== undefined) throw new Error(issue);
  return value as ConnectorKeyring;
}

export function connectorConfigIssue(value: unknown): string | undefined {
  const config = record(value);
  const ingress = record(config?.ingress);
  if (ingress === undefined) {
    return "Local ingress settings are required.";
  }
  if (
    ingress.host !== undefined &&
    ingress.host !== "127.0.0.1" &&
    ingress.host !== "::1"
  ) {
    return "Local ingress host must be 127.0.0.1 or ::1.";
  }
  if (
    typeof ingress.port !== "number" ||
    !Number.isSafeInteger(ingress.port) ||
    ingress.port < 1 ||
    ingress.port > 65_535
  ) {
    return "Local ingress port must be an integer from 1 to 65535.";
  }
  if (!trimmed(ingress.token) || /[\r\n]/u.test(ingress.token)) {
    return "Local ingress token must be a non-empty bearer token.";
  }

  const tunnel = record(config?.tunnel);
  if (tunnel === undefined) {
    return "Cloudflare Tunnel settings are required.";
  }
  if (!trimmed(tunnel.environmentId) || !trimmed(tunnel.tunnelId)) {
    return "Tunnel environment and tunnel IDs must be non-empty strings.";
  }
  if (!hostname(tunnel.hostname)) {
    return "Tunnel hostname must be a valid DNS hostname without a URL scheme.";
  }
  if (!provisioningOrigin(tunnel.provisionerUrl)) {
    return "Tunnel provisioner URL must be an HTTPS origin.";
  }
  if (!trimmed(tunnel.tokenFile)) {
    return "Tunnel token file must be a non-empty path.";
  }
  if (tunnel.cloudflaredPath !== undefined && !trimmed(tunnel.cloudflaredPath)) {
    return "cloudflared path must be a non-empty path when set.";
  }

  const repositories = record(config?.repositories);
  if (
    repositories === undefined ||
    Object.keys(repositories).length === 0 ||
    !Object.entries(repositories).every(
      ([key, path]) => trimmed(key) && trimmed(path),
    )
  ) {
    return "Repositories must map non-empty keys to non-empty local paths.";
  }

  if (
    !Array.isArray(config?.environments) ||
    config.environments.length === 0 ||
    !config.environments.every(trimmed)
  ) {
    return "Allowed environments must contain at least one non-empty string.";
  }

  const encryption = record(config?.encryption);
  const keyringIssue = connectorKeyringIssue(encryption?.keys);
  if (keyringIssue !== undefined) return keyringIssue;

  if (
    config?.stateDirectory !== undefined &&
    !trimmed(config.stateDirectory)
  ) {
    return "State directory must be a non-empty path when set.";
  }

  const codex = record(config?.codex);
  if (config?.codex !== undefined && codex === undefined) {
    return "Codex settings must be an object when set.";
  }
  if (
    codex?.approvalPolicy !== undefined &&
    codex.approvalPolicy !== "never" &&
    codex.approvalPolicy !== "on-request" &&
    codex.approvalPolicy !== "untrusted"
  ) {
    return "Codex approval policy is invalid.";
  }
  if (
    codex?.sandboxMode !== undefined &&
    codex.sandboxMode !== "danger-full-access" &&
    codex.sandboxMode !== "read-only" &&
    codex.sandboxMode !== "workspace-write"
  ) {
    return "Codex sandbox mode is invalid.";
  }

  const notifications = record(config?.notifications);
  if (config?.notifications !== undefined && notifications === undefined) {
    return "Notification settings must be an object when set.";
  }
  if (notifications?.slack !== undefined) {
    return slackNotificationConfigIssue(notifications.slack);
  }
  return undefined;
}

function connectorKeyringIssue(value: unknown): string | undefined {
  const keys = record(value);
  if (keys === undefined || Object.keys(keys).length === 0) {
    return "Encryption keys must contain at least one key.";
  }
  for (const [keyId, key] of Object.entries(keys)) {
    if (!trimmed(keyId) || keyId.length > 200 || typeof key !== "string") {
      return "Encryption key IDs and values must be non-empty strings.";
    }
    try {
      if (decodeBase64Url(key, "Connector encryption key").byteLength !== 32) {
        return "Each connector encryption key must decode to 32 bytes.";
      }
    } catch {
      return "Each connector encryption key must be canonical unpadded base64url.";
    }
  }
  return undefined;
}

function hostname(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  if (value !== value.trim() || value.length > 253 || value.includes(":")) {
    return false;
  }
  try {
    const url = new URL(`https://${value}`);
    return url.hostname === value.toLowerCase() && url.pathname === "/";
  } catch {
    return false;
  }
}

function provisioningOrigin(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost";
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function trimmed(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value === value.trim();
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
