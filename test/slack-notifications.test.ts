import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createSlackThreadStartedNotifier,
  SlackNotificationError,
  type SlackWebhookTransportRequest,
  type ThreadStartedNotification,
} from "../src/slack-notifications.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Slack thread-started notifications", () => {
  it("posts through the native transport to a loopback webhook", async () => {
    let receivedMethod: string | undefined;
    let receivedBody = "";
    const server = createServer((request, response) => {
      receivedMethod = request.method;
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        receivedBody += chunk;
      });
      request.on("end", () => {
        response.writeHead(200);
        response.end("ok");
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const notify = createSlackThreadStartedNotifier({
        webhookUrl: `http://127.0.0.1:${port}/slack`,
      });

      await notify(notification());

      expect(receivedMethod).toBe("POST");
      expect(JSON.parse(receivedBody)).toEqual({
        text: expect.stringContaining("Thread ID: thread-1"),
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        );
      });
    }
  });

  it("posts only Slack-safe thread and event metadata", async () => {
    const transport = vi.fn(
      async (_url: string, _request: SlackWebhookTransportRequest) => ({
        ok: true,
        status: 200,
      }),
    );
    const notify = createSlackThreadStartedNotifier(
      { webhookUrl: "https://notify.example.test/slack" },
      { transport },
    );
    const input = {
      ...notification(),
      threadName: "Investigate <!channel> & latency\nregression",
      payload: { secret: "database-password" },
      prompt: "private investigation prompt",
      context: { ciphertext: "encrypted-context" },
    };

    await notify(input);

    expect(transport).toHaveBeenCalledOnce();
    const [url, request] = transport.mock.calls[0]!;
    expect(url).toBe("https://notify.example.test/slack");
    expect(request).toMatchObject({
      method: "POST",
      headers: { "content-type": "application/json" },
    });
    const body = JSON.parse(request.body) as { text: string };
    expect(body.text).toContain(
      "Thread: Investigate &lt;!channel&gt; &amp; latency regression",
    );
    expect(body.text).toContain("Event: health.failed");
    expect(body.text).toContain("Environment: staging");
    expect(body.text).toContain("Repository: pagent");
    expect(body.text).toContain("Thread ID: thread-1");
    expect(body.text).toContain("Event ID: event-1");
    expect(body.text).toContain("Started: 2026-08-28T12:00:01.000Z");
    expect(body.text).toContain("Event occurred: 2026-08-28T12:00:00.000Z");
    expect(request.body).not.toContain("database-password");
    expect(request.body).not.toContain("private investigation prompt");
    expect(request.body).not.toContain("encrypted-context");
  });

  it("reports webhook rejection without exposing its URL", async () => {
    const webhookUrl = "https://notify.example.test/private-hook";
    const transport = vi.fn(async () => ({ ok: false, status: 429 }));
    const notify = createSlackThreadStartedNotifier(
      { webhookUrl },
      { transport },
    );

    const delivery = notify(notification());

    await expect(delivery).rejects.toMatchObject({
      name: "SlackNotificationError",
      code: "webhook_rejected",
      statusCode: 429,
      message: "Slack webhook rejected the notification with HTTP 429.",
    });
    await expect(delivery).rejects.not.toThrow(webhookUrl);
    expect(transport).toHaveBeenCalledOnce();
  });

  it("wraps transport failures with a stable network error", async () => {
    const cause = new Error("connect ECONNREFUSED private-hook");
    const notify = createSlackThreadStartedNotifier(
      { webhookUrl: "https://notify.example.test/private-hook" },
      { transport: async () => Promise.reject(cause) },
    );

    await expect(notify(notification())).rejects.toMatchObject({
      name: "SlackNotificationError",
      code: "network",
      message: "Pagent could not reach the Slack webhook.",
      cause,
    });
  });

  it("uses a two-second default timeout and aborts native fetch", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: URL, options: RequestInit) => {
        signal = options.signal as AbortSignal;
        return new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal?.reason), {
            once: true,
          });
        });
      }),
    );
    const notify = createSlackThreadStartedNotifier({
      webhookUrl: "https://notify.example.test/slack",
    });
    const delivery = notify(notification());
    const expectation = expect(delivery).rejects.toEqual(
      expect.objectContaining({
        name: "SlackNotificationError",
        code: "timeout",
        message: "Slack notification timed out after 2000ms.",
      }),
    );

    await vi.advanceTimersByTimeAsync(2_000);

    await expectation;
    expect(signal?.aborted).toBe(true);
  });

  it("validates webhook URLs and bounded positive timeouts", () => {
    expect(() =>
      createSlackThreadStartedNotifier({
        webhookUrl: "http://notify.example.test/slack",
      }),
    ).toThrow("Slack webhook URL must use HTTPS");
    expect(() =>
      createSlackThreadStartedNotifier({
        webhookUrl: "https://u:p@notify.example.test/slack#fragment",
      }),
    ).toThrow("must not contain credentials or a fragment");
    expect(() =>
      createSlackThreadStartedNotifier({
        webhookUrl: "https://notify.example.test/slack",
        timeoutMs: 30_001,
      }),
    ).toThrow("integer from 1 to 30000 milliseconds");
    for (const timeoutMs of [0, -1, 1.5]) {
      expect(() =>
        createSlackThreadStartedNotifier({
          webhookUrl: "https://notify.example.test/slack",
          timeoutMs,
        }),
      ).toThrow("integer from 1 to 30000 milliseconds");
    }
    expect(() =>
      createSlackThreadStartedNotifier({
        webhookUrl: "http://127.0.0.1:43129/slack",
        timeoutMs: 1,
      }),
    ).not.toThrow();
  });

  it("uses the exported error class for notification failures", () => {
    expect(
      new SlackNotificationError("network", "Slack failed"),
    ).toBeInstanceOf(Error);
  });
});

function notification(): ThreadStartedNotification {
  return {
    eventId: "event-1",
    eventType: "health.failed",
    environment: "staging",
    eventOccurredAt: "2026-08-28T12:00:00.000Z",
    repositoryKey: "pagent",
    threadId: "thread-1",
    threadName: "Investigate health.failed",
    startedAt: "2026-08-28T12:00:01.000Z",
  };
}
