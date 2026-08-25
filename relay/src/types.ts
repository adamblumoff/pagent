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

export interface SourceRoute {
  token: string;
  repositoryKey: string;
  connectorId: string;
  allowedEnvironments: readonly string[];
}

export interface ConnectorCredential {
  id: string;
  token: string;
}

export interface RelayConfig {
  port: number;
  heartbeatMs: number;
  sources: readonly SourceRoute[];
  connectors: readonly ConnectorCredential[];
}

export interface EnqueueInput {
  source: SourceRoute;
  event: EventEnvelope["event"];
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
  | { status: "cooldown" };

export interface RelayStore {
  initialize(): Promise<void>;
  enqueue(input: EnqueueInput): Promise<EnqueueResult>;
  tasksAfter(
    connectorId: string,
    lastEventId: string,
    limit: number,
  ): Promise<RelayTask[]>;
  subscribe(connectorId: string, listener: () => void): () => void;
  health(): Promise<void>;
  close(): Promise<void>;
}
