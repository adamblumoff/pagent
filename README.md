# Pagent

Pagent turns selected application failures into proactive Codex investigations. The application decides which results or errors are worth reviewing and sends only the context chosen by the developer.

```text
application -> Cloudflare edge -> named tunnel -> local Pagent -> Codex app server
```

The application SDK observes selected functions and emits qualifying events without changing their return values or errors. It does not read source code or start Codex.

`pagent init` provisions one named Cloudflare Tunnel for the development environment. The local daemon authenticates each source, enforces the repository and environment policy, decrypts the selected context, and applies bounded deduplication and cooldowns.

Pagent hands each accepted event to the Codex installation already on the machine. Codex investigates that checkout in read-only mode and creates a thread that a person can continue in the Codex app.

The local machine opens an outbound-only tunnel. If Pagent or the machine is off, delivery fails and no event waits for replay. Cloudflare sees encrypted event context. Repository contents and Codex results stay local.

## Setup

Deploy the Worker in [`provisioner/`](provisioner/README.md), then mint a short-lived, single-use setup credential:

```sh
PAGENT_PROVISIONER_URL=https://provision.example.com \
PAGENT_PROVISIONER_ADMIN_TOKEN=... \
pagent enrollment create
```

Give the printed credential to the developer running init:

```sh
pagent init \
  --provisioner https://provision.example.com \
  --enrollment pge_...
```

Init checks Git and Codex, installs a pinned checksum-verified `cloudflared` build when needed, provisions the environment, writes owner-only local credentials, and starts Pagent. The generated `.pagent/cloud.env` contains the application SDK settings; it does not contain Cloudflare account credentials.

Pagent also registers a per-user startup entry on Linux, macOS, and Windows. It returns after the user signs in following a reboot and restarts after an unexpected exit. `pagent stop` stops the current run without disabling startup; revoking the tunnel removes the startup entry.

## Slack notifications

The local connector can post to a Slack incoming webhook as soon as Codex creates an investigation thread. Notifications contain only event and thread metadata: the thread name and ID, event type and ID, environment, repository key, and timestamps. Event context, prompts, repository paths, and Codex output are never sent.

Add the webhook secret to `.pagent/local.env`:

```sh
PAGENT_SLACK_WEBHOOK_URL='paste the incoming webhook URL here'
```

Then opt in from `pagent.config.ts`:

```ts
export default defineConnectorConfig({
  // Existing connector settings...
  notifications: {
    slack: {
      webhookUrl: required("PAGENT_SLACK_WEBHOOK_URL"),
      timeoutMs: 2_000,
    },
  },
});
```

The timeout is optional and defaults to two seconds. Slack delivery is best-effort: Pagent makes one attempt, records failures in the connector log, and continues the Codex investigation. Run `pagent logs` to inspect notification failures.
