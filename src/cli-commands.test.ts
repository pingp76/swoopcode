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
  createScheduleCliCommand,
  createTaskCliCommand,
  createModelPolicyCliCommand,
  createThinkingCliCommand,
} from "./cli-commands.js";
import { createRuntimePolicyStore } from "./runtime-policy-store.js";
import { resolveFoundationModelProfile } from "./foundation-models.js";
import { createLogger } from "./logger.js";
import type { ScheduleManager } from "./schedules.js";
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

describe("CLI schedule command", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createScheduleManagerMock(): ScheduleManager {
    return {
      create: vi.fn(),
      list: vi.fn().mockReturnValue([]),
      read: vi.fn().mockReturnValue(null),
      cancel: vi.fn(),
      delete: vi.fn(),
      listOccurrences: vi.fn().mockReturnValue([]),
      start: vi.fn(),
      stop: vi.fn(),
      tick: vi.fn(),
      drainNotifications: vi.fn().mockReturnValue([]),
    };
  }

  it("lists current project schedules by default", () => {
    const manager = createScheduleManagerMock();
    const registry = createCliCommandRegistry();
    registry.register(createScheduleCliCommand(manager, createLogger("error")));

    registry.dispatch("/schedule list");

    expect(manager.list).toHaveBeenCalledWith({
      includeArchived: false,
      includeCancelled: false,
      currentProjectOnly: true,
    });
  });

  it("uses --all-projects only for explicit cross-project summaries", () => {
    const manager = createScheduleManagerMock();
    const registry = createCliCommandRegistry();
    registry.register(createScheduleCliCommand(manager, createLogger("error")));

    registry.dispatch("/schedule list --all --all-projects");

    expect(manager.list).toHaveBeenCalledWith({
      includeArchived: true,
      includeCancelled: true,
      currentProjectOnly: false,
    });
  });
});

describe("CLI model policy command", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createPolicyStore() {
    const profile = resolveFoundationModelProfile({
      provider: "kimi_platform_cn",
      model: "kimi-k2.6",
    });
    return createRuntimePolicyStore(profile, "kimi-k2.6");
  }

  it("dispatches /m to show policy status", () => {
    const store = createPolicyStore();
    const registry = createCliCommandRegistry();
    registry.register(createModelPolicyCliCommand(store, createLogger("error")));

    expect(registry.dispatch("/m")).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Model policy"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("kimi-k2.6"),
    );
  });

  it("dispatches /模型 alias", () => {
    const store = createPolicyStore();
    const registry = createCliCommandRegistry();
    registry.register(createModelPolicyCliCommand(store, createLogger("error")));

    expect(registry.dispatch("/模型")).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Model policy"),
    );
  });

  it("updates context budget with /m c 300k", () => {
    const profile = resolveFoundationModelProfile({
      provider: "openai_compatible",
      model: "deepseek-v4",
      explicitProfileId: "deepseek-v4",
    });
    const store = createRuntimePolicyStore(profile, "deepseek-v4");
    const registry = createCliCommandRegistry();
    registry.register(createModelPolicyCliCommand(store, createLogger("error")));

    registry.dispatch("/m c 300k");

    expect(store.getPolicy().context.effectiveBudgetTokens).toBe(300000);
    expect(console.log).toHaveBeenCalledWith("Context budget set to 300000.");
  });

  it("updates max output with /m out 16k", () => {
    const store = createPolicyStore();
    const registry = createCliCommandRegistry();
    registry.register(createModelPolicyCliCommand(store, createLogger("error")));

    registry.dispatch("/m out 16k");

    expect(store.getPolicy().request.maxOutputTokens).toBe(16000);
  });

  it("resets override with /m r", () => {
    const store = createPolicyStore();
    store.updateOverride({ contextBudgetTokens: 100000 }, "cli");
    const registry = createCliCommandRegistry();
    registry.register(createModelPolicyCliCommand(store, createLogger("error")));

    registry.dispatch("/m r");

    expect(store.getOverride()).toEqual({});
  });
});

describe("CLI thinking command", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function createThinkingStore() {
    const profile = resolveFoundationModelProfile({
      provider: "kimi_platform_cn",
      model: "kimi-k2.6",
    });
    return createRuntimePolicyStore(profile, "kimi-k2.6");
  }

  it("dispatches /t to show thinking status", () => {
    const store = createThinkingStore();
    const registry = createCliCommandRegistry();
    registry.register(createThinkingCliCommand(store, createLogger("error")));

    expect(registry.dispatch("/t")).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Thinking policy"),
    );
  });

  it("dispatches /思考 alias", () => {
    const store = createThinkingStore();
    const registry = createCliCommandRegistry();
    registry.register(createThinkingCliCommand(store, createLogger("error")));

    expect(registry.dispatch("/思考")).toBe(true);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Thinking policy"),
    );
  });

  it("sets thinking enabled with /t 开", () => {
    const store = createThinkingStore();
    const registry = createCliCommandRegistry();
    registry.register(createThinkingCliCommand(store, createLogger("error")));

    registry.dispatch("/t 开");

    expect(store.getPolicy().request.thinkingMode).toBe("enabled");
  });

  it("sets thinking disabled with /t 关", () => {
    const store = createThinkingStore();
    const registry = createCliCommandRegistry();
    registry.register(createThinkingCliCommand(store, createLogger("error")));

    registry.dispatch("/t 关");

    expect(store.getPolicy().request.thinkingMode).toBe("disabled");
  });

  it("sets thinking adaptive with /t 自", () => {
    const store = createThinkingStore();
    const registry = createCliCommandRegistry();
    registry.register(createThinkingCliCommand(store, createLogger("error")));

    registry.dispatch("/t 自");

    expect(store.getPolicy().request.thinkingMode).toBe("adaptive");
  });

  it("rejects thinking for non-thinking model", () => {
    const profile = resolveFoundationModelProfile({
      provider: "openai_compatible",
      model: "some-model",
    });
    const store = createRuntimePolicyStore(profile, "some-model");
    const registry = createCliCommandRegistry();
    registry.register(createThinkingCliCommand(store, createLogger("error")));

    registry.dispatch("/t 开");

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("Error:"),
    );
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining("does not support thinking mode"),
    );
  });
});
