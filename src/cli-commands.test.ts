/**
 * cli-commands.test.ts — CLI 命令分发测试
 *
 * 重点覆盖新增 /task 命令，确保 REPL 旁路命令可以直接查看持久化任务。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createCliCommandRegistry,
  createTaskCliCommand,
} from "./cli-commands.js";
import { createLogger } from "./logger.js";
import { createTaskStore } from "./task-store.js";
import { createTaskManager } from "./tasks.js";

const PROJECT_ROOT = resolve("/tmp/project-a");
let tempDir: string;

function createTaskCommand() {
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
  return {
    command: createTaskCliCommand(manager, createLogger("error")),
    manager,
  };
}

describe("CLI task command", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "task-cli-test-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("dispatches /task list", () => {
    const { command, manager } = createTaskCommand();
    manager.createGroup({
      title: "CLI Demo",
      tasks: [{ subject: "List task" }],
    });
    const registry = createCliCommandRegistry();
    registry.register(command);

    expect(registry.dispatch("/task list")).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("CLI Demo"),
    );
  });

  it("dispatches /task show", () => {
    const { command, manager } = createTaskCommand();
    const group = manager.createGroup({
      title: "Show Demo",
      tasks: [{ subject: "Show task" }],
    });
    const registry = createCliCommandRegistry();
    registry.register(command);

    registry.dispatch(`/task show ${group.id}`);

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("task_1"));
  });

  it("reports archive errors for active groups", () => {
    const { command, manager } = createTaskCommand();
    const group = manager.createGroup({
      title: "Archive Demo",
      tasks: [{ subject: "Archive task" }],
    });
    const registry = createCliCommandRegistry();
    registry.register(command);

    registry.dispatch(`/task archive ${group.id}`);

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Only completed or cancelled"),
    );
  });
});
