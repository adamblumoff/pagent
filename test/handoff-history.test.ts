import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileHandoffHistory,
  type HandoffHistoryRecord,
  type HandoffStatus,
} from "../src/handoff-history.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

describe("file handoff history", () => {
  it("records local lifecycle updates by event ID", async () => {
    const path = await historyPath();
    const history = new FileHandoffHistory(path);
    await history.upsert(handoff({ eventId: "event-1" }));

    await expect(history.update("event-1", {
      status: "running",
      startedAt: "2026-08-26T12:02:00.000Z",
      threadId: "thread-1",
      threadName: "Investigating checkout.failure-rate in pagent",
    })).resolves.toMatchObject({
      status: "running",
      threadId: "thread-1",
      threadName: "Investigating checkout.failure-rate in pagent",
    });
    await expect(history.update("event-1", {
      status: "completed",
      completedAt: "2026-08-26T12:03:00.000Z",
    })).resolves.toMatchObject({
      status: "completed",
      threadId: "thread-1",
      threadName: "Investigating checkout.failure-rate in pagent",
    });

    await expect(history.findByEventId("event-1")).resolves.toMatchObject({
      eventId: "event-1",
      status: "completed",
      threadId: "thread-1",
      threadName: "Investigating checkout.failure-rate in pagent",
    });
    await expect(history.update("missing", { status: "running" })).resolves.toBeUndefined();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      records: [{
        eventId: "event-1",
        threadId: "thread-1",
        threadName: "Investigating checkout.failure-rate in pagent",
      }],
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves a started thread when its investigation fails", async () => {
    const history = new FileHandoffHistory(await historyPath());
    await history.upsert(handoff({ eventId: "event-failed" }));
    await history.update("event-failed", {
      status: "running",
      startedAt: "2026-08-26T12:02:00.000Z",
      threadId: "thread-failed",
      threadName: "Investigating checkout.failure-rate in pagent",
    });

    await expect(history.update("event-failed", {
      status: "failed",
      completedAt: "2026-08-26T12:03:00.000Z",
      errorCode: "codex_failed",
      errorMessage: "Codex turn failed.",
    })).resolves.toMatchObject({
      status: "failed",
      threadId: "thread-failed",
      threadName: "Investigating checkout.failure-rate in pagent",
      errorCode: "codex_failed",
    });
  });

  it.each<HandoffStatus>([
    "received",
    "running",
    "completed",
    "suppressed",
    "failed",
  ])("stores the local %s status", async (status) => {
    const history = new FileHandoffHistory(await historyPath());
    await expect(history.upsert(handoff({ status }))).resolves.toMatchObject({ status });
  });

  it("stores failure details without event context", async () => {
    const path = await historyPath();
    const history = new FileHandoffHistory(path);
    await history.upsert(handoff({
      status: "failed",
      errorCode: "codex_failed",
      errorMessage: "Codex app server is unavailable.",
      completedAt: "2026-08-26T12:03:00.000Z",
    }));

    const serialized = await readFile(path, "utf8");
    expect(serialized).toContain("codex_failed");
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("context");
  });

  it("keeps the newest 100 records and replaces duplicate events", async () => {
    const history = new FileHandoffHistory(await historyPath());
    for (let index = 0; index < 101; index += 1) {
      await history.upsert(handoff({ eventId: `event-${index}` }));
    }
    await history.upsert(handoff({ eventId: "event-100", status: "running" }));

    const records = await history.list();
    expect(records).toHaveLength(100);
    expect(records[0]).toMatchObject({ eventId: "event-100", status: "running" });
    expect(records.some((record) => record.eventId === "event-0")).toBe(false);
    expect(records.filter((record) => record.eventId === "event-100")).toHaveLength(1);
  });

  it("migrates direct legacy arrays and drops queue-era statuses", async () => {
    const path = await historyPath();
    await writeFile(path, JSON.stringify([
      handoff({ eventId: "event-valid" }),
      { ...handoff({ eventId: "event-queued" }), status: "queued", attempts: 2 },
    ]));

    const history = new FileHandoffHistory(path);
    await expect(history.list()).resolves.toEqual([handoff({ eventId: "event-valid" })]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      records: [{ eventId: "event-valid" }],
    });
  });

  it("recovers from malformed JSON", async () => {
    const path = await historyPath();
    await writeFile(path, "{broken", "utf8");
    const history = new FileHandoffHistory(path);

    await expect(history.list()).resolves.toEqual([]);
    await history.upsert(handoff({ eventId: "event-1" }));
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      records: [{ eventId: "event-1" }],
    });
  });

  it("rejects invalid records and limits", async () => {
    const path = await historyPath();
    expect(() => new FileHandoffHistory(path, { limit: 0 })).toThrow(
      "Handoff history limit must be between 1 and 100.",
    );
    expect(() => new FileHandoffHistory(path, { limit: 101 })).toThrow(
      "Handoff history limit must be between 1 and 100.",
    );
    await expect(new FileHandoffHistory(path).upsert({
      ...handoff({ eventId: "event-1" }),
      status: "retrying" as HandoffStatus,
    })).rejects.toThrow("Handoff history record is invalid.");
  });
});

function handoff(overrides: Partial<HandoffHistoryRecord>): HandoffHistoryRecord {
  return {
    eventId: "event-1",
    eventType: "checkout.failure-rate",
    environment: "staging",
    status: "received",
    receivedAt: "2026-08-26T12:00:00.000Z",
    ...overrides,
  };
}

async function historyPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pagent-history-test-"));
  temporaryDirectories.push(directory);
  const stateDirectory = join(directory, "state");
  await mkdir(stateDirectory);
  return join(stateDirectory, "handoffs.json");
}
