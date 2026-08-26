import type {
  CliCommand,
  EventLifecycleStatus,
} from "./cli-args.js";
import {
  FileHandoffHistory,
  type HandoffHistoryRecord,
} from "./handoff-history.js";
import { loadConnectorConfig } from "./local-config.js";
import { localStatePaths } from "./local-state.js";
import {
  getRelayEventHistory,
  listRelayEventHistory,
  type RelayEventErrorCode,
  type RelayEventStatus,
  type RelayEventSummary,
} from "./relay-event-history.js";

type EventsCommand = Extract<CliCommand, { name: "events" }>;

interface EventView {
  eventId: string;
  type: string;
  environment: string;
  status: EventLifecycleStatus;
  attempts: number;
  receivedAt: string;
  occurredAt?: string | undefined;
  taskId?: string | undefined;
  threadId?: string | undefined;
  completedAt?: string | undefined;
  lastErrorCode?: RelayEventErrorCode | string | undefined;
  lastErrorMessage?: string | undefined;
  nextAction?: string | undefined;
}

interface RelayHistoryResult<T> {
  value: T;
  warning?: string | undefined;
}

const MAX_RELAY_EVENTS_SCANNED = 1_000;

export async function runEventsCommand(command: EventsCommand): Promise<void> {
  const loaded = await loadConnectorConfig();
  const paths = localStatePaths({
    stateDirectory: loaded.config.stateDirectory,
  });
  const history = new FileHandoffHistory(paths.historyPath);
  const relay = {
    relayUrl: loaded.config.relay.url,
    connectorId: loaded.config.relay.connectorId,
    token: loaded.config.relay.token,
  };

  if (command.action === "show") {
    const local = await history.findByEventId(command.eventId);
    const relayResult = await bestEffortRelay(
      () => getRelayEventHistory({ ...relay, eventId: command.eventId }),
      undefined,
    );
    const summary = relayResult.value;
    if (summary === undefined && local === undefined) {
      if (relayResult.warning !== undefined) {
        throw new Error(relayResult.warning);
      }
      throw new Error(
        `Pagent event ${command.eventId} was not found in relay or local history. ` +
          "Check the event ID, then run `pagent events`.",
      );
    }
    const event = mergeEvent(summary, local);
    if (command.json) {
      console.log(
        JSON.stringify(
          relayResult.warning === undefined
            ? event
            : { ...event, relayWarning: relayResult.warning },
          null,
          2,
        ),
      );
    } else {
      printEvent(event);
      printRelayWarning(relayResult.warning);
    }
    return;
  }

  const localRecords = await history.list();
  const localByEvent = new Map(
    localRecords.map((record) => [record.eventId, record]),
  );
  const relayResult = await listRelayEvents(relay, command, localByEvent);
  const relayByEvent = new Map(
    relayResult.value.map((summary) => [summary.eventId, summary]),
  );
  const eventIds = new Set([...relayByEvent.keys(), ...localByEvent.keys()]);
  const events = [...eventIds]
    .map((eventId) =>
      mergeEvent(relayByEvent.get(eventId), localByEvent.get(eventId)),
    )
    .filter((event) =>
      command.status === undefined ? true : event.status === command.status,
    )
    .sort(
      (left, right) =>
        Date.parse(right.receivedAt) - Date.parse(left.receivedAt),
    )
    .slice(0, command.limit);

  if (command.json) {
    console.log(
      JSON.stringify(
        {
          events,
          ...(relayResult.warning === undefined
            ? {}
            : { relayWarning: relayResult.warning }),
        },
        null,
        2,
      ),
    );
  } else {
    printEvents(events);
    printRelayWarning(relayResult.warning);
  }
}

async function listRelayEvents(
  relay: { relayUrl: string; connectorId: string; token: string },
  command: Extract<EventsCommand, { action: "list" }>,
  localByEvent: ReadonlyMap<string, HandoffHistoryRecord>,
): Promise<RelayHistoryResult<RelayEventSummary[]>> {
  return bestEffortRelay(async () => {
    const events: RelayEventSummary[] = [];
    let cursor: string | undefined;
    do {
      const remaining = MAX_RELAY_EVENTS_SCANNED - events.length;
      const page = await listRelayEventHistory({
        ...relay,
        limit:
          command.status === undefined
            ? command.limit
            : Math.min(100, remaining),
        ...(cursor === undefined ? {} : { cursor }),
      });
      events.push(...page.events);
      cursor = page.nextCursor;
      if (command.status === undefined) {
        break;
      }
      const matching = events.filter(
        (summary) =>
          mergeEvent(summary, localByEvent.get(summary.eventId)).status ===
          command.status,
      );
      if (matching.length >= command.limit) {
        break;
      }
    } while (cursor !== undefined && events.length < MAX_RELAY_EVENTS_SCANNED);
    return events;
  }, []);
}

async function bestEffortRelay<T>(
  operation: () => Promise<T>,
  fallback: T,
): Promise<RelayHistoryResult<T>> {
  try {
    return { value: await operation() };
  } catch (error) {
    return {
      value: fallback,
      warning:
        error instanceof Error
          ? error.message
          : "Pagent could not read relay event history. " +
            "Run `pagent doctor`, then retry the command.",
    };
  }
}

function mergeEvent(
  relay: RelayEventSummary | undefined,
  local: HandoffHistoryRecord | undefined,
): EventView {
  const attempts = Math.max(relay?.attemptCount ?? 0, local?.attempts ?? 0);
  const source = lifecycleSource(relay, local);
  const status = lifecycleStatus(source.status, attempts);
  const showError = status === "retrying" || status === "needs-attention";
  const lastErrorCode = showError ? source.lastErrorCode : undefined;
  const view: EventView = {
    eventId: relay?.eventId ?? local!.eventId,
    type: relay?.type ?? local!.eventType,
    environment: relay?.environment ?? local!.environment,
    status,
    attempts,
    receivedAt: relay?.receivedAt ?? local!.receivedAt,
    ...(relay?.occurredAt === undefined
      ? {}
      : { occurredAt: relay.occurredAt }),
    ...(relay?.taskId ?? local?.taskId
      ? { taskId: relay?.taskId ?? local?.taskId }
      : {}),
    ...(local?.threadId === undefined ? {} : { threadId: local.threadId }),
    ...(local?.completedAt ?? relay?.completedAt
      ? { completedAt: local?.completedAt ?? relay?.completedAt }
      : {}),
    ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
    ...(!showError || source.lastErrorMessage === undefined
      ? {}
      : { lastErrorMessage: source.lastErrorMessage }),
  };
  const nextAction = remediation(view);
  return nextAction === undefined ? view : { ...view, nextAction };
}

function lifecycleSource(
  relay: RelayEventSummary | undefined,
  local: HandoffHistoryRecord | undefined,
): {
  status: RelayEventStatus | HandoffHistoryRecord["status"];
  lastErrorCode?: string | undefined;
  lastErrorMessage?: string | undefined;
} {
  if (local === undefined) {
    return {
      status: relay?.status ?? "queued",
      ...(relay?.lastErrorCode === undefined
        ? {}
        : { lastErrorCode: relay.lastErrorCode }),
    };
  }
  if (
    relay === undefined ||
    lifecycleTimestamp(local) >= lifecycleTimestamp(relay)
  ) {
    return {
      status: local.status,
      ...(local.lastErrorCode === undefined
        ? {}
        : { lastErrorCode: local.lastErrorCode }),
      ...(local.lastErrorMessage === undefined
        ? {}
        : { lastErrorMessage: local.lastErrorMessage }),
    };
  }
  return {
    status: relay.status,
    ...(relay.lastErrorCode === undefined
      ? {}
      : { lastErrorCode: relay.lastErrorCode }),
  };
}

function lifecycleTimestamp(
  value: RelayEventSummary | HandoffHistoryRecord,
): number {
  if ("eventType" in value) {
    return Date.parse(
      value.completedAt ??
        value.lastAttemptAt ??
        value.startedAt ??
        value.receivedAt,
    );
  }
  return Date.parse(
    value.completedAt ??
      value.lastAttemptAt ??
      value.startedAt ??
      value.receivedLocallyAt ??
      value.receivedAt,
  );
}

function lifecycleStatus(
  status: RelayEventStatus | HandoffHistoryRecord["status"],
  attempts: number,
): EventLifecycleStatus {
  return status === "retrying" && attempts >= 3 ? "needs-attention" : status;
}

function remediation(event: EventView): string | undefined {
  if (event.status !== "retrying" && event.status !== "needs-attention") {
    return undefined;
  }
  switch (event.lastErrorCode) {
    case "connector_stopped":
      return "Run `pagent start`. The connector will retry the pending task.";
    case "policy_rejected":
      return "Check the repository and environment allowlists, then run `pagent start`.";
    case "context_unavailable":
      return "Run `pagent doctor` to check the local keyring, then restart the connector.";
    case "codex_failed":
      return "Open Codex, run `pagent doctor`, then restart the connector if it is stopped.";
    default:
      return "Run `pagent doctor`, then inspect `pagent logs` for the failed attempt.";
  }
}

function printEvents(events: EventView[]): void {
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
  console.log(`Attempts: ${event.attempts}`);
  console.log(`Relay received: ${event.receivedAt}`);
  if (event.threadId !== undefined) {
    console.log(`Codex thread: ${event.threadId}`);
  }
  if (event.lastErrorMessage !== undefined) {
    console.log(`Last error: ${event.lastErrorMessage}`);
  } else if (event.lastErrorCode !== undefined) {
    console.log(`Last error code: ${event.lastErrorCode}`);
  }
  console.log("Context: encrypted and not shown");
  if (event.nextAction !== undefined) {
    console.log(`Next action: ${event.nextAction}`);
  }
}

function printRelayWarning(warning: string | undefined): void {
  if (warning !== undefined) {
    console.error(`Relay history unavailable: ${warning}`);
  }
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
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}
