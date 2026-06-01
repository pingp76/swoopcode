/**
 * agent.test.ts — Agent 与 Hook 集成测试
 *
 * 使用 fake LLM、fake ToolRegistry、fake PermissionManager 测试
 * Agent 主流程中的 Hook 触发行为，不调用真实模型。
 */
import { describe, it, expect, vi } from "vitest";
import { createAgent } from "./agent.js";
import { createHookRunner } from "./hooks.js";
import type { HookHandler } from "./hooks.js";
import { createHistory } from "./history.js";
import { createContextCompressor } from "./compressor.js";
import type { LLMClient, LLMResponse } from "./llm.js";
import type { ToolRegistry, ToolExecutor } from "./tools/registry.js";
import type { ToolResult } from "./tools/types.js";
import type { Logger } from "./logger.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import * as recovery from "./recovery.js";
import { createTranscriptStore } from "./transcript.js";

// ============================================================
// Mock 工具
// ============================================================

/** 创建 mock 日志器（所有方法都是 spy） */
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * Mock LLM 响应输入（允许省略 assistantMessage，内部自动补全）
 */
type MockResponseInput = Omit<LLMResponse, "assistantMessage"> &
  Partial<Pick<LLMResponse, "assistantMessage">>;

/**
 * 创建 mock LLM 客户端
 *
 * @param responses - 预设的响应序列，每次调用 chat() 返回下一个
 */
function createMockLLM(responses: MockResponseInput[]): LLMClient {
  let callIndex = 0;
  return {
    async chat() {
      const resp = responses[callIndex++];
      if (!resp) throw new Error("No more mock responses");
      return {
        ...resp,
        assistantMessage:
          resp.assistantMessage ??
          ({
            role: "assistant",
            content: resp.content ?? null,
            ...(resp.toolCalls.length > 0
              ? { tool_calls: resp.toolCalls }
              : {}),
          } as ChatCompletionMessageParam),
      } as LLMResponse;
    },
  };
}

/**
 * 创建 mock 工具注册表
 *
 * @param toolName - 工具名称
 * @param executor - 工具执行函数
 */
function createMockToolRegistry(
  toolName: string,
  executor: ToolExecutor,
): ToolRegistry {
  const definition: ChatCompletionTool = {
    type: "function",
    function: {
      name: toolName,
      description: `Mock ${toolName}`,
      parameters: { type: "object", properties: {} },
    },
  };
  return {
    getToolDefinitions: () => [definition],
    getExecutor: (name: string) => (name === toolName ? executor : undefined),
  };
}

/** 创建 mock PermissionManager（auto 模式，全部放行） */
function createMockPermissionManager() {
  return {
    check: () => ({ action: "allow" as const }),
    setMode: vi.fn(),
    getMode: () => "auto" as const,
    getProjectDir: () => "/tmp",
  };
}

/** 构造一个 tool_call 对象 */
function makeToolCall(
  id: string,
  name: string,
  args: string = "{}",
): {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
} {
  return {
    id,
    type: "function" as const,
    function: { name, arguments: args },
  };
}

// ============================================================
// Agent 集成测试
// ============================================================

describe("Agent Hook 集成", () => {
  /** 创建测试用 Agent 的辅助函数 */
  function createTestAgent(deps: {
    llmResponses: MockResponseInput[];
    toolName?: string;
    toolExecutor?: ToolExecutor;
    hookHandlers?: Partial<Record<string, HookHandler[]>>;
  }) {
    const logger = createMockLogger();
    const toolName = deps.toolName ?? "run_bash";
    const toolExecutor =
      deps.toolExecutor ??
      (async () => ({ output: "tool output", error: false }) as ToolResult);

    const history = createHistory();
    const compressor = createContextCompressor({
      thresholdToolOutput: 2000,
      decayThreshold: 3,
      decayPreviewTokens: 100,
      maxContextTokens: 80000,
      compactKeepRecent: 4,
    });
    const permissionManager = createMockPermissionManager();
    const hookRunner = createHookRunner(deps.hookHandlers ?? {}, logger);

    const agent = createAgent({
      llm: createMockLLM(deps.llmResponses),
      history,
      tools: createMockToolRegistry(toolName, toolExecutor),
      logger,
      compressor,
      permissionManager,
      hookRunner,
    });

    return { agent, history, logger };
  }

  // -----------------------------------------------------------------
  // SessionStart
  // -----------------------------------------------------------------

  it("SessionStart exitCode 2 时，在首次 LLM 调用前注入补充消息", async () => {
    const logger = createMockLogger();
    const history = createHistory();
    const compressor = createContextCompressor({
      thresholdToolOutput: 2000,
      decayThreshold: 3,
      decayPreviewTokens: 100,
      maxContextTokens: 80000,
      compactKeepRecent: 4,
    });
    const hookRunner = createHookRunner(
      {
        SessionStart: [
          () => ({
            exitCode: 2 as const,
            message: "工作目录提示",
          }),
        ],
      },
      logger,
    );

    const agent = createAgent({
      llm: createMockLLM([
        { content: "done", toolCalls: [], finishReason: "stop" },
      ]),
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "ok",
        error: false,
      })),
      logger,
      compressor,
      permissionManager: createMockPermissionManager(),
      hookRunner,
    });

    await agent.run("hello");

    // history 中应有 Hook 注入的补充消息
    // 注意：prepareMessages 管道会合并连续 user 消息，所以检查 history 而非 LLM 输入
    const entries = history.getEntries();
    const hookEntries = entries.filter(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes(
          "[Hook: SessionStart]",
        ),
    );
    expect(hookEntries.length).toBeGreaterThanOrEqual(1);
    // 验证 Hook 消息的内容包含 handler 返回的文本
    const hookContent = (hookEntries[0]!.message as { content: string })
      .content;
    expect(hookContent).toContain("工作目录提示");
  });

  it("SessionStart 每个 Agent 实例只触发一次", async () => {
    const sessionHandler = vi
      .fn<HookHandler>()
      .mockReturnValue({ exitCode: 0 });

    const { agent } = createTestAgent({
      llmResponses: [
        // 第一次 run
        { content: "first response", toolCalls: [], finishReason: "stop" },
        // 第二次 run
        { content: "second response", toolCalls: [], finishReason: "stop" },
      ],
      hookHandlers: { SessionStart: [sessionHandler] },
    });

    await agent.run("first query");
    await agent.run("second query");

    // SessionStart handler 只应被调用一次（第一次 run）
    expect(sessionHandler).toHaveBeenCalledTimes(1);
  });

  it("连续 run 使用递增 turnIndex 和全局 loopIndex", async () => {
    const logger = createMockLogger();
    const history = createHistory();
    const transcriptStore = createTranscriptStore({
      now: () => new Date("2026-05-29T00:00:00.000Z"),
      idGenerator: () => "event",
    });
    const agent = createAgent({
      llm: createMockLLM([
        { content: "first response", toolCalls: [], finishReason: "stop" },
        { content: "second response", toolCalls: [], finishReason: "stop" },
      ]),
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "ok",
        error: false,
      })),
      logger,
      compressor: createContextCompressor(),
      permissionManager: createMockPermissionManager(),
      transcriptStore,
      sessionId: "main-session",
    });

    await agent.run("first query");
    await agent.run("second query");

    const entries = history.getEntries();
    expect(entries.map((e) => e.turnIndex)).toEqual([1, 1, 2, 2]);
    expect(entries.map((e) => e.loopRound)).toEqual([0, 1, 0, 1]);
    expect(entries.map((e) => e.loopIndex)).toEqual([1, 1, 2, 2]);
    expect(entries.map((e) => e.messageSequence)).toEqual([1, 2, 3, 4]);

    const events = transcriptStore.readSession("main-session");
    expect(events.map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(events.map((e) => e.historySequence)).toEqual([1, 2, 3, 4]);
    expect(events.map((e) => e.loopIndex)).toEqual([1, 1, 2, 2]);
  });

  it("SessionStart exitCode 1 时，history 不写入用户消息", async () => {
    const { agent, history } = createTestAgent({
      llmResponses: [
        // 第二次 run（如果 SessionStart 没被正确处理，可能需要这个响应）
        { content: "second response", toolCalls: [], finishReason: "stop" },
      ],
      hookHandlers: {
        SessionStart: [
          () => ({
            exitCode: 1 as const,
            message: "禁止启动",
          }),
        ],
      },
    });

    // 第一次 run 被 SessionStart block
    const result = await agent.run("blocked query");
    expect(result).toBe("禁止启动");

    // history 中不应有任何消息（block 在 appendMessage 之前）
    expect(history.getEntries()).toHaveLength(0);

    // 第二次 run 应该正常工作（SessionStart 不再触发，history 干净）
    const result2 = await agent.run("second query");
    expect(result2).toBe("second response");

    // history 中只有第二次 run 的消息
    const entries = history.getEntries();
    expect(entries.length).toBeGreaterThanOrEqual(1);
    // 不应包含被阻止的 query
    const blockedQuery = entries.find(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes(
          "blocked query",
        ),
    );
    expect(blockedQuery).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // PreToolUse
  // -----------------------------------------------------------------

  it("PreToolUse exitCode 1 时，不执行工具，写入 blocked tool_result", async () => {
    const toolExecutor = vi.fn<ToolExecutor>().mockResolvedValue({
      output: "should not reach",
      error: false,
    });

    const { agent, history } = createTestAgent({
      llmResponses: [
        // 第一轮：LLM 发起工具调用
        {
          content: null,
          toolCalls: [makeToolCall("call_1", "run_bash", '{"command":"ls"}')],
          finishReason: "stop",
        },
        // 第二轮：LLM 看到 blocked 结果后回复
        { content: "understood", toolCalls: [], finishReason: "stop" },
      ],
      toolExecutor,
      hookHandlers: {
        PreToolUse: [
          () => ({
            exitCode: 1 as const,
            message: "禁止执行",
          }),
        ],
      },
    });

    const result = await agent.run("run ls");

    // 工具执行函数不应被调用
    expect(toolExecutor).not.toHaveBeenCalled();

    // 历史中应有 blocked tool_result
    const entries = history.getEntries();
    const blockedEntry = entries.find(
      (e) =>
        (e.message as { role: string }).role === "tool" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes(
          "Blocked by PreToolUse hook",
        ),
    );
    expect(blockedEntry).toBeDefined();

    // 最终回复是 LLM 看到 blocked 后的回复
    expect(result).toBe("understood");
  });

  it("PreToolUse exitCode 2 时，工具照常执行，所有 tool_result 后追加 user 补充消息", async () => {
    const toolExecutor = vi.fn<ToolExecutor>().mockResolvedValue({
      output: "file list",
      error: false,
    });

    const { agent, history } = createTestAgent({
      llmResponses: [
        {
          content: null,
          toolCalls: [makeToolCall("call_1", "run_bash", '{"command":"ls"}')],
          finishReason: "stop",
        },
        { content: "final answer", toolCalls: [], finishReason: "stop" },
      ],
      toolExecutor,
      hookHandlers: {
        PreToolUse: [
          () => ({
            exitCode: 2 as const,
            message: "即将执行 bash",
          }),
        ],
      },
    });

    await agent.run("run ls");

    // 工具应该被执行
    expect(toolExecutor).toHaveBeenCalledTimes(1);

    // 历史中应有 Hook 注入的 user 消息
    const entries = history.getEntries();
    const userEntries = entries.filter(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes(
          "[Hook: PreToolUse]",
        ),
    );
    expect(userEntries.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------
  // PostToolUse
  // -----------------------------------------------------------------

  it("PostToolUse exitCode 2 时，追加 user 补充消息", async () => {
    const { agent, history } = createTestAgent({
      llmResponses: [
        {
          content: null,
          toolCalls: [makeToolCall("call_1", "run_bash", '{"command":"ls"}')],
          finishReason: "stop",
        },
        { content: "noted", toolCalls: [], finishReason: "stop" },
      ],
      hookHandlers: {
        PostToolUse: [
          () => ({
            exitCode: 2 as const,
            message: "工具执行完毕提醒",
          }),
        ],
      },
    });

    await agent.run("run ls");

    const entries = history.getEntries();
    const userEntries = entries.filter(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes(
          "[Hook: PostToolUse]",
        ),
    );
    expect(userEntries.length).toBeGreaterThanOrEqual(1);
  });

  // -----------------------------------------------------------------
  // 多 tool call 场景
  // -----------------------------------------------------------------

  it("多 tool call 时，补充消息不插入到 tool_result 中间", async () => {
    const toolExecutor = vi.fn<ToolExecutor>().mockResolvedValue({
      output: "result",
      error: false,
    });

    const { agent, history } = createTestAgent({
      llmResponses: [
        {
          content: null,
          toolCalls: [
            makeToolCall("call_1", "run_bash", '{"command":"ls"}'),
            makeToolCall("call_2", "run_bash", '{"command":"pwd"}'),
          ],
          finishReason: "stop",
        },
        { content: "done", toolCalls: [], finishReason: "stop" },
      ],
      toolExecutor,
      hookHandlers: {
        PreToolUse: [
          () => ({
            exitCode: 2 as const,
            message: "提醒",
          }),
        ],
      },
    });

    await agent.run("run both");

    // 验证历史中消息顺序：
    // assistant(tool_calls) → tool(result1) → tool(result2) → user(hook messages)
    // 中间不应有 user 消息
    const entries = history.getEntries();
    const roles = entries.map((e) => (e.message as { role: string }).role);

    // 找到第一个 tool 消息的索引
    const firstToolIdx = roles.indexOf("tool");
    const lastToolIdx = roles.lastIndexOf("tool");

    // 在 tool 消息之间不应有 user 消息
    const betweenTools = roles.slice(firstToolIdx, lastToolIdx + 1);
    expect(betweenTools.every((r) => r === "tool")).toBe(true);

    // 两个工具都应该被执行
    expect(toolExecutor).toHaveBeenCalledTimes(2);
  });

  it("多 tool call 后下一次 LLM 输入保持 assistant/tool_result/user 顺序", async () => {
    const logger = createMockLogger();
    const history = createHistory();
    const compressor = createContextCompressor({
      thresholdToolOutput: 2000,
      decayThreshold: 3,
      decayPreviewTokens: 100,
      maxContextTokens: 80000,
      compactKeepRecent: 4,
    });
    const toolExecutor = vi.fn<ToolExecutor>().mockResolvedValue({
      output: "result",
      error: false,
    });
    const capturedMessages: ChatCompletionMessageParam[][] = [];
    const responses: MockResponseInput[] = [
      {
        content: null,
        toolCalls: [
          makeToolCall("call_1", "run_bash", '{"command":"ls"}'),
          makeToolCall("call_2", "run_bash", '{"command":"pwd"}'),
        ],
        finishReason: "stop",
      },
      { content: "done", toolCalls: [], finishReason: "stop" },
    ];
    let callIndex = 0;
    const llm: LLMClient = {
      async chat(messages) {
        capturedMessages.push(
          JSON.parse(JSON.stringify(messages)) as ChatCompletionMessageParam[],
        );
        const response = responses[callIndex++];
        if (!response) throw new Error("No more mock responses");
        return {
          ...response,
          assistantMessage:
            response.assistantMessage ??
            ({
              role: "assistant",
              content: response.content ?? null,
              ...(response.toolCalls.length > 0
                ? { tool_calls: response.toolCalls }
                : {}),
            } as ChatCompletionMessageParam),
        } as LLMResponse;
      },
    };

    const agent = createAgent({
      llm,
      history,
      tools: createMockToolRegistry("run_bash", toolExecutor),
      logger,
      compressor,
      permissionManager: createMockPermissionManager(),
      hookRunner: createHookRunner(
        {
          PreToolUse: [
            () => ({
              exitCode: 2 as const,
              message: "提醒",
            }),
          ],
        },
        logger,
      ),
    });

    await agent.run("run both");

    expect(capturedMessages).toHaveLength(2);
    const secondCall = capturedMessages[1]!;
    expect(secondCall.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "user",
    ]);
    expect(
      (secondCall[1] as unknown as { tool_calls: unknown[] }).tool_calls,
    ).toHaveLength(2);
    expect(
      (secondCall[2] as unknown as { tool_call_id: string }).tool_call_id,
    ).toBe("call_1");
    expect(
      (secondCall[3] as unknown as { tool_call_id: string }).tool_call_id,
    ).toBe("call_2");
    // normalizeMessages 合并连续 user 消息，content 可能为数组格式
    const hookContent = secondCall[4]!.content;
    if (Array.isArray(hookContent)) {
      expect(
        hookContent.some(
          (c: unknown) =>
            typeof (c as { text?: string }).text === "string" &&
            (c as { text: string }).text.includes("[Hook: PreToolUse]"),
        ),
      ).toBe(true);
    } else {
      expect(hookContent).toContain("[Hook: PreToolUse]");
    }
  });
});

// ============================================================
// Agent 错误恢复
// ============================================================

describe("Agent 错误恢复", () => {
  /** 创建带指定 LLM 的测试 Agent */
  function createTestAgentWithLLM(llm: LLMClient) {
    const logger = createMockLogger();
    const history = createHistory();
    const compressor = createContextCompressor({
      thresholdToolOutput: 2000,
      decayThreshold: 3,
      decayPreviewTokens: 100,
      maxContextTokens: 80000,
      compactKeepRecent: 4,
    });
    const agent = createAgent({
      llm,
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "ok",
        error: false,
      })),
      logger,
      compressor,
      permissionManager: createMockPermissionManager(),
    });
    return { agent, history, logger };
  }

  it("network 错误在上限内重试并最终成功", async () => {
    const sleepSpy = vi.spyOn(recovery, "sleep").mockResolvedValue(undefined);

    let callCount = 0;
    const llm: LLMClient = {
      async chat() {
        callCount++;
        if (callCount <= 2) {
          throw Object.assign(new Error("timeout"), { status: 504 });
        }
        return {
          content: "success",
          toolCalls: [],
          finishReason: "stop",
          assistantMessage: {
            role: "assistant",
            content: "success",
          } as ChatCompletionMessageParam,
        };
      },
    };

    const { agent } = createTestAgentWithLLM(llm);
    const result = await agent.run("hello");

    expect(result).toBe("success");
    expect(callCount).toBe(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);

    sleepSpy.mockRestore();
  });

  it("network 错误超过上限后返回失败提示", async () => {
    const sleepSpy = vi.spyOn(recovery, "sleep").mockResolvedValue(undefined);

    let callCount = 0;
    const llm: LLMClient = {
      async chat() {
        callCount++;
        throw Object.assign(new Error("timeout"), { status: 504 });
      },
    };

    const { agent } = createTestAgentWithLLM(llm);
    const result = await agent.run("hello");

    expect(result).toContain("暂时不可用");
    // 1 次初始 + 5 次重试（maxApiRetries=5），第 6 次判定为 fail
    expect(callCount).toBe(6);
    expect(sleepSpy).toHaveBeenCalledTimes(5);

    sleepSpy.mockRestore();
  });

  it("credential 错误不重试，直接返回配置提示", async () => {
    const sleepSpy = vi.spyOn(recovery, "sleep").mockResolvedValue(undefined);

    let callCount = 0;
    const llm: LLMClient = {
      async chat() {
        callCount++;
        throw Object.assign(new Error("invalid api key"), { status: 401 });
      },
    };

    const { agent } = createTestAgentWithLLM(llm);
    const result = await agent.run("hello");

    expect(result).toContain("认证配置错误");
    expect(callCount).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();

    sleepSpy.mockRestore();
  });

  it("context_length 错误触发 compact 后再次调用", async () => {
    let callCount = 0;
    const llm: LLMClient = {
      async chat() {
        callCount++;
        if (callCount === 1) {
          throw Object.assign(new Error("context length exceeded"), {
            status: 400,
          });
        }
        return {
          content: "ok after compact",
          toolCalls: [],
          finishReason: "stop",
          assistantMessage: {
            role: "assistant",
            content: "ok after compact",
          } as ChatCompletionMessageParam,
        };
      },
    };

    const { agent } = createTestAgentWithLLM(llm);
    const result = await agent.run("hello");

    expect(result).toBe("ok after compact");
    expect(callCount).toBe(2);
  });

  it("finishReason='length' 且无 tool calls 时追加 continuation reminder", async () => {
    let callCount = 0;
    const llm: LLMClient = {
      async chat() {
        callCount++;
        if (callCount === 1) {
          return {
            content: "partial output",
            toolCalls: [],
            finishReason: "length",
            assistantMessage: {
              role: "assistant",
              content: "partial output",
            } as ChatCompletionMessageParam,
          };
        }
        return {
          content: "continued",
          toolCalls: [],
          finishReason: "stop",
          assistantMessage: {
            role: "assistant",
            content: "continued",
          } as ChatCompletionMessageParam,
        };
      },
    };

    const { agent, history } = createTestAgentWithLLM(llm);
    const result = await agent.run("hello");

    // 累积了第一次的 partial output 与第二次的 continuation
    expect(result).toBe("partial outputcontinued");
    expect(callCount).toBe(2);

    // history 中应有 continuation reminder（user 消息）
    const entries = history.getEntries();
    const reminderEntry = entries.find(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes(
          "从断点继续输出",
        ),
    );
    expect(reminderEntry).toBeDefined();
  });

  it("continuation 超过上限后返回部分内容和中断说明", async () => {
    let callCount = 0;
    const llm: LLMClient = {
      async chat() {
        callCount++;
        return {
          content: `partial ${callCount}`,
          toolCalls: [],
          finishReason: "length",
          assistantMessage: {
            role: "assistant",
            content: `partial ${callCount}`,
          } as ChatCompletionMessageParam,
        };
      },
    };

    const { agent } = createTestAgentWithLLM(llm);
    const result = await agent.run("hello");

    // maxContinueRetries = 2，所以：
    // 第 1 次返回 length -> continue (continueRetryCount=1)
    // 第 2 次返回 length -> continue (continueRetryCount=2)
    // 第 3 次返回 length -> fail (continueRetryCount=2 == max)
    expect(callCount).toBe(3);
    expect(result).toContain("模型输出被截断，已达到继续次数上限");
    expect(result).toContain("partial 3");
  });

  it("带 tool calls 的响应即使 finishReason='length' 也不走 continuation", async () => {
    const toolExecutor = vi.fn<ToolExecutor>().mockResolvedValue({
      output: "tool ok",
      error: false,
    });

    let callCount = 0;
    const llm: LLMClient = {
      async chat() {
        callCount++;
        if (callCount === 1) {
          return {
            content: null,
            toolCalls: [makeToolCall("call_1", "run_bash", '{"command":"ls"}')],
            finishReason: "length",
            assistantMessage: {
              role: "assistant",
              content: null,
              tool_calls: [makeToolCall("call_1", "run_bash", '{"command":"ls"}')],
            } as ChatCompletionMessageParam,
          };
        }
        return {
          content: "done",
          toolCalls: [],
          finishReason: "stop",
          assistantMessage: {
            role: "assistant",
            content: "done",
          } as ChatCompletionMessageParam,
        };
      },
    };

    const { history } = createTestAgentWithLLM(llm);
    // 替换工具执行器
    const agentWithTool = createAgent({
      llm,
      history,
      tools: createMockToolRegistry("run_bash", toolExecutor),
      logger: createMockLogger(),
      compressor: createContextCompressor({
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreviewTokens: 100,
        maxContextTokens: 80000,
        compactKeepRecent: 4,
      }),
      permissionManager: createMockPermissionManager(),
    });

    const result = await agentWithTool.run("run ls");

    expect(result).toBe("done");
    expect(toolExecutor).toHaveBeenCalledTimes(1);

    // 不应有 continuation reminder
    const entries = history.getEntries();
    const reminderEntry = entries.find(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes(
          "从断点继续输出",
        ),
    );
    expect(reminderEntry).toBeUndefined();
  });
});

// ============================================================
// Agent transcript 旁路记录
// ============================================================

describe("Agent transcript", () => {
  it("records raw messages separately from prompt history", async () => {
    const transcriptStore = createTranscriptStore({
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      idGenerator: (() => {
        let id = 0;
        return () => `event-${++id}`;
      })(),
    });
    const history = createHistory();
    const agent = createAgent({
      llm: createMockLLM([
        { content: "done", toolCalls: [], finishReason: "stop" },
      ]),
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "ok",
        error: false,
      })),
      logger: createMockLogger(),
      compressor: createContextCompressor({
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreviewTokens: 100,
        maxContextTokens: 80000,
        compactKeepRecent: 4,
      }),
      permissionManager: createMockPermissionManager(),
      transcriptStore,
      sessionId: "main-session",
    });

    await agent.run("hello");

    const events = transcriptStore.readSession("main-session");
    expect(events.map((e) => e.type)).toEqual([
      "user_message",
      "assistant_message",
    ]);
    expect(events[0]!.payload).toEqual({
      message: { role: "user", content: "hello" },
    });
    expect(history.getEntries()).toHaveLength(2);
  });
});

// ============================================================
// Async run 集成
// ============================================================

describe("Agent async run integration", () => {
  it("drains notifications before each LLM call", async () => {
    const drainSpy = vi.fn().mockReturnValue([]);
    const mockAsyncRunManager = {
      drainNotifications: drainSpy,
      checkForegroundToolConflict: () => ({ blocked: false }),
    };
    const history = createHistory();
    const agent = createAgent({
      llm: createMockLLM([
        { content: "done", toolCalls: [], finishReason: "stop" },
      ]),
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "ok",
        error: false,
      })),
      logger: createMockLogger(),
      compressor: createContextCompressor({
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreviewTokens: 100,
        maxContextTokens: 80000,
        compactKeepRecent: 4,
      }),
      permissionManager: createMockPermissionManager(),
      asyncRunManager: mockAsyncRunManager,
    });

    await agent.run("hello");
    expect(drainSpy).toHaveBeenCalled();
  });

  it("injects system-reminder when notifications exist", async () => {
    const mockAsyncRunManager = {
      drainNotifications: vi
        .fn()
        .mockReturnValueOnce([]) // 第一次：无通知
        .mockReturnValueOnce([
          // 第二次：有通知（在 tool call 之后）
          {
            id: "n1",
            runId: "ar_test",
            type: "async_run_finished",
            status: "completed",
            executor: "command",
            title: "Typecheck",
            preview: "ok",
            timestamp: "2026-05-19T12:00:00.000Z",
          },
        ]),
      checkForegroundToolConflict: () => ({ blocked: false }),
    };
    const history = createHistory();
    const agent = createAgent({
      llm: createMockLLM([
        // 第一轮：返回 tool call，让循环继续到第二轮
        {
          content: null,
          toolCalls: [
            makeToolCall("call_1", "run_bash", '{"command":"echo hello"}'),
          ],
          finishReason: "stop",
        },
        // 第二轮：返回文本
        { content: "done", toolCalls: [], finishReason: "stop" },
      ]),
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "ok",
        error: false,
      })),
      logger: createMockLogger(),
      compressor: createContextCompressor({
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreviewTokens: 100,
        maxContextTokens: 80000,
        compactKeepRecent: 4,
      }),
      permissionManager: createMockPermissionManager(),
      asyncRunManager: mockAsyncRunManager,
    });

    await agent.run("hello");

    const entries = history.getEntries();
    const reminderEntry = entries.find(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes(
          '<system-reminder source="async-run">',
        ),
    );
    expect(reminderEntry).toBeDefined();
  });

  it("reminder contains run_async_output_read guidance", async () => {
    const mockAsyncRunManager = {
      drainNotifications: vi
        .fn()
        .mockReturnValueOnce([])
        .mockReturnValueOnce([
          {
            id: "n1",
            runId: "ar_test",
            type: "async_run_finished",
            status: "completed",
            executor: "command",
            title: "Typecheck",
            preview: "ok",
            timestamp: "2026-05-19T12:00:00.000Z",
          },
        ]),
      checkForegroundToolConflict: () => ({ blocked: false }),
    };
    const history = createHistory();
    const agent = createAgent({
      llm: createMockLLM([
        {
          content: null,
          toolCalls: [
            makeToolCall("call_1", "run_bash", '{"command":"echo hello"}'),
          ],
          finishReason: "stop",
        },
        { content: "done", toolCalls: [], finishReason: "stop" },
      ]),
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "ok",
        error: false,
      })),
      logger: createMockLogger(),
      compressor: createContextCompressor({
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreviewTokens: 100,
        maxContextTokens: 80000,
        compactKeepRecent: 4,
      }),
      permissionManager: createMockPermissionManager(),
      asyncRunManager: mockAsyncRunManager,
    });

    await agent.run("hello");

    const entries = history.getEntries();
    const reminderEntry = entries.find(
      (e) =>
        (e.message as { role: string }).role === "user" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes(
          "run_async_output_read",
        ),
    );
    expect(reminderEntry).toBeDefined();
  });

  it("blocks foreground tool when async conflict detected", async () => {
    const toolExecutor = vi.fn<ToolExecutor>().mockResolvedValue({
      output: "should not reach",
      error: false,
    });
    const mockAsyncRunManager = {
      drainNotifications: vi.fn().mockReturnValue([]),
      checkForegroundToolConflict: () => ({
        blocked: true,
        reason: "Path claimed by running async run",
      }),
    };
    const history = createHistory();
    const agent = createAgent({
      llm: createMockLLM([
        {
          content: null,
          toolCalls: [
            makeToolCall("call_1", "run_write", '{"path":"src/file.ts","content":"x"}'),
          ],
          finishReason: "stop",
        },
        { content: "understood", toolCalls: [], finishReason: "stop" },
      ]),
      history,
      tools: createMockToolRegistry("run_write", toolExecutor),
      logger: createMockLogger(),
      compressor: createContextCompressor({
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreviewTokens: 100,
        maxContextTokens: 80000,
        compactKeepRecent: 4,
      }),
      permissionManager: createMockPermissionManager(),
      asyncRunManager: mockAsyncRunManager,
    });

    const result = await agent.run("write file");

    // 工具不应被执行
    expect(toolExecutor).not.toHaveBeenCalled();

    // 历史中应有 blocked tool_result
    const entries = history.getEntries();
    const blockedEntry = entries.find(
      (e) =>
        (e.message as { role: string }).role === "tool" &&
        typeof (e.message as { content: unknown }).content === "string" &&
        ((e.message as { content: string }).content as string).includes(
          "claimed by running async run",
        ),
    );
    expect(blockedEntry).toBeDefined();
    expect(result).toBe("understood");
  });

  it("allows foreground tool when no async conflict", async () => {
    const toolExecutor = vi.fn<ToolExecutor>().mockResolvedValue({
      output: "written",
      error: false,
    });
    const mockAsyncRunManager = {
      drainNotifications: vi.fn().mockReturnValue([]),
      checkForegroundToolConflict: () => ({ blocked: false }),
    };
    const agent = createAgent({
      llm: createMockLLM([
        {
          content: null,
          toolCalls: [
            makeToolCall("call_1", "run_write", '{"path":"src/file.ts","content":"x"}'),
          ],
          finishReason: "stop",
        },
        { content: "done", toolCalls: [], finishReason: "stop" },
      ]),
      history: createHistory(),
      tools: createMockToolRegistry("run_write", toolExecutor),
      logger: createMockLogger(),
      compressor: createContextCompressor({
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreviewTokens: 100,
        maxContextTokens: 80000,
        compactKeepRecent: 4,
      }),
      permissionManager: createMockPermissionManager(),
      asyncRunManager: mockAsyncRunManager,
    });

    await agent.run("write file");
    expect(toolExecutor).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// Reasoning content preservation (PDD21 Phase 6-7)
// ============================================================

describe("Agent reasoning content preservation", () => {
  it("prefers response.assistantMessage over manual construction", async () => {
    const history = createHistory();
    const capturedMessages: ChatCompletionMessageParam[][] = [];

    const llm: LLMClient = {
      async chat(messages) {
        capturedMessages.push(
          JSON.parse(JSON.stringify(messages)) as ChatCompletionMessageParam[],
        );
        return {
          content: "ok",
          toolCalls: [],
          finishReason: "stop",
          assistantMessage: {
            role: "assistant",
            content: "ok",
            reasoning_content: "I thought about this carefully.",
          } as ChatCompletionMessageParam,
        };
      },
    };

    const agent = createAgent({
      llm,
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "ok",
        error: false,
      })),
      logger: createMockLogger(),
      compressor: createContextCompressor({
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreviewTokens: 100,
        maxContextTokens: 80000,
        compactKeepRecent: 4,
      }),
      permissionManager: createMockPermissionManager(),
    });

    await agent.run("hello");

    // history 中的 assistant 消息应包含 reasoning_content
    const entries = history.getEntries();
    const assistantEntry = entries.find(
      (e) => (e.message as { role: string }).role === "assistant",
    );
    expect(assistantEntry).toBeDefined();
    expect(
      (assistantEntry!.message as unknown as { reasoning_content?: string })
        .reasoning_content,
    ).toBe("I thought about this carefully.");
  });

  it("preserves reasoning_content through message pipeline to next LLM call", async () => {
    const history = createHistory();
    const capturedMessages: ChatCompletionMessageParam[][] = [];
    let callIndex = 0;

    const responses: LLMResponse[] = [
      {
        content: null,
        toolCalls: [
          makeToolCall("call_1", "run_bash", '{"command":"ls"}'),
        ],
        finishReason: "stop",
        assistantMessage: {
          role: "assistant",
          content: null,
          reasoning_content: "Need to list files first",
          tool_calls: [
            makeToolCall("call_1", "run_bash", '{"command":"ls"}'),
          ],
        } as ChatCompletionMessageParam,
      },
      {
        content: "done",
        toolCalls: [],
        finishReason: "stop",
        assistantMessage: {
          role: "assistant",
          content: "done",
        } as ChatCompletionMessageParam,
      },
    ];

    const llm: LLMClient = {
      async chat(messages) {
        capturedMessages.push(
          JSON.parse(JSON.stringify(messages)) as ChatCompletionMessageParam[],
        );
        const resp = responses[callIndex++];
        if (!resp) throw new Error("No more mock responses");
        return resp;
      },
    };

    const agent = createAgent({
      llm,
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "file.txt",
        error: false,
      })),
      logger: createMockLogger(),
      compressor: createContextCompressor({
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreviewTokens: 100,
        maxContextTokens: 80000,
        compactKeepRecent: 4,
      }),
      permissionManager: createMockPermissionManager(),
    });

    await agent.run("list files");

    // 第二次 LLM 调用应包含带 reasoning_content 的 assistant 消息
    expect(capturedMessages).toHaveLength(2);
    const secondCall = capturedMessages[1]!;
    const assistantMsg = secondCall.find((m) => m.role === "assistant");
    expect(assistantMsg).toBeDefined();
    expect(
      (assistantMsg as unknown as { reasoning_content?: string }).reasoning_content,
    ).toBe("Need to list files first");
  });

  it("falls back to manual construction when assistantMessage is missing (backward compat)", async () => {
    const history = createHistory();

    // 构造一个不含 assistantMessage 的 response（模拟旧 mock）
    const llm: LLMClient = {
      async chat() {
        return {
          content: "legacy response",
          toolCalls: [],
          finishReason: "stop",
          // 故意不设置 assistantMessage，测试 fallback 路径
        } as unknown as LLMResponse;
      },
    };

    const agent = createAgent({
      llm,
      history,
      tools: createMockToolRegistry("run_bash", async () => ({
        output: "ok",
        error: false,
      })),
      logger: createMockLogger(),
      compressor: createContextCompressor({
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreviewTokens: 100,
        maxContextTokens: 80000,
        compactKeepRecent: 4,
      }),
      permissionManager: createMockPermissionManager(),
    });

    const result = await agent.run("hello");

    expect(result).toBe("legacy response");
    const entries = history.getEntries();
    const assistantEntry = entries.find(
      (e) => (e.message as { role: string }).role === "assistant",
    );
    expect(assistantEntry).toBeDefined();
    expect(
      (assistantEntry!.message as { content: unknown }).content,
    ).toBe("legacy response");
  });
});
