/**
 * llm.ts — 大语言模型（LLM）客户端模块
 *
 * 职责：封装与 LLM API 的通信，对外提供简洁的 chat() 接口。
 *
 * 关键设计决策：
 * - 使用 OpenAI SDK 接入所有 OpenAI-compatible 的 provider
 * - 通过 RuntimePolicy 驱动 LLMRequestAdapter，内部根据 policy 做协议适配
 * - streaming 聚合完全隐藏在 adapter 内，agent.ts 不感知 provider 差异
 * - LLMClient 接口保持不变，子智能体和 Async Run 复用同一个实例
 *
 * 向后兼容：
 * - createLLMClient() 的第三个参数 runtimePolicy 是可选的
 * - 不传时，从 ResolvedLLMConfig 构造一个默认 policy，保持旧行为
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { LLMLogger } from "./llm-logger.js";
import type { CacheDebugState } from "./cache-debug.js";
import type { ResolvedLLMConfig } from "./llm-providers.js";
import type { RuntimePolicy } from "./runtime-policy.js";
import {
  createOpenAIChatCompletionsAdapter,
  createStreamingAccumulator,
  type LLMUsageTelemetry,
} from "./llm-adapter.js";

/**
 * LLMResponse — LLM 返回结果的类型定义
 *
 * LLM 的响应可能包含：
 * - content：文本回复
 * - toolCalls：工具调用请求
 * - finishReason：停止原因
 * - assistantMessage：可直接写入 History 的原始 assistant 消息（含 provider 字段）
 * - reasoning：规范化后的 reasoning 内容
 * - usage：token 使用统计
 */
export interface LLMResponse {
  /** 模型生成的文本内容，如果没有文本回复则为 null */
  content: string | null;
  /** 模型请求调用的工具列表，如果没有工具调用则为空数组 */
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  /** 模型停止生成的原因，例如 "stop"、"length"、null 等 */
  finishReason: string | null;
  /**
   * 可直接写入 History 的 assistant 消息。
   * 当模型需要回放 reasoning_content/reasoning_details 时，agent 应优先保存它，
   * 而不是自己重新拼 content/tool_calls。
   */
  assistantMessage: ChatCompletionMessageParam;
  /**
   * 规范化后的 reasoning 内容，用于日志、调试和测试。
   * 不一定进入普通最终回复。
   */
  reasoning?: {
    content: string | null;
    details?: unknown;
    source:
      | "reasoning_content"
      | "reasoning_details"
      | "content_think_tags"
      | "none";
  };
  /** 规范化后的 usage 统计 */
  usage?: LLMUsageTelemetry;
}

/**
 * LLMClient — LLM 客户端的接口
 *
 * 为什么用接口？
 * - 依赖反转原则：agent.ts 依赖这个接口，而不是具体实现
 * - 测试时可以用 mock 实现替换，不需要真的调用 API
 * - 将来换 LLM 提供商时，只需要写一个新的实现
 */
export interface LLMClient {
  /**
   * 发送对话请求
   * @param messages - 对话历史（包含 system/user/assistant/tool 角色的消息）
   * @param tools - 可用工具的定义列表（可选，传了模型才知道能调用哪些工具）
   * @param cacheDebug - 可选的缓存调试状态，用于 LLM 日志记录前缀稳定性
   */
  chat(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
    cacheDebug?: CacheDebugState,
  ): Promise<LLMResponse>;
}

/**
 * createLLMClient — 创建 LLM 客户端实例
 *
 * @param config - 由 llm-providers.ts 解析得到的 ResolvedLLMConfig
 * @param llmLogger - 可选的 LLM 通信日志记录器
 * @param runtimePolicy - 可选的运行时策略；若提供，则驱动 adapter 做协议适配
 * @returns LLMClient 接口的实现
 */
export function createLLMClient(
  config: ResolvedLLMConfig,
  llmLogger?: LLMLogger,
  runtimePolicy?: RuntimePolicy | (() => RuntimePolicy),
): LLMClient {
  // 创建 OpenAI SDK 客户端
  // 保留 provider-specific 的 header 设置（如 Kimi Code 的 User-Agent）
  const defaultHeaders: Record<string, string> =
    config.provider === "kimi_code_cn" ? { "User-Agent": "KimiCLI/1.0" } : {};

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders,
  });

  return {
    async chat(messages, tools, cacheDebug) {
      // 每次 chat() 都重新获取当前 policy，支持运行时 CLI 修改（/m、/t）即时生效
      const policy =
        typeof runtimePolicy === "function"
          ? runtimePolicy()
          : (runtimePolicy ?? buildLegacyPolicy(config));

      // 创建协议适配器（policy 可能已变化）
      const adapter = createOpenAIChatCompletionsAdapter(policy);

      // 1. 协议适配：prepare messages（如补充 reasoning_content 占位）
      const processedMessages = adapter.prepareMessages(messages);

      // 2. 构建请求参数
      const prepared = tools
        ? adapter.buildRequest({ messages: processedMessages, tools })
        : adapter.buildRequest({ messages: processedMessages });

      // 3. 组装最终请求体
      const baseParams: Record<string, unknown> = {
        model: prepared.model,
        messages: prepared.messages,
      };

      if (tools && tools.length > 0) {
        baseParams.tools = tools;
      }

      // max token 字段根据 policy 选择
      baseParams[prepared.maxTokensField] = prepared.maxOutputTokens;

      // 注入 extraBody（如 thinking 参数）
      if (prepared.extraBody && Object.keys(prepared.extraBody).length > 0) {
        Object.assign(baseParams, prepared.extraBody);
      }

      // 记录请求日志
      llmLogger?.logRequest(processedMessages, tools, cacheDebug);

      const startTime = Date.now();

      // 4. 根据策略选择 streaming 或 non-streaming 路径
      if (prepared.stream) {
        const result = await chatStreaming(client, baseParams, adapter, llmLogger, startTime);
        return result;
      }

      const response = await client.chat.completions.create(baseParams as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParams);
      const durationMs = Date.now() - startTime;

      const result = adapter.parseNonStreamingResponse(response);

      llmLogger?.logResponse(result, durationMs);
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming 聚合实现
// ---------------------------------------------------------------------------

async function chatStreaming(
  client: OpenAI,
  params: Record<string, unknown>,
  adapter: ReturnType<typeof createOpenAIChatCompletionsAdapter>,
  llmLogger: LLMLogger | undefined,
  startTime: number,
): Promise<LLMResponse> {
  const stream = await client.chat.completions.create({
    ...params,
    stream: true,
  } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

  const acc = createStreamingAccumulator();

  for await (const chunk of stream) {
    adapter.parseStreamingChunk(chunk, acc);
  }

  const durationMs = Date.now() - startTime;
  const result = adapter.finishStreaming(acc);

  llmLogger?.logResponse(result, durationMs);
  return result;
}

// ---------------------------------------------------------------------------
// 向后兼容：从 ResolvedLLMConfig 构造默认 RuntimePolicy
// ---------------------------------------------------------------------------

function buildLegacyPolicy(config: ResolvedLLMConfig): RuntimePolicy {
  // 这是为旧测试和未传入 runtimePolicy 的调用点准备的兼容层。
  // 它尽量保持与旧 llm.ts 行为一致：
  // - streaming 由 config.capabilities.prefersStreaming 决定
  // - Kimi Code CN 的 reasoning_content 占位由 provider 名决定
  return {
    modelProfileId: "legacy",
    provider: config.provider,
    model: config.model,
    protocol: { selected: "openai-chat-completions", implemented: true },
    context: {
      contextWindowTokens: 128000,
      effectiveBudgetTokens: 80000,
      longContextThresholdTokens: 80000,
      compressionMode: "balanced",
      toolOutputCompressionThresholdTokens: 4000,
      decayThresholdLoops: 5,
      decayPreviewTokens: 200,
      compactKeepRecentBlocks: 6,
    },
    request: {
      prefersStreaming: config.capabilities.prefersStreaming,
      maxOutputTokens: 4096,
      maxTokensField: "max_tokens",
      thinkingMode: config.capabilities.supportsThinking ? "adaptive" : "disabled",
      extraBody: {},
    },
    reasoning: {
      returned: false,
      preserveRawAssistantMessage: false,
      mustReplayWithToolCalls: config.provider === "kimi_code_cn",
      responseFields: [],
      streamingDeltaFields: [],
    },
    tools: {
      supportsTools: config.capabilities.supportsTools,
      supportsToolChoiceRequired: config.capabilities.supportsToolChoiceRequired,
      allowedToolChoiceModes: ["auto", "none"],
      streamingArguments: config.capabilities.prefersStreaming,
      multimodalToolResults: false,
    },
    cache: {
      supported: false,
      automatic: false,
      exposeUsage: false,
      usageFields: {},
    },
    telemetry: {
      recordReasoningTokens: false,
      recordCacheTokens: false,
      recordEffectiveContextBudget: false,
    },
  };
}
