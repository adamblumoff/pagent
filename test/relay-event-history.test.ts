import { describe, expect, it, vi } from "vitest";

import {
  getRelayEventHistory,
  listRelayEventHistory,
} from "../src/relay-event-history.js";

const summary = {
  eventId: "event-1",
  type: "health.failed",
  environment: "staging",
  occurredAt: "2026-08-26T12:00:00.000Z",
  receivedAt: "2026-08-26T12:00:01.000Z",
  status: "retrying",
  attemptCount: 3,
  taskId: "9",
  receivedLocallyAt: "2026-08-26T12:00:02.000Z",
  startedAt: "2026-08-26T12:00:03.000Z",
  lastAttemptAt: "2026-08-26T12:00:04.000Z",
  lastErrorCode: "codex_failed",
} as const;

describe("relay event history client", () => {
  it("lists authenticated metadata with cursor pagination", async () => {
    const fetchHistory = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({
          version: 1,
          events: [summary],
          nextCursor: "next-page",
        }),
    );

    await expect(
      listRelayEventHistory({
        relayUrl: "https://relay.example.test",
        connectorId: "local one",
        token: "connector-secret",
        limit: 20,
        cursor: "current-page",
        fetch: fetchHistory as typeof fetch,
      }),
    ).resolves.toEqual({ events: [summary], nextCursor: "next-page" });

    const [url, init] = fetchHistory.mock.calls[0]!;
    expect(String(url)).toBe(
      "https://relay.example.test/v1/connectors/local%20one/event-history?limit=20&cursor=current-page",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer connector-secret",
    );
    expect(new Headers(init?.headers).get("cache-control")).toBe("no-store");
  });

  it("reads one event and treats a missing event as absent", async () => {
    const found = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        Response.json({ version: 1, event: summary }),
    );
    await expect(
      getRelayEventHistory({
        relayUrl: "https://relay.example.test",
        connectorId: "local",
        token: "secret",
        eventId: "event/1",
        fetch: found as typeof fetch,
      }),
    ).resolves.toEqual(summary);
    expect(String(found.mock.calls[0]?.[0])).toMatch(
      /\/event-history\/event%2F1$/u,
    );

    await expect(
      getRelayEventHistory({
        relayUrl: "https://relay.example.test",
        connectorId: "local",
        token: "secret",
        eventId: "missing",
        fetch: vi.fn(async () => new Response(null, { status: 404 })) as typeof fetch,
      }),
    ).resolves.toBeUndefined();
  });

  it("rejects bad responses and gives network remediation", async () => {
    await expect(
      listRelayEventHistory({
        relayUrl: "https://relay.example.test",
        connectorId: "local",
        token: "secret",
        limit: 20,
        fetch: vi.fn(async () => Response.json({ events: [] })) as typeof fetch,
      }),
    ).rejects.toThrow("invalid event history");

    await expect(
      listRelayEventHistory({
        relayUrl: "https://relay.example.test",
        connectorId: "local",
        token: "secret",
        limit: 20,
        fetch: vi.fn(async () => Promise.reject(new Error("offline"))) as typeof fetch,
      }),
    ).rejects.toThrow("Run `pagent doctor`");
  });
});
