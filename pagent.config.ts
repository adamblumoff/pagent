import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConnectorConfig } from "pagent/connector";

const repositoryDirectory = dirname(fileURLToPath(import.meta.url));

export default defineConnectorConfig({
  ingress: {
    host: "127.0.0.1",
    port: requiredPort("PAGENT_INGRESS_PORT"),
    token: required("PAGENT_SOURCE_TOKEN"),
  },
  tunnel: {
    environmentId: required("PAGENT_TUNNEL_ENVIRONMENT_ID"),
    tunnelId: required("PAGENT_TUNNEL_ID"),
    hostname: required("PAGENT_TUNNEL_HOSTNAME"),
    provisionerUrl: required("PAGENT_PROVISIONER_URL"),
    tokenFile: join(repositoryDirectory, ".pagent", "tunnel-token"),
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

function requiredPort(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535.`);
  }
  return value;
}

function keyring(): Record<string, string> {
  const value = JSON.parse(required("PAGENT_CONTEXT_KEYS")) as unknown;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("PAGENT_CONTEXT_KEYS must be a JSON object.");
  }
  return value as Record<string, string>;
}
