# Pagent

Pagent starts coding-agent work when application code observes a configured event. The observed function keeps its normal return value or error. Agent work runs in the background.

The first build supports:

- Sync and async function observation
- Per-event environment allowlists
- A global kill switch
- Event cooldowns
- Local Codex threads through `@openai/codex-sdk`

## Example

```ts
import { codexAgent, createPagent, defineEvent } from "pagent";

const healthFailed = defineEvent<{ status: string; reason: string }>({
  name: "health.failed",
  enabledIn: ["staging", "production"],
  cooldownMs: 60_000,
  prompt: (event) => `Investigate this health failure: ${event.payload.reason}`,
});

const pagent = createPagent({
  enabled: process.env.PAGENT_ENABLED === "true",
  environment: process.env.PAGENT_ENV,
  agent: codexAgent(),
});

const checkHealth = pagent.observe(rawHealthCheck, {
  event: healthFailed,
  when: ({ result }) => result.status === "unhealthy",
  context: ({ result }) => result,
});
```

Pagent does nothing unless `enabled` is exactly `true` and the current environment appears in `enabledIn`. A missing environment fails closed. Failures inside predicates, prompt construction, or the agent go to `onError` and do not affect the observed function.

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

The Codex adapter uses the local Codex login by default. It starts the thread with workspace write access and no interactive approval prompts.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```
