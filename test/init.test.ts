import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv, promisify } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runProjectInit,
  type ProjectInitDependencies,
  type ProjectInitOptions,
} from "../src/init.js";
import {
  TunnelProvisioningClient,
  type ProvisionedTunnel,
} from "../src/tunnel-provisioning.js";

const execFileAsync = promisify(execFile);
const ENROLLMENT_TOKEN = "pgen_test-enrollment-secret";
const MANAGEMENT_TOKEN = "pgmanage_test-management-secret";
const PROVISIONER_URL = "https://provision.pagent.test";
const ORIGIN_PORT = 47_321;
const TUNNEL_ID = "2d8f665d-e480-4499-b6f0-9f43b7d1a9df";
const TUNNEL_TOKEN = "cloudflare-tunnel-token";
const temporaryDirectories: string[] = [];

type Provisioner = NonNullable<ProjectInitDependencies["provisioner"]>;

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("project initialization", () => {
  it("provisions a tunnel and writes repository-scoped setup files", async () => {
    const root = await repository("Example Service");
    const nested = join(root, "packages", "api");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".gitignore"), "dist/\n");
    const remote = provisioner();

    const result = await runProjectInit(
      {
        ...initOptions(nested),
        environments: ["staging", "production"],
      },
      dependencies(remote.client),
    );

    expect(result).toMatchObject({
      projectDirectory: root,
      repositoryKey: "example-service",
      tunnelId: TUNNEL_ID,
      eventOrigin: tunnelOrigin(result.environmentId),
      environments: ["staging", "production"],
    });
    expect(result.environmentId).toMatch(
      /^example-service-dev-laptop-[A-Za-z0-9_-]{8}$/u,
    );
    expect(remote.createOrResume).toHaveBeenCalledWith({
      environmentId: result.environmentId,
      enrollmentToken: ENROLLMENT_TOKEN,
      idempotencyKey: expect.stringMatching(/^pgi_[A-Za-z0-9_-]{32}$/u),
      originPort: ORIGIN_PORT,
    });
    expect(remote.rotate).not.toHaveBeenCalled();

    const config = await readFile(result.configPath, "utf8");
    const local = parseEnv(await readFile(result.localEnvironmentPath, "utf8"));
    const cloud = parseEnv(await readFile(result.cloudEnvironmentPath, "utf8"));
    const tunnelToken = await readFile(result.tunnelTokenPath, "utf8");
    const keyring = JSON.parse(local.PAGENT_CONTEXT_KEYS!) as Record<string, string>;
    const keyId = cloud.PAGENT_ENCRYPTION_KEY_ID!;

    expect(config).toContain('host: "127.0.0.1"');
    expect(config).toContain(`port: ${ORIGIN_PORT}`);
    expect(config).toContain(`environmentId: ${JSON.stringify(result.environmentId)}`);
    expect(config).toContain(`tunnelId: ${JSON.stringify(TUNNEL_ID)}`);
    expect(config).toContain(
      `hostname: ${JSON.stringify(new URL(result.eventOrigin).hostname)}`,
    );
    expect(config).toContain(`provisionerUrl: ${JSON.stringify(PROVISIONER_URL)}`);
    expect(config).toContain(
      'tokenFile: join(repositoryDirectory, ".pagent", "tunnel-token")',
    );
    expect(config).toContain('cloudflaredPath: "/test/bin/cloudflared"');
    expect(config).toContain('"example-service": repositoryDirectory');
    expect(config).toContain('environments: ["staging","production"]');
    expect(config).toContain('sandboxMode: "read-only"');

    expect(local.PAGENT_SOURCE_TOKEN).toMatch(/^pgs_[A-Za-z0-9_-]{43}$/u);
    expect(local.PAGENT_MANAGEMENT_TOKEN).toBe(MANAGEMENT_TOKEN);
    expect(cloud).toMatchObject({
      PAGENT_ENABLED: "true",
      PAGENT_ENV: "staging",
      PAGENT_ENDPOINT_URL: `${result.eventOrigin}/v1/events`,
      PAGENT_SOURCE_TOKEN: local.PAGENT_SOURCE_TOKEN,
      PAGENT_ENCRYPTION_KEY_ID: keyId,
      PAGENT_ENCRYPTION_KEY: keyring[keyId],
    });
    expect(keyId).toMatch(/^key_[A-Za-z0-9_-]{16}$/u);
    expect(Object.keys(keyring)).toEqual([keyId]);
    expect(Buffer.from(cloud.PAGENT_ENCRYPTION_KEY!, "base64url")).toHaveLength(32);
    expect(tunnelToken).toBe(`${TUNNEL_TOKEN}\n`);

    for (const secret of [
      ENROLLMENT_TOKEN,
      MANAGEMENT_TOKEN,
      TUNNEL_TOKEN,
      local.PAGENT_SOURCE_TOKEN!,
      cloud.PAGENT_ENCRYPTION_KEY!,
    ]) {
      expect(config).not.toContain(secret);
      expect(JSON.stringify(result)).not.toContain(secret);
    }

    if (process.platform !== "win32") {
      expect((await stat(join(root, ".pagent"))).mode & 0o777).toBe(0o700);
      expect((await stat(result.localEnvironmentPath)).mode & 0o777).toBe(0o600);
      expect((await stat(result.cloudEnvironmentPath)).mode & 0o777).toBe(0o600);
      expect((await stat(result.tunnelTokenPath)).mode & 0o777).toBe(0o600);
      expect((await stat(result.configPath)).mode & 0o777).toBe(0o644);
    }
    expect(await readFile(result.gitIgnorePath, "utf8")).toBe(
      "dist/\n.pagent/\n",
    );
  });

  it("uses staging by default and keeps an existing ignore rule", async () => {
    const root = await repository("api");
    await writeFile(join(root, ".gitignore"), ".pagent/\n");

    const result = await runProjectInit(
      initOptions(root),
      dependencies(provisioner().client),
    );

    expect(result.environments).toEqual(["staging"]);
    expect(await readFile(result.gitIgnorePath, "utf8")).toBe(".pagent/\n");
    expect(parseEnv(await readFile(result.cloudEnvironmentPath, "utf8"))).toMatchObject({
      PAGENT_ENV: "staging",
      PAGENT_ENDPOINT_URL: `${result.eventOrigin}/v1/events`,
    });
  });

  it("rotates the tunnel and retains one previous context key", async () => {
    const root = await repository("api");
    const first = await runProjectInit(
      initOptions(root),
      dependencies(provisioner().client, 1),
    );
    const firstLocal = parseEnv(await readFile(first.localEnvironmentPath, "utf8"));
    const firstCloud = parseEnv(await readFile(first.cloudEnvironmentPath, "utf8"));
    const firstKeyring = JSON.parse(firstLocal.PAGENT_CONTEXT_KEYS!) as Record<
      string,
      string
    >;
    const firstKeyId = firstCloud.PAGENT_ENCRYPTION_KEY_ID!;
    const resetRemote = provisioner({
      managementToken: "pgmanage_rotated-management-secret",
      tunnelToken: "rotated-cloudflare-tunnel-token",
    });

    const reset = await runProjectInit(
      {
        ...initOptions(root),
        reset: true,
        environmentId: first.environmentId,
        managementToken: MANAGEMENT_TOKEN,
        originPort: 47_322,
        environments: ["production"],
      },
      dependencies(resetRemote.client, 90),
    );

    expect(resetRemote.createOrResume).not.toHaveBeenCalled();
    expect(resetRemote.rotate).toHaveBeenCalledWith({
      environmentId: first.environmentId,
      managementToken: MANAGEMENT_TOKEN,
      idempotencyKey: expect.stringMatching(/^pgi_[A-Za-z0-9_-]{32}$/u),
      originPort: 47_322,
    });
    const resetLocal = parseEnv(await readFile(reset.localEnvironmentPath, "utf8"));
    const resetCloud = parseEnv(await readFile(reset.cloudEnvironmentPath, "utf8"));
    const resetKeyring = JSON.parse(resetLocal.PAGENT_CONTEXT_KEYS!) as Record<
      string,
      string
    >;
    const resetKeyId = resetCloud.PAGENT_ENCRYPTION_KEY_ID!;
    expect(resetKeyId).not.toBe(firstKeyId);
    expect(resetKeyring).toEqual({
      [firstKeyId]: firstKeyring[firstKeyId],
      [resetKeyId]: resetCloud.PAGENT_ENCRYPTION_KEY,
    });
    expect(resetLocal.PAGENT_MANAGEMENT_TOKEN).toBe(
      "pgmanage_rotated-management-secret",
    );
    expect(await readFile(reset.tunnelTokenPath, "utf8")).toBe(
      "rotated-cloudflare-tunnel-token\n",
    );
    expect(await readFile(reset.configPath, "utf8")).toContain("port: 47322");
    expect(reset.environments).toEqual(["production"]);
  });

  it("replays the same pending environment and idempotency key after a failure", async () => {
    const root = await repository("api");
    await writeFile(join(root, ".gitignore"), "dist/\n");
    const remote = provisioner();
    remote.createOrResume
      .mockRejectedValueOnce(new Error("connection closed after request"))
      .mockImplementationOnce(async (input) => tunnel(input.environmentId, "resumed"));

    await expect(
      runProjectInit(initOptions(root), dependencies(remote.client, 1)),
    ).rejects.toThrow("connection closed after request");

    const pendingPath = join(root, ".git", "pagent", "pending-init.json");
    const pendingText = await readFile(pendingPath, "utf8");
    const pending = JSON.parse(pendingText) as Record<string, unknown>;
    expect(pending).toMatchObject({
      version: 2,
      projectDirectory: root,
      provisionerUrl: PROVISIONER_URL,
      environmentId: remote.createOrResume.mock.calls[0]![0].environmentId,
      originPort: ORIGIN_PORT,
      idempotencyKey: remote.createOrResume.mock.calls[0]![0].idempotencyKey,
    });
    expect(pendingText).not.toContain(ENROLLMENT_TOKEN);
    if (process.platform !== "win32") {
      expect((await stat(pendingPath)).mode & 0o777).toBe(0o600);
    }
    await expect(access(join(root, ".pagent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("dist/\n");

    const findAvailablePort = vi.fn(async () => 60_000);
    await runProjectInit(
      initOptions(root),
      {
        ...dependencies(remote.client, 90),
        findAvailablePort,
      },
    );

    expect(remote.createOrResume).toHaveBeenCalledTimes(2);
    expect(remote.createOrResume.mock.calls[1]![0]).toEqual(
      remote.createOrResume.mock.calls[0]![0],
    );
    expect(findAvailablePort).not.toHaveBeenCalled();
    await expect(access(pendingPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps enrollment credentials out of transport errors and pending state", async () => {
    const root = await repository("api");
    const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(
      new Error(`upstream echoed ${ENROLLMENT_TOKEN}`),
    );
    const client = new TunnelProvisioningClient({
      serviceUrl: PROVISIONER_URL,
      fetch,
    });

    const initialization = runProjectInit(
      initOptions(root),
      dependencies(client),
    );
    await expect(initialization).rejects.toMatchObject({ code: "network" });
    await expect(initialization).rejects.not.toThrow(ENROLLMENT_TOKEN);

    const pending = await readFile(
      join(root, ".git", "pagent", "pending-init.json"),
      "utf8",
    );
    expect(pending).not.toContain(ENROLLMENT_TOKEN);
  });

  it("refuses to overwrite initialized files without reset", async () => {
    const root = await repository("api");
    const first = await runProjectInit(
      initOptions(root),
      dependencies(provisioner().client),
    );
    const originalConfig = await readFile(first.configPath, "utf8");
    const secondRemote = provisioner();

    await expect(
      runProjectInit(initOptions(root), dependencies(secondRemote.client)),
    ).rejects.toThrow("Pagent is already initialized");
    expect(secondRemote.createOrResume).not.toHaveBeenCalled();
    expect(await readFile(first.configPath, "utf8")).toBe(originalConfig);
  });

  it("stops before rotation when the previous keyring is invalid", async () => {
    const root = await repository("api");
    const first = await runProjectInit(
      initOptions(root),
      dependencies(provisioner().client),
    );
    await writeFile(first.localEnvironmentPath, "PAGENT_CONTEXT_KEYS='{}'\n");
    const resetRemote = provisioner();

    await expect(runProjectInit(
      {
        ...initOptions(root),
        reset: true,
        environmentId: first.environmentId,
        managementToken: MANAGEMENT_TOKEN,
      },
      dependencies(resetRemote.client, 90),
    )).rejects.toThrow("Restore it or revoke the tunnel");
    expect(resetRemote.rotate).not.toHaveBeenCalled();
  });

  it.each([
    [
      "remote HTTP provisioner",
      { provisionerUrl: "http://provision.pagent.test" },
      "Provisioner URL must be an HTTPS origin",
    ],
    [
      "provisioner path",
      { provisionerUrl: `${PROVISIONER_URL}/api` },
      "Provisioner URL must be an HTTPS origin",
    ],
    [
      "duplicate environments",
      { environments: ["staging", "staging"] },
      "Allowed environments must be unique names",
    ],
    [
      "invalid ingress port",
      { originPort: 0 },
      "local ingress port must be from 1 to 65535",
    ],
  ])("rejects %s", async (_name, overrides, message) => {
    const root = await repository("api");
    const remote = provisioner();

    await expect(runProjectInit(
      { ...initOptions(root), ...overrides } as ProjectInitOptions,
      dependencies(remote.client),
    )).rejects.toThrow(message as string);
    expect(remote.createOrResume).not.toHaveBeenCalled();
  });

  it("requires reset identity and management credentials", async () => {
    const root = await repository("api");
    const remote = provisioner();

    await expect(runProjectInit(
      { ...initOptions(root), reset: true },
      dependencies(remote.client),
    )).rejects.toThrow("Management token is required");
    await expect(runProjectInit(
      {
        ...initOptions(root),
        reset: true,
        managementToken: MANAGEMENT_TOKEN,
      },
      dependencies(remote.client),
    )).rejects.toThrow("existing tunnel environment ID");
    expect(remote.rotate).not.toHaveBeenCalled();
  });

  it("stops before provisioning when Codex is unavailable", async () => {
    const root = await repository("api");
    const remote = provisioner();

    await expect(runProjectInit(initOptions(root), {
      ...dependencies(remote.client),
      probeCodex: async () => {
        throw new Error(`not signed in ${ENROLLMENT_TOKEN}`);
      },
    })).rejects.toThrow(
      "Codex must be installed and signed in before Pagent can initialize. Run `codex login`",
    );
    expect(remote.createOrResume).not.toHaveBeenCalled();
  });
});

function initOptions(cwd: string): ProjectInitOptions {
  return {
    cwd,
    provisionerUrl: PROVISIONER_URL,
    enrollmentToken: ENROLLMENT_TOKEN,
  };
}

function provisioner(overrides: {
  managementToken?: string;
  tunnelToken?: string;
} = {}) {
  const createOrResume = vi.fn<Provisioner["createOrResume"]>(
    async (input) => tunnel(input.environmentId, "created", overrides),
  );
  const rotate = vi.fn<Provisioner["rotate"]>(
    async (input) => tunnel(input.environmentId, "rotated", overrides),
  );
  return {
    client: { createOrResume, rotate },
    createOrResume,
    rotate,
  };
}

function tunnel(
  environmentId: string,
  status: ProvisionedTunnel["status"],
  overrides: {
    managementToken?: string;
    tunnelToken?: string;
  } = {},
): ProvisionedTunnel {
  return {
    environmentId,
    tunnelId: TUNNEL_ID,
    eventOrigin: tunnelOrigin(environmentId),
    tunnelToken: overrides.tunnelToken ?? TUNNEL_TOKEN,
    managementToken: overrides.managementToken ?? MANAGEMENT_TOKEN,
    status,
  };
}

function dependencies(
  provisionerClient: Provisioner,
  byte = 1,
): ProjectInitDependencies {
  return {
    provisioner: provisionerClient,
    findAvailablePort: async () => ORIGIN_PORT,
    ensureCloudflared: async () => "/test/bin/cloudflared",
    hostname: () => "Dev Laptop",
    probeCodex: async () => undefined,
    randomBytes: (size) => Buffer.alloc(size, byte),
  };
}

function tunnelOrigin(environmentId: string): string {
  return `https://${environmentId.toLowerCase()}.tunnels.pagent.test`;
}

async function repository(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "pagent-init-test-"));
  temporaryDirectories.push(parent);
  const root = join(parent, name);
  await mkdir(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  return root;
}
