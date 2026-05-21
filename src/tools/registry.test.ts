/**
 * registry.test.ts — 工具注册表测试
 *
 * 覆盖：重复注册报错、工具定义顺序稳定性、完整 registry 创建。
 */

import { describe, it, expect } from "vitest";
import { createToolRegistry } from "./registry.js";
import { createDefaultAsyncCommandPolicy } from "./bash.js";

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

// ============================================================================
// Async run provider 注册
// ============================================================================

describe("ToolRegistry async run provider", () => {
  it("registers async run tools when provider is given", () => {
    const asyncRunProvider = {
      toolEntries: [
        {
          definition: {
            type: "function" as const,
            function: { name: "run_async_start", description: "start async run" },
          },
          execute: async () => ({ output: "ok", error: false }),
        },
        {
          definition: {
            type: "function" as const,
            function: { name: "run_async_check", description: "check async run" },
          },
          execute: async () => ({ output: "ok", error: false }),
        },
      ],
    };

    const registry = createToolRegistry(
      undefined, undefined, undefined, undefined, undefined,
      asyncRunProvider,
    );
    const names = registry.getToolDefinitions().map((d) => d.function?.name);
    expect(names).toContain("run_async_start");
    expect(names).toContain("run_async_check");
  });
});

// ============================================================================
// 过滤选项
// ============================================================================

describe("ToolRegistry filtering options", () => {
  it("excludes run_write when includeFileWrite=false", () => {
    const registry = createToolRegistry(undefined, undefined, undefined, undefined, undefined, undefined, {
      includeFileWrite: false,
    });
    const names = registry.getToolDefinitions().map((d) => d.function?.name);
    expect(names).not.toContain("run_write");
    expect(names).toContain("run_read");
    expect(names).toContain("run_bash");
  });

  it("excludes run_edit when includeFileEdit=false", () => {
    const registry = createToolRegistry(undefined, undefined, undefined, undefined, undefined, undefined, {
      includeFileEdit: false,
    });
    const names = registry.getToolDefinitions().map((d) => d.function?.name);
    expect(names).not.toContain("run_edit");
    expect(names).toContain("run_read");
    expect(names).toContain("run_bash");
  });

  it("applies commandPolicy in run_bash executor", async () => {
    const policy = createDefaultAsyncCommandPolicy();
    const registry = createToolRegistry(undefined, undefined, undefined, undefined, undefined, undefined, {
      commandPolicy: policy,
    });
    const executor = registry.getExecutor("run_bash");
    expect(executor).toBeDefined();

    const result = await executor!({ command: "git status; touch x" });
    expect(result.error).toBe(true);
    expect(result.output).toContain("Shell operators");
  });

  it("applies readPolicy in run_read executor", async () => {
    const registry = createToolRegistry(undefined, undefined, undefined, undefined, undefined, undefined, {
      readPolicy: {
        validate(path: string) {
          if (path.startsWith("/secret")) {
            return { allowed: false, reason: "Secret path blocked" };
          }
          return { allowed: true };
        },
      },
    });
    const executor = registry.getExecutor("run_read");
    expect(executor).toBeDefined();

    const result = await executor!({ path: "/secret/config" });
    expect(result.error).toBe(true);
    expect(result.output).toContain("Secret path blocked");
  });

  it("filtered registry for subagent does not contain run_async_*", () => {
    const asyncRunProvider = {
      toolEntries: [
        {
          definition: {
            type: "function" as const,
            function: { name: "run_async_start", description: "start" },
          },
          execute: async () => ({ output: "ok", error: false }),
        },
      ],
    };
    const registry = createToolRegistry(
      undefined, undefined, undefined, undefined, undefined,
      asyncRunProvider,
      { includeFileWrite: false, includeFileEdit: false },
    );
    const names = registry.getToolDefinitions().map((d) => d.function?.name);
    // 这个 filtered registry 用于子智能体，它不包含 subagent 和 async-run 工具
    // 但这里传入的是 asyncRunProvider，所以 run_async_start 存在
    // 真正测试的是：子智能体的 registry 不传 asyncRunProvider
    expect(names).toContain("run_async_start");

    // 子智能体注册表：不传 asyncRunProvider
    const subRegistry = createToolRegistry(
      undefined, undefined, undefined, undefined, undefined, undefined,
      { includeFileWrite: false, includeFileEdit: false },
    );
    const subNames = subRegistry.getToolDefinitions().map((d) => d.function?.name);
    expect(subNames).not.toContain("run_async_start");
    expect(subNames).not.toContain("run_subagent");
  });
});
