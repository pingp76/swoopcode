/**
 * llm-adapter.ts — LLM 请求适配器模块
 *
 * 职责：把项目内部统一的消息/工具/策略转换成某协议请求，
 * 并把响应转换回统一 LLMResponse。
 *
 * 第一版只实现 OpenAI Chat Completions adapter。
 * Anthropic adapter 留给后续任务。
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { RuntimePolicy } from "./runtime-policy.js";
import type { LLMResponse } from "./llm.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * LLMUsageTelemetry — 规范化后的 usage 统计
 */
export interface LLMUsageTelemetry {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cachedTokens?: number;
  raw?: unknown;
}

/**
 * PreparedLLMRequest — 适配器准备好的请求
 */
export interface PreparedLLMRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  stream: boolean;
  extraBody?: Record<string, unknown>;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  maxOutputTokens: number;
}

/**
 * StreamingAccumulator — streaming 聚合状态
 */
export interface StreamingAccumulator {
  content: string;
  finishReason: string | null;
  toolCallAccumulators: Map<
    number,
    {
      id?: string;
      type?: "function";
      name?: string;
      arguments: string;
    }
  >;
  reasoningContent: string;
  /** 累积的 reasoning_details（如 MiniMax M3 返回的数组或对象） */
  reasoningDetails?: unknown;
  sawChoice: boolean;
  usage?: LLMUsageTelemetry | undefined;
}

/**
 * LLMRequestAdapter — 请求适配器接口
 */
export interface LLMRequestAdapter {
  prepareMessages(
    messages: ChatCompletionMessageParam[],
  ): ChatCompletionMessageParam[];
  buildRequest(input: {
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
  }): PreparedLLMRequest;
  parseNonStreamingResponse(response: unknown): LLMResponse;
  parseStreamingChunk(chunk: unknown, acc: StreamingAccumulator): void;
  finishStreaming(acc: StreamingAccumulator): LLMResponse;
}

// ---------------------------------------------------------------------------
// OpenAI Chat Completions Adapter
// ---------------------------------------------------------------------------

/**
 * 创建 OpenAI Chat Completions 适配器
 *
 * 处理 OpenAI SDK 的请求构造和响应解析，包括：
 * - reasoning_content 占位补充
 * - max token 字段选择
 * - thinking extraBody 注入
 * - streaming / non-streaming 响应解析
 * - usage / reasoning 提取
 */
export function createOpenAIChatCompletionsAdapter(
  policy: RuntimePolicy,
): LLMRequestAdapter {
  return {
    prepareMessages(messages) {
      // 教学导读：
      // adapter 只做协议字段适配，不做语义修复。
      // 这里根据 policy 补充必要的 reasoning_content 占位，
      // 避免某些兼容接口因缺少该字段返回 400。

      if (!policy.reasoning.mustReplayWithToolCalls) {
        return messages;
      }

      return messages.map((msg) => {
        if (msg.role !== "assistant") {
          return msg;
        }

        const m = msg as unknown as Record<string, unknown>;
        if (m.tool_calls && !m.reasoning_content && !m.reasoning_details) {
          return {
            ...msg,
            reasoning_content: "",
          } as ChatCompletionMessageParam;
        }
        return msg;
      });
    },

    buildRequest(input) {
      const result: PreparedLLMRequest = {
        model: policy.model,
        messages: input.messages,
        stream: policy.request.prefersStreaming,
        extraBody: policy.request.extraBody,
        maxTokensField: policy.request.maxTokensField,
        maxOutputTokens: policy.request.maxOutputTokens,
      };
      if (input.tools !== undefined) {
        result.tools = input.tools;
      }
      return result;
    },

    parseNonStreamingResponse(response) {
      const completion = response as OpenAI.Chat.Completions.ChatCompletion;
      const choice = completion.choices?.[0];
      if (!choice) {
        throw new Error("No response from LLM");
      }

      const message = choice.message;
      const toolCalls = message.tool_calls ?? [];

      // 构建可直接写入 history 的 assistant message
      const assistantMessage: ChatCompletionMessageParam = {
        role: "assistant",
        content: message.content ?? null,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      } as ChatCompletionMessageParam;

      // 如果模型返回 reasoning 字段，保留在 assistantMessage 中
      const rawMsg = message as unknown as Record<string, unknown>;
      if (
        rawMsg.reasoning_content &&
        typeof rawMsg.reasoning_content === "string"
      ) {
        (
          assistantMessage as unknown as Record<string, unknown>
        ).reasoning_content = rawMsg.reasoning_content;
      }
      if (rawMsg.reasoning_details) {
        (
          assistantMessage as unknown as Record<string, unknown>
        ).reasoning_details = rawMsg.reasoning_details;
      }

      const result: LLMResponse = {
        content: message.content ?? null,
        toolCalls,
        finishReason: choice.finish_reason ?? null,
        assistantMessage,
      };
      const reasoning = extractReasoning(message, policy);
      if (reasoning !== undefined) {
        result.reasoning = reasoning;
      }
      const usage = extractUsage(completion.usage, policy);
      if (usage !== undefined) {
        result.usage = usage;
      }
      return result;
    },

    parseStreamingChunk(chunk, acc) {
      const completionChunk =
        chunk as OpenAI.Chat.Completions.ChatCompletionChunk;
      const choice = completionChunk.choices?.[0];
      if (!choice) {
        // 某些 provider 会在最后一个 chunk 返回 usage，不含 choices
        const chunkRaw = chunk as unknown as { usage?: unknown };
        if (chunkRaw.usage) {
          acc.usage = extractUsage(
            chunkRaw.usage as OpenAI.Completions.CompletionUsage | undefined,
            policy,
          );
        }
        return;
      }
      acc.sawChoice = true;

      const delta = choice.delta;

      // 聚合文本 content
      if (delta.content) {
        acc.content += delta.content;
      }

      // 聚合 tool_calls delta
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          const existing = acc.toolCallAccumulators.get(idx) ?? {
            arguments: "",
          };

          if (tc.id) existing.id = tc.id;
          if (tc.type) existing.type = tc.type as "function";
          if (tc.function?.name) existing.name = tc.function.name;
          if (tc.function?.arguments) {
            existing.arguments += tc.function.arguments;
          }

          acc.toolCallAccumulators.set(idx, existing);
        }
      }

      // 聚合 reasoning_content delta
      const deltaRaw = delta as unknown as Record<string, unknown>;
      if (typeof deltaRaw.reasoning_content === "string") {
        acc.reasoningContent += deltaRaw.reasoning_content;
      }

      // 聚合 reasoning_details delta（MiniMax M3 等模型）
      if (deltaRaw.reasoning_details) {
        if (Array.isArray(deltaRaw.reasoning_details)) {
          if (!acc.reasoningDetails) {
            acc.reasoningDetails = [];
          }
          (acc.reasoningDetails as unknown[]).push(
            ...deltaRaw.reasoning_details,
          );
        } else if (typeof deltaRaw.reasoning_details === "string") {
          acc.reasoningDetails =
            ((acc.reasoningDetails as string | undefined) ?? "") +
            deltaRaw.reasoning_details;
        } else {
          acc.reasoningDetails = deltaRaw.reasoning_details;
        }
      }

      // 记录 finish_reason
      if (choice.finish_reason) {
        acc.finishReason = choice.finish_reason;
      }
    },

    finishStreaming(acc) {
      if (!acc.sawChoice) {
        throw new Error("No response from LLM");
      }

      // 将累积的 tool call 数据转换为标准格式
      const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] =
        [];
      const sortedIndices = Array.from(acc.toolCallAccumulators.keys()).sort(
        (a, b) => a - b,
      );
      for (const idx of sortedIndices) {
        const a = acc.toolCallAccumulators.get(idx)!;
        toolCalls.push({
          id: a.id ?? `call_stream_${idx}`,
          type: a.type ?? "function",
          function: {
            name: a.name ?? "",
            arguments: a.arguments,
          },
        });
      }

      const content = acc.content.length > 0 ? acc.content : null;

      // 构建 assistant message
      const assistantMessage: ChatCompletionMessageParam = {
        role: "assistant",
        content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      } as ChatCompletionMessageParam;

      // 如果有 reasoning content 或 reasoning details，加入 assistant message
      if (acc.reasoningContent) {
        (
          assistantMessage as unknown as Record<string, unknown>
        ).reasoning_content = acc.reasoningContent;
      }
      if (acc.reasoningDetails !== undefined) {
        (
          assistantMessage as unknown as Record<string, unknown>
        ).reasoning_details = acc.reasoningDetails;
      }

      const result: LLMResponse = {
        content,
        toolCalls,
        finishReason: acc.finishReason,
        assistantMessage,
      };
      if (
        acc.reasoningContent ||
        acc.reasoningDetails !== undefined ||
        policy.reasoning.returned
      ) {
        if (acc.reasoningDetails !== undefined) {
          result.reasoning = {
            content: null,
            details: acc.reasoningDetails,
            source: "reasoning_details",
          };
        } else {
          result.reasoning = {
            content: acc.reasoningContent || null,
            source: "reasoning_content",
          };
        }
      }
      if (acc.usage !== undefined) {
        result.usage = acc.usage;
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

/**
 * 提取 reasoning 内容
 */
function extractReasoning(
  message: OpenAI.Chat.Completions.ChatCompletionMessage,
  policy: RuntimePolicy,
): LLMResponse["reasoning"] {
  if (!policy.reasoning.returned) {
    return undefined;
  }

  const raw = message as unknown as Record<string, unknown>;

  if (typeof raw.reasoning_content === "string" && raw.reasoning_content) {
    return {
      content: raw.reasoning_content,
      source: "reasoning_content",
    };
  }

  if (raw.reasoning_details) {
    return {
      content: null,
      details: raw.reasoning_details,
      source: "reasoning_details",
    };
  }

  const content = message.content ?? "";
  if (typeof content === "string") {
    const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/);
    if (thinkMatch) {
      return {
        content: thinkMatch[1] ?? null,
        source: "content_think_tags",
      };
    }
  }

  return undefined;
}

/**
 * 提取 usage 统计
 */
function extractUsage(
  usage: OpenAI.Completions.CompletionUsage | undefined,
  policy: RuntimePolicy,
): LLMUsageTelemetry | undefined {
  if (!usage) {
    return undefined;
  }

  const telemetry: LLMUsageTelemetry = {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    raw: usage,
  };

  // 提取 reasoning tokens（OpenAI 格式）
  const raw = usage as unknown as Record<string, unknown>;
  if (
    typeof raw.completion_tokens_details === "object" &&
    raw.completion_tokens_details !== null
  ) {
    const details = raw.completion_tokens_details as Record<string, unknown>;
    if (typeof details.reasoning_tokens === "number") {
      telemetry.reasoningTokens = details.reasoning_tokens;
    }
  }

  // 提取 cache tokens（根据 profile 配置的字段名）
  if (policy.cache.supported && policy.cache.exposeUsage) {
    const usageFields = policy.cache.usageFields;
    if (
      usageFields.hitTokens &&
      typeof raw[usageFields.hitTokens] === "number"
    ) {
      telemetry.cacheHitTokens = raw[usageFields.hitTokens] as number;
    }
    if (
      usageFields.missTokens &&
      typeof raw[usageFields.missTokens] === "number"
    ) {
      telemetry.cacheMissTokens = raw[usageFields.missTokens] as number;
    }
    if (
      usageFields.cachedTokens &&
      typeof raw[usageFields.cachedTokens] === "number"
    ) {
      telemetry.cachedTokens = raw[usageFields.cachedTokens] as number;
    }
  }

  return telemetry;
}

/**
 * 创建初始的 streaming accumulator
 */
export function createStreamingAccumulator(): StreamingAccumulator {
  return {
    content: "",
    finishReason: null,
    toolCallAccumulators: new Map(),
    reasoningContent: "",
    sawChoice: false,
  };
}
