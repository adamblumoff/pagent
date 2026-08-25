import type { PagentEvent } from "./types.js";

export interface AgentRequest<TPayload = unknown> {
  cwd: string;
  prompt: string;
  event: PagentEvent<TPayload>;
  signal?: AbortSignal | undefined;
}

export interface AgentResult {
  threadId?: string;
}

export interface AgentAdapter {
  run(request: AgentRequest): Promise<AgentResult>;
}
