import { describe, it, expect, beforeEach } from "vitest";
import { createScheduleManager, type ScheduleManager } from "./schedules.js";
import { type ScheduleStore } from "./schedule-store.js";
import { createLogger } from "./logger.js";
import type { AsyncRunManager, AsyncRunRecord, AsyncRunExecutor, AsyncRunTrigger } from "./async-runs.js";

const NOW = new Date("2026-05-26T12:00:00Z");

function makeMockAsyncRunManager(): { records: AsyncRunRecord[]; onFinishRef?: ((record: AsyncRunRecord) => void) | undefined } & AsyncRunManager {
  const records: AsyncRunRecord[] = [];
  let onFinishRef: ((record: AsyncRunRecord) => void) | undefined;
  const mgr: { records: AsyncRunRecord[]; onFinishRef?: ((record: AsyncRunRecord) => void) | undefined } & AsyncRunManager = {
    records,
    start(input: { trigger?: AsyncRunTrigger; title: string; executor: AsyncRunExecutor; command?: string; prompt?: string; resources?: { read_paths?: string[]; write_paths?: string[] }; timeoutMs?: number; }): AsyncRunRecord {
      const id = `ar_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const startedAt = new Date();
      const record: AsyncRunRecord = {
        id,
        status: "running",
        title: input.title,
        executor: input.executor,
        resourceClaim: { readPaths: input.resources?.read_paths ?? [], writePaths: input.resources?.write_paths ?? [] },
        trigger: input.trigger ?? { kind: "manual" },
        startedAt: startedAt.toISOString(),
        timeoutAt: new Date(startedAt.getTime() + (input.timeoutMs ?? 300_000)).toISOString(),
        preview: "",
      };
      if (input.command !== undefined) record.command = input.command;
      if (input.prompt !== undefined) record.prompt = input.prompt;
      records.push(record);
      return record;
    },
    check: (runId: string) => records.find((r) => r.id === runId) ?? null,
    list: () => records,
    readOutput: () => "",
    drainNotifications: () => [],
    checkForegroundToolConflict: () => ({ blocked: false }),
    setOnFinish(handler: (record: AsyncRunRecord) => void): void {
      onFinishRef = handler;
    },
    get onFinishRef() {
      return onFinishRef;
    },
  };
  return mgr;
}

function createInMemoryStore(): ScheduleStore {
  const schedules = new Map<string, import("./schedule-store.js").ScheduleFile>();
  const occurrences = new Map<string, import("./schedule-store.js").ScheduleOccurrenceFile>();
  return {
    scan: () =>
      Array.from(schedules.values()).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        executor: s.execution.executor,
        nextRunAt: s.nextRunAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    list: () =>
      Array.from(schedules.values()).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        executor: s.execution.executor,
        nextRunAt: s.nextRunAt,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
      })),
    read: (id) => schedules.get(id) ?? null,
    save: (s) => {
      schedules.set(s.id, s);
    },
    hardDelete: (id) => {
      schedules.delete(id);
      occurrences.delete(id);
    },
    readOccurrence: (_scheduleId, occurrenceId) => occurrences.get(occurrenceId) ?? null,
    saveOccurrence: (o) => {
      occurrences.set(o.id, o);
    },
    listOccurrences: (_scheduleId, limit) => Array.from(occurrences.values()).slice(0, limit),
    rebuildIndex: () => {},
    getSchedulesDir: () => "/tmp/schedules",
  };
}

describe("ScheduleManager", () => {
  let store: ScheduleStore;
  let asyncRunManager: ReturnType<typeof makeMockAsyncRunManager>;
  let manager: ScheduleManager;

  beforeEach(() => {
    store = createInMemoryStore();
    asyncRunManager = makeMockAsyncRunManager();
    manager = createScheduleManager({
      store,
      asyncRunManager,
      projectRoot: "/tmp/project",
      logger: createLogger("info"),
      now: () => new Date(NOW),
    });
  });

  function makeBaseInput() {
    return {
      title: "Test Schedule",
      intent: { prompt: "Do something useful" },
      execution: {
        mode: "async" as const,
        executor: "subagent" as const,
        timeoutSeconds: 300,
        overlapPolicy: "allow" as const,
        permissionProfile: "readonly" as const,
        resources: { readPaths: ["."], writePaths: [] },
      },
      outputPolicy: {
        saveRawOutput: true,
        notifyLlm: true,
        linkedTaskUpdate: "never" as const,
      },
    };
  }

  it("creates a schedule and computes nextRunAt", () => {
    const schedule = manager.create({
      ...makeBaseInput(),
      timing: { type: "once", runAt: "2026-05-26T13:00:00Z" },
    });

    expect(schedule.id).toMatch(/^sch_\d{8}_\d{6}_[a-z0-9_-]+$/);
    expect(schedule.status).toBe("active");
    expect(schedule.nextRunAt).toBeDefined();
    expect(new Date(schedule.nextRunAt!).getTime()).toBe(new Date("2026-05-26T13:00:00Z").getTime());
  });

  it("tick triggers a due once schedule", () => {
    manager.create({
      ...makeBaseInput(),
      timing: { type: "once", runAt: "2026-05-26T11:00:00Z" },
    });

    manager.tick(new Date("2026-05-26T12:00:00Z"));

    expect(asyncRunManager.records.length).toBe(1);
    expect(asyncRunManager.records[0]!.title).toBe("Test Schedule");
    expect(asyncRunManager.records[0]!.trigger.kind).toBe("schedule");
  });

  it("does not trigger the same occurrence twice", () => {
    manager.create({
      ...makeBaseInput(),
      timing: { type: "once", runAt: "2026-05-26T11:00:00Z" },
    });

    const tickTime = new Date("2026-05-26T12:00:00Z");
    manager.tick(tickTime);
    manager.tick(tickTime);

    expect(asyncRunManager.records.length).toBe(1);
  });

  it("skips overlapping occurrences when overlapPolicy=skip", () => {
    manager.create({
      ...makeBaseInput(),
      execution: { ...makeBaseInput().execution, overlapPolicy: "skip" },
      timing: { type: "once", runAt: "2026-05-26T11:00:00Z" },
    });

    manager.tick(new Date("2026-05-26T12:00:00Z"));

    const occurrencesBefore = store.listOccurrences(asyncRunManager.records[0]!.trigger.scheduleId!, 10);
    const runningOcc = occurrencesBefore.find((o) => o.status === "running");
    expect(runningOcc).toBeDefined();
  });

  it("cancels a schedule and stops future triggers", () => {
    const schedule = manager.create({
      ...makeBaseInput(),
      execution: { ...makeBaseInput().execution, overlapPolicy: "skip" },
      timing: { type: "once", runAt: "2026-05-26T13:00:00Z" },
    });

    const cancelled = manager.cancel(schedule.id);
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.nextRunAt).toBeUndefined();

    manager.tick(new Date("2026-05-26T14:00:00Z"));
    expect(asyncRunManager.records.length).toBe(0);
  });

  it("rejects deleting a triggered schedule", () => {
    const schedule = manager.create({
      ...makeBaseInput(),
      timing: { type: "once", runAt: "2026-05-26T11:00:00Z" },
    });

    manager.tick(new Date("2026-05-26T12:00:00Z"));

    expect(() => manager.delete(schedule.id)).toThrow("Use cancel instead of delete");
  });

  it("allows deleting an untriggered schedule", () => {
    const schedule = manager.create({
      ...makeBaseInput(),
      execution: { ...makeBaseInput().execution, overlapPolicy: "skip" },
      timing: { type: "once", runAt: "2026-05-26T13:00:00Z" },
    });

    manager.delete(schedule.id);
    expect(store.read(schedule.id)).toBeNull();
  });

  it("updates occurrence status on async run finish", () => {
    manager.create({
      ...makeBaseInput(),
      timing: { type: "once", runAt: "2026-05-26T11:00:00Z" },
    });

    manager.tick(new Date("2026-05-26T12:00:00Z"));
    expect(asyncRunManager.records.length).toBe(1);

    const record = asyncRunManager.records[0]!;
    record.status = "completed";

    asyncRunManager.onFinishRef?.(record);

    const occurrences = store.listOccurrences(record.trigger.scheduleId!, 10);
    const occ = occurrences.find((o) => o.asyncRunId === record.id);
    expect(occ).toBeDefined();
    expect(occ!.status).toBe("completed");
  });

  it("drains schedule notifications", () => {
    manager.create({
      ...makeBaseInput(),
      timing: { type: "once", runAt: "2026-05-26T11:00:00Z" },
    });

    manager.tick(new Date("2026-05-26T12:00:00Z"));
    const notifications = manager.drainNotifications();
    expect(notifications.length).toBeGreaterThan(0);
    expect(notifications[0]!.type).toBe("triggered");

    expect(manager.drainNotifications().length).toBe(0);
  });
});

import { computeNextRunAt } from "./schedules.js";

describe("computeNextRunAt", () => {
  it("returns runAt for once timing regardless of after", () => {
    const timing = { type: "once" as const, runAt: "2026-05-26T11:00:00Z" };
    const result = computeNextRunAt(timing, "UTC", new Date("2026-05-26T12:00:00Z"));
    expect(result?.toISOString()).toBe("2026-05-26T11:00:00.000Z");
  });

  it("anchors every_seconds to startsAt offset", () => {
    const timing = {
      type: "recurring" as const,
      startsAt: "2026-05-26T12:00:05Z",
      rule: { kind: "every_seconds" as const, intervalSeconds: 60 },
    };
    // after = 12:00:30, startsAt = 12:00:05, interval = 60s
    // steps = floor(25000/60000) + 1 = 1 → result = 12:01:05
    const result = computeNextRunAt(timing, "UTC", new Date("2026-05-26T12:00:30Z"));
    expect(result?.toISOString()).toBe("2026-05-26T12:01:05.000Z");
  });

  it("jumps multiple intervals for every_seconds without linear loop", () => {
    const timing = {
      type: "recurring" as const,
      startsAt: "2026-05-26T12:00:05Z",
      rule: { kind: "every_seconds" as const, intervalSeconds: 60 },
    };
    // after = 12:02:06, elapsed = 121000ms, steps = floor(121000/60000)+1 = 3
    // result = 12:00:05 + 180s = 12:03:05
    const result = computeNextRunAt(timing, "UTC", new Date("2026-05-26T12:02:06Z"));
    expect(result?.toISOString()).toBe("2026-05-26T12:03:05.000Z");
  });

  it("returns startsAt directly when after is before startsAt", () => {
    const timing = {
      type: "recurring" as const,
      startsAt: "2026-05-26T14:00:00Z",
      rule: { kind: "hourly" as const, intervalHours: 1 },
    };
    const result = computeNextRunAt(timing, "UTC", new Date("2026-05-26T12:00:00Z"));
    expect(result?.toISOString()).toBe("2026-05-26T14:00:00.000Z");
  });

  it("respects weekly intervalWeeks > 1", () => {
    // 2026-05-25 is Monday
    const timing = {
      type: "recurring" as const,
      startsAt: "2026-05-25T10:00:00Z",
      rule: {
        kind: "weekly" as const,
        intervalWeeks: 2,
        daysOfWeek: ["mon" as const],
        timeOfDay: "10:00:00",
      },
    };
    // after = Tue May 26 11:00 → next should be Mon Jun 8 (skip May 25 weekIndex=0 passed,
    // May 25+7=Jun 1 weekIndex=1 skipped because 1%2=1)
    const result = computeNextRunAt(timing, "UTC", new Date("2026-05-26T11:00:00Z"));
    expect(result?.toISOString()).toBe("2026-06-08T10:00:00.000Z");
  });

  it("returns null when after is past endsAt", () => {
    const timing = {
      type: "recurring" as const,
      startsAt: "2026-05-26T10:00:00Z",
      endsAt: "2026-05-26T11:00:00Z",
      rule: { kind: "hourly" as const, intervalHours: 1 },
    };
    const result = computeNextRunAt(timing, "UTC", new Date("2026-05-26T12:00:00Z"));
    expect(result).toBeNull();
  });
});

describe("ScheduleManager listOccurrences limit", () => {
  let store: ScheduleStore;
  let asyncRunManager: ReturnType<typeof makeMockAsyncRunManager>;
  let manager: ScheduleManager;

  beforeEach(() => {
    store = createInMemoryStore();
    asyncRunManager = makeMockAsyncRunManager();
    manager = createScheduleManager({
      store,
      asyncRunManager,
      projectRoot: "/tmp/project",
      logger: createLogger("info"),
      now: () => new Date(NOW),
    });
  });

  it("respects the limit parameter", () => {
    const schedule = manager.create({
      title: "Limit Test",
      intent: { prompt: "test" },
      timing: { type: "once", runAt: "2026-05-26T13:00:00Z" },
      execution: {
        mode: "async" as const,
        executor: "subagent" as const,
        timeoutSeconds: 300,
        overlapPolicy: "allow" as const,
        permissionProfile: "readonly" as const,
        resources: { readPaths: ["."], writePaths: [] },
      },
      outputPolicy: {
        saveRawOutput: true,
        notifyLlm: true,
        linkedTaskUpdate: "never" as const,
      },
    });

    // Create 5 occurrences manually
    for (let i = 0; i < 5; i++) {
      store.saveOccurrence({
        version: 1,
        kind: "schedule_occurrence",
        id: `occ_test_${i}`,
        scheduleId: schedule.id,
        scheduledAt: new Date(`2026-05-26T12:00:0${i}Z`).toISOString(),
        status: "completed",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    }

    expect(manager.listOccurrences({ scheduleId: schedule.id }).length).toBe(5);
    expect(manager.listOccurrences({ scheduleId: schedule.id, limit: 3 }).length).toBe(3);
    expect(manager.listOccurrences({ scheduleId: schedule.id, limit: 10 }).length).toBe(5);
  });
});
