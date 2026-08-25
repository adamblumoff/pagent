# Pagent

Pagent turns an application event in the cloud into a read-only Codex investigation on an allowlisted local repository.

The application does not host a daemon, accept inbound connections, know a machine path, or install Codex. It sends one bounded HTTPS event to Pagent Relay. A local connector holds one outbound SSE connection to the relay and hands eligible tasks to the Codex already installed on that machine.

## Architecture

| Component | Owns | Does not own |
| --- | --- | --- |
| Application SDK | Observation, explicit event context, 64 KiB envelope limit, short POST timeout | Prompts, repository paths, Codex, SSE |
| Pagent Relay | Source and connector auth, environment policy, deduplication, cooldowns, repository routing, read-only prompt construction, Postgres persistence, SSE replay | Local paths, repository contents, Codex credentials, execution results |
| Local connector | Final environment/repository allowlists, repository-key mapping, durable local inbox, Codex execution | Inbound ports, cloud status updates |

The data path is intentionally one-way:

```text
cloud application -- HTTPS POST --> Pagent Relay -- SSE --> local connector -- stdio --> codex app-server
```

There is no polling, WebSocket, execution acknowledgement, or cloud-side repository clone. The relay persists before delivery, sends heartbeats, and replays after the connector's locally stored `Last-Event-ID`.

## SDK usage

```ts
import { createPagent, defineEvent } from "pagent";

const healthFailed = defineEvent<{
  errorRate: number;
  sampleSize: number;
  region: string;
}>({
  name: "health.failed",
  enabledIn: ["staging", "production"],
  investigation: {
    cooldownMs: 30 * 60_000,
  },
});

const pagent = createPagent({
  enabled: process.env.PAGENT_ENABLED === "true",
  environment: process.env.PAGENT_ENV,
  relay: {
    url: `${process.env.PAGENT_RELAY_URL}/v1/events`,
    token: process.env.PAGENT_RELAY_TOKEN!,
  },
  onDeliveryError: (error) =>
    console.error("Pagent emission failed", error),
});

const checkHealth = pagent.observe(rawHealthCheck, {
  event: healthFailed,
  on: "result",
  triggerWhen: ({ result }) =>
    result.sampleSize >= 100 && result.errorRate >= 0.05,
  group: ({ result }) => result.region,
  context: ({ result }) => ({
    errorRate: result.errorRate,
    sampleSize: result.sampleSize,
    region: result.region,
  }),
});
```

Pagent does not wrap every endpoint or decide that every HTTP 500 deserves an
investigation. The developer chooses the function, outcome, and
`triggerWhen` condition. A qualifying observation becomes one relay event;
relay cooldown is explicit in the event definition rather than silently
imposed by the SDK.

`context` is the application's explicit data boundary: include the diagnostic fields the agent needs and leave secrets out. `group` optionally creates independent cooldown scopes such as regions or tenants. Pagent does nothing unless `enabled` is exactly `true` and an environment is present. Delivery runs in the background, times out after two seconds by default, and cannot change the observed function's return value or thrown error. Call `await pagent.flush()` during graceful shutdown when the process must wait for pending deliveries.

`onDeliveryError` receives a typed error with a stable `code`, a `retryable`
flag, and an HTTP `statusCode` when the relay returned one. The callback is for
application logging and metrics; throwing from it never changes application
behavior.

The SDK POST contract is:

```json
{
  "version": 1,
  "event": {
    "id": "uuid",
    "type": "health.failed",
    "environment": "staging",
    "occurredAt": "2026-08-24T12:00:00.000Z",
    "investigation": {
      "cooldownMs": 1800000,
      "group": "us-central"
    },
    "payload": {}
  }
}
```

## Relay

`relay/` is a standalone Railway service. It uses Postgres for event idempotency, cooldown decisions, durable task sequence IDs, and SSE replay. A source token determines the repository key and connector route; the application cannot choose a local destination.

For one demo source and connector, copy `relay/.env.example` and configure:

```bash
DATABASE_URL=postgresql://...
PAGENT_SOURCE_TOKEN=...
PAGENT_CONNECTOR_TOKEN=...
PAGENT_REPOSITORY_KEY=pagent-demo
PAGENT_CONNECTOR_ID=demo-laptop
PAGENT_ALLOWED_ENVIRONMENTS=staging
```

Then run:

```bash
npm --prefix relay install
npm --prefix relay run dev
```

For multiple routes, use `PAGENT_SOURCES_JSON` and `PAGENT_CONNECTORS_JSON`, as documented in `relay/.env.example`.

## Local connector

Connector and Codex APIs live under the local-only `pagent/connector` entry
point. They are not part of the cloud application's import surface:

```ts
import {
  codexAgent,
  createRelayConnector,
  defineConnectorConfig,
} from "pagent/connector";
```

The connector requires the repository and the existing Codex CLI on the same machine:

```bash
PAGENT_RELAY_URL=http://localhost:3000 \
PAGENT_CONNECTOR_TOKEN=... \
PAGENT_CONNECTOR_ID=demo-laptop \
PAGENT_REPOSITORY_KEY=pagent-demo \
PAGENT_REPOSITORY_PATH="$PWD" \
PAGENT_ALLOWED_ENVIRONMENTS=staging \
pnpm connector
```

The inbox defaults to `.pagent/inbox.json`. It is written atomically with mode `0600` before Codex starts. The connector sends no status or result data back to the relay. When a run completes, it prints the local Codex thread ID so a person can continue it in the Codex app.

`pagent.config.ts` defaults connector runs to `read-only`. Set `PAGENT_CODEX_SANDBOX=workspace-write` or `danger-full-access` to opt into broader local permissions. The connector still uses the installed `codex app-server`, its current login, and the rest of the machine's Codex defaults.

## Cloud demo

The demo server performs a simulated failing health check at startup and exposes another trigger at `POST /demo/failure`. Its HTTP response does not wait for Pagent.

```bash
PAGENT_ENABLED=true \
PAGENT_ENV=staging \
PAGENT_RELAY_URL=http://localhost:3000 \
PAGENT_RELAY_TOKEN=... \
pnpm demo
```

For Railway, deploy two separate projects:

1. Deploy `relay/` as the relay project, add Postgres, set the relay variables, and expose its public domain.
2. Deploy the repository root as the demo project and set `PAGENT_ENABLED`, `PAGENT_ENV`, `PAGENT_RELAY_URL`, and `PAGENT_RELAY_TOKEN`.
3. Start the connector locally with the relay's public URL and connector credential.

The demo is successful when one staging failure creates exactly one local, read-only Codex thread in the `pagent-demo` repository.

## Development

```bash
pnpm test
pnpm typecheck
pnpm build
```

Prerequisites are Node.js 22 or newer and pnpm. Only the local connector requires an installed and authenticated `codex` command.

## SDK distribution

Pagent is private and workspace-local while its API is evolving. Applications in
the same workspace depend on it with `"pagent": "workspace:*"`; the SDK is not
published to npm and the repository has no registry or publishing automation.

The package boundary still matters. Cloud applications import only from
`pagent`, while the machine running Codex imports from `pagent/connector`.
Workspace builds must run `pnpm build` before executing compiled consumers.
When an external application needs the SDK, distribute an immutable private
artifact built from this same boundary rather than granting access to the whole
repository. A registry remains deferred until there is demand for one.

## MVP limits

- SDK delivery is best effort until the relay accepts the event; there is no local retry queue in the application process.
- The relay runs as one service replica for the first demo. Postgres is durable, but live SSE fan-out between multiple relay replicas is not implemented yet.
- A task that is interrupted after Codex starts but before local completion may be retried. End-to-end exactly-once execution requires a resumable, persisted Codex thread handoff.
- Relay retention and bounded local completed-ID compaction are follow-up work before long-running production use.
