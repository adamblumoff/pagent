import type { RelayConfig, RelayTask } from "../src/types.js";

export const relayTestConfig: RelayConfig = {
  port: 0,
  heartbeatMs: 100,
  acknowledgedContextRetentionMs: 86_400_000,
  sources: [
    {
      token: "source-secret",
      repositoryKey: "pagent-demo",
      connectorId: "local-1",
      allowedEnvironments: ["staging", "production"],
    },
  ],
  connectors: [{ id: "local-1", token: "connector-secret" }],
  adminToken: "admin-secret",
};

export function relayTestEvent(
  id: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    version: 2,
    event: {
      id,
      type: "health.failed",
      environment: "staging",
      occurredAt: "2026-08-24T12:00:00.000Z",
      context: {
        algorithm: "A256GCM",
        keyId: "staging-2026-08",
        iv: "AAECAwQFBgcICQoL",
        ciphertext: "AAECAwQFBgcICQoLDA0ODw",
      },
      ...overrides,
    },
  };
}

export function relayTestTask(
  id: string,
  eventId: string,
  overrides: Partial<RelayTask> = {},
): RelayTask {
  return {
    id,
    eventId,
    type: "health.failed",
    environment: "staging",
    occurredAt: "2026-08-24T12:00:00.000Z",
    investigation: { cooldownMs: 0 },
    repositoryKey: "pagent-demo",
    context: {
      algorithm: "A256GCM",
      keyId: "staging-2026-08",
      iv: "AAECAwQFBgcICQoL",
      ciphertext: "AAECAwQFBgcICQoLDA0ODw",
    },
    ...overrides,
  };
}
