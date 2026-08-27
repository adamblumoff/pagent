import { describe, expect, it } from "vitest";

import { CliUsageError, parseCliArgs, renderCliHelp } from "../src/cli-args.js";

describe("CLI arguments", () => {
  it("uses safe init defaults", () => {
    expect(parseCliArgs(["init"])).toEqual({
      name: "init",
      provisioner: undefined,
      enrollment: undefined,
      environments: ["staging"],
      yes: false,
      noStart: false,
      reset: false,
    });
  });

  it("parses provisioner init values and switches", () => {
    expect(parseCliArgs([
      "init",
      "--provisioner",
      "https://provisioner.example.com",
      "--enrollment=enroll-secret",
      "--environments",
      "staging, production",
      "--yes",
      "--no-start",
      "--reset",
    ])).toEqual({
      name: "init",
      provisioner: "https://provisioner.example.com",
      enrollment: "enroll-secret",
      environments: ["staging", "production"],
      yes: true,
      noStart: true,
      reset: true,
    });
  });

  it("parses tunnel revocation", () => {
    expect(parseCliArgs(["tunnel", "revoke"])).toEqual({
      name: "tunnel",
      action: "revoke",
      yes: false,
    });
    expect(parseCliArgs(["tunnel", "revoke", "--yes"])).toEqual({
      name: "tunnel",
      action: "revoke",
      yes: true,
    });
  });

  it("parses one-time enrollment token creation", () => {
    expect(parseCliArgs(["enrollment", "create"])).toEqual({
      name: "enrollment",
      action: "create",
      provisioner: undefined,
      adminToken: undefined,
      ttlMinutes: 10,
    });
    expect(parseCliArgs([
      "enrollment",
      "create",
      "--provisioner=https://provisioner.example.com",
      "--admin-token",
      "control-value",
      "--ttl",
      "30",
    ])).toEqual({
      name: "enrollment",
      action: "create",
      provisioner: "https://provisioner.example.com",
      adminToken: "control-value",
      ttlMinutes: 30,
    });
  });

  it("parses lifecycle and diagnostic commands", () => {
    expect(parseCliArgs(["start"])).toEqual({
      name: "start",
      foreground: false,
      skipDoctor: false,
    });
    expect(parseCliArgs(["start", "--foreground", "--skip-doctor"])).toEqual({
      name: "start",
      foreground: true,
      skipDoctor: true,
    });
    expect(parseCliArgs(["stop"])).toEqual({ name: "stop" });
    expect(parseCliArgs(["status", "--json"])).toEqual({ name: "status", json: true });
    expect(parseCliArgs(["doctor", "--json"])).toEqual({ name: "doctor", json: true });
  });

  it.each(["received", "running", "completed", "suppressed", "failed"])(
    "filters local event history by %s status",
    (status) => {
      expect(parseCliArgs(["events", "--status", status])).toEqual({
        name: "events",
        action: "list",
        limit: 20,
        status,
        json: false,
      });
    },
  );

  it("parses event list and detail commands", () => {
    expect(parseCliArgs(["events"])).toEqual({
      name: "events",
      action: "list",
      limit: 20,
      status: undefined,
      json: false,
    });
    expect(parseCliArgs(["events", "--limit=50", "--json"])).toEqual({
      name: "events",
      action: "list",
      limit: 50,
      status: undefined,
      json: true,
    });
    expect(parseCliArgs(["events", "show", "evt_7C92", "--json"])).toEqual({
      name: "events",
      action: "show",
      eventId: "evt_7C92",
      json: true,
    });
  });

  it("parses logs", () => {
    expect(parseCliArgs(["logs"])).toEqual({ name: "logs", follow: false, lines: 100 });
    expect(parseCliArgs(["logs", "--follow", "--lines", "25"])).toEqual({
      name: "logs",
      follow: true,
      lines: 25,
    });
  });

  it("supports help and version forms", () => {
    expect(parseCliArgs([])).toEqual({ name: "help" });
    expect(parseCliArgs(["--help"])).toEqual({ name: "help" });
    expect(parseCliArgs(["help", "tunnel"])).toEqual({ name: "help", command: "tunnel" });
    expect(parseCliArgs(["start", "-h"])).toEqual({ name: "help", command: "start" });
    expect(parseCliArgs(["--version"])).toEqual({ name: "version" });
  });

  it("rejects unknown commands", () => {
    expectUsageError(["connector", "revoke"], 'Unknown command "connector".');
  });

  it("rejects duplicate and conflicting flags", () => {
    expectUsageError(
      ["init", "--provisioner=one", "--provisioner", "two"],
      'Option "--provisioner" was provided more than once for "init".',
    );
    expectUsageError(
      ["init", "--yes", "--yes"],
      'Option "--yes" was provided more than once for "init".',
    );
    expectUsageError(
      ["tunnel", "revoke", "--yes", "--yes"],
      'Option "--yes" was provided more than once for "tunnel".',
    );
    expectUsageError(
      ["events", "--status", "received", "--status=completed"],
      'Option "--status" was provided more than once for "events".',
    );
    expectUsageError(
      ["start", "--help", "--foreground"],
      'Help for "start" cannot be combined with other arguments.',
    );
  });

  it("rejects malformed init and tunnel values", () => {
    expectUsageError(["init", "--provisioner"], 'Option "--provisioner" requires a value.');
    expectUsageError(["init", "--enrollment="], 'Option "--enrollment" requires a value.');
    expectUsageError(
      ["init", "--environments", "staging,,production"],
      'Option "--environments" requires a comma-separated list of unique, non-empty names.',
    );
    expectUsageError(
      ["init", "--environments=staging,staging"],
      'Option "--environments" requires a comma-separated list of unique, non-empty names.',
    );
    expectUsageError(["tunnel"], 'Usage: pagent tunnel revoke [--yes].');
    expectUsageError(["tunnel", "delete"], 'Usage: pagent tunnel revoke [--yes].');
    expectUsageError(
      ["enrollment"],
      "Usage: pagent enrollment create [--provisioner <url>] [--admin-token <token>] [--ttl <minutes>].",
    );
    expectUsageError(
      ["enrollment", "create", "--ttl", "1441"],
      'Option "--ttl" cannot exceed 1440 minutes.',
    );
  });

  it("rejects malformed event and log options", () => {
    expectUsageError(["logs", "--lines", "0"], 'Option "--lines" requires a positive integer.');
    expectUsageError(["events", "--limit", "101"], 'Option "--limit" cannot exceed 100.');
    expectUsageError(
      ["events", "--status", "retrying"],
      'Option "--status" must be one of: received, running, completed, suppressed, failed.',
    );
    expectUsageError(["events", "show"], "Usage: pagent events show <event-id> [--json].");
  });

  it("renders direct-architecture help", () => {
    expect(renderCliHelp()).toContain("init        Provision a tunnel");
    expect(renderCliHelp()).toContain("tunnel      Revoke this environment's tunnel");
    expect(renderCliHelp()).toContain("enrollment  Create a one-time setup token");
    expect(renderCliHelp("init")).toContain("--provisioner <url>");
    expect(renderCliHelp("init")).toContain("--enrollment <token>");
    expect(renderCliHelp("tunnel")).toContain("tunnel revoke");
    expect(renderCliHelp("status")).toContain("Cloudflare Tunnel state");
  });
});

function expectUsageError(args: string[], message: string): void {
  expect(() => parseCliArgs(args)).toThrowError(message);
  try {
    parseCliArgs(args);
  } catch (error) {
    expect(error).toBeInstanceOf(CliUsageError);
    expect((error as CliUsageError).exitCode).toBe(2);
  }
}
