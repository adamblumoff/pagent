import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  installStartupService,
  removeStartupService,
  startupDefinition,
  type StartupServiceOptions,
} from "../src/startup-service.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("startup service", () => {
  it("installs and removes a restart-on-failure systemd user service", async () => {
    const options = await fixture("linux");
    const run = vi.fn(async () => undefined);

    const registration = await installStartupService(options, { run });

    expect(registration).toMatchObject({
      manager: "systemd",
      name: expect.stringMatching(/^pagent-[a-f0-9]{16}\.service$/u),
    });
    const unit = await readFile(registration!.path, "utf8");
    expect(unit).toContain("WantedBy=default.target");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("ExecStart=");
    expect(unit).toContain('"start" "--foreground" "--skip-doctor"');
    expect(unit).toContain("StandardOutput=");
    expect(unit).not.toContain("PAGENT_SOURCE_TOKEN");
    expect(run.mock.calls).toEqual([
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", registration!.name]],
      ["systemctl", ["--user", "start", registration!.name]],
    ]);
    if (process.platform !== "win32") {
      expect((await stat(registration!.path)).mode & 0o777).toBe(0o600);
    }

    run.mockClear();
    await removeStartupService(options, { run });
    await expect(access(registration!.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(run.mock.calls).toEqual([
      ["systemctl", ["--user", "disable", "--now", registration!.name]],
      ["systemctl", ["--user", "reset-failed", registration!.name]],
      ["systemctl", ["--user", "daemon-reload"]],
    ]);
  });

  it("writes a launch agent that restarts failures but respects pagent stop", async () => {
    const options = await fixture("darwin", "Project & Tools");
    options.userId = 501;
    const definition = startupDefinition(options);

    expect(definition).toMatchObject({
      manager: "launchd",
      name: expect.stringMatching(/^dev\.pagent\.[a-f0-9]{16}$/u),
    });
    expect(definition!.contents).toContain("<key>RunAtLoad</key>");
    expect(definition!.contents).toContain("<key>SuccessfulExit</key>\n      <false/>");
    expect(definition!.contents).toContain("Project &amp; Tools");
    expect(definition!.installCommands).toEqual([
      {
        command: "launchctl",
        args: ["bootout", `gui/501/${definition!.name}`],
        ignoreFailure: true,
      },
      {
        command: "launchctl",
        args: ["bootstrap", "gui/501", definition!.path],
      },
    ]);
    expect(definition!.removeCommands).toEqual([{
      command: "launchctl",
      args: ["bootout", `gui/501/${definition!.name}`],
      ignoreFailure: true,
    }]);
  });

  it("writes a Windows logon task that retries crashes but exits after a clean stop", async () => {
    const options = await fixture("win32", "Project % Tools");
    const run = vi.fn(async () => undefined);

    const registration = await installStartupService(options, { run });

    expect(registration).toMatchObject({
      manager: "task-scheduler",
      name: expect.stringMatching(/^Pagent-[a-f0-9]{16}$/u),
    });
    const script = await readFile(registration!.path, "utf8");
    expect(script).toContain(":run\r\n");
    expect(script).toContain("start --foreground --skip-doctor");
    expect(script).toContain("if errorlevel 1 (");
    expect(script).toContain("goto run");
    expect(script).toContain("Project %% Tools");
    expect(run).toHaveBeenCalledWith("schtasks.exe", expect.arrayContaining([
      "/SC",
      "ONLOGON",
      "/IT",
    ]));
    expect(run).toHaveBeenCalledWith("schtasks.exe", [
      "/Run",
      "/TN",
      registration!.name,
    ]);

    run.mockClear();
    await removeStartupService(options, { run });
    expect(run.mock.calls).toEqual([
      ["schtasks.exe", ["/End", "/TN", registration!.name]],
      ["schtasks.exe", ["/Delete", "/TN", registration!.name, "/F"]],
    ]);
  });

  it("keeps a systemd registration when its immediate start is still failing", async () => {
    const options = await fixture("linux");
    const run = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args.includes("start")) throw new Error("service is retrying");
    });

    const registration = await installStartupService(options, { run });

    expect(registration?.manager).toBe("systemd");
    await expect(access(registration!.path)).resolves.toBeUndefined();
  });

  it("can register startup without replacing an already-running daemon", async () => {
    const options = await fixture("linux");
    options.startImmediately = false;
    const run = vi.fn(async (_command: string, _args: readonly string[]) => undefined);

    await installStartupService(options, { run });

    expect(run.mock.calls.flatMap(([, args]) => args)).not.toContain("start");
  });

  it("rejects a quoted Windows PATH before writing a task", async () => {
    const options = await fixture("win32");
    options.environment = { PATH: 'C:\\Tools;"C:\\Other Tools"' };

    await expect(installStartupService(options)).rejects.toThrow(
      "startup PATH cannot contain a double quote",
    );
  });

  it("uses one stable service name per repository", async () => {
    const first = await fixture("linux");
    const same = { ...first };
    const other = { ...first, projectDirectory: `${first.projectDirectory}-other` };

    expect(startupDefinition(first)?.name).toBe(startupDefinition(same)?.name);
    expect(startupDefinition(first)?.name).not.toBe(startupDefinition(other)?.name);
  });

  it("returns no registration on unsupported platforms", async () => {
    const options = await fixture("linux");
    options.platform = "freebsd";

    await expect(installStartupService(options)).resolves.toBeUndefined();
  });
});

async function fixture(
  platform: NodeJS.Platform,
  projectName = "Example Project",
): Promise<StartupServiceOptions> {
  const root = await mkdtemp(join(tmpdir(), "pagent-startup-test-"));
  temporaryDirectories.push(root);
  return {
    platform,
    projectDirectory: join(root, projectName),
    stateDirectory: join(root, "state"),
    logPath: join(root, "state", "connector.log"),
    executablePath: join(root, "bin", "node"),
    cliPath: join(root, "pagent", "dist", "cli.js"),
    homeDirectory: join(root, "home"),
    environment: { PATH: join(root, "bin") },
  };
}
