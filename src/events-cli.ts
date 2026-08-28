import type { CliCommand, EventLifecycleStatus } from "./cli-args.js";
import {
  FileHandoffHistory,
  type HandoffHistoryRecord,
} from "./handoff-history.js";
import { loadConnectorConfig } from "./local-config.js";
import { localStatePaths } from "./local-state.js";

type EventsCommand = Extract<CliCommand, { name: "events" }>;

interface EventView {
  eventId: string;
  type: string;
  environment: string;
  status: EventLifecycleStatus;
  receivedAt: string;
  threadId?: string | undefined;
  threadName?: string | undefined;
  completedAt?: string | undefined;
  errorCode?: string | undefined;
  errorMessage?: string | undefined;
  nextAction?: string | undefined;
}

export async function runEventsCommand(command: EventsCommand): Promise<void> {
  const loaded = await loadConnectorConfig();
  const paths = localStatePaths({ stateDirectory: loaded.config.stateDirectory });
  const history = new FileHandoffHistory(paths.historyPath);

  if (command.action === "show") {
    const record = await history.findByEventId(command.eventId);
    if (record === undefined) {
      throw new Error(
        `Pagent event ${command.eventId} was not found in local history. Check the event ID, then run \`pagent events\`.`,
      );
    }
    const event = eventView(record);
    if (command.json) console.log(JSON.stringify(event, null, 2));
    else printEvent(event);
    return;
  }

  const events = (await history.list())
    .map(eventView)
    .filter((event) =>
      command.status === undefined ? true : event.status === command.status,
    )
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
    .slice(0, command.limit);

  if (command.json) console.log(JSON.stringify({ events }, null, 2));
  else printEvents(events);
}

function eventView(record: HandoffHistoryRecord): EventView {
  const view: EventView = {
    eventId: record.eventId,
    type: record.eventType,
    environment: record.environment,
    status: record.status,
    receivedAt: record.receivedAt,
    ...(record.threadId === undefined ? {} : { threadId: record.threadId }),
    ...(record.threadName === undefined ? {} : { threadName: record.threadName }),
    ...(record.completedAt === undefined ? {} : { completedAt: record.completedAt }),
    ...(record.errorCode === undefined ? {} : { errorCode: record.errorCode }),
    ...(record.errorMessage === undefined ? {} : { errorMessage: record.errorMessage }),
  };
  const nextAction = remediation(view);
  return nextAction === undefined ? view : { ...view, nextAction };
}

function remediation(event: EventView): string | undefined {
  if (event.status !== "failed") return undefined;
  switch (event.errorCode) {
    case "policy_rejected":
      return "Check the repository and environment settings, then send a new event.";
    case "context_unavailable":
      return "Run `pagent doctor` to check the local keyring, then send a new event.";
    case "codex_failed":
      return "Open Codex, run `pagent doctor`, then send a new event.";
    default:
      return "Run `pagent doctor`, then inspect `pagent logs`.";
  }
}

function printEvents(events: readonly EventView[]): void {
  if (events.length === 0) {
    console.log("No matching Pagent events.");
    return;
  }
  console.log(
    `${"TIME".padEnd(9)}${"EVENT".padEnd(30)}${"STATUS".padEnd(18)}THREAD`,
  );
  for (const event of events) {
    console.log(
      `${relativeTime(event.receivedAt).padEnd(9)}` +
        `${truncate(event.type, 28).padEnd(30)}` +
        `${event.status.padEnd(18)}${event.threadId ?? "-"}`,
    );
  }
}

function printEvent(event: EventView): void {
  console.log(`Event: ${event.eventId}`);
  console.log(`Type: ${event.type}`);
  console.log(`Environment: ${event.environment}`);
  console.log(`Status: ${event.status}`);
  console.log(`Received locally: ${event.receivedAt}`);
  if (event.threadId !== undefined) console.log(`Codex thread: ${event.threadId}`);
  if (event.threadName !== undefined) console.log(`Thread name: ${event.threadName}`);
  if (event.errorMessage !== undefined) console.log(`Last error: ${event.errorMessage}`);
  else if (event.errorCode !== undefined) console.log(`Last error code: ${event.errorCode}`);
  console.log("Context: encrypted and not shown");
  if (event.nextAction !== undefined) console.log(`Next action: ${event.nextAction}`);
}

function relativeTime(value: string): string {
  const milliseconds = Math.max(0, Date.now() - new Date(value).valueOf());
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 3)}...`;
}
