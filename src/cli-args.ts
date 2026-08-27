export const cliCommandNames = [
  "init",
  "enrollment",
  "tunnel",
  "start",
  "stop",
  "status",
  "events",
  "logs",
  "doctor",
  "help",
  "version",
] as const;

export type CliCommandName = (typeof cliCommandNames)[number];

export const eventLifecycleStatuses = [
  "received",
  "running",
  "completed",
  "suppressed",
  "failed",
] as const;

export type EventLifecycleStatus = (typeof eventLifecycleStatuses)[number];

export type CliCommand =
  | {
      name: "init";
      provisioner: string | undefined;
      enrollment: string | undefined;
      environments: string[];
      yes: boolean;
      noStart: boolean;
      reset: boolean;
    }
  | {
      name: "enrollment";
      action: "create";
      provisioner: string | undefined;
      adminToken: string | undefined;
      ttlMinutes: number;
    }
  | {
      name: "tunnel";
      action: "revoke";
      yes: boolean;
    }
  | {
      name: "start";
      foreground: boolean;
      skipDoctor: boolean;
    }
  | {
      name: "stop";
    }
  | {
      name: "status";
      json: boolean;
    }
  | {
      name: "events";
      action: "list";
      limit: number;
      status: EventLifecycleStatus | undefined;
      json: boolean;
    }
  | {
      name: "events";
      action: "show";
      eventId: string;
      json: boolean;
    }
  | {
      name: "logs";
      follow: boolean;
      lines: number;
    }
  | {
      name: "doctor";
      json: boolean;
    }
  | {
      name: "help";
      command?: CliCommandName;
    }
  | {
      name: "version";
    };

export class CliUsageError extends Error {
  readonly exitCode = 2;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const helpByCommand: Record<CliCommandName, string> = {
  init: `Usage: pagent init [options]

Provision a Cloudflare Tunnel and write this repository's local configuration.

Options:
  --provisioner <url>     Pagent provisioning service URL
  --enrollment <token>   Short-lived enrollment token
  --environments <list>  Comma-separated environments (default: staging)
  --yes                   Skip the confirmation prompt
  --no-start              Do not start Pagent or enable automatic startup
  --reset                 Replace an existing Pagent setup
  -h, --help              Show help for init`,
  enrollment: `Usage: pagent enrollment create [options]

Create a short-lived, single-use token for \`pagent init\`.

Options:
  --provisioner <url>    Pagent provisioning service URL
  --admin-token <token>  Provisioner admin token (prefer the environment variable)
  --ttl <minutes>        Token lifetime from 1 to 1440 minutes (default: 10)
  -h, --help             Show help for enrollment`,
  tunnel: `Usage: pagent tunnel revoke [options]

Delete this environment's Cloudflare Tunnel and revoke its management token.

Options:
  --yes                  Skip the confirmation prompt
  -h, --help             Show help for tunnel`,
  start: `Usage: pagent start [options]

Start the local connector and enable automatic startup.

Options:
  --foreground   Run in the current terminal
  --skip-doctor  Skip advisory doctor checks
  -h, --help     Show help for start`,
  stop: `Usage: pagent stop

Stop the current run without disabling startup after reboot.

Options:
  -h, --help  Show help for stop`,
  status: `Usage: pagent status [options]

Show local ingress and Cloudflare Tunnel state.

Options:
  --json      Print machine-readable JSON
  -h, --help  Show help for status`,
  events: `Usage: pagent events [options]
       pagent events show <event-id> [--json]

List recent event handoffs or inspect one event.

Options:
  --limit <count>    Number of events to show from 1 to 100 (default: 20)
  --status <status>  Filter by lifecycle status
  --json             Print machine-readable JSON
  -h, --help         Show help for events`,
  logs: `Usage: pagent logs [options]

Read logs from the background connector.

Options:
  --follow         Continue streaming new log entries
  --lines <count>  Number of recent lines to show (default: 100)
  -h, --help       Show help for logs`,
  doctor: `Usage: pagent doctor [options]

Run non-destructive configuration and connectivity checks.

Options:
  --json      Print machine-readable JSON
  -h, --help  Show help for doctor`,
  help: `Usage: pagent help [command]

Show general help or help for one command.`,
  version: `Usage: pagent version

Print the installed Pagent version.`,
};

const generalHelp = `Usage: pagent <command> [options]

Run and inspect local Pagent.

Commands:
  init        Provision a tunnel and write local configuration
  enrollment  Create a one-time setup token
  tunnel      Revoke this environment's tunnel
  start       Start Pagent and enable automatic startup
  stop        Stop Pagent gracefully
  status      Show ingress and tunnel state
  events      Show recent event handoffs
  logs        Read connector logs
  doctor      Check the local setup without changing it
  help        Show help for a command
  version     Print the installed version

Run \`pagent help <command>\` for command-specific options.`;

export function renderCliHelp(command?: CliCommandName): string {
  return command === undefined ? generalHelp : helpByCommand[command];
}

export function parseCliArgs(args: readonly string[]): CliCommand {
  if (args.length === 0) {
    return { name: "help" };
  }

  const first = args[0]!;
  if (first === "--help" || first === "-h") {
    requireNoExtras(first, args);
    return { name: "help" };
  }

  if (first === "--version" || first === "-v") {
    requireNoExtras(first, args);
    return { name: "version" };
  }

  if (!isCliCommandName(first)) {
    if (first.startsWith("-")) {
      throw new CliUsageError(`Unknown option "${first}".`);
    }
    throw new CliUsageError(`Unknown command "${first}".`);
  }

  const rest = args.slice(1);
  const helpIndex = rest.findIndex((arg) => arg === "--help" || arg === "-h");
  if (helpIndex >= 0) {
    if (rest.length !== 1) {
      throw new CliUsageError(
        `Help for "${first}" cannot be combined with other arguments.`,
      );
    }
    return { name: "help", command: first };
  }

  switch (first) {
    case "init":
      return parseInit(rest);
    case "enrollment":
      return parseEnrollment(rest);
    case "tunnel":
      return parseTunnel(rest);
    case "start":
      return parseStart(rest);
    case "stop":
      requireNoCommandArgs(first, rest);
      return { name: "stop" };
    case "status":
      return { name: "status", json: parseBooleanFlag(first, rest, "--json") };
    case "events":
      return parseEvents(rest);
    case "logs":
      return parseLogs(rest);
    case "doctor":
      return { name: "doctor", json: parseBooleanFlag(first, rest, "--json") };
    case "help":
      return parseHelp(rest);
    case "version":
      requireNoCommandArgs(first, rest);
      return { name: "version" };
  }
}

function parseEnrollment(args: readonly string[]): CliCommand {
  if (args[0] !== "create") {
    throw new CliUsageError(
      "Usage: pagent enrollment create [--provisioner <url>] [--admin-token <token>] [--ttl <minutes>].",
    );
  }
  let provisioner: string | undefined;
  let adminToken: string | undefined;
  let ttlMinutes = 10;
  let hasTtl = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index]!;
    const option = valueOption(arg, ["--provisioner", "--admin-token", "--ttl"]);
    if (!option) rejectCommandArg("enrollment", arg);
    if (
      (option.flag === "--provisioner" && provisioner !== undefined) ||
      (option.flag === "--admin-token" && adminToken !== undefined) ||
      (option.flag === "--ttl" && hasTtl)
    ) {
      throw duplicateOption("enrollment", option.flag);
    }
    const value = optionValue(option, args[index + 1]);
    if (option.inlineValue === undefined) index += 1;
    if (option.flag === "--provisioner") {
      provisioner = value;
    } else if (option.flag === "--admin-token") {
      adminToken = value;
    } else {
      ttlMinutes = parsePositiveInteger(option.flag, value);
      if (ttlMinutes > 1_440) {
        throw new CliUsageError('Option "--ttl" cannot exceed 1440 minutes.');
      }
      hasTtl = true;
    }
  }
  return { name: "enrollment", action: "create", provisioner, adminToken, ttlMinutes };
}

function parseTunnel(args: readonly string[]): CliCommand {
  if (args[0] !== "revoke") {
    throw new CliUsageError('Usage: pagent tunnel revoke [--yes].');
  }
  let yes = false;
  for (const arg of args.slice(1)) {
    if (arg === "--yes") {
      yes = setOnce("tunnel", arg, yes);
      continue;
    }
    rejectCommandArg("tunnel", arg);
  }
  return { name: "tunnel", action: "revoke", yes };
}

function valueOption<const TFlag extends string>(
  arg: string,
  flags: readonly TFlag[],
): { flag: TFlag; inlineValue?: string } | undefined {
  for (const flag of flags) {
    if (arg === flag) return { flag };
    if (arg.startsWith(`${flag}=`)) {
      return { flag, inlineValue: arg.slice(flag.length + 1) };
    }
  }
  return undefined;
}

function optionValue(
  option: { flag: string; inlineValue?: string },
  next: string | undefined,
): string {
  const value = option.inlineValue ?? next;
  if (
    value === undefined ||
    value.trim() === "" ||
    (option.inlineValue === undefined && value.startsWith("-"))
  ) {
    throw new CliUsageError(`Option "${option.flag}" requires a value.`);
  }
  return value;
}

function parseInit(args: readonly string[]): CliCommand {
  let provisioner: string | undefined;
  let enrollment: string | undefined;
  let environments = ["staging"];
  let hasEnvironments = false;
  let yes = false;
  let noStart = false;
  let reset = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--yes") {
      yes = setOnce("init", arg, yes);
      continue;
    }
    if (arg === "--no-start") {
      noStart = setOnce("init", arg, noStart);
      continue;
    }
    if (arg === "--reset") {
      reset = setOnce("init", arg, reset);
      continue;
    }

    const option = valueOption(arg, [
      "--provisioner",
      "--enrollment",
      "--environments",
    ]);
    if (option !== undefined) {
      const duplicate =
        (option.flag === "--provisioner" && provisioner !== undefined) ||
        (option.flag === "--enrollment" && enrollment !== undefined) ||
        (option.flag === "--environments" && hasEnvironments);
      if (duplicate) {
        throw duplicateOption("init", option.flag);
      }

      const value = optionValue(option, args[index + 1]);

      if (option.flag === "--provisioner") {
        provisioner = value;
      } else if (option.flag === "--enrollment") {
        enrollment = value;
      } else {
        environments = parseEnvironmentList(value);
        hasEnvironments = true;
      }

      if (option.inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    rejectCommandArg("init", arg);
  }

  return {
    name: "init",
    provisioner,
    enrollment,
    environments,
    yes,
    noStart,
    reset,
  };
}

function parseEnvironmentList(value: string): string[] {
  const environments = value.split(",").map((environment) => environment.trim());
  if (
    environments.some((environment) => environment === "") ||
    new Set(environments).size !== environments.length
  ) {
    throw new CliUsageError(
      'Option "--environments" requires a comma-separated list of unique, non-empty names.',
    );
  }
  return environments;
}

function parseStart(args: readonly string[]): CliCommand {
  let foreground = false;
  let skipDoctor = false;

  for (const arg of args) {
    if (arg === "--foreground") {
      foreground = setOnce("start", arg, foreground);
    } else if (arg === "--skip-doctor") {
      skipDoctor = setOnce("start", arg, skipDoctor);
    } else {
      rejectCommandArg("start", arg);
    }
  }

  return { name: "start", foreground, skipDoctor };
}

function parseLogs(args: readonly string[]): CliCommand {
  let follow = false;
  let lines = 100;
  let hasLines = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--follow") {
      follow = setOnce("logs", arg, follow);
      continue;
    }

    if (arg === "--lines" || arg.startsWith("--lines=")) {
      if (hasLines) {
        throw duplicateOption("logs", "--lines");
      }

      const inlineValue = arg.startsWith("--lines=")
        ? arg.slice("--lines=".length)
        : undefined;
      const value = inlineValue ?? args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new CliUsageError('Option "--lines" requires a positive integer.');
      }

      lines = parsePositiveInteger("--lines", value);
      hasLines = true;
      if (inlineValue === undefined) {
        index += 1;
      }
      continue;
    }

    rejectCommandArg("logs", arg);
  }

  return { name: "logs", follow, lines };
}

function parseEvents(args: readonly string[]): CliCommand {
  if (args[0] === "show") {
    return parseEventShow(args.slice(1));
  }

  let limit = 20;
  let status: EventLifecycleStatus | undefined;
  let json = false;
  let hasLimit = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") {
      json = setOnce("events", arg, json);
      continue;
    }

    const option = valueOption(arg, ["--limit", "--status"]);
    if (!option) rejectCommandArg("events", arg);
    if (option.flag === "--limit" && hasLimit) {
      throw duplicateOption("events", option.flag);
    }
    if (option.flag === "--status" && status !== undefined) {
      throw duplicateOption("events", option.flag);
    }

    const value = optionValue(option, args[index + 1]);
    if (option.inlineValue === undefined) index += 1;
    if (option.flag === "--limit") {
      limit = parsePositiveInteger(option.flag, value);
      if (limit > 100) {
        throw new CliUsageError('Option "--limit" cannot exceed 100.');
      }
      hasLimit = true;
    } else {
      status = parseEventLifecycleStatus(value);
    }
  }

  return { name: "events", action: "list", limit, status, json };
}

function parseEventShow(args: readonly string[]): CliCommand {
  const eventId = args[0];
  if (eventId === undefined || eventId.startsWith("-")) {
    throw new CliUsageError("Usage: pagent events show <event-id> [--json].");
  }

  return {
    name: "events",
    action: "show",
    eventId,
    json: parseBooleanFlag("events", args.slice(1), "--json"),
  };
}

function parseEventLifecycleStatus(value: string): EventLifecycleStatus {
  if ((eventLifecycleStatuses as readonly string[]).includes(value)) {
    return value as EventLifecycleStatus;
  }
  throw new CliUsageError(
    `Option "--status" must be one of: ${eventLifecycleStatuses.join(", ")}.`,
  );
}

function parseHelp(args: readonly string[]): CliCommand {
  if (args.length === 0) {
    return { name: "help" };
  }
  if (args.length > 1) {
    throw new CliUsageError("The help command accepts at most one command name.");
  }

  const command = args[0]!;
  if (!isCliCommandName(command)) {
    throw new CliUsageError(`Unknown command "${command}".`);
  }
  return { name: "help", command };
}

function parseBooleanFlag(
  command: CliCommandName,
  args: readonly string[],
  flag: string,
): boolean {
  let enabled = false;
  for (const arg of args) {
    if (arg !== flag) {
      rejectCommandArg(command, arg);
    }
    enabled = setOnce(command, flag, enabled);
  }
  return enabled;
}

function parsePositiveInteger(flag: string, value: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new CliUsageError(`Option "${flag}" requires a positive integer.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new CliUsageError(`Option "${flag}" is too large.`);
  }
  return parsed;
}

function setOnce(command: CliCommandName, flag: string, current: boolean): true {
  if (current) {
    throw duplicateOption(command, flag);
  }
  return true;
}

function duplicateOption(command: CliCommandName, flag: string): CliUsageError {
  return new CliUsageError(`Option "${flag}" was provided more than once for "${command}".`);
}

function rejectCommandArg(command: CliCommandName, arg: string): never {
  if (arg.startsWith("-")) {
    throw new CliUsageError(`Unknown option "${arg}" for "${command}".`);
  }
  throw new CliUsageError(`Unexpected argument "${arg}" for "${command}".`);
}

function requireNoCommandArgs(command: CliCommandName, args: readonly string[]): void {
  if (args.length > 0) {
    rejectCommandArg(command, args[0]!);
  }
}

function requireNoExtras(flag: string, args: readonly string[]): void {
  if (args.length > 1) {
    throw new CliUsageError(`Option "${flag}" cannot be combined with other arguments.`);
  }
}

function isCliCommandName(value: string | undefined): value is CliCommandName {
  return value !== undefined && (cliCommandNames as readonly string[]).includes(value);
}
