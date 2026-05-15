/**
 * tasks.test.ts — TaskManager 业务规则测试
 *
 * 覆盖：创建、依赖阻塞、自动完成、软删除保护、跨项目元数据。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "./logger.js";
import { createTaskStore } from "./task-store.js";
import { createTaskManager } from "./tasks.js";

const PROJECT_ROOT = resolve("/tmp/project-a");
const PROJECT_B = resolve("/tmp/project-b");
let tempDir: string;

function createManager() {
  const store = createTaskStore({
    tasksDir: tempDir,
    projectRoot: PROJECT_ROOT,
    logger: createLogger("error"),
  });
  store.scan();
  return createTaskManager({
    store,
    projectRoot: PROJECT_ROOT,
    now: () => new Date("2026-05-13T15:30:00.000Z"),
    eventIdGenerator: () => "event_test",
  });
}

describe("TaskManager", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "tasks-test-"));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("creates a task group with stable task ids", () => {
    const manager = createManager();

    const group = manager.createGroup({
      title: "Task System",
      tasks: [{ subject: "Design store" }, { subject: "Wire tools" }],
    });

    expect(group.id).toBe("tg_20260513_153000_task_system");
    expect(group.tasks.map((task) => task.id)).toEqual(["task_1", "task_2"]);
    expect(manager.getActiveGroupId()).toBe(group.id);
  });

  it("rejects starting a task before dependencies complete", () => {
    const manager = createManager();
    const group = manager.createGroup({
      title: "Dependency Demo",
      tasks: [
        { subject: "First task" },
        { subject: "Second task", blockedBy: ["task_1"] },
      ],
    });

    expect(() =>
      manager.updateTask(group.id, "task_2", { status: "in_progress" }),
    ).toThrow("blocked by task_1");
  });

  it("auto-completes the group when all non-deleted tasks complete", () => {
    const manager = createManager();
    const group = manager.createGroup({
      title: "Complete Demo",
      tasks: [{ subject: "Only task" }],
    });

    manager.updateTask(group.id, "task_1", { status: "in_progress" });
    const view = manager.updateTask(group.id, "task_1", {
      status: "completed",
    });

    expect(view.group.status).toBe("completed");
  });

  it("refuses to delete a task that still blocks another task", () => {
    const manager = createManager();
    const group = manager.createGroup({
      title: "Delete Demo",
      tasks: [
        { subject: "First task" },
        { subject: "Second task", blockedBy: ["task_1"] },
      ],
    });

    expect(() => manager.deleteTask(group.id, "task_1")).toThrow(
      "required by task_2",
    );
  });

  it("stores multi-project task groups as metadata, not path nesting", () => {
    const manager = createManager();
    const group = manager.createGroup({
      title: "Multi Project",
      projectRoots: [PROJECT_ROOT, PROJECT_B],
      primaryProjectRoot: PROJECT_ROOT,
      tasks: [{ subject: "Coordinate projects" }],
    });

    expect(group.scope).toBe("multi_project");
    expect(group.projectRoots).toEqual([PROJECT_ROOT, PROJECT_B]);
  });
});
