const DEFAULT_SLACK_NOTIFICATION_TIMEOUT_MS = 2_000;
const MAX_SLACK_NOTIFICATION_TIMEOUT_MS = 30_000;
const MAX_METADATA_LENGTH = 300;

export interface SlackNotificationConfig {
  webhookUrl: string;
  timeoutMs?: number | undefined;
}

export interface ThreadStartedNotification {
  eventId: string;
  eventType: string;
  environment: string;
  eventOccurredAt: string;
  repositoryKey: string;
  threadId: string;
  threadName: string;
  startedAt: string;
}

export interface SlackWebhookTransportRequest {
  method: "POST";
  headers: Readonly<Record<string, string>>;
  body: string;
}

export interface SlackWebhookTransportResponse {
  readonly ok: boolean;
  readonly status: number;
}

export type SlackWebhookTransport = (
  url: string,
  request: SlackWebhookTransportRequest,
) => Promise<SlackWebhookTransportResponse>;

export type SlackNotificationErrorCode =
  | "timeout"
  | "webhook_rejected"
  | "network";

export class SlackNotificationError extends Error {
  readonly code: SlackNotificationErrorCode;
  readonly statusCode?: number | undefined;

  constructor(
    code: SlackNotificationErrorCode,
    message: string,
    options: { cause?: unknown; statusCode?: number } = {},
  ) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "SlackNotificationError";
    this.code = code;
    this.statusCode = options.statusCode;
  }
}

export type ThreadStartedNotifier = (
  notification: ThreadStartedNotification,
) => Promise<void>;

export function createSlackThreadStartedNotifier(
  config: SlackNotificationConfig,
  dependencies: { transport?: SlackWebhookTransport } = {},
): ThreadStartedNotifier {
  const issue = slackNotificationConfigIssue(config);
  if (issue !== undefined) throw new Error(issue);

  const webhookUrl = new URL(config.webhookUrl);
  const timeoutMs = config.timeoutMs ?? DEFAULT_SLACK_NOTIFICATION_TIMEOUT_MS;

  return async (notification) => {
    const request: SlackWebhookTransportRequest = {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: threadStartedText(notification) }),
    };
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;

    try {
      const delivery =
        dependencies.transport === undefined
          ? nativeTransport(webhookUrl, request, controller.signal)
          : dependencies.transport(webhookUrl.toString(), request);
      const response = await Promise.race([
        delivery,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(timeoutError(timeoutMs));
          }, timeoutMs);
        }),
      ]);

      if (!response.ok) {
        throw new SlackNotificationError(
          "webhook_rejected",
          `Slack webhook rejected the notification with HTTP ${response.status}.`,
          { statusCode: response.status },
        );
      }
    } catch (error) {
      if (timedOut) throw timeoutError(timeoutMs);
      if (error instanceof SlackNotificationError) throw error;
      throw new SlackNotificationError(
        "network",
        "Pagent could not reach the Slack webhook.",
        { cause: error },
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  };
}

export function slackNotificationConfigIssue(
  value: unknown,
): string | undefined {
  const config = record(value);
  if (config === undefined) {
    return "Slack notification settings must be an object.";
  }
  if (!slackWebhookUrl(config.webhookUrl)) {
    return "Slack webhook URL must use HTTPS, except for an HTTP loopback address, and must not contain credentials or a fragment.";
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isSafeInteger(config.timeoutMs) ||
      (config.timeoutMs as number) < 1 ||
      (config.timeoutMs as number) > MAX_SLACK_NOTIFICATION_TIMEOUT_MS)
  ) {
    return `Slack notification timeout must be an integer from 1 to ${MAX_SLACK_NOTIFICATION_TIMEOUT_MS} milliseconds.`;
  }
  return undefined;
}

function threadStartedText(notification: ThreadStartedNotification): string {
  return [
    "Pagent started a Codex investigation.",
    `Thread: ${slackSafe(notification.threadName)}`,
    `Event: ${slackSafe(notification.eventType)}`,
    `Environment: ${slackSafe(notification.environment)}`,
    `Repository: ${slackSafe(notification.repositoryKey)}`,
    `Thread ID: ${slackSafe(notification.threadId)}`,
    `Event ID: ${slackSafe(notification.eventId)}`,
    `Started: ${slackSafe(notification.startedAt)}`,
    `Event occurred: ${slackSafe(notification.eventOccurredAt)}`,
  ].join("\n");
}

function slackSafe(value: string): string {
  const normalized = value.replace(/\s+/gu, " ").trim();
  const bounded =
    normalized.length <= MAX_METADATA_LENGTH
      ? normalized
      : `${normalized.slice(0, MAX_METADATA_LENGTH - 3)}...`;
  return bounded
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function slackWebhookUrl(value: unknown): value is string {
  if (typeof value !== "string" || value !== value.trim()) return false;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]" ||
      url.hostname === "localhost";
    return (
      (url.protocol === "https:" || (url.protocol === "http:" && loopback)) &&
      url.username === "" &&
      url.password === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

async function nativeTransport(
  url: URL,
  request: SlackWebhookTransportRequest,
  signal: AbortSignal,
): Promise<SlackWebhookTransportResponse> {
  return globalThis.fetch(url, { ...request, signal });
}

function timeoutError(timeoutMs: number): SlackNotificationError {
  return new SlackNotificationError(
    "timeout",
    `Slack notification timed out after ${timeoutMs}ms.`,
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
