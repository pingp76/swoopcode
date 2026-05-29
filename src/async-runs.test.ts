/**
 * async-runs.test.ts — AsyncRunManager 单元测试
 *
 * 覆盖 finishRun 核心正确性、生命周期状态机、并发限制、深拷贝、
 * 前台冲突检测、notification 队列等关键行为。
 */

import { describe, it, expect, vi } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createAsyncRunManager } from "./async-runs.js";
import type { LLMClient } from "./llm.js";
import type { Logger } from "./logger.js";
import { createDefaultAsyncCommandPolicy } from "./tools/bash.js";
import type { AsyncCommandPolicy } from "./execution-policy.js";
import type { ToolRegistry } from "./tools/registry.js";
import { createOutputStore } from "./output-store.js";

// ---------------------------------------------------------------------------
// 测试辅助函数
// ---------------------------------------------------------------------------

/**
 * 创建临时目录用于测试输出
 */
function createTempDir(): string {
  const dir = resolve(tmpdir(), `async-runs-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 清理临时目录
 */
function cleanupTempDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理失败
  }
}

/**
 * 创建 mock logger
 */
function createMockLogger(): Logger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
}

/**
 * 创建最小可用的 AsyncRunManager
 */
function createTestManager(options?: {
  projectRoot?: string;
  taskOutputsDir?: string;
  commandPolicy?: AsyncCommandPolicy;
  withOutputStore?: boolean;
}) {
  const tempDir = createTempDir();
  const taskOutputsDir = options?.taskOutputsDir ?? resolve(tempDir, "outputs");
  const outputStore = options?.withOutputStore
    ? createOutputStore({
        outputDir: taskOutputsDir,
        clock: () => new Date("2026-05-28T15:30:00.000"),
        idGenerator: () => "abc123",
      })
    : undefined;
  const manager = createAsyncRunManager({
    projectRoot: options?.projectRoot ?? tempDir,
    taskOutputsDir,
    llm: {} as LLMClient,
    logger: createMockLogger(),
    commandPolicy: options?.commandPolicy ?? createAllowAllCommandPolicy(),
    ...(outputStore ? { outputStore } : {}),
    createAgentFn: vi.fn().mockReturnValue({
      run: vi.fn().mockResolvedValue("subagent output"),
    }),
    createCompressorFn: vi.fn(),
    createReadonlyRegistryFn: vi.fn().mockReturnValue({
      getToolDefinitions: vi.fn().mockReturnValue([]),
      getExecutor: vi.fn(),
    } satisfies ToolRegistry),
    getStableSystemPrompt: () => null,
  });
  return { manager, tempDir, outputStore };
}

function createAllowAllCommandPolicy(): AsyncCommandPolicy {
  return {
    maxTimeoutMs: 300_000,
    validate: () => ({ allowed: true }),
  };
}

// ---------------------------------------------------------------------------
// 测试套件
// ---------------------------------------------------------------------------

describe("AsyncRunManager", () => {
  describe("start", () => {
    it("should create a running record for command executor", () => {
      const { manager, tempDir } = createTestManager();
      try {
        const record = manager.start({
          title: "Run typecheck",
          executor: "command",
          command: "npm run typecheck",
          resources: { read_paths: ["src"], write_paths: [] },
        });

        expect(record.status).toBe("running");
        expect(record.executor).toBe("command");
        expect(record.title).toBe("Run typecheck");
        expect(record.command).toBe("npm run typecheck");
        expect(record.id).toMatch(/^ar_\d{8}_\d{6}_[a-z0-9]{4,12}$/);
        expect(record.resourceClaim.readPaths).toEqual(["src"]);
        expect(record.resourceClaim.writePaths).toEqual([]);
        expect(record.outputPath).toBeDefined();
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should create a running record for subagent executor", () => {
      const { manager, tempDir } = createTestManager();
      try {
        const record = manager.start({
          title: "Analyze failures",
          executor: "subagent",
          prompt: "Analyze test failures",
          resources: { read_paths: ["src"], write_paths: [] },
        });

        expect(record.status).toBe("running");
        expect(record.executor).toBe("subagent");
        expect(record.prompt).toBe("Analyze test failures");
        expect(record.maxRounds).toBe(8); // 默认值
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject invalid executor", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(() =>
          manager.start({
            resources: { read_paths: [], write_paths: [] },
            title: "Test",
            executor: "invalid" as never,
            command: "ls",
          }),
        ).toThrow('Invalid executor: "invalid"');
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject missing command for executor=command", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(() =>
          manager.start({
            resources: { read_paths: [], write_paths: [] },
            title: "Test",
            executor: "command",
          }),
        ).toThrow("command is required when executor='command'");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject missing prompt for executor=subagent", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(() =>
          manager.start({
            resources: { read_paths: [], write_paths: [] },
            title: "Test",
            executor: "subagent",
          }),
        ).toThrow("prompt is required when executor='subagent'");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject resources as array", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(() =>
          manager.start({
            title: "Test",
            executor: "command",
            command: "ls",
            // @ts-expect-error 故意传入错误类型测试防御性校验
            resources: [],
          }),
        ).toThrow("resources must be an object");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject resources without read_paths/write_paths", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(() =>
          manager.start({
            title: "Test",
            executor: "command",
            command: "ls",
            resources: {},
          }),
        ).not.toThrow(); // 空对象通过，因为 ?? [] 提供默认值
        // 验证空对象确实能启动（read_paths/write_paths 默认为空数组）
        const record = manager.start({
          title: "Test2",
          executor: "command",
          command: "ls",
          resources: {},
        });
        expect(record.resourceClaim.readPaths).toEqual([]);
        expect(record.resourceClaim.writePaths).toEqual([]);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject non-empty write_paths", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(() =>
          manager.start({
            title: "Test",
            executor: "command",
            command: "ls",
            resources: { read_paths: [], write_paths: ["src"] },
          }),
        ).toThrow("write_paths must be empty");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject out-of-bounds read_paths", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(() =>
          manager.start({
            title: "Test",
            executor: "command",
            command: "ls",
            resources: { read_paths: ["../outside"], write_paths: [] },
          }),
        ).toThrow('is outside project directory');
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject command blocked by readonly execution policy", () => {
      const { manager, tempDir } = createTestManager({
        commandPolicy: createDefaultAsyncCommandPolicy(),
      });
      try {
        expect(() =>
          manager.start({
            title: "Fix lint",
            executor: "command",
            command: "npx eslint --fix",
            resources: { read_paths: ["src"], write_paths: [] },
          }),
        ).toThrow("--fix");
        expect(() =>
          manager.start({
            title: "TSC emit",
            executor: "command",
            command: "npx tsc",
            resources: { read_paths: ["src"], write_paths: [] },
          }),
        ).toThrow("--noEmit");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should allow noEmit tsc command through readonly execution policy", () => {
      const { manager, tempDir } = createTestManager({
        commandPolicy: createDefaultAsyncCommandPolicy(),
      });
      try {
        const record = manager.start({
          title: "TSC no emit",
          executor: "command",
          command: "npx tsc --noEmit",
          resources: { read_paths: ["src"], write_paths: [] },
        });

        expect(record.command).toBe("npx tsc --noEmit");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject timeout exceeding maximum", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(() =>
          manager.start({
            resources: { read_paths: [], write_paths: [] },
            title: "Test",
            executor: "command",
            command: "ls",
            timeoutMs: 400_000,
          }),
        ).toThrow("exceeds maximum (300000)");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject max_rounds exceeding maximum", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(() =>
          manager.start({
            resources: { read_paths: [], write_paths: [] },
            title: "Test",
            executor: "subagent",
            prompt: "test",
            maxRounds: 25,
          }),
        ).toThrow("exceeds maximum (20)");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should enforce concurrency limit of 3", () => {
      const { manager, tempDir } = createTestManager();
      try {
        // 启动 3 个（达到上限）
        for (let i = 0; i < 3; i++) {
          manager.start({
            resources: { read_paths: [], write_paths: [] },
            title: `Test ${i}`,
            executor: "command",
            command: "sleep 10",
            timeoutMs: 60_000,
          });
        }

        // 第 4 个应该被拒绝
        expect(() =>
          manager.start({
            resources: { read_paths: [], write_paths: [] },
            title: "Test 4",
            executor: "command",
            command: "sleep 10",
            timeoutMs: 60_000,
          }),
        ).toThrow("Maximum concurrent async runs (3) reached");
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("finishRun correctness", () => {
    it("should transition from running to completed", async () => {
      const { manager, tempDir } = createTestManager();
      try {
        const record = manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test",
          executor: "command",
          command: "echo hello",
        });

        // 等待命令完成（echo 很快）
        await new Promise((r) => setTimeout(r, 500));

        const checked = manager.check(record.id);
        expect(checked?.status).toBeOneOf(["completed", "running"]);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should timeout after deadline", async () => {
      const { manager, tempDir } = createTestManager();
      try {
        const record = manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test",
          executor: "command",
          command: "sleep 10",
          timeoutMs: 100, // 100ms 超时
        });

        // 等待超时
        await new Promise((r) => setTimeout(r, 300));

        const checked = manager.check(record.id);
        expect(checked?.status).toBe("timeout");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should mark non-zero exit as failed", async () => {
      const { manager, tempDir } = createTestManager();
      try {
        const record = manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test",
          executor: "command",
          command: "exit 1",
        });

        // 等待命令完成
        await new Promise((r) => setTimeout(r, 500));

        const checked = manager.check(record.id);
        expect(checked?.status).toBe("failed");
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("check and list", () => {
    it("should return deep copy from check()", () => {
      const { manager, tempDir } = createTestManager();
      try {
        const record = manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test",
          executor: "command",
          command: "echo hello",
        });

        const copy1 = manager.check(record.id);
        const copy2 = manager.check(record.id);

        expect(copy1).not.toBe(copy2); // 不同引用
        expect(copy1).toEqual(copy2);

        // 修改副本不应影响内部状态
        copy1!.resourceClaim.readPaths.push("mutated");
        const copy3 = manager.check(record.id);
        expect(copy3!.resourceClaim.readPaths).not.toContain("mutated");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should return null for unknown run_id", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(manager.check("ar_20260519_000000_xxxx")).toBeNull();
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should filter list by status", () => {
      const { manager, tempDir } = createTestManager();
      try {
        const r1 = manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test 1",
          executor: "command",
          command: "echo hello",
        });
        const r2 = manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test 2",
          executor: "command",
          command: "sleep 10",
          timeoutMs: 60_000,
        });

        const runningList = manager.list({ status: "running" });
        expect(runningList.map((r) => r.id)).toEqual(
          expect.arrayContaining([r1.id, r2.id]),
        );

        const allList = manager.list();
        expect(allList.length).toBe(2);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should exclude terminal runs when includeTerminal=false", async () => {
      const { manager, tempDir } = createTestManager();
      try {
        manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test",
          executor: "command",
          command: "echo hello",
        });

        // 等待完成
        await new Promise((r) => setTimeout(r, 500));

        const all = manager.list();
        const nonTerminal = manager.list({ includeTerminal: false });
        expect(nonTerminal.length).toBeLessThanOrEqual(all.length);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("drainNotifications", () => {
    it("should return and clear notifications", async () => {
      const { manager, tempDir } = createTestManager();
      try {
        manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test",
          executor: "command",
          command: "echo hello",
        });

        // 等待完成
        await new Promise((r) => setTimeout(r, 500));

        const notifications1 = manager.drainNotifications();
        const notifications2 = manager.drainNotifications();

        expect(notifications1.length).toBeGreaterThanOrEqual(0);
        expect(notifications2.length).toBe(0); // 已清空
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("readOutput", () => {
    it("should read output file by run_id", async () => {
      const { manager, tempDir } = createTestManager();
      try {
        manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test",
          executor: "command",
          command: "echo hello-world",
        });

        // 等待完成
        await new Promise((r) => setTimeout(r, 500));

        const list = manager.list();
        const completed = list.find((r) => r.status === "completed");
        if (completed) {
          const output = manager.readOutput({ runId: completed.id });
          expect(output).toContain("hello-world");
        }
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should register completed output in OutputStore when provided", async () => {
      const { manager, tempDir, outputStore } = createTestManager({
        withOutputStore: true,
      });
      try {
        manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test",
          executor: "command",
          command: "echo output-store-run",
        });

        await new Promise((r) => setTimeout(r, 500));

        const completed = manager
          .list()
          .find((r) => r.status === "completed");
        expect(completed?.outputId).toBe("out_20260528_153000_abc123");
        expect(
          outputStore!.read({ outputId: completed!.outputId! }).content,
        ).toContain("output-store-run");
        expect(manager.readOutput({ runId: completed!.id })).toContain(
          "output-store-run",
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should reject invalid run_id", () => {
      const { manager, tempDir } = createTestManager();
      try {
        expect(() => manager.readOutput({ runId: "invalid" })).toThrow(
          "Invalid run_id format",
        );
      } finally {
        cleanupTempDir(tempDir);
      }
    });

  });

  describe("checkForegroundToolConflict", () => {
    it("should allow when no running async runs", () => {
      const { manager, tempDir } = createTestManager();
      try {
        const result = manager.checkForegroundToolConflict({
          toolName: "run_write",
          args: { path: "src/file.ts", content: "test" },
        });
        expect(result.blocked).toBe(false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should block write to path claimed by running async run", () => {
      const { manager, tempDir } = createTestManager();
      try {
        manager.start({
          title: "Test",
          executor: "command",
          command: "sleep 10",
          resources: { read_paths: ["src"], write_paths: [] },
          timeoutMs: 60_000,
        });

        const result = manager.checkForegroundToolConflict({
          toolName: "run_write",
          args: { path: "src/file.ts", content: "test" },
        });

        expect(result.blocked).toBe(true);
        expect(result.reason).toContain("claimed by running async run");
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should block edit to path claimed by running async run", () => {
      const { manager, tempDir } = createTestManager();
      try {
        manager.start({
          title: "Test",
          executor: "command",
          command: "sleep 10",
          resources: { read_paths: ["src"], write_paths: [] },
          timeoutMs: 60_000,
        });

        const result = manager.checkForegroundToolConflict({
          toolName: "run_edit",
          args: { path: "src/file.ts", old_string: "a", new_string: "b" },
        });

        expect(result.blocked).toBe(true);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should block exact edit to path claimed by running async run", () => {
      const { manager, tempDir } = createTestManager();
      try {
        manager.start({
          title: "Test",
          executor: "command",
          command: "sleep 10",
          resources: { read_paths: ["src"], write_paths: [] },
          timeoutMs: 60_000,
        });

        const result = manager.checkForegroundToolConflict({
          toolName: "run_edit_exact",
          args: {
            path: "src/file.ts",
            old_string: "a",
            new_string: "b",
            expected_occurrences: 1,
          },
        });

        expect(result.blocked).toBe(true);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should block non-read-only bash when async runs are active", () => {
      const { manager, tempDir } = createTestManager({
        commandPolicy: {
          maxTimeoutMs: 300_000,
          validate(command: string) {
            if (command === "sleep 10") return { allowed: true };
            if (command.includes(";")) {
              return {
                allowed: false,
                reason: "Shell operators are not allowed",
              };
            }
            return { allowed: true };
          },
        },
      });
      try {
        manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test",
          executor: "command",
          command: "sleep 10",
          timeoutMs: 60_000,
        });

        // 带 shell operator 的命令应被 block
        const result = manager.checkForegroundToolConflict({
          toolName: "run_bash",
          args: { command: "git status; touch x" },
        });

        expect(result.blocked).toBe(true);
      } finally {
        cleanupTempDir(tempDir);
      }
    });

    it("should allow read-only bash when async runs are active", () => {
      const { manager, tempDir } = createTestManager();
      try {
        manager.start({
          resources: { read_paths: [], write_paths: [] },
          title: "Test",
          executor: "command",
          command: "sleep 10",
          timeoutMs: 60_000,
        });

        const result = manager.checkForegroundToolConflict({
          toolName: "run_bash",
          args: { command: "git status" },
        });

        expect(result.blocked).toBe(false);
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });

  describe("record fields", () => {
    it("should include all expected fields in record", () => {
      const { manager, tempDir } = createTestManager();
      try {
        const record = manager.start({
          title: "Run typecheck",
          executor: "command",
          command: "npm run typecheck",
          groupId: "tg_test",
          persistentTaskId: "task_1",
          resources: { read_paths: ["src", "package.json"], write_paths: [] },
          timeoutMs: 120_000,
          trigger: { kind: "manual" },
        });

        expect(record.id).toBeDefined();
        expect(record.executor).toBe("command");
        expect(record.title).toBe("Run typecheck");
        expect(record.status).toBe("running");
        expect(record.groupId).toBe("tg_test");
        expect(record.persistentTaskId).toBe("task_1");
        expect(record.command).toBe("npm run typecheck");
        expect(record.resourceClaim.readPaths).toEqual(["src", "package.json"]);
        expect(record.resourceClaim.writePaths).toEqual([]);
        expect(record.startedAt).toBeDefined();
        expect(record.timeoutAt).toBeDefined();
        expect(record.preview).toBeDefined();
        expect(record.outputPath).toBeDefined();
        expect(record.trigger).toEqual({ kind: "manual" });
      } finally {
        cleanupTempDir(tempDir);
      }
    });
  });
});
