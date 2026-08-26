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
