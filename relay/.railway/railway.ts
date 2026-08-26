import { defineRailway, preserve, project, service } from "railway/iac";

export const partial = "relay";

export default defineRailway(() => {
  const relay = service("relay", {
    build: {
      builder: "RAILPACK",
      buildCommand: "npm run build",
    },
    deploy: {
      startCommand: "npm start",
      healthcheckPath: "/health",
      healthcheckTimeout: 30,
      restartPolicyMaxRetries: 5,
    },
    env: {
      DATABASE_URL: preserve(),
      PAGENT_ADMIN_TOKEN: preserve(),
      PAGENT_SSE_HEARTBEAT_MS: preserve(),
    },
  });

  return project("pagent-relay", {
    resources: [relay],
  });
});
