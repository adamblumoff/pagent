import { describe, expect, it } from "vitest";

import {
  CliUsageError,
  parseCliArgs,
  renderCliHelp,
} from "../src/cli-args.js";

describe("CLI arguments", () => {
  it("uses safe init defaults", () => {
    expect(parseCliArgs(["init"])).toEqual({
      name: "init",
      relay: undefined,
      enrollment: undefined,
      environments: ["staging"],
      yes: false,
      noStart: false,
      reset: false,
    });
  });

  it("parses init values and switches", () => {
    expect(
      parseCliArgs([
        "init",
        "--relay",
        "https://relay.example.com",
        "--enrollment=secret",
        "--environments",
        "staging, production",
        "--yes",
        "--no-start",
        "--reset",
      ]),
    ).toEqual({
      name: "init",
      relay: "https://relay.example.com",
      enrollment: "secret",
      environments: ["staging", "production"],
      yes: true,
      noStart: true,
      reset: true,
    });
  });

  it("parses relay administration commands", () => {
    expect(
      parseCliArgs([
        "enrollment",
        "create",
        "--relay=https://relay.example.test",
        "--admin-token",
        "admin-secret",
        "--ttl",
        "30",
        "--connector",
        "api-laptop",
      ]),
    ).toEqual({
      name: "enrollment",
      relay: "https://relay.example.test",
      adminToken: "admin-secret",
      ttlMinutes: 30,
      connectorId: "api-laptop",
    });
    expect(
      parseCliArgs([
        "connector",
        "revoke",
        "api-laptop",
        "--relay",
        "https://relay.example.test",
        "--yes",
      ]),
    ).toEqual({
      name: "connector",
      connectorId: "api-laptop",
      relay: "https://relay.example.test",
      adminToken: undefined,
      yes: true,
    });
  });

  it("starts in the background with doctor checks by default", () => {
    expect(parseCliArgs(["start"])).toEqual({
      name: "start",
      foreground: false,
      skipDoctor: false,
    });
  });

  it("supports foreground startup and explicitly skipping doctor", () => {
    expect(parseCliArgs(["start", "--foreground", "--skip-doctor"])).toEqual({
      name: "start",
      foreground: true,
      skipDoctor: true,
    });
  });

  it("parses lifecycle and diagnostic commands", () => {
    expect(parseCliArgs(["stop"])).toEqual({ name: "stop" });
    expect(parseCliArgs(["status", "--json"])).toEqual({
      name: "status",
      json: true,
    });
    expect(parseCliArgs(["doctor"])).toEqual({ name: "doctor", json: false });
    expect(parseCliArgs(["doctor", "--json"])).toEqual({
      name: "doctor",
      json: true,
    });
  });

  it("parses log tailing and line limits", () => {
    expect(parseCliArgs(["logs"])).toEqual({
      name: "logs",
      follow: false,
      lines: 100,
    });
    expect(parseCliArgs(["logs", "--follow", "--lines", "25"])).toEqual({
      name: "logs",
      follow: true,
      lines: 25,
    });
    expect(parseCliArgs(["logs", "--lines=40"])).toEqual({
      name: "logs",
      follow: false,
      lines: 40,
    });
  });

  it("supports general, command, and version help forms", () => {
    expect(parseCliArgs([])).toEqual({ name: "help" });
    expect(parseCliArgs(["--help"])).toEqual({ name: "help" });
    expect(parseCliArgs(["help", "logs"])).toEqual({
      name: "help",
      command: "logs",
    });
    expect(parseCliArgs(["start", "-h"])).toEqual({
      name: "help",
      command: "start",
    });
    expect(parseCliArgs(["--version"])).toEqual({ name: "version" });
    expect(parseCliArgs(["-v"])).toEqual({ name: "version" });
  });

  it("rejects unknown commands, flags, and positional arguments", () => {
    expectUsageError(["launch"], 'Unknown command "launch".');
    expectUsageError(["--wat"], 'Unknown option "--wat".');
    expectUsageError(["start", "--wat"], 'Unknown option "--wat" for "start".');
    expectUsageError(["stop", "later"], 'Unexpected argument "later" for "stop".');
  });

  it("rejects duplicate and conflicting flags", () => {
    expectUsageError(
      ["init", "--relay=one", "--relay", "two"],
      'Option "--relay" was provided more than once for "init".',
    );
    expectUsageError(
      ["init", "--yes", "--yes"],
      'Option "--yes" was provided more than once for "init".',
    );
    expectUsageError(
      ["start", "--foreground", "--foreground"],
      'Option "--foreground" was provided more than once for "start".',
    );
    expectUsageError(
      ["status", "--json", "--json"],
      'Option "--json" was provided more than once for "status".',
    );
    expectUsageError(
      ["start", "--help", "--foreground"],
      'Help for "start" cannot be combined with other arguments.',
    );
    expectUsageError(
      ["--help", "--version"],
      'Option "--help" cannot be combined with other arguments.',
    );
  });

  it("rejects missing and malformed init values", () => {
    expectUsageError(
      ["init", "--relay"],
      'Option "--relay" requires a value.',
    );
    expectUsageError(
      ["init", "--enrollment="],
      'Option "--enrollment" requires a value.',
    );
    expectUsageError(
      ["init", "--environments", "staging,,production"],
      'Option "--environments" requires a comma-separated list of unique, non-empty names.',
    );
    expectUsageError(
      ["init", "--environments=staging,staging"],
      'Option "--environments" requires a comma-separated list of unique, non-empty names.',
    );
    expectUsageError(
      ["init", "--help", "--yes"],
      'Help for "init" cannot be combined with other arguments.',
    );
  });

  it("rejects malformed relay administration commands", () => {
    expectUsageError(
      ["enrollment"],
      'The enrollment command requires the action "create".',
    );
    expectUsageError(
      ["enrollment", "create", "--ttl", "1441"],
      'Option "--ttl" cannot exceed 1440 minutes.',
    );
    expectUsageError(
      ["connector", "revoke"],
      "Usage: pagent connector revoke <connector-id> [options].",
    );
  });

  it("requires a valid positive line count", () => {
    expectUsageError(
      ["logs", "--lines"],
      'Option "--lines" requires a positive integer.',
    );
    expectUsageError(
      ["logs", "--lines", "0"],
      'Option "--lines" requires a positive integer.',
    );
    expectUsageError(
      ["logs", "--lines=2.5"],
      'Option "--lines" requires a positive integer.',
    );
  });

  it("renders concise general and command help", () => {
    expect(renderCliHelp()).toContain("Usage: pagent <command> [options]");
    expect(renderCliHelp()).toContain("init        Enroll this repository");
    expect(renderCliHelp()).toContain("enrollment  Create a single-use");
    expect(renderCliHelp("connector")).toContain("connector revoke");
    expect(renderCliHelp()).toContain("start       Start the connector");
    expect(renderCliHelp("init")).toContain("--enrollment <code>");
    expect(renderCliHelp("start")).toContain("--foreground");
    expect(renderCliHelp("logs")).toContain("--lines <count>");
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
