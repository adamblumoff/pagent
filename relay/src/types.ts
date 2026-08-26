export interface EncryptedContext {
  algorithm: "A256GCM";
  keyId: string;
  iv: string;
  ciphertext: string;
}

export interface EventEnvelope {
  version: 2;
  event: {
    id: string;
    type: string;
    environment: string;
    occurredAt: string;
    investigation: {
      cooldownMs: number;
      group?: string | undefined;
    };
    context: EncryptedContext;
  };
}

export interface SourceAuthorization {
  repositoryKey: string;
  connectorId: string;
  allowedEnvironments: readonly string[];
}

export interface SourceRoute extends SourceAuthorization {
  token: string;
}

export interface ConnectorCredential {
  id: string;
  token: string;
}

export interface RelayConfig {
  port: number;
  heartbeatMs: number;
  acknowledgedContextRetentionMs: number;
  sources: readonly SourceRoute[];
  connectors: readonly ConnectorCredential[];
  adminToken?: string;
}

export interface EnqueueInput {
  source: SourceAuthorization;
  event: EventEnvelope["event"];
}

export interface EnrollmentInput {
  connectorId: string;
  repositoryKey: string;
  allowedEnvironments: readonly string[];
  sourceTokenHash: string;
  connectorTokenHash: string;
  replace: boolean;
}

export interface EnrollmentResult {
  status: "enrolled" | "rotated" | "existing" | "conflict" | "invalid-code";
}

export interface EnrollmentAttempt {
  codeHash: string;
  requestHash: string;
  enrollment: EnrollmentInput;
}

export interface EnrollmentCodeInput {
  codeHash: string;
  expiresAt: string;
  connectorId?: string | undefined;
}

export interface RelayTask {
  id: string;
  eventId: string;
  type: string;
  environment: string;
  occurredAt: string;
  investigation: EventEnvelope["event"]["investigation"];
  repositoryKey: string;
  context: EncryptedContext;
}

export const relayTaskErrorCodes = [
  "policy_rejected",
  "context_unavailable",
  "codex_failed",
  "connector_stopped",
  "unknown",
] as const;

export type RelayTaskErrorCode = (typeof relayTaskErrorCodes)[number];
export type RelayTaskProgressStatus = "received" | "started" | "retrying";

export interface RelayTaskProgress {
  status: RelayTaskProgressStatus;
  errorCode?: RelayTaskErrorCode | undefined;
}

export type RelayEventStatus =
  | "suppressed"
  | "queued"
  | "received"
  | "running"
  | "retrying"
  | "completed";

export interface RelayEventSummary {
  eventId: string;
  type: string;
  environment: string;
  occurredAt: string;
  receivedAt: string;
  status: RelayEventStatus;
  attemptCount: number;
  taskId?: string | undefined;
  receivedLocallyAt?: string | undefined;
  startedAt?: string | undefined;
  lastAttemptAt?: string | undefined;
  lastErrorCode?: RelayTaskErrorCode | undefined;
  completedAt?: string | undefined;
}

export interface RelayEventCursor {
  receivedAt: string;
  eventId: string;
}

export interface RelayEventHistoryRecord {
  event: RelayEventSummary;
  cursor: RelayEventCursor;
}

export type EnqueueResult =
  | { status: "queued"; task: RelayTask }
  | { status: "duplicate"; task?: RelayTask }
  | { status: "cooldown" }
  | { status: "retired-key" };

export interface RelayStore {
  initialize(): Promise<void>;
  createEnrollmentCode(input: EnrollmentCodeInput): Promise<void>;
  enroll(input: EnrollmentAttempt): Promise<EnrollmentResult>;
  revokeConnector(connectorId: string): Promise<boolean>;
  findSource(sourceTokenHash: string): Promise<SourceAuthorization | undefined>;
  authorizeConnector(
    connectorId: string,
    connectorTokenHash: string,
  ): Promise<boolean>;
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  tasksAfter(
    connectorId: string,
    lastEventId: string,
    limit: number,
  ): Promise<RelayTask[]>;
  eventsBefore(
    connectorId: string,
    cursor: RelayEventCursor | undefined,
    limit: number,
  ): Promise<RelayEventHistoryRecord[]>;
  findEvent(
    connectorId: string,
    eventId: string,
  ): Promise<RelayEventSummary | undefined>;
  updateTaskProgress(
    connectorId: string,
    taskId: string,
    progress: RelayTaskProgress,
  ): Promise<boolean>;
  acknowledgeTask(connectorId: string, taskId: string): Promise<boolean>;
  retireContextKey(connectorId: string, keyId: string): Promise<boolean>;
  purgeAcknowledgedContext(before: string): Promise<number>;
  subscribe(connectorId: string, listener: () => void): () => void;
  subscribeCredentialChanges(
    listener: (connectorId: string) => void,
  ): () => void;
  health(): Promise<void>;
  close(): Promise<void>;
}
