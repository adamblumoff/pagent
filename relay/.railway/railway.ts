import { defineRailway, preserve, project, service } from "railway/iac";

export const partial = "relay";

export default defineRailway(() => {
  const relay = service("relay", {
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm --filter pagent-relay build",
    },
    deploy: {
      startCommand: "pnpm --filter pagent-relay start",
      healthcheckPath: "/health",
      healthcheckTimeout: 30,
      restartPolicyMaxRetries: 5,
    },
    env: {
      DATABASE_URL: preserve(),
      PAGENT_ADMIN_TOKEN: preserve(),
      PAGENT_ENABLED: preserve(),
      PAGENT_ENCRYPTION_KEY: preserve(),
      PAGENT_ENCRYPTION_KEY_ID: preserve(),
      PAGENT_ENV: preserve(),
      PAGENT_RELAY_TOKEN: preserve(),
      PAGENT_RELAY_URL: preserve(),
      PAGENT_SSE_HEARTBEAT_MS: preserve(),
    },
  });

  return project("pagent-relay", {
    resources: [relay],
  });
});
