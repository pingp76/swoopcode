/**
 * llm.ts — 大语言模型（LLM）客户端模块
 *
 * 职责：封装与 LLM API 的通信，对外提供简洁的 chat() 接口。
 *
 * 关键设计决策：
 * - 使用 OpenAI SDK 接入所有 OpenAI-compatible 的 provider
 * - 通过 ResolvedLLMConfig 传入 provider 信息，内部根据 capabilities 做兼容适配
 * - streaming 聚合完全隐藏在 llm.ts 内，agent.ts 不感知 provider 差异
 * - LLMClient 接口保持不变，子智能体和 Async Run 复用同一个实例
 *
 * OpenAI SDK 的工作流程：
 * 1. 创建 OpenAI 客户端实例（配置 apiKey 和 baseURL）
 * 2. 调用 client.chat.completions.create() 发送对话请求
 * 3. 若 provider prefersStreaming，使用 stream: true 并聚合 delta
 * 4. 解析返回的响应，提取文本内容和工具调用信息
 */

import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { LLMLogger } from "./llm-logger.js";
import type { CacheDebugState } from "./cache-debug.js";
import type { ResolvedLLMConfig } from "./llm-providers.js";

/**
 * LLMResponse — LLM 返回结果的类型定义
 *
 * LLM 的响应可能包含两种内容：
 * - content：文本回复（模型生成的文字）
 * - toolCalls：工具调用请求（模型认为需要执行某个工具）
 *
 * 这两者可能同时存在，也可能只有其中一个。
 */
export interface LLMResponse {
  /** 模型生成的文本内容，如果没有文本回复则为 null */
  content: string | null;
  /** 模型请求调用的工具列表，如果没有工具调用则为空数组 */
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  /** 模型停止生成的原因，例如 "stop"、"length"、null 等 */
  finishReason: string | null;
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
 * @returns LLMClient 接口的实现
 *
 * 工厂函数模式：把创建逻辑封装在函数中，调用者不需要知道
 * 内部使用的是 streaming 还是 non-streaming 路径。
 */
export function createLLMClient(
  config: ResolvedLLMConfig,
  llmLogger?: LLMLogger,
): LLMClient {
  // 设计套路：把 provider 差异收敛在 LLMClient 边界。
  // agent.ts 只依赖 LLMClient.chat(messages, tools)，不关心：
  // - baseURL 是 OpenAI 还是 Kimi 兼容端点
  // - 是否必须 streaming
  // - 某个 provider 是否需要额外 header 或 reasoning_content
  //
  // 常见错误是把这些 if(provider === "...") 散落到 agent 主循环里，
  // 结果每接一个 provider 都污染核心 Agent 逻辑。

  // 创建 OpenAI SDK 客户端，通过 baseURL 重定向到对应的 provider 服务器
  // Kimi Code CN 的 OpenAI 兼容端点要求特定的 User-Agent，否则返回 403
  const defaultHeaders: Record<string, string> =
    config.provider === "kimi_code_cn" ? { "User-Agent": "KimiCLI/1.0" } : {};

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    defaultHeaders,
  });

  return {
    async chat(messages, tools, cacheDebug) {
      // 消息已由调用方（agent.ts）完成标准化和压缩处理
      // 这里直接使用传入的消息，不再做任何转换
      //
      // 重要边界：LLMClient 不负责修复 tool_call/tool_result 顺序。
      // 那属于 normalize.ts / agent.ts 的协议整理职责。
      // LLMClient 只处理 provider 传输层兼容性，避免层次混乱。

      // Kimi Code 兼容：当 thinking 启用时，包含 tool_calls 的 assistant 消息
      // 必须同时包含 reasoning_content，否则返回 400 错误。
      // 如果历史消息中的 assistant tool call 缺少该字段，补充空字符串占位。
      // 这是 provider 方言适配的典型例子：
      // 标准 OpenAI 消息不要求 reasoning_content，但某些兼容接口会要求。
      // 适配放在这里，agent/history/normalize 都不需要知道这个特殊字段。
      const processedMessages =
        config.provider === "kimi_code_cn"
          ? messages.map((msg) => {
              if (msg.role === "assistant") {
                const m = msg as unknown as Record<string, unknown>;
                if (m.tool_calls && !m.reasoning_content) {
                  return {
                    ...msg,
                    reasoning_content: "",
                  } as ChatCompletionMessageParam;
                }
              }
              return msg;
            })
          : messages;

      // 记录发送给 LLM 的请求（消息列表 + 工具定义 + 可选 cache debug）
      llmLogger?.logRequest(processedMessages, tools, cacheDebug);

      // 基础请求参数：模型名和消息列表
      const baseParams = {
        model: config.model,
        messages: processedMessages,
      };

      // 调用参数：只有当 tools 不为空时才传入 tools 参数
      // 这是因为某些模型在不传 tools 时行为不同（不会尝试调用工具）
      // 另一个隐藏坑：有些兼容 provider 对 tools: [] 和“不传 tools”
      // 的处理不同。这里选择无工具时完全省略字段，减少 provider 兼容问题。
      const params =
        tools && tools.length > 0 ? { ...baseParams, tools } : baseParams;

      // 记录请求开始时间，用于计算耗时
      const startTime = Date.now();

      // 根据 provider 能力选择 streaming 或 non-streaming 路径
      if (config.capabilities.prefersStreaming) {
        // 两条路径最终都返回同一个 LLMResponse 形状。
        // 这样 agent.ts 不需要关心 provider 是流式还是非流式，只处理统一结果。
        const result = await chatStreaming(
          client,
          params,
          llmLogger,
          startTime,
        );
        return result;
      }

      const response = await client.chat.completions.create(params);
      const durationMs = Date.now() - startTime;

      // 从响应中提取第一个（通常也是唯一的）选择的结果
      const choice = response.choices?.[0];
      if (!choice) {
        // 记录原始响应结构，帮助诊断 API 异常
        // 空 choices 不是可恢复的正常响应。
        // 这里抛错交给 recovery.ts 分类；同时截断日志，避免把超大响应打满终端。
        console.warn(
          "[llm] Empty choices in response: %s",
          JSON.stringify(response).slice(0, 500),
        );
        throw new Error("No response from LLM");
      }

      const message = choice.message;
      const result: LLMResponse = {
        // content 可能为 null（比如模型只返回了工具调用，没有文字）
        content: message.content ?? null,
        // tool_calls 可能为 undefined，统一转为空数组方便后续处理
        toolCalls: message.tool_calls ?? [],
        // finish_reason 表示生成停止的原因，如 "stop"、"length" 等
        finishReason: choice.finish_reason ?? null,
      };

      // 记录从 LLM 收到的响应（内容 + 工具调用 + 耗时）
      llmLogger?.logResponse(result, durationMs);

      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Streaming 聚合实现
// ---------------------------------------------------------------------------

/**
 * 通过 streaming 方式调用 LLM，并聚合 delta 为统一的 LLMResponse
 *
 * 聚合规则：
 * - content：累加所有 chunk.choices[0].delta.content
 * - tool_calls：按 index 分组，累加 function.arguments，保留 id/name/type
 * - finish_reason：取最后一个非 null 的 finish_reason
 */
async function chatStreaming(
  client: OpenAI,
  params: {
    model: string;
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
  },
  llmLogger: LLMLogger | undefined,
  startTime: number,
): Promise<LLMResponse> {
  // streaming 聚合是 function calling 最容易写错的地方。
  // 文本 delta 可以简单拼接，但 tool_calls 的 function.arguments 往往被拆成很多片，
  // 甚至一片只有 "{"，下一片才有字段内容。必须按 tool_call index 累积。
  //
  // 常见错误：
  // - 每个 chunk 都 push 一个 tool_call，导致一次工具调用变成多次
  // - 忽略 index，多个并行 tool call 的 arguments 混在一起
  // - finish_reason 只看第一片，错过最后的 length/tool_calls/stop
  const stream = await client.chat.completions.create({
    ...params,
    stream: true,
  });

  // 聚合状态
  let content = "";
  let finishReason: string | null = null;
  let sawChoice = false;

  // 按 index 累积 tool call delta
  // key: tool call index, value: 累积中的 tool call 数据
  const toolCallAccumulators = new Map<
    number,
    {
      id?: string;
      type?: "function";
      name?: string;
      arguments: string;
    }
  >();

  for await (const chunk of stream) {
    const choice = chunk.choices?.[0];
    // 某些兼容 API 可能发送心跳 chunk 或空 choices。
    // 空 chunk 不代表失败，只有整个 stream 都没有 choice 才在末尾抛错。
    if (!choice) continue;
    sawChoice = true;

    const delta = choice.delta;

    // 聚合文本 content
    if (delta.content) {
      content += delta.content;
    }

    // 聚合 tool_calls delta
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        // OpenAI 风格 streaming 会把同一个 tool call 的字段拆成多片：
        // 第一片可能只有 id/name，后续多片逐步追加 arguments。
        // 所以这里必须按 index 找到累积器，而不是把每个 chunk 当成一个完整调用。
        const existing = toolCallAccumulators.get(idx) ?? { arguments: "" };

        if (tc.id) {
          existing.id = tc.id;
        }
        if (tc.type) {
          existing.type = tc.type as "function";
        }
        if (tc.function?.name) {
          existing.name = tc.function.name;
        }
        if (tc.function?.arguments) {
          existing.arguments += tc.function.arguments;
        }

        toolCallAccumulators.set(idx, existing);
      }
    }

    // 记录 finish_reason（通常在最后一个 chunk 出现）
    if (choice.finish_reason) {
      finishReason = choice.finish_reason;
    }
  }

  const durationMs = Date.now() - startTime;

  // 如果 stream 没有任何有效 choice，和 non-streaming 路径保持一致，抛出错误
  if (!sawChoice) {
    console.warn("[llm] Empty stream: no choices received");
    throw new Error("No response from LLM");
  }

  // 将累积的 tool call 数据转换为标准 ChatCompletionMessageToolCall 格式
  const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];

  // 按 index 排序，保证顺序稳定
  const sortedIndices = Array.from(toolCallAccumulators.keys()).sort(
    (a, b) => a - b,
  );

  for (const idx of sortedIndices) {
    const acc = toolCallAccumulators.get(idx)!;
    // id/name/type 理论上应由上游提供，但兼容 provider 可能缺字段。
    // 这里补默认值是为了让后续 tool_call / tool_result 配对流程仍有稳定结构。
    //
    // 注意：如果 name 为空，后续 ToolRegistry 会返回 Unknown tool。
    // 这里不提前丢弃，是为了保留模型原始意图并让主循环生成可见错误反馈。
    toolCalls.push({
      id: acc.id ?? `call_stream_${idx}`,
      type: acc.type ?? "function",
      function: {
        name: acc.name ?? "",
        arguments: acc.arguments,
      },
    });
  }

  const result: LLMResponse = {
    content: content.length > 0 ? content : null,
    toolCalls,
    finishReason,
  };

  // 记录从 LLM 收到的响应（内容 + 工具调用 + 耗时）
  llmLogger?.logResponse(result, durationMs);

  return result;
}
