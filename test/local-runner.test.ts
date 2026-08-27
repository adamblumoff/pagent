import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ConnectorConfig } from "../src/config.js";
import { decryptEventContext } from "../src/crypto.js";
import {
  requestLocalControl,
  type LocalDaemonStatus,
} from "../src/local-control.js";
import type {
  LocalIngressOptions,
  LocalIngressServer,
} from "../src/local-ingress.js";
import {
  runLocalConnector,
  type LocalRunnerDependencies,
} from "../src/local-runner.js";
import { localStatePaths } from "../src/local-state.js";
import type {
  CloudflaredTunnelProcess,
  TunnelProcessHealth,
} from "../src/tunnel-process.js";
import type {
  EncryptedPagentEvent,
  EventEnvelope,
} from "../src/types.js";

const KEY = Buffer.alloc(32, 1).toString("base64url");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("local connector runner", () => {
  it("becomes ready after ingress, cloudflared, and the encrypted probe, then stops cleanly", async () => {
    const directory = await temporaryDirectory();
    const paths = localStatePaths({ stateDirectory: join(directory, "state") });
    const config = connectorConfig();
    const tunnelReady = deferred<void>();
    const probeReady = deferred<void>();
    const callOrder: string[] = [];
    const logs: string[] = [];
    let ingressOptions: LocalIngressOptions | undefined;
    let probeSignal: AbortSignal | undefined;
    let tunnelState: TunnelProcessHealth["state"] = "starting";

    const closeIngress = vi.fn(async () => undefined);
    const stopTunnel = vi.fn(async () => {
      tunnelState = "stopped";
    });
    const ingress: LocalIngressServer = {
      host: "127.0.0.1",
      port: 43123,
      eventsUrl: "http://127.0.0.1:43123/v1/events",
      probeUrl: "http://127.0.0.1:43123/v1/probe",
      close: closeIngress,
    };
    const tunnel: CloudflaredTunnelProcess = {
      ready: tunnelReady.promise,
      health: () => tunnelHealth(tunnelState),
      stop: stopTunnel,
    };
    const startIngress: NonNullable<
      LocalRunnerDependencies["startIngress"]
    > = vi.fn(async (options) => {
      callOrder.push("ingress");
      ingressOptions = options;
      return ingress;
    });
    const startTunnel: NonNullable<
      LocalRunnerDependencies["startTunnel"]
    > = vi.fn(async () => {
      callOrder.push("tunnel");
      return tunnel;
    });
    const probe: NonNullable<LocalRunnerDependencies["probe"]> = vi.fn(
      async (receivedConfig, signal) => {
        callOrder.push("probe");
        expect(receivedConfig).toBe(config);
        probeSignal = signal;
        await probeReady.promise;
      },
    );
    let readyStatus: LocalDaemonStatus | undefined;

    const runner = runLocalConnector({
      config,
      paths,
      startupTimeoutMs: 1_000,
      dependencies: { startIngress, startTunnel, probe },
      log: (message) => logs.push(message),
      onReady: (status) => {
        readyStatus = status;
      },
    });

    await waitFor(() => ingressOptions !== undefined);
    expect(readyStatus).toBeUndefined();
    expect(ingressOptions).toMatchObject({
      host: "127.0.0.1",
      port: 43123,
      environmentId: "env-test",
      source: {
        token: "source-token",
        allowedEnvironments: ["staging"],
      },
      repositories: { pagent: process.cwd() },
      encryption: config.encryption,
    });
    await waitFor(() => vi.mocked(startTunnel).mock.calls.length === 1);
    expect(callOrder).toEqual(["ingress", "tunnel"]);
    expect(readyStatus).toBeUndefined();

    tunnelState = "ready";
    tunnelReady.resolve();
    await waitFor(() => vi.mocked(probe).mock.calls.length === 1);
    expect(callOrder).toEqual(["ingress", "tunnel", "probe"]);
    expect(readyStatus).toBeUndefined();
    expect(probeSignal?.aborted).toBe(false);

    probeReady.resolve();
    await waitFor(() => readyStatus !== undefined);
    expect(readyStatus).toMatchObject({
      phase: "ready",
      ingressReady: true,
      ingressPort: 43123,
      tunnelConnected: true,
      tunnelHostname: "env-test.pagent.example.com",
      cloudflaredPid: 2468,
    });

    await recordCompletedHandoff(ingressOptions!);
    await expect(
      requestLocalControl(paths.controlEndpoint, { method: "status" }),
    ).resolves.toMatchObject({
      phase: "ready",
      ingressReady: true,
      ingressPort: 43123,
      tunnelConnected: true,
      tunnelHostname: "env-test.pagent.example.com",
      cloudflaredPid: 2468,
      lastHandoff: {
        eventType: "health.failed",
        threadId: "thread-1",
        completedAt: "2026-08-27T12:00:02.000Z",
      },
    });

    await expect(
      requestLocalControl(paths.controlEndpoint, { method: "stop" }),
    ).resolves.toEqual({ stopping: true });
    await runner;

    expect(probeSignal?.aborted).toBe(true);
    expect(stopTunnel).toHaveBeenCalledOnce();
    expect(closeIngress).toHaveBeenCalledOnce();
    expect(logs).toContain("[pagent] encrypted tunnel probe passed");
    await expect(
      requestLocalControl(paths.controlEndpoint, { method: "status" }),
    ).rejects.toThrow();
  });

  it("cleans up ingress, tunnel, and control state when the probe fails", async () => {
    const directory = await temporaryDirectory();
    const paths = localStatePaths({ stateDirectory: join(directory, "state") });
    const closeIngress = vi.fn(async () => undefined);
    const stopTunnel = vi.fn(async () => undefined);
    const ingress: LocalIngressServer = {
      host: "127.0.0.1",
      port: 43123,
      eventsUrl: "http://127.0.0.1:43123/v1/events",
      probeUrl: "http://127.0.0.1:43123/v1/probe",
      close: closeIngress,
    };
    const tunnel: CloudflaredTunnelProcess = {
      ready: Promise.resolve(),
      health: () => tunnelHealth("ready"),
      stop: stopTunnel,
    };
    const ready = vi.fn();

    await expect(
      runLocalConnector({
        config: connectorConfig(),
        paths,
        startupTimeoutMs: 1_000,
        onReady: ready,
        log: () => undefined,
        dependencies: {
          startIngress: async () => ingress,
          startTunnel: async () => tunnel,
          probe: async () => Promise.reject(new Error("probe refused")),
        },
      }),
    ).rejects.toThrow("probe refused");

    expect(ready).not.toHaveBeenCalled();
    expect(stopTunnel).toHaveBeenCalledOnce();
    expect(closeIngress).toHaveBeenCalledOnce();
    await expect(
      requestLocalControl(paths.controlEndpoint, { method: "status" }),
    ).rejects.toThrow();
  });

  it("sends an encrypted end-to-end readiness probe through the tunnel hostname", async () => {
    const directory = await temporaryDirectory();
    const paths = localStatePaths({ stateDirectory: join(directory, "state") });
    const config = connectorConfig();
    const closeIngress = vi.fn(async () => undefined);
    const stopTunnel = vi.fn(async () => undefined);
    const probeFetch = vi.fn(
      async (_input: string | URL | Request, _request?: RequestInit) =>
        Response.json({
          version: 1,
          status: "ready",
          environmentId: "env-test",
        }),
    );
    vi.stubGlobal("fetch", probeFetch);
    let ready = false;
    const runner = runLocalConnector({
      config,
      paths,
      startupTimeoutMs: 1_000,
      log: () => undefined,
      onReady: () => {
        ready = true;
      },
      dependencies: {
        startIngress: async () => ({
          host: "127.0.0.1",
          port: 43123,
          eventsUrl: "http://127.0.0.1:43123/v1/events",
          probeUrl: "http://127.0.0.1:43123/v1/probe",
          close: closeIngress,
        }),
        startTunnel: async () => ({
          ready: Promise.resolve(),
          health: () => tunnelHealth("ready"),
          stop: stopTunnel,
        }),
      },
    });

    await waitFor(() => ready);
    expect(probeFetch).toHaveBeenCalledOnce();
    const [url, request] = probeFetch.mock.calls[0]!;
    if (request === undefined) throw new Error("Probe request options were missing.");
    expect(url).toBe("https://env-test.pagent.example.com/v1/probe");
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer source-token",
        "content-type": "application/json",
      },
      signal: expect.any(AbortSignal),
    });
    const body = JSON.parse(String(request.body)) as EventEnvelope;
    expect(JSON.stringify(body)).not.toContain('"probe":true');
    await expect(
      decryptEventContext(
        {
          id: body.event.id,
          type: body.event.type,
          environment: body.event.environment,
          occurredAt: body.event.occurredAt,
          investigation: body.event.investigation,
        },
        body.event.context,
        KEY,
      ),
    ).resolves.toEqual({ probe: true, environmentId: "env-test" });

    await requestLocalControl(paths.controlEndpoint, { method: "stop" });
    await runner;
    expect(stopTunnel).toHaveBeenCalledOnce();
    expect(closeIngress).toHaveBeenCalledOnce();
  });
});

function connectorConfig(): ConnectorConfig {
  return {
    ingress: {
      host: "127.0.0.1",
      port: 43123,
      token: "source-token",
    },
    tunnel: {
      environmentId: "env-test",
      tunnelId: "tunnel-test",
      hostname: "env-test.pagent.example.com",
      provisionerUrl: "https://provisioner.pagent.example.com",
      tokenFile: "/state/tunnel-token",
      cloudflaredPath: "/opt/cloudflared",
    },
    repositories: { pagent: process.cwd() },
    environments: ["staging"],
    encryption: { keys: { current: KEY } },
    codex: { sandboxMode: "read-only" },
  };
}

function tunnelHealth(state: TunnelProcessHealth["state"]): TunnelProcessHealth {
  const ready = state === "ready";
  return {
    state,
    running: state === "starting" || ready,
    ready,
    pid: 2468,
    startedAt: "2026-08-27T11:59:00.000Z",
    ...(ready ? { readyAt: "2026-08-27T11:59:01.000Z" } : {}),
  };
}

async function recordCompletedHandoff(options: LocalIngressOptions): Promise<void> {
  const event = encryptedEvent("event-1", "health.failed");
  const route = { repositoryKey: "pagent" };
  await options.onLifecycle?.(
    { status: "received", occurredAt: "2026-08-27T12:00:00.000Z" },
    event,
    route,
  );
  await options.onLifecycle?.(
    { status: "running", occurredAt: "2026-08-27T12:00:01.000Z" },
    event,
    route,
  );
  await options.onLifecycle?.(
    {
      status: "completed",
      occurredAt: "2026-08-27T12:00:02.000Z",
      threadId: "thread-1",
    },
    event,
    route,
  );
}

function encryptedEvent(id: string, type: string): EncryptedPagentEvent {
  return {
    id,
    type,
    environment: "staging",
    occurredAt: "2026-08-27T12:00:00.000Z",
    investigation: { cooldownMs: 0 },
    context: {
      algorithm: "A256GCM",
      keyId: "current",
      iv: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value?: T): void;
} {
  let resolvePromise: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value?: T) {
      resolvePromise?.(value as T);
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pagent-runner-test-"));
  temporaryDirectories.push(path);
  return path;
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the local runner.");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
