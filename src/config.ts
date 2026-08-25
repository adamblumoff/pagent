import type { CodexAgentOptions } from "./codex.js";

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
