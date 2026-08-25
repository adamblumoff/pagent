import type { CodexAgentOptions } from "./codex.js";

/** Local settings for the connector process that launches Codex. */
export interface ConnectorConfig {
  codex?: CodexAgentOptions | undefined;
}

/** Defines local connector settings without widening their inferred types. */
export function defineConnectorConfig<const TConfig extends ConnectorConfig>(
  config: TConfig,
): TConfig {
  return config;
}
