import { resolve } from "node:path";

import {
  codexAgent,
  createRelayConnector,
} from "../src/index.js";
import pagentConfig from "../pagent.config.js";

const relayUrl = requireEnvironment("PAGENT_RELAY_URL");
const connectorId = process.env.PAGENT_CONNECTOR_ID?.trim() || "demo-laptop";
const repositoryKey = process.env.PAGENT_REPOSITORY_KEY?.trim() || "pagent-demo";
const repositoryPath = resolve(
  process.env.PAGENT_REPOSITORY_PATH?.trim() || process.cwd(),
);

const connector = createRelayConnector({
  url: new URL(
    `/v1/connectors/${encodeURIComponent(connectorId)}/events`,
    relayUrl,
  ).toString(),
  token: requireEnvironment("PAGENT_CONNECTOR_TOKEN"),
  inboxPath: resolve(
    process.env.PAGENT_INBOX_PATH?.trim() || ".pagent/inbox.json",
  ),
  repositories: { [repositoryKey]: repositoryPath },
  environments: commaSeparated(
    process.env.PAGENT_ALLOWED_ENVIRONMENTS,
    ["staging"],
  ),
  agent: codexAgent(pagentConfig.codex),
  onAgentResult: (result, task) => {
    console.log(
      `[pagent] ${task.type} diagnosis thread: ${result.threadId ?? "unknown"}`,
    );
    if (result.finalResponse !== undefined) {
      console.log(result.finalResponse);
    }
  },
  onError: (error) => console.error("[pagent] connector error", error),
});

const abort = new AbortController();
process.once("SIGINT", () => abort.abort());
process.once("SIGTERM", () => abort.abort());

console.log(
  `[pagent] connecting ${connectorId}; ${repositoryKey} -> ${repositoryPath}; sandbox=${pagentConfig.codex?.sandboxMode ?? "Codex default"}`,
);
await connector.run({ signal: abort.signal });

function requireEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (value === undefined || value.length === 0) {
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
