import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
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
import { promisify, parseEnv } from "node:util";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runProjectInit,
  type EnrollmentFetch,
  type ProjectInitDependencies,
} from "../src/init.js";

const execFileAsync = promisify(execFile);
const ENROLLMENT_CODE = "pge_test-secret";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("project initialization", () => {
  it("enrolls local credentials and writes a private, repository-scoped setup", async () => {
    const root = await repository("Example Service");
    const nested = join(root, "packages", "api");
    await mkdir(nested, { recursive: true });
    await writeFile(join(root, ".gitignore"), "dist/\n");
    const fetchEnrollment = successfulFetch();

    const result = await runProjectInit(
      {
        cwd: nested,
        relayUrl: "https://relay.example.test/",
        enrollmentCode: ENROLLMENT_CODE,
        environments: ["staging", "production"],
      },
      dependencies(fetchEnrollment),
    );

    expect(result).toMatchObject({
      projectDirectory: root,
      repositoryKey: "example-service",
      relayUrl: "https://relay.example.test",
      environments: ["staging", "production"],
    });
    expect(result.connectorId).toMatch(
      /^example-service-dev-laptop-[A-Za-z0-9_-]{8}$/u,
    );

    const config = await readFile(result.configPath, "utf8");
    const local = parseEnv(await readFile(result.localEnvironmentPath, "utf8"));
    const cloud = parseEnv(await readFile(result.cloudEnvironmentPath, "utf8"));
    expect(config).toContain('url: "https://relay.example.test"');
    expect(config).toContain('"example-service": repositoryDirectory');
    expect(config).toContain('environments: ["staging","production"]');
    expect(config).toContain('sandboxMode: "read-only"');
    expect(config).toContain(
      'stateDirectory: join(repositoryDirectory, ".pagent", "state")',
    );
    expect(config).not.toContain(ENROLLMENT_CODE);
    expect(config).not.toContain(local.PAGENT_CONNECTOR_TOKEN);
    expect(config).not.toContain(cloud.PAGENT_RELAY_TOKEN);
    expect(config).not.toContain(cloud.PAGENT_ENCRYPTION_KEY);

    const keyring = JSON.parse(local.PAGENT_CONTEXT_KEYS!) as Record<string, string>;
    const keyId = cloud.PAGENT_ENCRYPTION_KEY_ID!;
    expect(local.PAGENT_CONNECTOR_TOKEN).toMatch(/^pgcon_/u);
    expect(cloud).toMatchObject({
      PAGENT_ENABLED: "true",
      PAGENT_ENV: "staging",
      PAGENT_RELAY_URL: "https://relay.example.test",
      PAGENT_ENCRYPTION_KEY_ID: keyId,
      PAGENT_ENCRYPTION_KEY: keyring[keyId],
    });
    expect(keyId).toMatch(/^key-[A-Za-z0-9_-]{43}$/u);
    expect(Object.keys(keyring)).toEqual([keyId]);
    expect(cloud.PAGENT_RELAY_TOKEN).toMatch(/^pgsrc_/u);
    expect(Buffer.from(cloud.PAGENT_ENCRYPTION_KEY!, "base64url")).toHaveLength(32);

    expect((await stat(join(root, ".pagent"))).mode & 0o777).toBe(0o700);
    expect((await stat(result.localEnvironmentPath)).mode & 0o777).toBe(0o600);
    expect((await stat(result.cloudEnvironmentPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(result.gitIgnorePath, "utf8")).toBe(
      "dist/\n.pagent/\n",
    );

    expect(fetchEnrollment).toHaveBeenCalledTimes(1);
    const [url, request] = fetchEnrollment.mock.calls[0]!;
    expect(url.toString()).toBe("https://relay.example.test/v1/enroll");
    expect(request.method).toBe("POST");
    expect(request.headers).toEqual({
      authorization: `Bearer ${ENROLLMENT_CODE}`,
      "content-type": "application/json",
    });
    expect(request.signal).toBeInstanceOf(AbortSignal);
    const body = JSON.parse(request.body as string) as Record<string, unknown>;
    expect(body).toEqual({
      version: 1,
      connectorId: result.connectorId,
      repositoryKey: "example-service",
      allowedEnvironments: ["staging", "production"],
      sourceTokenHash: hash(cloud.PAGENT_RELAY_TOKEN!),
      connectorTokenHash: hash(local.PAGENT_CONNECTOR_TOKEN!),
      replace: false,
    });
    expect(JSON.stringify(body)).not.toContain(cloud.PAGENT_RELAY_TOKEN);
    expect(JSON.stringify(body)).not.toContain(local.PAGENT_CONNECTOR_TOKEN);
    expect(JSON.stringify(result)).not.toContain(ENROLLMENT_CODE);
    expect(JSON.stringify(result)).not.toContain(cloud.PAGENT_ENCRYPTION_KEY);
  });

  it("uses staging by default and does not duplicate the ignore rule", async () => {
    const root = await repository("api");
    await writeFile(join(root, ".gitignore"), ".pagent/\n");

    const result = await runProjectInit(
      {
        cwd: root,
        relayUrl: "http://127.0.0.1:8787",
        enrollmentCode: ENROLLMENT_CODE,
      },
      dependencies(successfulFetch()),
    );

    expect(result.environments).toEqual(["staging"]);
    expect(await readFile(result.gitIgnorePath, "utf8")).toBe(".pagent/\n");
    expect(parseEnv(await readFile(result.cloudEnvironmentPath, "utf8"))).toMatchObject({
      PAGENT_ENV: "staging",
      PAGENT_RELAY_URL: "http://127.0.0.1:8787",
    });
  });

  it("refuses to overwrite initialized files unless reset is explicit", async () => {
    const root = await repository("api");
    const firstFetch = successfulFetch();
    const first = await runProjectInit(
      initOptions(root),
      dependencies(firstFetch),
    );
    const originalConfig = await readFile(first.configPath, "utf8");
    const firstLocal = parseEnv(
      await readFile(first.localEnvironmentPath, "utf8"),
    );
    const firstCloud = parseEnv(
      await readFile(first.cloudEnvironmentPath, "utf8"),
    );
    const firstKeyring = JSON.parse(firstLocal.PAGENT_CONTEXT_KEYS!) as Record<
      string,
      string
    >;
    const firstKeyId = firstCloud.PAGENT_ENCRYPTION_KEY_ID!;
    const secondFetch = successfulFetch();

    await expect(
      runProjectInit(initOptions(root), dependencies(secondFetch)),
    ).rejects.toThrow("Pagent is already initialized");
    expect(secondFetch).not.toHaveBeenCalled();
    expect(await readFile(first.configPath, "utf8")).toBe(originalConfig);

    const reset = await runProjectInit(
      {
        ...initOptions(root),
        reset: true,
        connectorId: first.connectorId,
        environments: ["production"],
      },
      dependencies(successfulFetch("rotated"), 90),
    );
    expect(reset.environments).toEqual(["production"]);
    expect(await readFile(reset.configPath, "utf8")).toContain(
      'environments: ["production"]',
    );
    const resetLocal = parseEnv(
      await readFile(reset.localEnvironmentPath, "utf8"),
    );
    const resetCloud = parseEnv(
      await readFile(reset.cloudEnvironmentPath, "utf8"),
    );
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
  });

  it("refuses to rotate before enrollment when the existing keyring is invalid", async () => {
    const root = await repository("api");
    const first = await runProjectInit(
      initOptions(root),
      dependencies(successfulFetch()),
    );
    await writeFile(first.localEnvironmentPath, "PAGENT_CONTEXT_KEYS='{}'\n");
    const fetchEnrollment = successfulFetch("rotated");

    await expect(
      runProjectInit(
        {
          ...initOptions(root),
          reset: true,
          connectorId: first.connectorId,
        },
        dependencies(fetchEnrollment, 90),
      ),
    ).rejects.toThrow("Restore that file or revoke the connector");
    expect(fetchEnrollment).not.toHaveBeenCalled();
  });

  it("requires HTTPS except for exact loopback hosts", async () => {
    const root = await repository("api");
    const fetchEnrollment = successfulFetch();

    await expect(
      runProjectInit(
        { ...initOptions(root), relayUrl: "http://relay.example.test" },
        dependencies(fetchEnrollment),
      ),
    ).rejects.toThrow("Relay URL must use HTTPS");
    await expect(
      runProjectInit(
        { ...initOptions(root), relayUrl: "http://localhost.example.test" },
        dependencies(fetchEnrollment),
      ),
    ).rejects.toThrow("Relay URL must use HTTPS");
    await expect(
      runProjectInit(
        { ...initOptions(root), relayUrl: "https://relay.example.test/base" },
        dependencies(fetchEnrollment),
      ),
    ).rejects.toThrow("Relay URL must be an origin without a path");
    expect(fetchEnrollment).not.toHaveBeenCalled();
  });

  it("leaves the repository unchanged when enrollment fails", async () => {
    const root = await repository("api");
    await writeFile(join(root, ".gitignore"), "dist/\n");
    const fetchEnrollment = vi.fn<EnrollmentFetch>().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: "unauthorized" }),
    });

    await expect(
      runProjectInit(initOptions(root), dependencies(fetchEnrollment)),
    ).rejects.toThrow("Relay enrollment failed with HTTP 401");

    await expect(access(join(root, "pagent.config.ts"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(join(root, ".pagent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      access(join(root, ".git", "pagent", "pending-init.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(root, ".gitignore"), "utf8")).toBe("dist/\n");
  });

  it("does not expose secrets in HTTP or network errors", async () => {
    const root = await repository("api");
    const httpError = runProjectInit(
      initOptions(root),
      dependencies(
        vi.fn<EnrollmentFetch>().mockResolvedValue({
          ok: false,
          status: 500,
          json: async () => ({ error: "server error" }),
        }),
      ),
    );
    await expect(httpError).rejects.toThrow("Relay enrollment failed with HTTP 500");
    await expect(httpError).rejects.not.toThrow(ENROLLMENT_CODE);

    const networkError = runProjectInit(
      initOptions(root),
      dependencies(
        vi
          .fn<EnrollmentFetch>()
          .mockRejectedValue(new Error(`upstream echoed ${ENROLLMENT_CODE}`)),
      ),
    );
    await expect(networkError).rejects.toThrow("Pagent could not reach the relay");
    await expect(networkError).rejects.not.toThrow(ENROLLMENT_CODE);
  });

  it("reuses pending credentials after an ambiguous network failure", async () => {
    const root = await repository("api");
    const fetchEnrollment = vi
      .fn<EnrollmentFetch>()
      .mockRejectedValueOnce(new Error("connection closed after request"))
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ status: "existing" }),
      });

    await expect(
      runProjectInit(initOptions(root), dependencies(fetchEnrollment, 1)),
    ).rejects.toThrow("could not reach the relay");
    await expect(
      access(join(root, ".git", "pagent", "pending-init.json")),
    ).resolves.toBeUndefined();

    await runProjectInit(initOptions(root), dependencies(fetchEnrollment, 90));

    expect(fetchEnrollment).toHaveBeenCalledTimes(2);
    expect(fetchEnrollment.mock.calls[1]?.[1].body).toBe(
      fetchEnrollment.mock.calls[0]?.[1].body,
    );
    await expect(
      access(join(root, ".git", "pagent", "pending-init.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an HTML or malformed success response", async () => {
    const root = await repository("api");
    const malformed = vi.fn<EnrollmentFetch>().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError(`unexpected ${ENROLLMENT_CODE}`);
      },
    });

    const initialization = runProjectInit(
      initOptions(root),
      dependencies(malformed),
    );
    await expect(initialization).rejects.toThrow(
      "Relay enrollment returned an invalid response with HTTP 200",
    );
    await expect(initialization).rejects.not.toThrow(ENROLLMENT_CODE);
    await expect(access(join(root, ".pagent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("stops before enrollment when Codex is unavailable", async () => {
    const root = await repository("api");
    const fetchEnrollment = successfulFetch();

    await expect(
      runProjectInit(initOptions(root), {
        ...dependencies(fetchEnrollment),
        probeCodex: async () => {
          throw new Error(`not signed in ${ENROLLMENT_CODE}`);
        },
      }),
    ).rejects.toThrow(
      "Codex must be installed and signed in before Pagent can initialize. Run `codex login`",
    );
    expect(fetchEnrollment).not.toHaveBeenCalled();
  });
});

function initOptions(root: string): {
  cwd: string;
  relayUrl: string;
  enrollmentCode: string;
} {
  return {
    cwd: root,
    relayUrl: "https://relay.example.test",
    enrollmentCode: ENROLLMENT_CODE,
  };
}

function successfulFetch(status: "enrolled" | "rotated" = "enrolled") {
  return vi.fn<EnrollmentFetch>().mockResolvedValue({
    ok: true,
    status: 201,
    json: async () => ({ status }),
  });
}

function dependencies(
  fetchEnrollment: EnrollmentFetch,
  byte = 1,
): ProjectInitDependencies {
  return {
    fetch: fetchEnrollment,
    hostname: () => "Dev Laptop",
    probeCodex: async () => undefined,
    randomBytes: (size) => Buffer.alloc(size, byte),
  };
}

async function repository(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), "pagent-init-test-"));
  temporaryDirectories.push(parent);
  const root = join(parent, name);
  await mkdir(root);
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  return root;
}

function hash(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}
