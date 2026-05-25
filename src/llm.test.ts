/**
 * llm.ts — LLM 客户端单元测试
 *
 * 覆盖：non-streaming 路径、streaming 路径的 content/tool_calls 聚合、llmLogger 调用。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createLLMClient, type LLMResponse } from "./llm.js";
import type { ResolvedLLMConfig } from "./llm-providers.js";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

// ============================================================
// Mock OpenAI SDK
// ============================================================

const mockCreate = vi.fn();

vi.mock("openai", () => {
  return {
    default: vi.fn().mockImplementation(() => ({
      chat: {
        completions: {
          create: mockCreate,
        },
      },
    })),
  };
});

// ============================================================
// Mock LLMLogger
// ============================================================

function createMockLLMLogger() {
  return {
    logRequest: vi.fn(),
    logResponse: vi.fn(),
  };
}

// ============================================================
// 辅助函数
// ============================================================

function createResolvedConfig(
  overrides: Partial<ResolvedLLMConfig> = {},
): ResolvedLLMConfig {
  return {
    provider: "openai_compatible",
    displayName: "OpenAI-compatible",
    apiKey: "sk-test",
    baseURL: "https://api.test.com/v1",
    model: "test-model",
    capabilities: {
      supportsTools: true,
      supportsToolChoiceRequired: false,
      prefersStreaming: false,
      supportsThinking: false,
    },
    ...overrides,
  };
}

const dummyMessages: ChatCompletionMessageParam[] = [
  { role: "user", content: "hello" },
];

const dummyTools: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "run_bash",
      description: "Run bash command",
      parameters: { type: "object", properties: {} },
    },
  },
];

// ============================================================
// Non-streaming 路径
// ============================================================

describe("non-streaming 路径", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  it("调用 chat.completions.create() 一次并解析 content/tool_calls", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: "Hello world",
            tool_calls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "run_bash", arguments: '{"command":"ls"}' },
              },
            ],
          },
          finish_reason: "stop",
        },
      ],
    });

    const config = createResolvedConfig();
    const llm = createLLMClient(config);
    const result = await llm.chat(dummyMessages, dummyTools);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.model).toBe("test-model");
    expect(callArgs.messages).toBe(dummyMessages);
    expect(callArgs.tools).toBe(dummyTools);

    expect(result.content).toBe("Hello world");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.id).toBe("call_1");
    expect(result.toolCalls[0]!.function.name).toBe("run_bash");
    expect(result.finishReason).toBe("stop");
  });

  it("tools 为空时不传 tools 参数", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "OK" }, finish_reason: "stop" }],
    });

    const config = createResolvedConfig();
    const llm = createLLMClient(config);
    await llm.chat(dummyMessages, []);

    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.tools).toBeUndefined();
  });

  it("content 为 null 时统一为 null", async () => {
    mockCreate.mockResolvedValue({
      choices: [
        {
          message: {
            content: null,
            tool_calls: [],
          },
          finish_reason: "stop",
        },
      ],
    });

    const config = createResolvedConfig();
    const llm = createLLMClient(config);
    const result = await llm.chat(dummyMessages);

    expect(result.content).toBeNull();
    expect(result.toolCalls).toEqual([]);
  });

  it("空 choices 时抛出错误", async () => {
    mockCreate.mockResolvedValue({ choices: [] });

    const config = createResolvedConfig();
    const llm = createLLMClient(config);
    await expect(llm.chat(dummyMessages)).rejects.toThrow(
      "No response from LLM",
    );
  });

  it("调用 llmLogger.logResponse()", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
    });

    const logger = createMockLLMLogger();
    const config = createResolvedConfig();
    const llm = createLLMClient(config, logger);
    await llm.chat(dummyMessages);

    expect(logger.logResponse).toHaveBeenCalledTimes(1);
    const loggedResult = logger.logResponse.mock.calls[0]![0] as LLMResponse;
    expect(loggedResult.content).toBe("Hi");
  });
});

// ============================================================
// Streaming 路径
// ============================================================

describe("streaming 路径", () => {
  beforeEach(() => {
    mockCreate.mockReset();
  });

  function createMockStream(chunks: unknown[]) {
    return {
      [Symbol.asyncIterator]: async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      },
    };
  }

  it("能聚合多段 content", async () => {
    mockCreate.mockResolvedValue(
      createMockStream([
        {
          choices: [{ delta: { content: "Hello" }, finish_reason: null }],
        },
        {
          choices: [{ delta: { content: " world" }, finish_reason: null }],
        },
        {
          choices: [{ delta: { content: "!" }, finish_reason: "stop" }],
        },
      ]),
    );

    const config = createResolvedConfig({
      capabilities: {
        supportsTools: true,
        supportsToolChoiceRequired: false,
        prefersStreaming: true,
        supportsThinking: false,
      },
    });
    const llm = createLLMClient(config);
    const result = await llm.chat(dummyMessages);

    expect(mockCreate).toHaveBeenCalledTimes(1);
    const callArgs = mockCreate.mock.calls[0]![0];
    expect(callArgs.stream).toBe(true);

    expect(result.content).toBe("Hello world!");
    expect(result.toolCalls).toEqual([]);
    expect(result.finishReason).toBe("stop");
  });

  it("能聚合 tool_calls arguments 分片", async () => {
    mockCreate.mockResolvedValue(
      createMockStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "run_bash", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: '{"command":"' },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    function: { arguments: 'ls"}' },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    );

    const config = createResolvedConfig({
      capabilities: {
        supportsTools: true,
        supportsToolChoiceRequired: false,
        prefersStreaming: true,
        supportsThinking: false,
      },
    });
    const llm = createLLMClient(config);
    const result = await llm.chat(dummyMessages, dummyTools);

    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.id).toBe("call_1");
    expect(result.toolCalls[0]!.function.name).toBe("run_bash");
    expect(result.toolCalls[0]!.function.arguments).toBe('{"command":"ls"}');
    expect(result.finishReason).toBe("tool_calls");
  });

  it("多 tool call 按 index 分组聚合", async () => {
    mockCreate.mockResolvedValue(
      createMockStream([
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "run_bash", arguments: "" },
                  },
                  {
                    index: 1,
                    id: "call_2",
                    type: "function",
                    function: { name: "run_read", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"c' } },
                  { index: 1, function: { arguments: '{"p' } },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: 'md":"ls"}' } },
                  { index: 1, function: { arguments: 'ath":"x"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      ]),
    );

    const config = createResolvedConfig({
      capabilities: {
        supportsTools: true,
        supportsToolChoiceRequired: false,
        prefersStreaming: true,
        supportsThinking: false,
      },
    });
    const llm = createLLMClient(config);
    const result = await llm.chat(dummyMessages, dummyTools);

    expect(result.toolCalls).toHaveLength(2);
    expect(result.toolCalls[0]!.function.name).toBe("run_bash");
    expect(result.toolCalls[0]!.function.arguments).toBe('{"cmd":"ls"}');
    expect(result.toolCalls[1]!.function.name).toBe("run_read");
    expect(result.toolCalls[1]!.function.arguments).toBe('{"path":"x"}');
  });

  it("content 为空字符串时返回 null", async () => {
    mockCreate.mockResolvedValue(
      createMockStream([
        {
          choices: [{ delta: {}, finish_reason: "stop" }],
        },
      ]),
    );

    const config = createResolvedConfig({
      capabilities: {
        supportsTools: true,
        supportsToolChoiceRequired: false,
        prefersStreaming: true,
        supportsThinking: false,
      },
    });
    const llm = createLLMClient(config);
    const result = await llm.chat(dummyMessages);

    expect(result.content).toBeNull();
  });

  it("streaming 结束后调用 llmLogger.logResponse()", async () => {
    mockCreate.mockResolvedValue(
      createMockStream([
        {
          choices: [{ delta: { content: "Hi" }, finish_reason: "stop" }],
        },
      ]),
    );

    const logger = createMockLLMLogger();
    const config = createResolvedConfig({
      capabilities: {
        supportsTools: true,
        supportsToolChoiceRequired: false,
        prefersStreaming: true,
        supportsThinking: false,
      },
    });
    const llm = createLLMClient(config, logger);
    await llm.chat(dummyMessages);

    expect(logger.logResponse).toHaveBeenCalledTimes(1);
    const loggedResult = logger.logResponse.mock.calls[0]![0] as LLMResponse;
    expect(loggedResult.content).toBe("Hi");
  });
});
