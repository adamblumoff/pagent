import { constants } from "node:fs";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  resolveCloudflaredBinary,
  startCloudflaredTunnel,
  type SpawnTunnelProcess,
  type TunnelChildProcess,
  type TunnelSpawnOptions,
} from "../src/tunnel-process.js";

describe("cloudflared tunnel process", () => {
  it("resolves explicit paths and PATH executables", async () => {
    const access = vi.fn(async (path: string) => {
      if (path !== "/tools/cloudflared") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
    });

    await expect(
      resolveCloudflaredBinary({
        binaryPath: "./bin/cloudflared",
        dependencies: {
          cwd: "/project",
          access: async () => undefined,
        },
      }),
    ).resolves.toBe("/project/bin/cloudflared");
    await expect(
      resolveCloudflaredBinary({
        dependencies: {
          env: { PATH: "/missing:/tools" },
          platform: "linux",
          access,
        },
      }),
    ).resolves.toBe("/tools/cloudflared");
    expect(access).toHaveBeenLastCalledWith("/tools/cloudflared", constants.X_OK);
  });

  it("uses a token file, becomes ready from process output, and stops cleanly", async () => {
    const child = new FakeChildProcess();
    child.onKill = (signal) => {
      if (signal === "SIGTERM") {
        child.close(null, "SIGTERM");
      }
    };
    const calls: SpawnCall[] = [];
    const logs: string[] = [];
    const spawn: SpawnTunnelProcess = (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    };
    const dates = [
      new Date("2026-08-27T10:00:00.000Z"),
      new Date("2026-08-27T10:00:01.000Z"),
    ];

    const tunnel = await startCloudflaredTunnel({
      tokenFile: ".pagent/tunnel-token",
      binaryPath: "/opt/cloudflared",
      log: (message) => logs.push(message),
      dependencies: {
        cwd: "/project",
        env: {
          PATH: "/opt",
          TUNNEL_TOKEN: "token-contents-must-not-leak",
        },
        access: async () => undefined,
        spawn,
        now: () => dates.shift() ?? new Date("2026-08-27T10:00:02.000Z"),
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      command: "/opt/cloudflared",
      args: ["tunnel", "--no-autoupdate", "run"],
      options: {
        env: {
          PATH: "/opt",
          TUNNEL_TOKEN_FILE: "/project/.pagent/tunnel-token",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    expect(JSON.stringify(calls)).not.toContain("token-contents-must-not-leak");
    expect(tunnel.health()).toEqual({
      state: "starting",
      running: true,
      ready: false,
      pid: 1234,
      startedAt: "2026-08-27T10:00:00.000Z",
      readyAt: undefined,
      exitCode: undefined,
      signal: undefined,
      error: undefined,
    });

    child.stderr.write("INF Registered tunnel con");
    child.stderr.write("nection connIndex=0\n");
    await tunnel.ready;
    expect(tunnel.health()).toMatchObject({
      state: "ready",
      running: true,
      ready: true,
      readyAt: "2026-08-27T10:00:01.000Z",
    });

    await tunnel.stop();
    expect(child.signals).toEqual(["SIGTERM"]);
    expect(tunnel.health()).toMatchObject({
      state: "stopped",
      running: false,
      ready: false,
      signal: "SIGTERM",
    });
    expect(logs).toEqual([
      "[pagent] Cloudflare Tunnel connected",
      "[pagent] Cloudflare Tunnel stopped",
    ]);
    expect(logs.join(" ")).not.toContain("token-contents-must-not-leak");
  });

  it("rejects readiness when cloudflared exits before connecting", async () => {
    const child = new FakeChildProcess();
    const tunnel = await testTunnel(child);

    child.close(1, null);

    await expect(tunnel.ready).rejects.toThrow(
      "cloudflared exited before the tunnel was ready",
    );
    expect(tunnel.health()).toMatchObject({
      state: "failed",
      running: false,
      ready: false,
      exitCode: 1,
    });
  });

  it("escalates to SIGKILL when graceful shutdown times out", async () => {
    const child = new FakeChildProcess();
    child.onKill = (signal) => {
      if (signal === "SIGKILL") {
        child.close(null, "SIGKILL");
      }
    };
    const tunnel = await testTunnel(child, 5);
    child.stdout.write("Registered tunnel connection\n");
    await tunnel.ready;

    await tunnel.stop();

    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(tunnel.health()).toMatchObject({
      state: "stopped",
      running: false,
      signal: "SIGKILL",
    });
  });

  it("reports spawn failures without exposing the underlying message", async () => {
    const child = new FakeChildProcess();
    const logs: string[] = [];
    const tunnel = await testTunnel(child, undefined, logs);

    child.emit("error", new Error("token-contents-must-not-leak"));

    await expect(tunnel.ready).rejects.toThrow("could not be started");
    expect(tunnel.health()).toMatchObject({
      state: "failed",
      running: false,
      error: "cloudflared could not be started.",
    });
    expect(logs.join(" ")).not.toContain("token-contents-must-not-leak");
  });
});

interface SpawnCall {
  command: string;
  args: readonly string[];
  options: TunnelSpawnOptions;
}

class FakeChildProcess extends EventEmitter implements TunnelChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 1234;
  exitCode: number | null = null;
  readonly signals: Array<NodeJS.Signals | number> = [];
  onKill?: ((signal: NodeJS.Signals | number) => void) | undefined;

  kill(signal: NodeJS.Signals | number = "SIGTERM"): boolean {
    this.signals.push(signal);
    this.onKill?.(signal);
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.emit("close", code, signal);
  }
}

async function testTunnel(
  child: FakeChildProcess,
  stopTimeoutMs?: number,
  logs: string[] = [],
) {
  return startCloudflaredTunnel({
    tokenFile: "/state/tunnel-token",
    binaryPath: "/opt/cloudflared",
    stopTimeoutMs,
    log: (message) => logs.push(message),
    dependencies: {
      access: async () => undefined,
      spawn: () => child,
    },
  });
}
