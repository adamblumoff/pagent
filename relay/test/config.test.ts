import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { loadConfig } from "../src/config.js";

describe("relay config", () => {
  it("allows admin-only bootstrap", () => {
    assert.deepEqual(
      loadConfig({ PAGENT_ADMIN_TOKEN: " admin-secret " }),
      {
        port: 3000,
        heartbeatMs: 15_000,
        acknowledgedContextRetentionMs: 86_400_000,
        sources: [],
        connectors: [],
        adminToken: "admin-secret",
      },
    );
  });

  it("keeps static source and connector credentials working", () => {
    const config = loadConfig({
      PAGENT_SOURCE_TOKEN: "source-secret",
      PAGENT_CONNECTOR_TOKEN: "connector-secret",
      PAGENT_REPOSITORY_KEY: "repo",
      PAGENT_CONNECTOR_ID: "connector",
      PAGENT_ALLOWED_ENVIRONMENTS: "staging,production",
    });

    assert.deepEqual(config.sources, [
      {
        token: "source-secret",
        repositoryKey: "repo",
        connectorId: "connector",
        allowedEnvironments: ["staging", "production"],
      },
    ]);
    assert.deepEqual(config.connectors, [
      { id: "connector", token: "connector-secret" },
    ]);
    assert.equal(config.adminToken, undefined);
    assert.equal(config.acknowledgedContextRetentionMs, 86_400_000);
  });

  it("rejects an inert config and incomplete static credentials", () => {
    assert.throws(() => loadConfig({}), /static source.*admin/i);
    assert.throws(
      () =>
        loadConfig({
          PAGENT_ADMIN_TOKEN: "admin-secret",
          PAGENT_SOURCE_TOKEN: "partial-source",
        }),
      /PAGENT_REPOSITORY_KEY is required/,
    );
    assert.throws(
      () => loadConfig({ PAGENT_ENROLLMENT_TOKEN: "legacy" }),
      /no longer supported/i,
    );
    assert.throws(
      () =>
        loadConfig({
          PAGENT_ADMIN_TOKEN: "admin-secret",
          PAGENT_ACKNOWLEDGED_CONTEXT_RETENTION_MS: "0",
        }),
      /positive integer/,
    );
  });
});
