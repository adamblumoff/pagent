import { defineConfig } from "./src/index.js";

export default defineConfig({
  enabled: process.env.PAGENT_ENABLED === "true",
  environment: process.env.PAGENT_ENV,
  cwd: process.cwd(),
  codex: {
    sandboxMode: "read-only",
    approvalPolicy: "never",
  },
});
