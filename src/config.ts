import type { CodexAgentOptions } from "./codex.js";
import type { RelayOptions } from "./types.js";

export interface PagentConfig {
  enabled?: boolean | undefined;
  environment?: string | undefined;
  cwd?: string | undefined;
  codex?: CodexAgentOptions | undefined;
  relay?: RelayOptions | undefined;
}

export function defineConfig<const TConfig extends PagentConfig>(
  config: TConfig,
): TConfig {
  return config;
}
