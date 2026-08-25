import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensureLocalStateDirectory,
  localStatePaths,
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

  it("creates a restricted local state directory", async () => {
    const directory = await temporaryDirectory();
    const paths = localStatePaths({ stateDirectory: join(directory, "state") });
    await ensureLocalStateDirectory(paths);

    expect((await stat(paths.directory)).isDirectory()).toBe(true);
    if (process.platform !== "win32") {
      expect((await stat(paths.directory)).mode & 0o777).toBe(0o700);
    }
  });
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pagent-state-test-"));
  temporaryDirectories.push(path);
  return path;
}
