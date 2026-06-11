/**
 * tools/schedules.test.ts — Schedule 工具提供者测试
 *
 * 覆盖 LLM 可见的 Schedule tool 契约，确保 schema、参数解析和
 * ScheduleManager 调用保持一致。
 */

import { describe, expect, it, vi } from "vitest";
import type { ScheduleManager, ScheduleView } from "../schedules.js";
import type { ScheduleSummary } from "../schedule-store.js";
import { createScheduleToolProvider } from "./schedules.js";

function createMockSchedule(overrides?: Partial<ScheduleView>): ScheduleView {
  const now = "2026-05-26T12:00:00.000Z";
  return {
    version: 1,
    kind: "schedule",
    id: "sch_20260526_120000_test",
    title: "Test Schedule",
    status: "active",
    createdAt: now,
    updatedAt: now,
    projectRoot: "/tmp/project",
    cwd: "/tmp/project",
    timezone: "UTC",
    intent: { prompt: "Run tests" },
    timing: { type: "once", runAt: "2026-05-26T13:00:00.000Z" },
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
    nextRunAt: "2026-05-26T13:00:00.000Z",
    triggeredCount: 0,
    missedCount: 0,
    skippedCount: 0,
    ...overrides,
  };
}

function createMockManager(
  overrides?: Partial<ScheduleManager>,
): ScheduleManager {
  return {
    create: vi.fn().mockImplementation((input) =>
      createMockSchedule({
        title: input.title,
        intent: input.intent,
        timing: input.timing,
        execution: {
          mode: "async",
          executor: input.execution.executor,
          command: input.execution.command,
          timeoutSeconds: input.execution.timeoutSeconds,
          overlapPolicy: input.execution.overlapPolicy,
          permissionProfile: input.execution.permissionProfile,
          resources: input.execution.resources,
        },
        outputPolicy: input.outputPolicy,
      }),
    ),
    list: vi.fn().mockReturnValue([] satisfies ScheduleSummary[]),
    read: vi.fn().mockReturnValue(createMockSchedule()),
    cancel: vi
      .fn()
      .mockReturnValue(createMockSchedule({ status: "cancelled" })),
    delete: vi.fn(),
    listOccurrences: vi.fn().mockReturnValue([]),
    start: vi.fn(),
    stop: vi.fn(),
    tick: vi.fn(),
    drainNotifications: vi.fn().mockReturnValue([]),
    ...overrides,
  };
}

describe("ScheduleToolProvider", () => {
  it("has six stable tool entries", () => {
    const provider = createScheduleToolProvider(createMockManager());

    expect(
      provider.toolEntries.map((entry) => entry.definition.function.name),
    ).toEqual([
      "run_schedule_create",
      "run_schedule_list",
      "run_schedule_read",
      "run_schedule_cancel",
      "run_schedule_delete",
      "run_schedule_occurrence_list",
    ]);
  });

  it("does not expose unimplemented output policy fields", () => {
    const provider = createScheduleToolProvider(createMockManager());
    const createDefinition = provider.toolEntries[0]!.definition;
    const schema = JSON.stringify(createDefinition);

    expect(schema).not.toContain("save_raw_output");
    expect(schema).not.toContain("linked_task_update");
    expect(schema).toContain("notify_llm");
  });

  it("passes current_project_only to manager.list", async () => {
    const manager = createMockManager();
    const provider = createScheduleToolProvider(manager);

    await provider.toolEntries[1]!.execute({
      current_project_only: false,
      include_archived: true,
    });

    expect(manager.list).toHaveBeenCalledWith({
      currentProjectOnly: false,
      includeArchived: true,
    });
  });

  it("creates schedules with fixed not-yet-implemented policy defaults", async () => {
    const manager = createMockManager();
    const provider = createScheduleToolProvider(manager);

    const result = await provider.toolEntries[0]!.execute({
      title: "Nightly check",
      intent: { prompt: "Run nightly checks" },
      timing: { type: "once", run_at: "2026-05-26T13:00:00.000Z" },
      execution: {
        executor: "subagent",
        permission_profile: "ci",
        resources: { read_paths: ["."], write_paths: [] },
      },
      output_policy: {
        save_raw_output: false,
        linked_task_update: "append_note",
        notify_llm: false,
      },
    });

    expect(result.error).toBe(false);
    expect(manager.create).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({
          permissionProfile: "readonly",
        }),
        outputPolicy: expect.objectContaining({
          saveRawOutput: true,
          notifyLlm: false,
          linkedTaskUpdate: "never",
        }),
      }),
    );
  });
});
