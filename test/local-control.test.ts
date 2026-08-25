import { writeFile, mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestLocalControl,
  startLocalControlServer,
  type LocalDaemonStatus,
} from "../src/local-control.js";
import { ensureLocalStateDirectory, localStatePaths } from "../src/local-state.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("local daemon control", () => {
  it("serves live status and requests graceful shutdown", async () => {
    const paths = await temporaryState();
    const stop = vi.fn();
    const status = daemonStatus(paths.controlEndpoint);
    const server = await startLocalControlServer({
      endpoint: paths.controlEndpoint,
      getStatus: () => status,
      onStop: stop,
    });

    try {
      if (process.platform !== "win32") {
        expect((await stat(paths.controlEndpoint)).mode & 0o777).toBe(0o600);
      }
      await expect(
        requestLocalControl(paths.controlEndpoint, { method: "status" }),
      ).resolves.toEqual(status);
      await expect(
        requestLocalControl(paths.controlEndpoint, { method: "stop" }),
      ).resolves.toEqual({ stopping: true });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });

  it("treats a live listener as authoritative over diagnostic state", async () => {
    const paths = await temporaryState();
    const first = await startLocalControlServer({
      endpoint: paths.controlEndpoint,
      getStatus: () => daemonStatus(paths.controlEndpoint),
      onStop: () => undefined,
    });

    try {
      await expect(
        startLocalControlServer({
          endpoint: paths.controlEndpoint,
          getStatus: () => daemonStatus(paths.controlEndpoint),
          onStop: () => undefined,
        }),
      ).rejects.toThrow("already listening");
      await expect(
        requestLocalControl(paths.controlEndpoint, { method: "status" }),
      ).resolves.toMatchObject({ pid: process.pid });
    } finally {
      await first.close();
    }
  });

  it.runIf(process.platform !== "win32")(
    "removes a stale endpoint only after a refused connection",
    async () => {
      const paths = await temporaryState();
      await writeFile(paths.controlEndpoint, "stale");

      const server = await startLocalControlServer({
        endpoint: paths.controlEndpoint,
        getStatus: () => daemonStatus(paths.controlEndpoint),
        onStop: () => undefined,
      });

      try {
        await expect(
          requestLocalControl(paths.controlEndpoint, { method: "status" }),
        ).resolves.toMatchObject({ phase: "ready" });
      } finally {
        await server.close();
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not unlink an endpoint occupied by another live process",
    async () => {
      const paths = await temporaryState();
      const occupant = createServer((socket) => socket.end());
      await new Promise<void>((resolve, reject) => {
        occupant.once("error", reject);
        occupant.listen(paths.controlEndpoint, resolve);
      });

      try {
        await expect(
          startLocalControlServer({
            endpoint: paths.controlEndpoint,
            getStatus: () => daemonStatus(paths.controlEndpoint),
            onStop: () => undefined,
          }),
        ).rejects.toThrow("already listening");
      } finally {
        await new Promise<void>((resolve, reject) =>
          occupant.close((error) => (error === undefined ? resolve() : reject(error))),
        );
      }
    },
  );
});

function daemonStatus(controlEndpoint: string): LocalDaemonStatus {
  return {
    version: 1,
    pid: process.pid,
    startedAt: "2026-08-25T12:00:00.000Z",
    controlEndpoint,
    phase: "ready",
    relayConnected: true,
    pendingTasks: 0,
    lastHandoff: {
      eventType: "health.failed",
      threadId: "thread-1",
      completedAt: "2026-08-25T12:01:00.000Z",
    },
  };
}

async function temporaryState() {
  const directory = await mkdtemp(join(tmpdir(), "pagent-control-test-"));
  temporaryDirectories.push(directory);
  const paths = localStatePaths({ stateDirectory: join(directory, "state") });
  await ensureLocalStateDirectory(paths);
  return paths;
}
