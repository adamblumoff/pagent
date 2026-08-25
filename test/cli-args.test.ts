import { describe, expect, it } from "vitest";

import {
  CliUsageError,
  parseCliArgs,
  renderCliHelp,
} from "../src/cli-args.js";

describe("CLI arguments", () => {
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
    expect(renderCliHelp()).toContain("start    Start the connector");
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
