import { constants } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { CodexSandboxProbeError } from "../src/codex.js";
import {
  runDoctor,
  type DoctorDependencies,
  type DoctorInput,
} from "../src/doctor.js";

const KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

describe("runDoctor", () => {
  it("verifies a ready connector without exposing credentials", async () => {
    const signals: AbortSignal[] = [];
    const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = input.toString();
      if (init?.signal) signals.push(init.signal);
      if (url.endsWith("/health")) {
        return Response.json({ status: "ok" });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer connector-secret",
      );
      return new Response(new ReadableStream(), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const probeCodex = vi.fn(async () => undefined);

    const report = await runDoctor(input(), dependencies({ fetch, probeCodex }));

    expect(report.ok).toBe(true);
    expect(report.warnings).toBe(0);
    expect(report.checks.map(({ id }) => id)).toEqual([
      "runtime",
      "config",
      "repositories",
      "inbox",
      "state",
      "relay.health",
      "relay.sse",
      "codex",
      "sandbox.runtime",
      "worktree",
      "sandbox",
    ]);
    expect(report.checks.every(({ status }) => status === "pass")).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(true);
    expect(probeCodex).toHaveBeenCalledWith({
      timeoutMs: 5_000,
      sandbox: { cwd: "/repo", mode: "read-only" },
    });
    expect(JSON.stringify(report)).not.toContain("connector-secret");
    expect(JSON.stringify(report)).not.toContain(KEY);
  });

  it("fails invalid encryption settings without contacting the relay", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const report = await runDoctor(
      input({ encryption: { keys: { current: "not-a-32-byte-key" } } }),
      dependencies({ fetch }),
    );

    expect(check(report, "config").status).toBe("fail");
    expect(check(report, "relay.health")).toMatchObject({ status: "warn" });
    expect(check(report, "relay.sse")).toMatchObject({ status: "warn" });
    expect(report.ok).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("detects legacy inbox and incompatible process state", async () => {
    const report = await runDoctor(
      input(),
      dependencies({
        stat: vi.fn(async (path: string) =>
          path === resolve("/repo")
            ? directory()
            : file(),
        ),
        readFile: vi.fn(async (path: string) =>
          path.endsWith("inbox.json")
            ? JSON.stringify({ version: 1 })
            : JSON.stringify({ version: 9 }),
        ),
      }),
    );

    expect(check(report, "inbox")).toEqual({
      id: "inbox",
      label: "Encrypted inbox",
      status: "fail",
      detail: "Inbox uses v1; archive or remove it before starting Pagent.",
    });
    expect(check(report, "state").status).toBe("fail");
    expect(report.ok).toBe(false);
  });

  it("reports relay status failures and never includes the connector token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async (request) =>
      request.toString().endsWith("/health")
        ? new Response(null, { status: 503 })
        : new Response(null, { status: 401 }),
    );
    const report = await runDoctor(input(), dependencies({ fetch }));

    expect(check(report, "relay.health").detail).toBe(
      "Relay health returned HTTP 503.",
    );
    expect(check(report, "relay.sse").detail).toBe(
      "Relay connector authentication returned HTTP 401.",
    );
    expect(JSON.stringify(report)).not.toContain("connector-secret");
  });

  it("keeps dirty worktrees and a write-capable sandbox advisory", async () => {
    const report = await runDoctor(
      input({ codex: { sandboxMode: "workspace-write" } }),
      dependencies({ gitStatus: vi.fn(async () => " M src/index.ts\n") }),
    );

    expect(check(report, "worktree").status).toBe("warn");
    expect(check(report, "sandbox").status).toBe("warn");
    expect(report.ok).toBe(true);
    expect(report.warnings).toBe(2);
  });

  it("fails a missing repository and an unavailable Codex app server", async () => {
    const report = await runDoctor(
      input(),
      dependencies({
        stat: vi.fn(async (path: string) => {
          if (path === resolve("/repo")) throw missing();
          if (path === resolve("/state")) return directory();
          throw missing();
        }),
        probeCodex: vi.fn(async () => {
          throw new Error("ENOENT secret=should-not-leak");
        }),
      }),
    );

    expect(check(report, "repositories").status).toBe("fail");
    expect(check(report, "codex")).toMatchObject({
      status: "fail",
      detail: "Codex app server could not be found or initialized.",
      remediation: expect.stringContaining("codex login"),
    });
    expect(check(report, "sandbox.runtime")).toMatchObject({ status: "warn" });
    expect(JSON.stringify(report)).not.toContain("should-not-leak");
  });

  it("does not misdiagnose a missing repository as a sandbox failure", async () => {
    const probeCodex = vi.fn(async () => undefined);
    const report = await runDoctor(
      input(),
      dependencies({
        stat: vi.fn(async (path: string) => {
          if (path === resolve("/repo")) throw missing();
          if (path === resolve("/state")) return directory();
          throw missing();
        }),
        probeCodex,
      }),
    );

    expect(probeCodex).toHaveBeenCalledWith({ timeoutMs: 5_000 });
    expect(check(report, "codex").status).toBe("pass");
    expect(check(report, "sandbox.runtime")).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("repository mapping"),
    });
  });

  it("fails with a concrete fix when Ubuntu blocks Bubblewrap", async () => {
    const report = await runDoctor(
      input({ includeAdvisories: false }),
      dependencies({
        probeCodex: vi.fn(async () => {
          throw new CodexSandboxProbeError(
            "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted secret=hidden",
          );
        }),
      }),
    );

    expect(check(report, "codex").status).toBe("pass");
    expect(check(report, "sandbox.runtime")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("host blocked"),
      remediation: expect.stringContaining("use_legacy_landlock = true"),
    });
    expect(report.checks.map(({ id }) => id)).not.toContain("worktree");
    expect(report.checks.map(({ id }) => id)).not.toContain("sandbox");
    expect(report.ok).toBe(false);
    expect(JSON.stringify(report)).not.toContain("secret=hidden");
  });
});

function input(overrides: Partial<DoctorInput> = {}): DoctorInput {
  return {
    relayUrl: "https://relay.example.test",
    connectorId: "local-connector",
    connectorToken: "connector-secret",
    inboxPath: "/state/inbox.json",
    statePath: "/state/process.json",
    repositories: { app: "/repo" },
    environments: ["staging"],
    encryption: { keys: { current: KEY } },
    codex: { sandboxMode: "read-only" },
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<DoctorDependencies> = {},
): Partial<DoctorDependencies> {
  return {
    runtimeCapabilities: () => [],
    stat: vi.fn(async (path: string) => {
      if (path === resolve("/repo") || path === resolve("/state")) {
        return directory();
      }
      throw missing();
    }),
    access: vi.fn(async (_path: string, mode: number) => {
      expect(mode & constants.R_OK).not.toBe(0);
    }),
    readFile: vi.fn(async () => ""),
    fetch: vi.fn<typeof globalThis.fetch>(async (request) =>
      request.toString().endsWith("/health")
        ? Response.json({ status: "ok" })
        : new Response(new ReadableStream(), {
            headers: { "content-type": "text/event-stream" },
          }),
    ),
    gitStatus: vi.fn(async () => ""),
    probeCodex: vi.fn(async () => undefined),
    ...overrides,
  };
}

function directory() {
  return { isDirectory: () => true, isFile: () => false };
}

function file() {
  return { isDirectory: () => false, isFile: () => true };
}

function missing(): NodeJS.ErrnoException {
  return Object.assign(new Error("missing"), { code: "ENOENT" });
}

function check(
  report: Awaited<ReturnType<typeof runDoctor>>,
  id: Awaited<ReturnType<typeof runDoctor>>["checks"][number]["id"],
) {
  return report.checks.find((item) => item.id === id)!;
}
