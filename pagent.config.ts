import { resolve } from "node:path";

import { defineConnectorConfig } from "pagent/connector";

const connectorId = process.env.PAGENT_CONNECTOR_ID?.trim() || "demo-laptop";
const repositoryKey =
  process.env.PAGENT_REPOSITORY_KEY?.trim() || "pagent-demo";

export default defineConnectorConfig({
  relay: {
    url: requireEnvironment("PAGENT_RELAY_URL"),
    token: requireEnvironment("PAGENT_CONNECTOR_TOKEN"),
    connectorId,
  },
  repositories: {
    [repositoryKey]: resolve(
      process.env.PAGENT_REPOSITORY_PATH?.trim() || process.cwd(),
    ),
  },
  environments: commaSeparated(
    process.env.PAGENT_ALLOWED_ENVIRONMENTS,
    ["staging"],
  ),
  encryption: {
    keys: contextKeys(process.env.PAGENT_CONTEXT_KEYS),
  },
  codex: {
    sandboxMode: codexSandboxMode(process.env.PAGENT_CODEX_SANDBOX),
  },
});

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value === "") {
    throw new Error(`${name} is required.`);
  }
  return value;
}

function commaSeparated(
  value: string | undefined,
  fallback: readonly string[],
): string[] {
  const items = value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return items === undefined || items.length === 0 ? [...fallback] : items;
}

function contextKeys(value: string | undefined): Record<string, string> {
  if (value === undefined || value.trim() === "") {
    throw new Error("PAGENT_CONTEXT_KEYS is required.");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (cause) {
    throw new Error("PAGENT_CONTEXT_KEYS must be a JSON object.", { cause });
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length === 0 ||
    !Object.values(parsed).every((key) => typeof key === "string")
  ) {
    throw new Error("PAGENT_CONTEXT_KEYS must map key IDs to base64url keys.");
  }

  return parsed as Record<string, string>;
}

function codexSandboxMode(
  value: string | undefined,
): "read-only" | "workspace-write" | "danger-full-access" {
  if (
    value === "workspace-write" ||
    value === "danger-full-access" ||
    value === "read-only"
  ) {
    return value;
  }
  return "read-only";
}
