import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FileHandoffHistory,
  type HandoffHistoryRecord,
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
  it("records and updates local handoff metadata", async () => {
    const path = await historyPath();
    const history = new FileHandoffHistory(path);
    await history.upsert(handoff({ taskId: "1", eventId: "event-1" }));

    await expect(
      history.update("1", {
        status: "retrying",
        attempts: 3,
        lastAttemptAt: "2026-08-26T12:02:00.000Z",
        lastErrorCode: "codex_unavailable",
        lastErrorMessage: "Start Codex, then run `pagent doctor`.",
      }),
    ).resolves.toMatchObject({
      status: "retrying",
      attempts: 3,
      lastErrorCode: "codex_unavailable",
      lastErrorMessage: "Start Codex, then run `pagent doctor`.",
    });
    await history.update("1", {
      status: "completed",
      completedAt: "2026-08-26T12:03:00.000Z",
      threadId: "thread-1",
    });

    await expect(history.findByEventId("event-1")).resolves.toMatchObject({
      taskId: "1",
      status: "completed",
      attempts: 3,
      threadId: "thread-1",
    });
    await expect(history.update("missing", { status: "running" })).resolves.toBe(
      undefined,
    );
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      records: [{ eventId: "event-1", threadId: "thread-1" }],
    });
    if (process.platform !== "win32") {
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  it("keeps the newest 100 records and replaces duplicate tasks", async () => {
    const path = await historyPath();
    const history = new FileHandoffHistory(path);

    for (let index = 0; index < 101; index += 1) {
      await history.upsert(
        handoff({ taskId: String(index), eventId: `event-${index}` }),
      );
    }
    await history.upsert(
      handoff({
        taskId: "100",
        eventId: "event-replaced",
        status: "running",
      }),
    );

    const records = await history.list();
    expect(records).toHaveLength(100);
    expect(records[0]).toMatchObject({
      taskId: "100",
      eventId: "event-replaced",
      status: "running",
    });
    expect(records.some((record) => record.taskId === "0")).toBe(false);
    expect(records.filter((record) => record.taskId === "100")).toHaveLength(1);
  });

  it("migrates legacy arrays and drops invalid records", async () => {
    const path = await historyPath();
    await writeFile(
      path,
      JSON.stringify([
        handoff({ taskId: "valid", eventId: "event-valid" }),
        { taskId: "invalid", eventId: "event-invalid" },
      ]),
    );

    const history = new FileHandoffHistory(path);
    await expect(history.list()).resolves.toEqual([
      handoff({ taskId: "valid", eventId: "event-valid" }),
    ]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 1,
      records: [{ taskId: "valid" }],
    });
  });

  it("recovers from malformed JSON without exposing event context", async () => {
    const path = await historyPath();
    await writeFile(path, "{broken", "utf8");
    const history = new FileHandoffHistory(path);

    await expect(history.list()).resolves.toEqual([]);
    await history.upsert(handoff({ taskId: "1", eventId: "event-1" }));

    const serialized = await readFile(path, "utf8");
    expect(JSON.parse(serialized)).toMatchObject({
      version: 1,
      records: [{ taskId: "1" }],
    });
    expect(serialized).not.toContain("payload");
    expect(serialized).not.toContain("context");
  });

  it("rejects invalid records and limits", async () => {
    const path = await historyPath();
    expect(() => new FileHandoffHistory(path, { limit: 0 })).toThrow(
      "Handoff history limit must be between 1 and 100.",
    );
    expect(() => new FileHandoffHistory(path, { limit: 101 })).toThrow(
      "Handoff history limit must be between 1 and 100.",
    );
    await expect(
      new FileHandoffHistory(path).upsert({
        ...handoff({ taskId: "1", eventId: "event-1" }),
        attempts: -1,
      }),
    ).rejects.toThrow("Handoff history record is invalid.");
  });
});

function handoff(
  overrides: Partial<HandoffHistoryRecord>,
): HandoffHistoryRecord {
  return {
    taskId: "task-1",
    eventId: "event-1",
    eventType: "checkout.failure-rate",
    environment: "staging",
    status: "received",
    attempts: 0,
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
