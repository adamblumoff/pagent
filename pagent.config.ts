import { defineConfig } from "./src/index.js";

const relayUrl = process.env.PAGENT_RELAY_URL?.trim();
const relayToken = process.env.PAGENT_RELAY_TOKEN?.trim();

export default defineConfig({
  enabled: process.env.PAGENT_ENABLED === "true",
  environment: process.env.PAGENT_ENV,
  cwd: process.cwd(),
  codex: {
    sandboxMode: codexSandboxMode(process.env.PAGENT_CODEX_SANDBOX),
  },
  ...(relayUrl && relayToken
    ? {
        relay: {
          url: new URL("/v1/events", relayUrl).toString(),
          token: relayToken,
        },
      }
    : {}),
});

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
