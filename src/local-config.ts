import { access } from "node:fs/promises";
import { dirname, join, parse, resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { pathToFileURL } from "node:url";

import {
  parseConnectorConfig,
  type ConnectorConfig,
} from "./config.js";

const CONFIG_NAMES = [
  "pagent.config.ts",
  "pagent.config.mts",
  "pagent.config.mjs",
  "pagent.config.js",
] as const;
let configRevision = 0;

export interface LoadedConnectorConfig {
  config: ConnectorConfig;
  path: string;
  projectDirectory: string;
}

export async function loadConnectorConfig(options: {
  cwd?: string;
  configPath?: string | undefined;
} = {}): Promise<LoadedConnectorConfig> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const configuredPath = options.configPath ?? process.env.PAGENT_CONFIG;
  const path =
    configuredPath === undefined
      ? await findConfig(cwd)
      : resolve(cwd, configuredPath);

  if (path === undefined) {
    throw new Error(
      `No Pagent config was found from ${cwd}. Add pagent.config.ts at the repository root.`,
    );
  }

  loadProjectEnvironment(dirname(path));

  let imported: unknown;
  try {
    const url = pathToFileURL(path);
    if (configRevision > 0) {
      url.searchParams.set("pagent_revision", String(configRevision));
    }
    imported = await import(url.href);
  } catch (cause) {
    throw new Error(`Could not load Pagent config at ${path}.`, { cause });
  }

  const module = record(imported);
  let config: ConnectorConfig;
  try {
    config = parseConnectorConfig(module?.default);
  } catch (cause) {
    const detail = cause instanceof Error ? ` ${cause.message}` : "";
    throw new Error(`Pagent config at ${path} is invalid.${detail}`, { cause });
  }

  return { config, path, projectDirectory: dirname(path) };
}

/** Reloads a config after `pagent init --reset` replaces it in this process. */
export function invalidateConnectorConfigCache(): void {
  configRevision += 1;
}

function loadProjectEnvironment(directory: string): void {
  const paths = [
    join(directory, ".pagent", "local.env"),
    join(directory, ".env"),
  ];
  for (const path of paths) {
    try {
      loadEnvFile(path);
    } catch (error) {
      if (!isNodeError(error) || error.code !== "ENOENT") {
        throw error;
      }
    }
  }
}

async function findConfig(start: string): Promise<string | undefined> {
  let directory = start;
  const root = parse(start).root;

  while (true) {
    for (const name of CONFIG_NAMES) {
      const candidate = join(directory, name);
      if (await exists(candidate)) {
        return candidate;
      }
    }
    if (directory === root) {
      return undefined;
    }
    directory = dirname(directory);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error;
}
