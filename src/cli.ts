#!/usr/bin/env node

import { fileURLToPath } from "node:url";

import {
  CliUsageError,
  parseCliArgs,
  renderCliHelp,
  type CliCommand,
} from "./cli-args.js";
import { runEventsCommand } from "./events-cli.js";
import { runProjectInit } from "./init.js";
import {
  invalidateConnectorConfigCache,
  loadConnectorConfig,
  type LoadedConnectorConfig,
} from "./local-config.js";
import {
  isDaemonInvocation,
  isInteractive,
  question,
  runDaemonMain,
  runDoctorCommand,
  runLogsCommand,
  runStartCommand,
  runStatusCommand,
  runStopCommand,
  runTunnelCommand,
  safeCliErrorMessage,
  stopConnectorForRotation,
} from "./runtime-cli.js";
import { TunnelProvisioningClient } from "./tunnel-provisioning.js";
import { PAGENT_VERSION } from "./version.js";

const CLI_PATH = fileURLToPath(import.meta.url);

async function main(): Promise<void> {
  if (isDaemonInvocation()) {
    await runDaemonMain();
    return;
  }

  let command: CliCommand;
  try {
    command = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof CliUsageError) {
      console.error(error.message);
      console.error("Run `pagent --help` for usage.");
      process.exitCode = error.exitCode;
      return;
    }
    throw error;
  }

  switch (command.name) {
    case "help":
      console.log(renderCliHelp(command.command));
      return;
    case "version":
      console.log(PAGENT_VERSION);
      return;
    case "init":
      await initCommand(command);
      return;
    case "enrollment":
      await enrollmentCommand(command);
      return;
    case "tunnel":
      await runTunnelCommand(command, CLI_PATH);
      return;
    case "doctor":
      await runDoctorCommand(command.json);
      return;
    case "start":
      await runStartCommand(command.foreground, command.skipDoctor, CLI_PATH);
      return;
    case "stop":
      await runStopCommand();
      return;
    case "status":
      await runStatusCommand(command.json);
      return;
    case "events":
      await runEventsCommand(command);
      return;
    case "logs":
      await runLogsCommand(command.lines, command.follow);
      return;
  }
}

async function enrollmentCommand(
  command: Extract<CliCommand, { name: "enrollment" }>,
): Promise<void> {
  const interactive = isInteractive();
  const provisionerUrl = await cliValue({
    value: command.provisioner ?? process.env.PAGENT_PROVISIONER_URL,
    interactive,
    prompt: "Provisioning service URL: ",
    missing:
      "Provisioning service URL is required. Pass `--provisioner <url>` or set PAGENT_PROVISIONER_URL.",
  });
  const adminToken = await cliValue({
    value: command.adminToken ?? process.env.PAGENT_PROVISIONER_ADMIN_TOKEN,
    interactive,
    prompt: "Provisioner admin token: ",
    hidden: true,
    missing:
      "Provisioner admin token is required. Set PAGENT_PROVISIONER_ADMIN_TOKEN or pass `--admin-token <token>`.",
  });
  const enrollment = await new TunnelProvisioningClient({
    serviceUrl: provisionerUrl,
  }).createEnrollmentToken({
    adminToken,
    expiresInSeconds: command.ttlMinutes * 60,
  });
  console.log(enrollment.token);
  console.error(`Enrollment token expires at ${enrollment.expiresAt}.`);
}

async function initCommand(
  command: Extract<CliCommand, { name: "init" }>,
): Promise<void> {
  const interactive = isInteractive();
  const provisionerUrl = await cliValue({
    value: command.provisioner ?? process.env.PAGENT_PROVISIONER_URL,
    interactive,
    prompt: "Provisioning service URL: ",
    missing:
      "Provisioning service URL is required. Pass `--provisioner <url>` or set PAGENT_PROVISIONER_URL.",
  });
  const enrollmentToken = command.reset
    ? "unused-during-reset"
    : await cliValue({
        value: command.enrollment ?? process.env.PAGENT_ENROLLMENT_TOKEN,
        interactive,
        prompt: "Enrollment token: ",
        hidden: true,
        missing:
          "Enrollment token is required. Pass `--enrollment <token>` or set PAGENT_ENROLLMENT_TOKEN.",
      });

  if (!command.yes) {
    if (!interactive) {
      throw new Error(
        "Pagent init needs confirmation in a non-interactive shell. Review the options, then add `--yes`.",
      );
    }
    const action = command.reset
      ? "Rotate this tunnel and its credentials now"
      : `Provision this repository for ${command.environments.join(", ")} and ${
          command.noStart ? "leave Pagent stopped" : "start Pagent"
        }`;
    const answer = await question(`${action}? [y/N] `);
    if (answer.toLowerCase() !== "y" && answer.toLowerCase() !== "yes") {
      console.log("Pagent init cancelled.");
      return;
    }
  }

  console.log("Checking Git, Codex, and tunnel provisioning.");
  let managementToken = process.env.PAGENT_MANAGEMENT_TOKEN;
  let existing: LoadedConnectorConfig | undefined;
  if (command.reset) {
    try {
      existing = await loadConnectorConfig();
      managementToken = process.env.PAGENT_MANAGEMENT_TOKEN;
    } catch {
      throw new Error(
        "Pagent could not read the existing tunnel identity. Repair the config or revoke the tunnel before resetting it.",
      );
    }
    await stopConnectorForRotation();
  }
  const initialized = await runProjectInit({
    provisionerUrl,
    enrollmentToken,
    environments: command.environments,
    reset: command.reset,
    environmentId: existing?.config.tunnel.environmentId,
    originPort: existing?.config.ingress.port,
    managementToken,
  });
  process.chdir(initialized.projectDirectory);

  if (command.reset) {
    delete process.env.PAGENT_SOURCE_TOKEN;
    delete process.env.PAGENT_MANAGEMENT_TOKEN;
    delete process.env.PAGENT_CONTEXT_KEYS;
    invalidateConnectorConfigCache();
  }

  console.log(`\nPagent initialized for ${initialized.repositoryKey}.`);
  console.log(`Tunnel hostname: ${initialized.eventOrigin}`);
  console.log(`Local config: ${initialized.configPath}`);
  console.log(`Application environment: ${initialized.cloudEnvironmentPath}`);
  if (command.reset) {
    console.log(
      "Application credentials changed. Update the deployment from cloud.env before sending more events.",
    );
  }

  if (command.noStart) {
    await runDoctorCommand(false);
    if (process.exitCode === undefined) {
      console.log("\nPagent is stopped. Run `pagent start` when you are ready.");
    }
    return;
  }
  await runStartCommand(false, false, CLI_PATH);
}

async function cliValue(options: {
  value: string | undefined;
  interactive: boolean;
  prompt: string;
  missing: string;
  hidden?: boolean;
}): Promise<string> {
  const value = options.value?.trim();
  if (value) return value;
  if (!options.interactive) throw new Error(options.missing);
  const answer = (await question(options.prompt, options.hidden === true)).trim();
  if (!answer) throw new Error(options.missing);
  return answer;
}

main().catch((error: unknown) => {
  console.error(safeCliErrorMessage(error));
  process.exitCode = 1;
});
