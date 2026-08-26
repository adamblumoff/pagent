import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConnectorConfig } from "pagent/connector";

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConnectorConfig({
  relay: {
    url: "https://relay-production-4b69.up.railway.app",
    token: required("PAGENT_CONNECTOR_TOKEN"),
    connectorId: "pagent-adam-blumoff-dell-06qEm7BG",
  },
  repositories: {
    "pagent": repositoryDirectory,
  },
  environments: ["staging"],
  encryption: {
    keys: keyring(),
  },
  codex: {
    sandboxMode: "read-only",
  },
  stateDirectory: join(repositoryDirectory, ".pagent", "state"),
});

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function keyring(): Record<string, string> {
  const value = JSON.parse(required("PAGENT_CONTEXT_KEYS")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PAGENT_CONTEXT_KEYS must be a JSON object.");
  }
  return value as Record<string, string>;
}
