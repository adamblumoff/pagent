# Pagent

Pagent starts coding-agent work when application code observes a configured event. The observed function keeps its normal return value or error. Agent work runs in the background.

The first build supports:

- Sync and async function observation
- Per-event environment allowlists
- A global kill switch
- Event cooldowns
- Persistent Codex threads through `@openai/codex-sdk`
- Read-only diagnosis by default

## Configuration

`pagent.config.ts` is the root configuration file. The demo imports it directly, so there is no configuration loader or CLI process.

```ts
import { defineConfig } from "pagent";

export default defineConfig({
  enabled: process.env.PAGENT_ENABLED === "true",
  environment: process.env.PAGENT_ENV,
  cwd: process.cwd(),
  codex: {
    sandboxMode: "read-only",
    approvalPolicy: "never",
  },
});
```

`sandboxMode` accepts `read-only`, `workspace-write`, or `danger-full-access`. Keep `read-only` for automatic diagnosis. Choosing either write mode allows the automatic run to change files.

## Example

```ts
import { codexAgent, createPagent, defineEvent } from "pagent";
import config from "./pagent.config.js";

const healthFailed = defineEvent<{ status: string; reason: string }>({
  name: "health.failed",
  enabledIn: ["staging", "production"],
  cooldownMs: 60_000,
  prompt: (event) => `Investigate this health failure: ${event.payload.reason}`,
});

const { codex, ...runtimeConfig } = config;
const pagent = createPagent({
  ...runtimeConfig,
  agent: codexAgent(codex),
});

const checkHealth = pagent.observe(rawHealthCheck, {
  event: healthFailed,
  when: ({ result }) => result.status === "unhealthy",
  context: ({ result }) => result,
});
```

Pagent does nothing unless `enabled` is exactly `true` and the current environment appears in `enabledIn`. A missing environment fails closed. Failures inside predicates, prompt construction, or the agent go to `onError` and do not affect the observed function.

## Human handoff

Each completed run returns a persistent `threadId`. Codex stores the thread under `~/.codex/sessions`. An App Server client using the same `CODEX_HOME` can inspect it with `thread/read` or load it with `thread/resume`.

After resuming, the person can start another turn with a different `sandboxPolicy`. For example, a client can change a diagnostic thread to `workspaceWrite` before asking Codex to implement a fix. App Server applies turn-level sandbox overrides to that turn and later turns in the same thread.

This local handoff is ready for the MVP. A hosted handoff needs a persistent App Server and shared thread storage. App Server's remote WebSocket transport is currently experimental, so it should not be the production transport yet.

## Demo

The demo service checks a simulated latency value every five seconds. The default 750 ms latency exceeds its 500 ms threshold.

Run it locally. The health check reports unhealthy, but Pagent does not start an agent:

```bash
PAGENT_ENABLED=true PAGENT_ENV=local pnpm demo
```

Run the same service as staging. The first unhealthy result starts a Codex thread, and the cooldown suppresses repeated runs:

```bash
PAGENT_ENABLED=true PAGENT_ENV=staging pnpm demo
```

The Codex adapter uses the local Codex login by default. It starts a persistent read-only thread with no interactive approval prompts and prints the thread ID for handoff.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```
