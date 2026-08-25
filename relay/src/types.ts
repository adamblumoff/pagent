export interface EventEnvelope {
  version: 1;
  event: {
    id: string;
    type: string;
    environment: string;
    occurredAt: string;
    investigation: {
      cooldownMs: number;
      group?: string | undefined;
    };
    payload: unknown;
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
  prompt: string;
}

export interface RelayTask {
  id: string;
  type: string;
  environment: string;
  occurredAt: string;
  investigation: EventEnvelope["event"]["investigation"];
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
