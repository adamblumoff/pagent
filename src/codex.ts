import {
  Codex,
  type ApprovalMode,
  type SandboxMode,
} from "@openai/codex-sdk";

import type { AgentAdapter, AgentResult } from "./types.js";

export interface CodexAgentOptions {
  apiKey?: string;
  approvalPolicy?: ApprovalMode;
  sandboxMode?: SandboxMode;
}

export function codexAgent(options: CodexAgentOptions = {}): AgentAdapter {
  const codex = new Codex(
    options.apiKey === undefined ? undefined : { apiKey: options.apiKey },
  );

  return {
    async run(request): Promise<AgentResult> {
      const thread = codex.startThread({
        approvalPolicy: options.approvalPolicy ?? "never",
        sandboxMode: options.sandboxMode ?? "read-only",
        workingDirectory: request.cwd,
      });
      const result = await thread.run(request.prompt);

      return thread.id === null
        ? { finalResponse: result.finalResponse }
        : {
            threadId: thread.id,
            finalResponse: result.finalResponse,
          };
    },
  };
}
