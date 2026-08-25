export interface EventEnvelope {
  version: 1;
  event: {
    id: string;
    type: string;
    environment: string;
    occurredAt: string;
    payload: unknown;
  };
}

export interface SourceRoute {
  token: string;
  repositoryKey: string;
  connectorId: string;
  allowedEnvironments: readonly string[];
  cooldownMs: number;
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
  prompt: string;
}

export interface RelayTask {
  id: string;
  type: string;
  environment: string;
  occurredAt: string;
  repositoryKey: string;
  prompt: string;
  payload: unknown;
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
