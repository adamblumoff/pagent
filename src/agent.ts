import type { PagentEvent } from "./types.js";

export interface AgentRequest<TPayload = unknown> {
  cwd: string;
  prompt: string;
  threadName: string;
  event: PagentEvent<TPayload>;
  onThreadStarted(thread: {
    threadId: string;
    threadName: string;
  }): void | Promise<void>;
  signal?: AbortSignal | undefined;
}

export interface AgentAdapter {
  run(request: AgentRequest): Promise<void>;
}
