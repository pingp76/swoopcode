import { describe, it, expect, vi } from "vitest";
import {
  subagentToolDefinition,
  createSubagentToolProvider,
} from "./subagent.js";
import { createToolRegistry } from "./registry.js";
import type { LLMClient, LLMResponse } from "../llm.js";
import type { ToolRegistry } from "./registry.js";
import { createContextCompressor } from "../compressor.js";
import { createPermissionManager } from "../permission.js";
import { createDefaultAsyncCommandPolicy } from "./bash.js";
import { createSessionManager } from "../session.js";
import { createTranscriptStore } from "../transcript.js";

// ============================================================
// Mock 工具：创建可控的 LLM 客户端，用于测试不同场景
// ============================================================

/**
 * createMockLLM — 创建 mock LLM 客户端
 *
 * @param responses - 预设的响应序列，每次调用 chat() 返回下一个
 * 调用完所有预设后抛出错误（测试不应超出预期的调用次数）
 */
function createMockLLM(responses: LLMResponse[]): LLMClient {
  let callIndex = 0;
  return {
    async chat() {
      const resp = responses[callIndex++];
      if (!resp) throw new Error("No more mock responses");
      return resp;
    },
  };
}

/**
 * createAlwaysToolCallLLM — 创建永远返回工具调用的 mock LLM
 *
 * 用于测试轮数上限：LLM 不断请求调用 run_bash，永远不会自然结束
 */
function createAlwaysToolCallLLM(): LLMClient {
  return {
    async chat() {
      return {
        content: null,
        toolCalls: [
          {
            id: "call_mock",
            type: "function",
            function: {
              name: "run_bash",
              arguments: '{"command":"echo still running"}',
            },
          },
        ],
        finishReason: "stop",
        assistantMessage: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_mock",
              type: "function",
              function: {
                name: "run_bash",
                arguments: '{"command":"echo still running"}',
              },
            },
          ],
        } as import("openai/resources/chat/completions").ChatCompletionMessageParam,
      };
    },
  };
}

/**
 * createMockLogger — 创建 mock 日志器
 */
function createMockLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// ============================================================
// 测试：工具定义
// ============================================================

describe("subagentToolDefinition", () => {
  it("has correct tool name", () => {
    expect(subagentToolDefinition.function.name).toBe("run_subagent");
  });

  it("requires task parameter", () => {
    const required = subagentToolDefinition.function.parameters?.required;
    expect(required).toContain("task");
  });

  it("has optional max_rounds parameter", () => {
    const props = subagentToolDefinition.function.parameters?.properties ?? {};
    expect(props).toHaveProperty("task");
    expect(props).toHaveProperty("max_rounds");
    expect(subagentToolDefinition.function.parameters?.required).not.toContain(
      "max_rounds",
    );
  });

  it("description mentions synchronous use case", () => {
    const desc = subagentToolDefinition.function.description ?? "";
    expect(desc).toContain("run_subagent");
    expect(desc).toContain("need the result");
  });

  it("description mentions run_async_start for non-blocking work", () => {
    const desc = subagentToolDefinition.function.description ?? "";
    expect(desc).toContain("run_async_start");
    expect(desc).toContain("non-blocking");
  });

  it("description mentions executor=subagent", () => {
    const desc = subagentToolDefinition.function.description ?? "";
    expect(desc).toContain('executor="subagent"');
  });
});

// ============================================================
// 测试：executeSubagent 执行器
// ============================================================

describe("createSubagentToolProvider", () => {
  // 权限管理器：auto 模式允许所有操作，避免权限拦截干扰 subagent 测试
  const testPermissionManager = createPermissionManager(process.cwd());
  testPermissionManager.setMode("auto");

  it("returns provider with one tool entry", () => {
    const provider = createSubagentToolProvider({
      llm: createMockLLM([]),
      logger: createMockLogger(),
      createFilteredRegistry: () =>
        createToolRegistry() as unknown as ToolRegistry,
      createAgentFn: vi.fn(),
      createCompressorFn: () => createContextCompressor(),
      permissionManager: testPermissionManager,
      commandPolicy: createDefaultAsyncCommandPolicy(),
    });

    expect(provider.toolEntries).toHaveLength(1);
    expect(provider.toolEntries[0]?.definition).toBe(subagentToolDefinition);
  });

  it("returns error when task is empty", async () => {
    const execute = createSubagentToolProvider({
      llm: createMockLLM([]),
      logger: createMockLogger(),
      createFilteredRegistry: () =>
        createToolRegistry() as unknown as ToolRegistry,
      createAgentFn: vi.fn(),
      createCompressorFn: () => createContextCompressor(),
      permissionManager: testPermissionManager,
      commandPolicy: createDefaultAsyncCommandPolicy(),
    }).toolEntries[0]!.execute;

    const result = await execute({ task: "" });
    expect(result.error).toBe(true);
    expect(result.output).toContain("required");
  });

  it("returns error when task is whitespace only", async () => {
    const execute = createSubagentToolProvider({
      llm: createMockLLM([]),
      logger: createMockLogger(),
      createFilteredRegistry: () =>
        createToolRegistry() as unknown as ToolRegistry,
      createAgentFn: vi.fn(),
      createCompressorFn: () => createContextCompressor(),
      permissionManager: testPermissionManager,
      commandPolicy: createDefaultAsyncCommandPolicy(),
    }).toolEntries[0]!.execute;

    const result = await execute({ task: "   " });
    expect(result.error).toBe(true);
    expect(result.output).toContain("required");
  });

  it("returns success result from sub-agent", async () => {
    // 子 Agent 的 LLM 直接返回文本回复（无工具调用），模拟任务一步完成
    const mockLLM = createMockLLM([
      {
        content: "Analysis complete: found 3 issues",
        toolCalls: [],
        finishReason: "stop",
        assistantMessage: {
          role: "assistant",
          content: "Analysis complete: found 3 issues",
        } as import("openai/resources/chat/completions").ChatCompletionMessageParam,
      },
    ]);
    const mockLogger = createMockLogger();

    // 用真实的 createToolRegistry 创建过滤后的注册表
    const filteredRegistry = createToolRegistry() as unknown as ToolRegistry;

    // 捕获传给 createAgentFn 的参数，验证正确性
    let capturedMaxRounds: number | undefined;
    const provider = createSubagentToolProvider({
      llm: mockLLM,
      logger: mockLogger,
      createFilteredRegistry: () => filteredRegistry,
      createAgentFn: (deps) => {
        capturedMaxRounds = deps.maxRounds;
        // 返回一个 mock Agent，直接返回结果
        return {
          run: async () => "Analysis complete: found 3 issues",
        };
      },
      createCompressorFn: () => createContextCompressor(),
      permissionManager: testPermissionManager,
      commandPolicy: createDefaultAsyncCommandPolicy(),
    });

    const result = await provider.toolEntries[0]!.execute({
      task: "analyze the code",
    });

    expect(result.error).toBe(false);
    expect(result.output).toBe("Analysis complete: found 3 issues");
    // 默认 max_rounds 是 20
    expect(capturedMaxRounds).toBe(20);
  });

  it("passes custom max_rounds to sub-agent", async () => {
    let capturedMaxRounds: number | undefined;
    const provider = createSubagentToolProvider({
      llm: createMockLLM([]),
      logger: createMockLogger(),
      createFilteredRegistry: () =>
        createToolRegistry() as unknown as ToolRegistry,
      createAgentFn: (deps) => {
        capturedMaxRounds = deps.maxRounds;
        return { run: async () => "done" };
      },
      createCompressorFn: () => createContextCompressor(),
      permissionManager: testPermissionManager,
      commandPolicy: createDefaultAsyncCommandPolicy(),
    });

    await provider.toolEntries[0]!.execute({
      task: "quick task",
      max_rounds: "5",
    });

    expect(capturedMaxRounds).toBe(5);
  });

  it("creates a child session and passes it to the sub-agent", async () => {
    const sessionManager = createSessionManager({
      projectRoot: "/repo",
      model: "test-model",
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      idGenerator: (() => {
        let id = 0;
        return () => `session-${++id}`;
      })(),
    });
    const transcriptStore = createTranscriptStore();
    const parent = sessionManager.createMainSession();

    let capturedSessionId: string | undefined;
    const provider = createSubagentToolProvider({
      llm: createMockLLM([]),
      logger: createMockLogger(),
      createFilteredRegistry: () =>
        createToolRegistry() as unknown as ToolRegistry,
      createAgentFn: (deps) => {
        capturedSessionId = deps.sessionId;
        expect(deps.transcriptStore).toBe(transcriptStore);
        return { run: async () => "done" };
      },
      createCompressorFn: () => createContextCompressor(),
      permissionManager: testPermissionManager,
      commandPolicy: createDefaultAsyncCommandPolicy(),
      sessionManager,
      transcriptStore,
      parentSessionId: parent.id,
    });

    await provider.toolEntries[0]!.execute({ task: "child task" });

    expect(capturedSessionId).toBe("session-2");
    const child = sessionManager.get("session-2");
    expect(child?.kind).toBe("subagent");
    expect(child?.parentSessionId).toBe(parent.id);
    expect(child?.endedAt).toBe("2026-05-11T00:00:00.000Z");
  });

  it("returns error when LLM throws", async () => {
    // 创建一个会抛错的 mock LLM
    const failingLLM: LLMClient = {
      async chat() {
        throw new Error("API rate limit exceeded");
      },
    };

    // createAgentFn 返回一个真实使用 failingLLM 的 Agent
    // Agent 现在内置错误恢复：不再直接把错误抛出，而是分类后返回失败提示
    const { createAgent } = await import("../agent.js");
    const permissionManager = createPermissionManager(process.cwd());
    permissionManager.setMode("auto"); // auto 模式允许 bash，避免权限拦截干扰测试
    const provider = createSubagentToolProvider({
      llm: failingLLM,
      logger: createMockLogger(),
      createFilteredRegistry: () =>
        createToolRegistry() as unknown as ToolRegistry,
      createAgentFn: createAgent,
      createCompressorFn: () => createContextCompressor(),
      permissionManager,
      commandPolicy: createDefaultAsyncCommandPolicy(),
    });

    const result = await provider.toolEntries[0]!.execute({
      task: "will fail",
    });

    // Agent 内部捕获错误并返回失败提示，不再向上抛出
    expect(result.error).toBe(false);
    expect(result.output).toContain("未知错误");
    expect(result.output).toContain("API rate limit exceeded");
  });
});

// ============================================================
// 测试：过滤后的工具注册表
// ============================================================

describe("filtered tool registry for sub-agent", () => {
  it("contains only bash and file tools (5 tools)", () => {
    // createToolRegistry() 不传任何 provider → 只有 bash + files
    const registry = createToolRegistry();
    const defs = registry.getToolDefinitions();

    expect(defs).toHaveLength(5);

    const names = defs.map((d) => d.function.name);
    expect(names).toContain("run_bash");
    expect(names).toContain("run_read");
    expect(names).toContain("run_write");
    expect(names).toContain("run_edit");
    expect(names).toContain("run_edit_exact");
  });

  it("does not contain run_subagent", () => {
    const registry = createToolRegistry();
    const names = registry.getToolDefinitions().map((d) => d.function.name);
    expect(names).not.toContain("run_subagent");
  });

  it("does not contain run_todo tools", () => {
    const registry = createToolRegistry();
    const names = registry.getToolDefinitions().map((d) => d.function.name);
    for (const name of names) {
      expect(name?.startsWith("run_todo_")).toBe(false);
    }
  });
});

// ============================================================
// 测试：轮数上限（使用真实的 createAgent + mock LLM）
// ============================================================

describe("sub-agent round limit", () => {
  it("stops at max_rounds and returns round-limit message", async () => {
    // LLM 永远返回工具调用（run_bash），永远不会自然结束
    const alwaysToolCallLLM = createAlwaysToolCallLLM();
    const mockLogger = createMockLogger();
    const filteredRegistry = createToolRegistry() as unknown as ToolRegistry;

    const { createAgent } = await import("../agent.js");
    const permissionManager = createPermissionManager(process.cwd());
    permissionManager.setMode("auto");

    const provider = createSubagentToolProvider({
      llm: alwaysToolCallLLM,
      logger: mockLogger,
      createFilteredRegistry: () => filteredRegistry,
      createAgentFn: createAgent,
      createCompressorFn: () => createContextCompressor(),
      permissionManager,
      commandPolicy: createDefaultAsyncCommandPolicy(),
    });

    // 设置 max_rounds = 3，子 Agent 应该在 3 轮后强制停止
    const result = await provider.toolEntries[0]!.execute({
      task: "infinite task",
      max_rounds: "3",
    });

    expect(result.error).toBe(false);
    expect(result.output).toContain("Round limit reached");
    expect(result.output).toContain("3");
  });
});
