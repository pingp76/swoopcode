/**
 * tools/tasks.test.ts — Task tool provider 测试
 *
 * 覆盖：工具参数校验、输出 id、状态更新和 active group reminder。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "../logger.js";
import { createSessionEventBuffer } from "../session-events.js";
import { createTaskStore } from "../task-store.js";
import { createTaskManager } from "../tasks.js";
import { createTaskToolProvider } from "./tasks.js";

const PROJECT_ROOT = resolve("/tmp/project-a");
let tempDir: string;

function setupTool(name: string) {
  const store = createTaskStore({
    tasksDir: tempDir,
    projectRoot: PROJECT_ROOT,
    logger: createLogger("error"),
  });
  store.scan();
  const manager = createTaskManager({
    store,
    projectRoot: PROJECT_ROOT,
    now: () => new Date("2026-05-13T15:30:00.000Z"),
    eventIdGenerator: () => "event_test",
  });
  const sessionEventBuffer = createSessionEventBuffer();
  const provider = createTaskToolProvider(manager, { sessionEventBuffer });
  const tool = provider.toolEntries.find(
    (entry) => entry.definition.function.name === name,
  );
  if (!tool) throw new Error(`Tool not found: ${name}`);
  return { execute: tool.execute, manager, sessionEventBuffer, provider };
}

describe("Task tools", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "task-tool-test-"));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns ToolResult.error for missing required parameters", async () => {
    const { execute } = setupTool("run_task_group_create");

    const result = await execute({ title: "Missing tasks" });

    expect(result.error).toBe(true);
    expect(result.output).toContain("'tasks' must be a non-empty array");
  });

  it("creates a group and returns explicit group/task ids", async () => {
    const { execute, sessionEventBuffer } = setupTool("run_task_group_create");

    const result = await execute({
      title: "Task System",
      tasks: [{ subject: "Design store" }],
    });

    expect(result.error).toBe(false);
    expect(result.output).toContain("tg_20260513_153000_task_system");
    expect(result.output).toContain("task_1");
    expect(sessionEventBuffer.peek()[0]?.source).toBe("task");
  });

  it("tool descriptions distinguish durable task groups from TODO lists", () => {
    const { provider } = setupTool("run_task_group_create");
    const createDef = provider.toolEntries.find(
      (entry) => entry.definition.function.name === "run_task_group_create",
    )?.definition.function.description;
    const updateDef = provider.toolEntries.find(
      (entry) => entry.definition.function.name === "run_task_update",
    )?.definition.function.description;

    expect(createDef).toContain("persistent Task Group");
    expect(createDef).toContain("run_todo_create");
    expect(updateDef).toContain("run_todo_update");
  });

  it("updates status through run_task_update", async () => {
    const { manager, provider } = setupTool("run_task_update");
    const group = manager.createGroup({
      title: "Update Demo",
      tasks: [{ subject: "Do work" }],
    });
    const update = provider.toolEntries.find(
      (entry) => entry.definition.function.name === "run_task_update",
    );
    if (!update) throw new Error("update tool missing");

    const result = await update.execute({
      group_id: group.id,
      task_id: "task_1",
      status: "in_progress",
      note: "starting",
    });

    expect(result.error).toBe(false);
    expect(result.output).toContain("[>] task_1");
    expect(result.output).toContain("starting");
  });
});
