import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type StartupPlatform = "linux" | "darwin" | "win32";
type StartupManager = "systemd" | "launchd" | "task-scheduler";

export interface StartupServiceOptions {
  projectDirectory: string;
  stateDirectory: string;
  logPath: string;
  executablePath: string;
  cliPath: string;
  platform?: NodeJS.Platform | undefined;
  homeDirectory?: string | undefined;
  environment?: NodeJS.ProcessEnv | undefined;
  userId?: number | undefined;
  startImmediately?: boolean | undefined;
}

export interface StartupServiceRegistration {
  manager: StartupManager;
  name: string;
  path: string;
}

export interface StartupServiceDependencies {
  run?: ((command: string, args: readonly string[]) => Promise<void>) | undefined;
}

interface StartupDefinition extends StartupServiceRegistration {
  contents: string;
  installCommands: readonly Command[];
  removeCommands: readonly Command[];
}

interface Command {
  command: string;
  args: readonly string[];
  ignoreFailure?: boolean | undefined;
}

export async function installStartupService(
  options: StartupServiceOptions,
  dependencies: StartupServiceDependencies = {},
): Promise<StartupServiceRegistration | undefined> {
  const definition = startupDefinition(options);
  if (definition === undefined) return undefined;

  await mkdir(dirname(definition.path), { recursive: true, mode: 0o700 });
  await writeFile(definition.path, definition.contents, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(definition.path, 0o600);

  const run = dependencies.run ?? runCommand;
  for (const command of definition.installCommands) {
    try {
      await run(command.command, command.args);
    } catch (error) {
      if (command.ignoreFailure !== true) throw error;
    }
  }
  return registration(definition);
}

export async function removeStartupService(
  options: StartupServiceOptions,
  dependencies: StartupServiceDependencies = {},
): Promise<void> {
  const definition = startupDefinition(options);
  if (definition === undefined) return;

  const run = dependencies.run ?? runCommand;
  for (const command of definition.removeCommands) {
    try {
      await run(command.command, command.args);
    } catch (error) {
      if (command.ignoreFailure !== true) throw error;
    }
  }
  await rm(definition.path, { force: true });
  if (definition.manager === "systemd") {
    await run("systemctl", ["--user", "daemon-reload"]);
  }
}

export function startupDefinition(
  options: StartupServiceOptions,
): StartupDefinition | undefined {
  const platform = supportedPlatform(options.platform ?? process.platform);
  if (platform === undefined) return undefined;

  const projectDirectory = resolve(options.projectDirectory);
  const stateDirectory = resolve(options.stateDirectory);
  const logPath = resolve(options.logPath);
  const executablePath = resolve(options.executablePath);
  const cliPath = resolve(options.cliPath);
  const homeDirectory = resolve(options.homeDirectory ?? homedir());
  const environment = options.environment ?? process.env;
  const path = environment.PATH ?? environment.Path ?? dirname(executablePath);
  const startImmediately = options.startImmediately !== false;
  const id = createHash("sha256")
    .update(projectDirectory)
    .digest("hex")
    .slice(0, 16);

  if (platform === "linux") {
    const name = `pagent-${id}.service`;
    const servicePath = join(
      environment.XDG_CONFIG_HOME ?? join(homeDirectory, ".config"),
      "systemd",
      "user",
      name,
    );
    return {
      manager: "systemd",
      name,
      path: servicePath,
      contents: systemdUnit({
        projectDirectory,
        logPath,
        executablePath,
        cliPath,
        path,
      }),
      installCommands: [
        { command: "systemctl", args: ["--user", "daemon-reload"] },
        { command: "systemctl", args: ["--user", "enable", name] },
        ...(startImmediately
          ? [{
              command: "systemctl",
              args: ["--user", "start", name],
              ignoreFailure: true,
            }]
          : []),
      ],
      removeCommands: [
        {
          command: "systemctl",
          args: ["--user", "disable", "--now", name],
          ignoreFailure: true,
        },
        {
          command: "systemctl",
          args: ["--user", "reset-failed", name],
          ignoreFailure: true,
        },
      ],
    };
  }

  if (platform === "darwin") {
    const name = `dev.pagent.${id}`;
    const servicePath = join(homeDirectory, "Library", "LaunchAgents", `${name}.plist`);
    return {
      manager: "launchd",
      name,
      path: servicePath,
      contents: launchAgent({
        name,
        projectDirectory,
        logPath,
        executablePath,
        cliPath,
        path,
      }),
      installCommands: !startImmediately || options.userId === undefined
        ? []
        : [
            {
              command: "launchctl",
              args: ["bootout", `gui/${options.userId}/${name}`],
              ignoreFailure: true,
            },
            {
              command: "launchctl",
              args: ["bootstrap", `gui/${options.userId}`, servicePath],
            },
          ],
      removeCommands: options.userId === undefined
        ? []
        : [{
            command: "launchctl",
            args: ["bootout", `gui/${options.userId}/${name}`],
            ignoreFailure: true,
          }],
    };
  }

  const name = `Pagent-${id}`;
  const scriptPath = join(stateDirectory, `startup-${id}.cmd`);
  return {
    manager: "task-scheduler",
    name,
    path: scriptPath,
    contents: windowsStartupScript({
      projectDirectory,
      logPath,
      executablePath,
      cliPath,
      path,
    }),
    installCommands: [
      {
        command: "schtasks.exe",
        args: [
          "/Create",
          "/TN",
          name,
          "/TR",
          `"${scriptPath}"`,
          "/SC",
          "ONLOGON",
          "/RL",
          "LIMITED",
          "/IT",
          "/F",
        ],
      },
      ...(startImmediately
        ? [{ command: "schtasks.exe", args: ["/Run", "/TN", name] }]
        : []),
    ],
    removeCommands: [
      {
        command: "schtasks.exe",
        args: ["/End", "/TN", name],
        ignoreFailure: true,
      },
      {
        command: "schtasks.exe",
        args: ["/Delete", "/TN", name, "/F"],
        ignoreFailure: true,
      },
    ],
  };
}

function systemdUnit(input: ServiceCommandInput): string {
  const description = `Pagent for ${basename(input.projectDirectory)}`
    .replace(/[\r\n]/gu, " ");
  const command = [
    input.executablePath,
    input.cliPath,
    "start",
    "--foreground",
    "--skip-doctor",
  ].map(systemdQuote).join(" ");
  return `[Unit]
Description=${description.replace(/%/gu, "%%")}

[Service]
Type=simple
WorkingDirectory=${systemdPath(input.projectDirectory)}
ExecStart=:${command}
Environment=${systemdQuote(`PATH=${input.path}`)}
Restart=on-failure
RestartSec=5s
UMask=0077
StandardOutput=append:${systemdPath(input.logPath)}
StandardError=append:${systemdPath(input.logPath)}

[Install]
WantedBy=default.target
`;
}

function launchAgent(input: ServiceCommandInput & { name: string }): string {
  const argumentsXml = [
    input.executablePath,
    input.cliPath,
    "start",
    "--foreground",
    "--skip-doctor",
  ].map((value) => `      <string>${xmlEscape(value)}</string>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${xmlEscape(input.name)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsXml}
    </array>
    <key>WorkingDirectory</key>
    <string>${xmlEscape(input.projectDirectory)}</string>
    <key>EnvironmentVariables</key>
    <dict>
      <key>PATH</key>
      <string>${xmlEscape(input.path)}</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <dict>
      <key>SuccessfulExit</key>
      <false/>
    </dict>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>${xmlEscape(input.logPath)}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(input.logPath)}</string>
  </dict>
</plist>
`;
}

function windowsStartupScript(input: ServiceCommandInput): string {
  const command = [input.executablePath, input.cliPath]
    .map(windowsBatchQuote)
    .join(" ");
  return `@echo off\r
cd /d ${windowsBatchQuote(input.projectDirectory)}\r
set "PATH=${windowsBatchEnvironmentValue(input.path)}"\r
:run\r
${command} start --foreground --skip-doctor >> ${windowsBatchQuote(input.logPath)} 2>&1\r
if errorlevel 1 (\r
  timeout /t 5 /nobreak >nul\r
  goto run\r
)\r
`;
}

interface ServiceCommandInput {
  projectDirectory: string;
  logPath: string;
  executablePath: string;
  cliPath: string;
  path: string;
}

function systemdQuote(value: string): string {
  rejectControlCharacters(value, "systemd value");
  return `"${value
    .replace(/\\/gu, "\\\\")
    .replace(/"/gu, '\\"')
    .replace(/%/gu, "%%")}"`;
}

function systemdPath(value: string): string {
  rejectControlCharacters(value, "systemd path");
  return value
    .replace(/\\/gu, "\\\\")
    .replace(/ /gu, "\\x20")
    .replace(/%/gu, "%%");
}

function xmlEscape(value: string): string {
  rejectControlCharacters(value, "launchd value");
  return value
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}

function windowsBatchQuote(value: string): string {
  rejectControlCharacters(value, "Windows startup value");
  if (value.includes('"')) {
    throw new Error("Pagent startup paths cannot contain a double quote on Windows.");
  }
  return `"${windowsBatchValue(value)}"`;
}

function windowsBatchValue(value: string): string {
  return value.replace(/%/gu, "%%");
}

function windowsBatchEnvironmentValue(value: string): string {
  rejectControlCharacters(value, "Windows startup environment");
  if (value.includes('"')) {
    throw new Error("Pagent startup PATH cannot contain a double quote on Windows.");
  }
  return windowsBatchValue(value);
}

function rejectControlCharacters(value: string, kind: string): void {
  if (/[\u0000\r\n]/u.test(value)) {
    throw new Error(`Pagent ${kind} cannot contain control characters.`);
  }
}

function supportedPlatform(platform: NodeJS.Platform): StartupPlatform | undefined {
  return platform === "linux" || platform === "darwin" || platform === "win32"
    ? platform
    : undefined;
}

function registration(
  definition: StartupDefinition,
): StartupServiceRegistration {
  return {
    manager: definition.manager,
    name: definition.name,
    path: definition.path,
  };
}

async function runCommand(command: string, args: readonly string[]): Promise<void> {
  await execFileAsync(command, [...args], { windowsHide: true });
}
