# Pagent

Pagent turns selected application failures into proactive Codex investigations. The application decides which results or errors are worth reviewing and sends only the context chosen by the developer.

```text
cloud application -> HTTPS -> relay -> SSE -> local connector -> Codex app server
```

The application SDK observes selected functions and emits qualifying events without changing their return values or errors. It does not read source code or start Codex.

The relay authenticates each source, routes events to the right connector, applies deduplication and developer-defined cooldowns, and persists tasks for replay.

The local connector maps repository keys to allowlisted local paths and hands each task to the Codex installation already on the machine. Codex investigates that checkout in read-only mode and creates a thread that a person can continue in the Codex app.

The path is one-way. The local machine opens the outbound SSE connection, and no repository contents or Codex results are sent back to the relay.
