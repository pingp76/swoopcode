import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createScheduleStore,
  validateScheduleFile,
  validateOccurrenceFile,
} from "./schedule-store.js";
import { createLogger } from "./logger.js";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "schedule-store-test-"));
}

function makeValidSchedule(
  id: string,
  overrides?: Partial<import("./schedule-store.js").ScheduleFile>,
): import("./schedule-store.js").ScheduleFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: "schedule",
    id,
    title: "Test Schedule",
    status: "active",
    createdAt: now,
    updatedAt: now,
    projectRoot: "/tmp/project",
    cwd: "/tmp/project",
    timezone: "Asia/Shanghai",
    intent: { prompt: "Run tests" },
    timing: { type: "once", runAt: now },
    execution: {
      mode: "async",
      executor: "subagent",
      timeoutSeconds: 300,
      overlapPolicy: "skip",
      permissionProfile: "readonly",
      resources: { readPaths: ["."], writePaths: [] },
    },
    outputPolicy: {
      saveRawOutput: true,
      notifyLlm: true,
      linkedTaskUpdate: "never",
    },
    triggeredCount: 0,
    missedCount: 0,
    skippedCount: 0,
    ...overrides,
  };
}

function makeValidOccurrence(
  scheduleId: string,
  occurrenceId: string,
  overrides?: Partial<import("./schedule-store.js").ScheduleOccurrenceFile>,
): import("./schedule-store.js").ScheduleOccurrenceFile {
  const now = new Date().toISOString();
  return {
    version: 1,
    kind: "schedule_occurrence",
    id: occurrenceId,
    scheduleId,
    scheduledAt: now,
    status: "triggered",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("validateScheduleFile", () => {
  it("accepts a valid schedule", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test");
    expect(validateScheduleFile(schedule)).toEqual([]);
  });

  it("rejects wrong version", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      version: 2 as 1,
    });
    expect(validateScheduleFile(schedule)).toContain("version must be 1");
  });

  it("rejects wrong kind", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      kind: "task_group" as "schedule",
    });
    expect(validateScheduleFile(schedule)).toContain('kind must be "schedule"');
  });

  it("rejects invalid id format", () => {
    const schedule = makeValidSchedule("bad-id");
    expect(validateScheduleFile(schedule)).toContain("id has invalid format");
  });

  it("rejects mismatched directory id", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test");
    expect(
      validateScheduleFile(schedule, "sch_20260525_120000_other"),
    ).toContain("directory id and content id do not match");
  });

  it("rejects missing title", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      title: "",
    });
    expect(validateScheduleFile(schedule)).toContain("title is required");
  });

  it("rejects invalid status", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      status: "paused" as "active",
    });
    expect(validateScheduleFile(schedule)).toContain("status is invalid");
  });

  it("rejects relative projectRoot", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      projectRoot: "relative/path",
    });
    expect(validateScheduleFile(schedule)).toContain(
      "projectRoot must be an absolute path",
    );
  });

  it("rejects cwd outside projectRoot", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      cwd: "/other/path",
    });
    expect(validateScheduleFile(schedule)).toContain(
      "cwd must be within projectRoot",
    );
  });

  it("rejects invalid timezone", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      timezone: "Mars/Phobos",
    });
    expect(validateScheduleFile(schedule)).toContain("timezone is invalid");
  });

  it("rejects missing intent.prompt", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      intent: { prompt: "" },
    });
    expect(validateScheduleFile(schedule)).toContain(
      "intent.prompt is required",
    );
  });

  it("rejects once timing without runAt", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      timing: { type: "once", runAt: "" },
    });
    expect(validateScheduleFile(schedule)).toContain(
      "once timing requires runAt",
    );
  });

  it("accepts recurring without endsAt", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      timing: {
        type: "recurring",
        startsAt: new Date().toISOString(),
        rule: { kind: "daily", intervalDays: 1, timeOfDay: "09:00:00" },
      },
    });
    expect(validateScheduleFile(schedule)).toEqual([]);
  });

  it("rejects endsAt earlier than startsAt", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      timing: {
        type: "recurring",
        startsAt: "2026-05-26T00:00:00Z",
        endsAt: "2026-05-25T00:00:00Z",
        rule: { kind: "daily", intervalDays: 1, timeOfDay: "09:00:00" },
      },
    });
    expect(validateScheduleFile(schedule)).toContain(
      "endsAt must be later than startsAt",
    );
  });

  it("rejects command executor without command", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      execution: {
        mode: "async",
        executor: "command",
        timeoutSeconds: 300,
        overlapPolicy: "skip",
        permissionProfile: "readonly",
        resources: { readPaths: ["."], writePaths: [] },
      },
    });
    expect(validateScheduleFile(schedule)).toContain(
      "execution.command is required when executor is command",
    );
  });

  it("rejects invalid overlapPolicy", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      execution: {
        mode: "async",
        executor: "subagent",
        timeoutSeconds: 300,
        overlapPolicy: "queue" as "skip",
        permissionProfile: "readonly",
        resources: { readPaths: ["."], writePaths: [] },
      },
    });
    expect(validateScheduleFile(schedule)).toContain(
      'execution.overlapPolicy must be "allow" or "skip"',
    );
  });

  it("rejects negative triggeredCount", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      triggeredCount: -1,
    });
    expect(validateScheduleFile(schedule)).toContain(
      "triggeredCount must be a non-negative number",
    );
  });
});

describe("validateOccurrenceFile", () => {
  it("accepts a valid occurrence", () => {
    const occ = makeValidOccurrence(
      "sch_20260525_120000_test",
      "occ_20260525_120000_x7a9",
    );
    expect(validateOccurrenceFile(occ)).toEqual([]);
  });

  it("accepts an orphaned occurrence", () => {
    const occ = makeValidOccurrence(
      "sch_20260525_120000_test",
      "occ_20260525_120000_x7a9",
      {
        status: "orphaned",
        completedAt: new Date().toISOString(),
        reason: "Async run was lost after restart",
      },
    );
    expect(validateOccurrenceFile(occ)).toEqual([]);
  });

  it("rejects wrong kind", () => {
    const occ = makeValidOccurrence(
      "sch_20260525_120000_test",
      "occ_20260525_120000_x7a9",
      {
        kind: "schedule" as "schedule_occurrence",
      },
    );
    expect(validateOccurrenceFile(occ)).toContain(
      'kind must be "schedule_occurrence"',
    );
  });

  it("rejects invalid status", () => {
    const occ = makeValidOccurrence(
      "sch_20260525_120000_test",
      "occ_20260525_120000_x7a9",
      {
        status: "unknown" as "triggered",
      },
    );
    expect(validateOccurrenceFile(occ)).toContain("status is invalid");
  });
});

describe("createScheduleStore", () => {
  let tmpDir: string;
  let store: ReturnType<typeof createScheduleStore>;
  const logger = createLogger("silent");

  beforeEach(() => {
    tmpDir = makeTempDir();
    store = createScheduleStore({
      schedulesDir: path.resolve(tmpDir, "schedules"),
      projectRoot: "/tmp/project",
      logger,
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves and reads a schedule", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test");
    store.save(schedule);
    const read = store.read("sch_20260525_120000_test");
    expect(read).not.toBeNull();
    expect(read!.id).toBe("sch_20260525_120000_test");
    expect(read!.title).toBe("Test Schedule");
  });

  it("returns null for non-existent schedule", () => {
    expect(store.read("sch_20260525_120000_missing")).toBeNull();
  });

  it("lists schedules with default filters", () => {
    store.save(
      makeValidSchedule("sch_20260525_120000_a", { status: "active" }),
    );
    store.save(
      makeValidSchedule("sch_20260525_120000_b", { status: "cancelled" }),
    );
    store.save(
      makeValidSchedule("sch_20260525_120000_c", { status: "archived" }),
    );

    const list = store.list();
    expect(list.map((s) => s.id)).toContain("sch_20260525_120000_a");
    expect(list.map((s) => s.id)).not.toContain("sch_20260525_120000_b");
    expect(list.map((s) => s.id)).not.toContain("sch_20260525_120000_c");
  });

  it("scan rebuilds index", () => {
    store.save(makeValidSchedule("sch_20260525_120000_test"));
    const scanned = store.scan();
    expect(scanned.length).toBe(1);

    const indexPath = path.resolve(tmpDir, "schedules", "index.json");
    expect(fs.existsSync(indexPath)).toBe(true);
    const index = JSON.parse(fs.readFileSync(indexPath, "utf-8"));
    expect(index.schedules).toContain("sch_20260525_120000_test");
  });

  it("scan returns all projects while list defaults to current project", () => {
    store.save(makeValidSchedule("sch_20260525_120000_a"));
    store.save(
      makeValidSchedule("sch_20260525_120000_b", {
        projectRoot: "/tmp/project-b",
        cwd: "/tmp/project-b",
      }),
    );

    const defaultList = store.list();
    expect(defaultList.map((s) => s.id)).toEqual(["sch_20260525_120000_a"]);

    const scanned = store.scan();
    expect(scanned.map((s) => s.id).sort()).toEqual([
      "sch_20260525_120000_a",
      "sch_20260525_120000_b",
    ]);
  });

  it("hard deletes a schedule", () => {
    store.save(makeValidSchedule("sch_20260525_120000_test"));
    store.hardDelete("sch_20260525_120000_test");
    expect(store.read("sch_20260525_120000_test")).toBeNull();
  });

  it("saves and reads an occurrence", () => {
    store.save(makeValidSchedule("sch_20260525_120000_test"));
    const occ = makeValidOccurrence(
      "sch_20260525_120000_test",
      "occ_20260525_120000_x7a9",
    );
    store.saveOccurrence(occ);
    const read = store.readOccurrence(
      "sch_20260525_120000_test",
      "occ_20260525_120000_x7a9",
    );
    expect(read).not.toBeNull();
    expect(read!.status).toBe("triggered");
  });

  it("lists occurrences sorted by scheduledAt desc", () => {
    store.save(makeValidSchedule("sch_20260525_120000_test"));
    store.saveOccurrence(
      makeValidOccurrence(
        "sch_20260525_120000_test",
        "occ_20260525_100000_x7a9",
        {
          scheduledAt: "2026-05-25T10:00:00Z",
        },
      ),
    );
    store.saveOccurrence(
      makeValidOccurrence(
        "sch_20260525_120000_test",
        "occ_20260525_120000_x7a9",
        {
          scheduledAt: "2026-05-25T12:00:00Z",
        },
      ),
    );
    const list = store.listOccurrences("sch_20260525_120000_test");
    expect(list[0]!.id).toBe("occ_20260525_120000_x7a9");
    expect(list[1]!.id).toBe("occ_20260525_100000_x7a9");
  });

  it("limits occurrences", () => {
    store.save(makeValidSchedule("sch_20260525_120000_test"));
    for (let i = 0; i < 5; i++) {
      store.saveOccurrence(
        makeValidOccurrence(
          "sch_20260525_120000_test",
          `occ_20260525_${String(i).padStart(2, "0")}0000_x7a9`,
          {
            scheduledAt: `2026-05-25T${String(i).padStart(2, "0")}:00:00Z`,
          },
        ),
      );
    }
    const list = store.listOccurrences("sch_20260525_120000_test", 2);
    expect(list.length).toBe(2);
  });

  it("filters by projectRoot", () => {
    store.save(
      makeValidSchedule("sch_20260525_120000_a", {
        projectRoot: "/tmp/project-a",
        cwd: "/tmp/project-a",
      }),
    );
    store.save(
      makeValidSchedule("sch_20260525_120000_b", {
        projectRoot: "/tmp/project-b",
        cwd: "/tmp/project-b",
      }),
    );

    const list = store.list({ projectRoot: "/tmp/project-a" });
    expect(list.map((s) => s.id)).toEqual(["sch_20260525_120000_a"]);
  });

  it("can explicitly list schedules across all projects", () => {
    store.save(makeValidSchedule("sch_20260525_120000_a"));
    store.save(
      makeValidSchedule("sch_20260525_120000_b", {
        projectRoot: "/tmp/project-b",
        cwd: "/tmp/project-b",
      }),
    );

    const list = store.list({ currentProjectOnly: false });
    expect(list.map((s) => s.id).sort()).toEqual([
      "sch_20260525_120000_a",
      "sch_20260525_120000_b",
    ]);
  });

  it("rejects saving invalid schedule", () => {
    const schedule = makeValidSchedule("sch_20260525_120000_test", {
      title: "",
    });
    expect(() => store.save(schedule)).toThrow("title is required");
  });
});
