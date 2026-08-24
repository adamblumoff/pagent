# Pagent

Pagent starts coding-agent work when application code observes a configured event. The observed function keeps its normal return value or error. Agent work runs in the background.

The first build supports:

- Sync and async function observation
- Per-event environment allowlists
- A global kill switch
- Event cooldowns
- Persistent Codex threads through the installed `codex app-server`
- Existing Codex permissions inherited by default

## Configuration

`pagent.config.ts` is the root configuration file. The demo imports it directly, so there is no configuration loader or CLI process.

```ts
import { defineConfig } from "pagent";

export default defineConfig({
  enabled: process.env.PAGENT_ENABLED === "true",
  environment: process.env.PAGENT_ENV,
  cwd: process.cwd(),
  codex: {},
});
```

Pagent launches `codex app-server` from `PATH` and inherits its environment. That means it uses the existing Codex login, `config.toml`, skills, plugins, MCP servers, and `CODEX_HOME`. Pagent does not install or bundle a second Codex executable.

The empty `codex` object inherits Codex's existing permission defaults. To override them for Pagent runs, `sandboxMode` accepts `read-only`, `workspace-write`, or `danger-full-access`, and `approvalPolicy` accepts `untrusted`, `on-request`, or `never`.

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

Each completed run returns a persistent `threadId`. The installed Codex stores the thread in its normal session store, usually `~/.codex/sessions`. Any Codex client using the same `CODEX_HOME` can inspect it with `thread/read` or load it with `thread/resume`.

After resuming, the person can start another turn with a different `sandboxPolicy`. App Server applies turn-level sandbox overrides to that turn and later turns in the same thread.

This local handoff is ready for the MVP. App Server's remote WebSocket transport is currently experimental, so Pagent uses the local stdio transport.

## Prerequisites

- `codex` must already be installed, available on `PATH`, and logged in.
- `cwd` must point to a repository that already exists on the same machine.

Pagent fails with a direct setup error when either prerequisite is missing. It never downloads Codex or a repository on the application's behalf.

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

The Codex adapter uses the installed Codex instance, local login, and existing permission defaults. It prints the persistent thread ID for handoff.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```
