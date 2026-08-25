import type { CodexAgentOptions } from "./codex.js";
import { decodeBase64Url } from "./encoding.js";

/** AES-256-GCM decryption keys indexed by the public ID in each event. */
export type ConnectorKeyring = Readonly<Record<string, string>>;

export interface ConnectorEncryptionConfig {
  keys: ConnectorKeyring;
}

export interface ConnectorRelayConfig {
  /** Relay origin, such as https://relay.example.com. */
  url: string;
  token: string;
  connectorId: string;
}

/** Local settings for the connector process that launches Codex. */
export interface ConnectorConfig {
  relay: ConnectorRelayConfig;
  repositories: Readonly<Record<string, string>>;
  environments: readonly string[];
  codex?: CodexAgentOptions | undefined;
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

export function connectorConfigIssue(value: unknown): string | undefined {
  const config = record(value);
  const relay = record(config?.relay);
  if (relay === undefined) {
    return "Relay settings are required.";
  }

  if (!httpUrl(relay.url)) {
    return "Relay URL must be an HTTP or HTTPS URL without embedded credentials.";
  }
  if (!trimmed(relay.token) || /[\r\n]/u.test(relay.token)) {
    return "Relay token must be a non-empty bearer token.";
  }
  if (!trimmed(relay.connectorId)) {
    return "Connector ID must be a non-empty string.";
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
  const keys = record(encryption?.keys);
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
  return undefined;
}

function httpUrl(value: unknown): boolean {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.username === "" &&
      url.password === ""
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
