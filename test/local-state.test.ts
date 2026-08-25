import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureLocalStateDirectory,
  localStatePaths,
  readDaemonMetadata,
  removeDaemonMetadata,
  writeDaemonMetadata,
} from "../src/local-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("local state", () => {
  it("selects the platform state directory and honors explicit overrides", () => {
    expect(
      localStatePaths({
        platform: "linux",
        homeDirectory: "/home/ada",
        environment: {},
      }),
    ).toMatchObject({
      directory: "/home/ada/.local/state/pagent",
      daemonMetadataPath: "/home/ada/.local/state/pagent/daemon.json",
      inboxPath: "/home/ada/.local/state/pagent/inbox.json",
      logPath: "/home/ada/.local/state/pagent/connector.log",
      controlEndpoint: "/home/ada/.local/state/pagent/control.sock",
    });
    expect(
      localStatePaths({
        platform: "linux",
        homeDirectory: "/home/ada",
        environment: { XDG_STATE_HOME: "/state" },
      }).directory,
    ).toBe("/state/pagent");
    expect(
      localStatePaths({
        platform: "darwin",
        homeDirectory: "/Users/ada",
        environment: {},
      }).directory,
    ).toBe("/Users/ada/Library/Application Support/Pagent");
    const windowsPaths = localStatePaths({
      platform: "win32",
      homeDirectory: "C:\\Users\\ada",
      environment: { LOCALAPPDATA: "C:\\Local" },
    });
    expect(windowsPaths.controlEndpoint).toMatch(
      /^\\\\\.\\pipe\\pagent-[a-f0-9]{16}$/,
    );
    expect(
      localStatePaths({
        stateDirectory: "/explicit",
        environment: { PAGENT_STATE_DIR: "/environment" },
      }).directory,
    ).toBe("/explicit");
  });

  it("writes restricted diagnostic metadata without unknown fields", async () => {
    const directory = await temporaryDirectory();
    const paths = localStatePaths({ stateDirectory: join(directory, "state") });
    const metadata = {
      version: 1 as const,
      pid: 42,
      startedAt: "2026-08-25T12:00:00.000Z",
      controlEndpoint: paths.controlEndpoint,
      token: "must-not-be-persisted",
    };

    await writeDaemonMetadata(paths, metadata);

    expect(await readDaemonMetadata(paths)).toEqual({
      version: 1,
      pid: 42,
      startedAt: "2026-08-25T12:00:00.000Z",
      controlEndpoint: paths.controlEndpoint,
    });
    expect(await readFile(paths.daemonMetadataPath, "utf8")).not.toContain(
      "must-not-be-persisted",
    );
    if (process.platform !== "win32") {
      expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(paths.daemonMetadataPath)).mode & 0o777).toBe(0o600);
    }
  });

  it("only removes metadata still owned by the expected PID", async () => {
    const directory = await temporaryDirectory();
    const paths = localStatePaths({ stateDirectory: join(directory, "state") });
    await ensureLocalStateDirectory(paths);
    await writeDaemonMetadata(paths, {
      version: 1,
      pid: 84,
      startedAt: "2026-08-25T12:00:00.000Z",
      controlEndpoint: paths.controlEndpoint,
    });

    expect(await removeDaemonMetadata(paths, 42)).toBe(false);
    expect(await readDaemonMetadata(paths)).toBeDefined();
    expect(await removeDaemonMetadata(paths, 84)).toBe(true);
    expect(await readDaemonMetadata(paths)).toBeUndefined();
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pagent-state-test-"));
  temporaryDirectories.push(path);
  return path;
}
