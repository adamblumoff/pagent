import { defineConnectorConfig } from "pagent/connector";

export default defineConnectorConfig({
  codex: {
    sandboxMode: codexSandboxMode(process.env.PAGENT_CODEX_SANDBOX),
  },
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
