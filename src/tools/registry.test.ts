/**
 * registry.test.ts — 工具注册表测试
 *
 * 覆盖：重复注册报错、工具定义顺序稳定性、完整 registry 创建。
 */

import { describe, it, expect } from "vitest";
import { createToolRegistry } from "./registry.js";

// ============================================================================
// 重复注册
// ============================================================================

describe("ToolRegistry duplicate registration", () => {
  it("throws when registering the same tool name twice", () => {
    // createToolRegistry 内部已注册 run_bash
    // 若再传入一个包含 run_bash 的 provider，应抛错
    const duplicateProvider = {
      toolEntries: [
        {
          definition: {
            type: "function" as const,
            function: { name: "run_bash", description: "duplicate bash" },
          },
          execute: async () => ({ output: "ok", error: false }),
        },
      ],
    };

    expect(() => createToolRegistry(duplicateProvider)).toThrow(
      'Tool "run_bash" is already registered',
    );
  });

  it("two independent registries have same order", () => {
    const r1 = createToolRegistry();
    const r2 = createToolRegistry();

    const names1 = r1.getToolDefinitions().map((d) => d.function?.name);
    const names2 = r2.getToolDefinitions().map((d) => d.function?.name);

    expect(names1).toEqual(names2);
  });
});

// ============================================================================
// 顺序稳定性
// ============================================================================

describe("ToolRegistry order stability", () => {
  it("returns definitions in registration order", () => {
    const registry = createToolRegistry();
    const defs = registry.getToolDefinitions();
    const names = defs.map((d) => d.function?.name);

    // 基础工具：bash, read, write, edit
    expect(names).toContain("run_bash");
    expect(names).toContain("run_read");
    expect(names).toContain("run_write");
    expect(names).toContain("run_edit");

    // 多次调用顺序一致
    const defs2 = registry.getToolDefinitions();
    const names2 = defs2.map((d) => d.function?.name);
    expect(names).toEqual(names2);
  });
});

// ============================================================================
// 完整注册表
// ============================================================================

describe("ToolRegistry full setup", () => {
  it("includes all tool categories when providers are given", () => {
    const todoProvider = {
      toolEntries: [
        {
          definition: {
            type: "function" as const,
            function: { name: "run_todo_create", description: "create todo" },
          },
          execute: async () => ({ output: "ok", error: false }),
        },
      ],
    };

    const skillProvider = {
      toolEntries: [
        {
          definition: {
            type: "function" as const,
            function: { name: "run_skill", description: "invoke skill" },
          },
          execute: async () => ({ output: "ok", error: false }),
        },
      ],
    };

    const taskProvider = {
      toolEntries: [
        {
          definition: {
            type: "function" as const,
            function: {
              name: "run_task_group_list",
              description: "list tasks",
            },
          },
          execute: async () => ({ output: "ok", error: false }),
        },
      ],
    };

    const registry = createToolRegistry(
      todoProvider,
      undefined,
      skillProvider,
      undefined,
      taskProvider,
    );
    const names = registry.getToolDefinitions().map((d) => d.function?.name);

    expect(names).toContain("run_bash");
    expect(names).toContain("run_read");
    expect(names).toContain("run_todo_create");
    expect(names).toContain("run_skill");
    expect(names).toContain("run_task_group_list");
  });
});
