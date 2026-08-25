import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { loadConnectorConfig } from "../src/local-config.js";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PAGENT_TEST_RELAY_URL;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("local connector config", () => {
  it("finds the project config from a nested directory and loads its .env", async () => {
    const root = await temporaryDirectory();
    const nested = join(root, "packages", "service");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(root, ".env"),
      "PAGENT_TEST_RELAY_URL=https://relay.example.test\n",
    );
    await writeFile(
      join(root, "pagent.config.mjs"),
      `export default {
        relay: { url: process.env.PAGENT_TEST_RELAY_URL, token: "secret", connectorId: "local" },
        repositories: { pagent: ${JSON.stringify(root)} },
        environments: ["staging"],
        encryption: { keys: { current: ${JSON.stringify(KEY)} } }
      };\n`,
    );

    const loaded = await loadConnectorConfig({ cwd: nested });

    expect(loaded.path).toBe(join(root, "pagent.config.mjs"));
    expect(loaded.projectDirectory).toBe(root);
    expect(loaded.config.relay.url).toBe("https://relay.example.test");
  });

  it("loads local connector secrets before the project .env", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".pagent"), { recursive: true });
    await writeFile(
      join(root, ".pagent", "local.env"),
      "PAGENT_TEST_RELAY_URL=https://local.example.test\n",
    );
    await writeFile(
      join(root, ".env"),
      "PAGENT_TEST_RELAY_URL=https://project.example.test\n",
    );
    await writeFile(
      join(root, "pagent.config.mjs"),
      `export default {
        relay: { url: process.env.PAGENT_TEST_RELAY_URL, token: "secret", connectorId: "local" },
        repositories: { pagent: ${JSON.stringify(root)} },
        environments: ["staging"],
        encryption: { keys: { current: ${JSON.stringify(KEY)} } }
      };\n`,
    );

    const loaded = await loadConnectorConfig({ cwd: root });

    expect(loaded.config.relay.url).toBe("https://local.example.test");
  });

  it("rejects a config without the local connector contract", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "pagent.config.mjs");
    await writeFile(path, "export default { codex: {} };\n");

    await expect(loadConnectorConfig({ cwd: root })).rejects.toThrow(
      "is invalid. Relay settings are required.",
    );
  });

  it("rejects invalid key material without including it in the error", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "pagent.config.mjs");
    await writeFile(
      path,
      `export default {
        relay: { url: "https://relay.example.test", token: "secret", connectorId: "local" },
        repositories: { pagent: ${JSON.stringify(root)} },
        environments: ["staging"],
        encryption: { keys: { current: "secret-key-material" } }
      };\n`,
    );

    const loading = loadConnectorConfig({ cwd: root });
    await expect(loading).rejects.toThrow(
      "Each connector encryption key must be canonical unpadded base64url.",
    );
    await expect(loading).rejects.not.toThrow("secret-key-material");
  });

  it("explains when no config exists", async () => {
    const root = await temporaryDirectory();

    await expect(loadConnectorConfig({ cwd: root })).rejects.toThrow(
      "No Pagent config was found",
    );
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pagent-config-"));
  temporaryDirectories.push(path);
  return path;
}
