import { defineRailway, preserve, project, service } from "railway/iac";

export const partial = "demo";

export default defineRailway(() => {
  const demo = service("demo", {
    build: {
      builder: "RAILPACK",
      buildCommand: "pnpm build:sdk && pnpm --filter pagent-demo build",
    },
    deploy: {
      startCommand: "pnpm --filter pagent-demo start",
      healthcheckPath: "/health",
      healthcheckTimeout: 30,
      restartPolicyMaxRetries: 5,
    },
    env: {
      DEMO_TRIGGER_TOKEN: preserve(),
      PAGENT_ENABLED: preserve(),
      PAGENT_ENCRYPTION_KEY: preserve(),
      PAGENT_ENCRYPTION_KEY_ID: preserve(),
      PAGENT_ENV: preserve(),
      PAGENT_RELAY_TOKEN: preserve(),
      PAGENT_RELAY_URL: preserve(),
    },
  });

  return project("pagent-demo", {
    resources: [demo],
  });
});
