/**
 * llm.ts — 大语言模型（LLM）客户端模块
 *
 * 职责：封装与 LLM API 的通信，对外提供简洁的 chat() 接口。
 *
 * 关键设计决策：
 * - 使用 OpenAI SDK 而非自己封装 HTTP 请求，因为 MiniMax 提供 OpenAI 兼容的 API 格式
 * - 通过 baseURL 参数将请求指向 MiniMax 的服务器，而不是 OpenAI 的
 * - 定义 LLMClient 接口，便于将来替换为其他 LLM 提供商
 *
 * OpenAI SDK 的工作流程：
 * 1. 创建 OpenAI 客户端实例（配置 apiKey 和 baseURL）
 * 2. 调用 client.chat.completions.create() 发送对话请求
 * 3. 解析返回的响应，提取文本内容和工具调用信息
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions";
import type { LLMLogger } from "./llm-logger.js";
import type { CacheDebugState } from "./cache-debug.js";

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
 * @param config - 包含 apiKey、baseURL、model 的配置对象
 * @returns LLMClient 接口的实现
 *
 * 工厂函数模式：把创建逻辑封装在函数中，调用者不需要知道
 * 内部使用的是 OpenAI SDK 还是其他实现。
 */
export function createLLMClient(config: {
  apiKey: string;
  baseURL: string;
  model: string;
}, llmLogger?: LLMLogger): LLMClient {
  // 创建 OpenAI SDK 客户端，通过 baseURL 重定向到 MiniMax 的服务器
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
  });

  return {
    async chat(messages, tools, cacheDebug) {
      // 消息已由调用方（agent.ts）完成标准化和压缩处理
      // 这里直接使用传入的消息，不再做任何转换

      // 记录发送给 LLM 的请求（消息列表 + 工具定义 + 可选 cache debug）
      llmLogger?.logRequest(messages, tools, cacheDebug);

      // 基础请求参数：模型名和消息列表
      const baseParams = {
        model: config.model,
        messages,
      };

      // 调用参数：只有当 tools 不为空时才传入 tools 参数
      // 这是因为某些模型在不传 tools 时行为不同（不会尝试调用工具）
      const params =
        tools && tools.length > 0 ? { ...baseParams, tools } : baseParams;

      // 简单重试机制：API 偶尔返回空 choices（限流、瞬时故障等）
      const maxRetries = 2;
      let lastError: Error | undefined;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        // 记录请求开始时间，用于计算耗时
        const startTime = Date.now();

        try {
          const response = await client.chat.completions.create(params);
          const durationMs = Date.now() - startTime;

          // 从响应中提取第一个（通常也是唯一的）选择的结果
          const choice = response.choices?.[0]?.message;
          if (!choice) {
            // 记录原始响应结构，帮助诊断 API 异常
            console.warn(
              "[llm] Empty choices in response (attempt %d/%d): %s",
              attempt + 1,
              maxRetries + 1,
              JSON.stringify(response).slice(0, 500),
            );
            lastError = new Error(
              `No response from LLM (empty choices, attempt ${attempt + 1}/${maxRetries + 1})`,
            );
            // 等待一小段时间再重试，避免紧密循环
            if (attempt < maxRetries) {
              await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
            }
            continue;
          }

          const result = {
            // content 可能为 null（比如模型只返回了工具调用，没有文字）
            content: choice.content ?? null,
            // tool_calls 可能为 undefined，统一转为空数组方便后续处理
            toolCalls: choice.tool_calls ?? [],
          };

          // 记录从 LLM 收到的响应（内容 + 工具调用 + 耗时）
          llmLogger?.logResponse(result, durationMs);

          return result;
        } catch (apiError) {
          // SDK 抛出的 HTTP 错误（4xx/5xx），也尝试重试
          const errMsg =
            apiError instanceof Error ? apiError.message : String(apiError);
          console.warn(
            "[llm] API error (attempt %d/%d): %s",
            attempt + 1,
            maxRetries + 1,
            errMsg,
          );
          lastError =
            apiError instanceof Error ? apiError : new Error(errMsg);
          if (attempt < maxRetries) {
            await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
          }
        }
      }

      throw lastError ?? new Error("No response from LLM");
    },
  };
}
