import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runDoctor,
  type DoctorOptions,
  type DoctorReport,
} from "../src/doctor.js";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("runDoctor", () => {
  it("checks a healthy direct-tunnel environment without exposing secrets", async () => {
    const fixture = await localFixture();
    const resolveCloudflared = vi.fn(async () => "/tools/cloudflared");
    const cloudflaredVersion = vi.fn(
      async () => "cloudflared version 2026.8.0",
    );
    const probeCodex = vi.fn(async () => undefined);
    const checkPort = vi.fn(async () => undefined);

    const report = await runDoctor(
      options(fixture, {
        dependencies: {
          resolveCloudflared,
          cloudflaredVersion,
          probeCodex,
          checkPort,
        },
      }),
    );

    expect(report).toMatchObject({ ok: true, warnings: 0 });
    expect(report.checks.map(({ id }) => id)).toEqual([
      "repositories",
      "environments",
      "encryption",
      "tunnel.token",
      "cloudflared",
      "codex",
      "ingress.port",
      "tunnel.hostname",
    ]);
    expect(report.checks.every(({ status }) => status === "pass")).toBe(true);
    expect(check(report, "repositories").detail).toContain(fixture.repository);
    expect(check(report, "tunnel.token").detail).toBe(fixture.tokenFile);
    expect(check(report, "cloudflared").detail).toBe(
      "cloudflared version 2026.8.0",
    );
    expect(resolveCloudflared).toHaveBeenCalledWith({
      binaryPath: "/tools/cloudflared",
    });
    expect(cloudflaredVersion).toHaveBeenCalledWith("/tools/cloudflared");
    expect(probeCodex).toHaveBeenCalledOnce();
    expect(checkPort).toHaveBeenCalledWith("127.0.0.1", 43127);

    const output = JSON.stringify(report);
    expect(output).not.toContain("ingress-secret");
    expect(output).not.toContain("tunnel-token-contents");
    expect(output).not.toContain(KEY);
  });

  it.runIf(process.platform !== "win32")(
    "warns when the tunnel token is readable by other users",
    async () => {
      const fixture = await localFixture();
      await chmod(fixture.tokenFile, 0o644);

      const report = await runDoctor(options(fixture));

      expect(report).toMatchObject({ ok: true, warnings: 1 });
      expect(check(report, "tunnel.token")).toMatchObject({
        status: "warn",
        detail: `${fixture.tokenFile} is readable outside its owner.`,
        remediation: `Run \`chmod 600 ${fixture.tokenFile}\`.`,
      });
    },
  );

  it("requires exactly one readable repository", async () => {
    const fixture = await localFixture();
    const report = await runDoctor(
      options(fixture, {
        repositories: {
          app: fixture.repository,
          duplicate: fixture.repository,
        },
      }),
    );

    expect(report.ok).toBe(false);
    expect(check(report, "repositories")).toMatchObject({
      status: "fail",
      detail: "Direct tunnel delivery requires exactly one repository.",
      remediation: "Keep only this initialized repository in pagent.config.ts.",
    });
  });

  it("fails when the tunnel token is missing", async () => {
    const fixture = await localFixture();
    const missingToken = join(fixture.root, "missing-token");
    const report = await runDoctor(
      options(fixture, {
        tunnel: { ...baseTunnel(fixture), tokenFile: missingToken },
      }),
    );

    expect(report.ok).toBe(false);
    expect(check(report, "tunnel.token")).toMatchObject({
      status: "fail",
      detail: `${missingToken} is missing or unreadable.`,
      remediation: expect.stringContaining("pagent init --reset"),
    });
  });

  it("reports cloudflared failures without copying sensitive errors", async () => {
    const fixture = await localFixture();
    const report = await runDoctor(
      options(fixture, {
        dependencies: {
          ...passingDependencies(),
          resolveCloudflared: vi.fn(async () => {
            throw new Error("spawn failed token=tunnel-token-contents");
          }),
        },
      }),
    );

    expect(check(report, "cloudflared")).toMatchObject({
      status: "fail",
      detail: "cloudflared is unavailable or could not report its version.",
      remediation: expect.stringContaining("tunnel.cloudflaredPath"),
    });
    expect(JSON.stringify(report)).not.toContain("tunnel-token-contents");
  });

  it("reports unavailable Codex without copying the probe error", async () => {
    const fixture = await localFixture();
    const report = await runDoctor(
      options(fixture, {
        dependencies: {
          ...passingDependencies(),
          probeCodex: vi.fn(async () => {
            throw new Error("codex failed ingress-secret");
          }),
        },
      }),
    );

    expect(check(report, "codex")).toMatchObject({
      status: "fail",
      detail: "Codex is unavailable or signed out.",
      remediation: expect.stringContaining("codex login"),
    });
    expect(JSON.stringify(report)).not.toContain("ingress-secret");
  });

  it("fails when the local ingress port is occupied", async () => {
    const fixture = await localFixture();
    const report = await runDoctor(
      options(fixture, {
        ingress: { host: "::1", port: 44004, token: "ingress-secret" },
        dependencies: {
          ...passingDependencies(),
          checkPort: vi.fn(async () => {
            throw new Error("EADDRINUSE");
          }),
        },
      }),
    );

    expect(check(report, "ingress.port")).toMatchObject({
      status: "fail",
      detail: "::1:44004 is already in use.",
      remediation: expect.stringContaining("pagent init --reset"),
    });
  });

  it("reports invalid environment, encryption, and hostname settings", async () => {
    const fixture = await localFixture();
    const report = await runDoctor(
      options(fixture, {
        environments: [],
        encryption: { keys: {} },
        tunnel: {
          ...baseTunnel(fixture),
          hostname: "https://invalid.example.test",
        },
      }),
    );

    expect(report.ok).toBe(false);
    expect(check(report, "environments")).toMatchObject({ status: "fail" });
    expect(check(report, "encryption")).toMatchObject({ status: "fail" });
    expect(check(report, "tunnel.hostname")).toMatchObject({
      status: "fail",
      detail: "The configured hostname is invalid.",
    });
  });
});

interface LocalFixture {
  root: string;
  repository: string;
  tokenFile: string;
}

async function localFixture(): Promise<LocalFixture> {
  const root = await mkdtemp(join(tmpdir(), "pagent-doctor-test-"));
  temporaryDirectories.push(root);
  const repository = join(root, "repository");
  const tokenFile = join(root, "tunnel-token");
  await mkdir(repository);
  await writeFile(tokenFile, "tunnel-token-contents", { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  return { root, repository, tokenFile };
}

function options(
  fixture: LocalFixture,
  overrides: Partial<DoctorOptions> = {},
): DoctorOptions {
  return {
    ingress: { host: "127.0.0.1", port: 43127, token: "ingress-secret" },
    tunnel: baseTunnel(fixture),
    repositories: { app: fixture.repository },
    environments: ["staging"],
    encryption: { keys: { current: KEY } },
    dependencies: passingDependencies(),
    ...overrides,
  };
}

function baseTunnel(fixture: LocalFixture): DoctorOptions["tunnel"] {
  return {
    environmentId: "environment-1",
    tunnelId: "tunnel-1",
    hostname: "environment-1.pagent.example.test",
    provisionerUrl: "https://provisioner.example.test",
    tokenFile: fixture.tokenFile,
    cloudflaredPath: "/tools/cloudflared",
  };
}

function passingDependencies(): NonNullable<DoctorOptions["dependencies"]> {
  return {
    resolveCloudflared: vi.fn(async () => "/tools/cloudflared"),
    cloudflaredVersion: vi.fn(async () => "cloudflared version 2026.8.0"),
    probeCodex: vi.fn(async () => undefined),
    checkPort: vi.fn(async () => undefined),
  };
}

function check(report: DoctorReport, id: string) {
  const result = report.checks.find((item) => item.id === id);
  expect(result, `Missing doctor check ${id}`).toBeDefined();
  return result!;
}
