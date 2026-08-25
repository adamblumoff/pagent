export const cliCommandNames = [
  "start",
  "stop",
  "status",
  "logs",
  "doctor",
  "help",
  "version",
] as const;

export type CliCommandName = (typeof cliCommandNames)[number];

export type CliCommand =
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
  start: `Usage: pagent start [options]

Start the local connector in the background.

Options:
  --foreground   Run in the current terminal
  --skip-doctor  Skip advisory doctor checks
  -h, --help     Show help for start`,
  stop: `Usage: pagent stop

Stop the local connector gracefully.

Options:
  -h, --help  Show help for stop`,
  status: `Usage: pagent status [options]

Show connector state and relay connectivity.

Options:
  --json      Print machine-readable JSON
  -h, --help  Show help for status`,
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

Run and inspect the local Pagent connector.

Commands:
  start    Start the connector (background by default)
  stop     Stop the connector gracefully
  status   Show connector state
  logs     Read connector logs
  doctor   Check the local setup without changing it
  help     Show help for a command
  version  Print the installed version

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
    case "start":
      return parseStart(rest);
    case "stop":
      requireNoCommandArgs(first, rest);
      return { name: "stop" };
    case "status":
      return { name: "status", json: parseBooleanFlag(first, rest, "--json") };
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
