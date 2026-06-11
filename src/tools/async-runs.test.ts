/**
 * async-runs.test.ts — Async Run 工具提供者测试
 *
 * 覆盖 4 个工具定义、参数校验、JSON 输出格式。
 */

import { describe, it, expect, vi } from "vitest";
import type { AsyncRunManager, AsyncRunRecord } from "../async-runs.js";
import { createAsyncRunToolProvider } from "./async-runs.js";

describe("AsyncRunToolProvider", () => {
  function createMockManager(
    overrides?: Partial<AsyncRunManager>,
  ): AsyncRunManager {
    return {
      start: vi.fn().mockImplementation(
        (input) =>
          ({
            id: "ar_20260519_120000_abc123",
            executor: input.executor ?? "command",
            title: input.title ?? "Test",
            status: "running",
            startedAt: "2026-05-19T12:00:00.000Z",
            timeoutAt: "2026-05-19T12:02:00.000Z",
            resourceClaim: input.resources ?? {
              readPaths: ["src"],
              writePaths: [],
            },
            preview: input.title ?? "Test",
            outputPath: "/tmp/async-runs/ar_20260519_120000_abc123/output.txt",
            trigger: { kind: "manual" },
          }) as AsyncRunRecord,
      ),
      check: vi.fn().mockReturnValue(null),
      list: vi.fn().mockReturnValue([]),
      readOutput: vi.fn().mockReturnValue("output content"),
      drainNotifications: vi.fn().mockReturnValue([]),
      checkForegroundToolConflict: vi.fn().mockReturnValue({
        blocked: false,
      }),
      ...overrides,
    };
  }

  it("should have exactly 4 tool entries with correct names", () => {
    const provider = createAsyncRunToolProvider(createMockManager());
    expect(provider.toolEntries).toHaveLength(4);
    const names = provider.toolEntries.map((e) => e.definition.function.name);
    expect(names).toContain("run_async_start");
    expect(names).toContain("run_async_check");
    expect(names).toContain("run_async_list");
    expect(names).toContain("run_async_output_read");
  });

  describe("run_async_start", () => {
    it("should return error for missing title", async () => {
      const provider = createAsyncRunToolProvider(createMockManager());
      const result = await provider.toolEntries[0]!.execute({
        executor: "command",
        command: "ls",
      });
      expect(result.error).toBe(true);
      expect(result.output).toContain("title is required");
    });

    it("should return error for invalid executor", async () => {
      const provider = createAsyncRunToolProvider(createMockManager());
      const result = await provider.toolEntries[0]!.execute({
        executor: "invalid",
        title: "Test",
      });
      expect(result.error).toBe(true);
      expect(result.output).toContain(
        "executor must be 'command' or 'subagent'",
      );
    });

    it("should return error for missing command", async () => {
      const provider = createAsyncRunToolProvider(createMockManager());
      const result = await provider.toolEntries[0]!.execute({
        executor: "command",
        title: "Test",
      });
      expect(result.error).toBe(true);
      expect(result.output).toContain("command is required");
    });

    it("should return error for missing prompt", async () => {
      const provider = createAsyncRunToolProvider(createMockManager());
      const result = await provider.toolEntries[0]!.execute({
        executor: "subagent",
        title: "Test",
      });
      expect(result.error).toBe(true);
      expect(result.output).toContain("prompt is required");
    });

    it("should return error when resources is an array", async () => {
      const provider = createAsyncRunToolProvider(createMockManager());
      const result = await provider.toolEntries[0]!.execute({
        executor: "command",
        title: "Test",
        command: "ls",
        resources: [],
      });
      expect(result.error).toBe(true);
      expect(result.output).toContain("resources must be an object");
    });

    it("should return error when resources.read_paths is missing", async () => {
      const provider = createAsyncRunToolProvider(createMockManager());
      const result = await provider.toolEntries[0]!.execute({
        executor: "command",
        title: "Test",
        command: "ls",
        resources: { write_paths: [] },
      });
      expect(result.error).toBe(true);
      expect(result.output).toContain("resources.read_paths must be an array");
    });

    it("should return JSON with run_id on success", async () => {
      const manager = createMockManager();
      const provider = createAsyncRunToolProvider(manager);
      const result = await provider.toolEntries[0]!.execute({
        executor: "command",
        title: "Run typecheck",
        command: "npm run typecheck",
        resources: { read_paths: [], write_paths: [] },
      });
      expect(result.error).toBe(false);
      const json = JSON.parse(result.output);
      expect(json.type).toBe("async_run_started");
      expect(json.run_id).toMatch(/^ar_/);
      expect(json.status).toBe("running");
      expect(json.executor).toBe("command");
      expect(json.title).toBe("Run typecheck");
      expect(json.resource_claim).toBeDefined();
    });

    it("should propagate manager errors", async () => {
      const manager = createMockManager({
        start: vi.fn().mockImplementation(() => {
          throw new Error("Concurrency limit reached");
        }),
      });
      const provider = createAsyncRunToolProvider(manager);
      const result = await provider.toolEntries[0]!.execute({
        executor: "command",
        title: "Test",
        command: "ls",
        resources: { read_paths: [], write_paths: [] },
      });
      expect(result.error).toBe(true);
      expect(result.output).toContain("Concurrency limit reached");
    });
  });

  describe("run_async_check", () => {
    it("should return error for unknown run", async () => {
      const provider = createAsyncRunToolProvider(createMockManager());
      const result = await provider.toolEntries[1]!.execute({
        run_id: "ar_unknown",
      });
      expect(result.error).toBe(true);
      expect(result.output).toContain("not found");
    });

    it("should return status JSON for known run", async () => {
      const mockRecord: AsyncRunRecord = {
        id: "ar_test",
        executor: "command",
        title: "Test",
        status: "completed",
        resourceClaim: { readPaths: ["src"], writePaths: [] },
        startedAt: "2026-05-19T12:00:00.000Z",
        timeoutAt: "2026-05-19T12:02:00.000Z",
        finishedAt: "2026-05-19T12:00:30.000Z",
        durationMs: 30000,
        preview: "Done",
        outputPath: "/tmp/output.txt",
        trigger: { kind: "manual" },
      };
      const manager = createMockManager({
        check: vi.fn().mockReturnValue(mockRecord),
      });
      const provider = createAsyncRunToolProvider(manager);
      const result = await provider.toolEntries[1]!.execute({
        run_id: "ar_test",
      });
      expect(result.error).toBe(false);
      const json = JSON.parse(result.output);
      expect(json.type).toBe("async_run_status");
      expect(json.run_id).toBe("ar_test");
      expect(json.status).toBe("completed");
    });
  });

  describe("run_async_list", () => {
    it("should return empty list JSON", async () => {
      const provider = createAsyncRunToolProvider(createMockManager());
      const result = await provider.toolEntries[2]!.execute({});
      expect(result.error).toBe(false);
      const json = JSON.parse(result.output);
      expect(json.type).toBe("async_run_list");
      expect(json.count).toBe(0);
      expect(json.runs).toEqual([]);
    });

    it("should pass status filter to manager", async () => {
      const manager = createMockManager();
      const provider = createAsyncRunToolProvider(manager);
      await provider.toolEntries[2]!.execute({ status: "running" });
      expect(manager.list).toHaveBeenCalledWith({
        status: "running",
        includeTerminal: undefined,
      });
    });
  });

  describe("run_async_output_read", () => {
    it("should return output JSON", async () => {
      const provider = createAsyncRunToolProvider(createMockManager());
      const result = await provider.toolEntries[3]!.execute({
        run_id: "ar_test",
      });
      expect(result.error).toBe(false);
      const json = JSON.parse(result.output);
      expect(json.type).toBe("async_run_output");
      expect(json.run_id).toBe("ar_test");
      expect(json.content).toBe("output content");
    });

    it("should reject path parameter", async () => {
      // run_async_output_read 只接受 run_id，不接受 path
      const provider = createAsyncRunToolProvider(createMockManager());
      const result = await provider.toolEntries[3]!.execute({
        run_id: "ar_test",
      });
      expect(result.error).toBe(false);
    });

    it("should return error when readOutput fails", async () => {
      const manager = createMockManager({
        readOutput: vi.fn().mockImplementation(() => {
          throw new Error("Output not found");
        }),
      });
      const provider = createAsyncRunToolProvider(manager);
      const result = await provider.toolEntries[3]!.execute({
        run_id: "ar_test",
      });
      expect(result.error).toBe(true);
      expect(result.output).toContain("Output not found");
    });
  });
});
