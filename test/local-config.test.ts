import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  invalidateConnectorConfigCache,
  loadConnectorConfig,
} from "../src/local-config.js";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  delete process.env.PAGENT_TEST_HOSTNAME;
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("local connector config", () => {
  it("finds the direct config from a nested directory and loads its .env", async () => {
    const root = await temporaryDirectory();
    const nested = join(root, "packages", "service");
    await mkdir(nested, { recursive: true });
    await writeFile(
      join(root, ".env"),
      "PAGENT_TEST_HOSTNAME=env-project.dev.example.test\n",
    );
    await writeFile(
      join(root, "pagent.config.mjs"),
      directConfig(root, "process.env.PAGENT_TEST_HOSTNAME"),
    );

    const loaded = await loadConnectorConfig({ cwd: nested });

    expect(loaded.path).toBe(join(root, "pagent.config.mjs"));
    expect(loaded.projectDirectory).toBe(root);
    expect(loaded.config).toMatchObject({
      ingress: { host: "127.0.0.1", port: 43121, token: "source-secret" },
      tunnel: {
        environmentId: "dev-machine",
        tunnelId: "tunnel-1",
        hostname: "env-project.dev.example.test",
        provisionerUrl: "https://provisioner.example.test",
        tokenFile: join(root, ".pagent", "tunnel-token"),
      },
    });
  });

  it("loads local connector secrets before the project .env", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, ".pagent"), { recursive: true });
    await writeFile(
      join(root, ".pagent", "local.env"),
      "PAGENT_TEST_HOSTNAME=env-local.dev.example.test\n",
    );
    await writeFile(
      join(root, ".env"),
      "PAGENT_TEST_HOSTNAME=env-project.dev.example.test\n",
    );
    await writeFile(
      join(root, "pagent.config.mjs"),
      directConfig(root, "process.env.PAGENT_TEST_HOSTNAME"),
    );

    const loaded = await loadConnectorConfig({ cwd: root });

    expect(loaded.config.tunnel.hostname).toBe("env-local.dev.example.test");
  });

  it("rejects a config without local ingress settings", async () => {
    const root = await temporaryDirectory();
    await writeFile(
      join(root, "pagent.config.mjs"),
      "export default {};\n",
    );

    await expect(loadConnectorConfig({ cwd: root })).rejects.toThrow(
      "is invalid. Local ingress settings are required.",
    );
  });

  it("reloads tunnel settings after reset invalidates the module cache", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "pagent.config.mjs");
    await writeFile(path, directConfig(root, '"env-old.dev.example.test"'));
    expect((await loadConnectorConfig({ cwd: root })).config.tunnel.hostname).toBe(
      "env-old.dev.example.test",
    );

    await writeFile(path, directConfig(root, '"env-new.dev.example.test"'));
    invalidateConnectorConfigCache();

    expect((await loadConnectorConfig({ cwd: root })).config.tunnel.hostname).toBe(
      "env-new.dev.example.test",
    );
  });

  it("rejects invalid key material without including it in the error", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "pagent.config.mjs");
    await writeFile(
      path,
      directConfig(root, '"env.dev.example.test"').replace(KEY, "secret-key-material"),
    );

    const loading = loadConnectorConfig({ cwd: root });
    await expect(loading).rejects.toThrow(
      "Each connector encryption key must be canonical unpadded base64url.",
    );
    await expect(loading).rejects.not.toThrow("secret-key-material");
  });

  it("validates direct tunnel and loopback ingress fields", async () => {
    const root = await temporaryDirectory();
    const path = join(root, "pagent.config.mjs");
    await writeFile(
      path,
      directConfig(root, '"env.dev.example.test"').replace(
        'host: "127.0.0.1"',
        'host: "0.0.0.0"',
      ),
    );
    await expect(loadConnectorConfig({ cwd: root })).rejects.toThrow(
      "Local ingress host must be 127.0.0.1 or ::1.",
    );

    await writeFile(
      path,
      directConfig(root, '"env.dev.example.test"').replace(
        "https://provisioner.example.test",
        "http://provisioner.example.test",
      ),
    );
    invalidateConnectorConfigCache();
    await expect(loadConnectorConfig({ cwd: root })).rejects.toThrow(
      "Tunnel provisioner URL must be an HTTPS origin.",
    );

    await writeFile(
      path,
      directConfig(root, '"env.dev.example.test"').replace(
        "https://provisioner.example.test",
        "http://127.0.0.1:8787",
      ),
    );
    invalidateConnectorConfigCache();
    await expect(loadConnectorConfig({ cwd: root })).resolves.toMatchObject({
      config: { tunnel: { provisionerUrl: "http://127.0.0.1:8787" } },
    });
  });

  it("explains when no config exists", async () => {
    const root = await temporaryDirectory();
    await expect(loadConnectorConfig({ cwd: root })).rejects.toThrow(
      "No Pagent config was found",
    );
  });
});

function directConfig(root: string, hostnameExpression: string): string {
  return `export default {
    ingress: { host: "127.0.0.1", port: 43121, token: "source-secret" },
    tunnel: {
      environmentId: "dev-machine",
      tunnelId: "tunnel-1",
      hostname: ${hostnameExpression},
      provisionerUrl: "https://provisioner.example.test",
      tokenFile: ${JSON.stringify(join(root, ".pagent", "tunnel-token"))}
    },
    repositories: { pagent: ${JSON.stringify(root)} },
    environments: ["staging"],
    encryption: { keys: { current: ${JSON.stringify(KEY)} } },
    codex: { sandboxMode: "read-only" }
  };\n`;
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pagent-config-"));
  temporaryDirectories.push(path);
  return path;
}
