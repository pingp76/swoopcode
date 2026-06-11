/**
 * live-llm.ts — Live Eval LLM Client
 *
 * 职责：为 eval live smoke 提供真实 LLM 调用能力。
 *
 * 设计决策：
 * - 复用现有 createLLMClient()，不重新实现 LLM 协议。
 * - 只做 eval 层的 thin wrapper：记录 llm_call / llm_response 事件，限制 maxCalls。
 * - 通过 loadConfig() 获取 provider 配置，使用 .env 中的 API key。
 * - 由于 loadConfig() 是同步的，可以在 async startCase 中调用。
 * - maxCalls 限制防止 live case 因模型异常进入无限循环，保护 eval 预算。
 */

import {
  createLLMClient,
  type LLMClient,
  type LLMResponse,
} from "../../llm.js";
import { loadConfig } from "../../config.js";
import type { AgentRuntimeEvent } from "../core/case-schema.js";
import type { ResolvedLLMConfig } from "../../llm-providers.js";

/**
 * createLiveEvalLLMClient — 创建 live eval LLM 客户端
 *
 * @param options.emitEvent - 事件发射回调，用于记录 llm_call / llm_response
 * @param options.maxCalls - 最大 LLM 调用次数，超过后抛错（默认 10）
 * @returns LLMClient 接口实现
 */
export function createLiveEvalLLMClient(options: {
  emitEvent: (event: AgentRuntimeEvent) => void;
  maxCalls?: number;
}): LLMClient {
  const maxCalls = options.maxCalls ?? 10;
  // 延迟加载 config：在 chat() 首次调用时才读取 .env，避免工厂阶段就报错
  let inner: LLMClient | undefined;

  function getInner(): LLMClient {
    if (inner) return inner;
    const config = loadConfig();
    if (!config.apiKey) {
      throw new Error(
        "[LiveEval] Missing LLM API key. Live mode requires a configured API key (e.g., LLM_API_KEY in .env).",
      );
    }
    const resolvedConfig: ResolvedLLMConfig = {
      provider: config.provider,
      displayName: config.providerDisplayName,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model,
      capabilities: config.llmCapabilities,
    };
    inner = createLLMClient(resolvedConfig, undefined, config.runtimePolicy);
    return inner;
  }

  let callCount = 0;

  return {
    async chat(messages, tools, cacheDebug): Promise<LLMResponse> {
      callCount += 1;
      if (callCount > maxCalls) {
        throw new Error(
          `Live eval LLM call limit exceeded: ${maxCalls} calls allowed`,
        );
      }

      // 记录 llm_call 事件
      options.emitEvent({
        kind: "llm_call",
        source: "llm",
        mode: "live",
        messageCount: messages.length,
        toolDefinitionCount: tools?.length ?? 0,
      } as AgentRuntimeEvent);

      // 调用真实 LLM（首次调用时延迟初始化 inner）
      const response = await getInner().chat(messages, tools, cacheDebug);

      // 记录 llm_response 事件
      const responseEvent: {
        kind: "llm_response";
        source: "llm";
        mode: "live";
        contentPreview?: string;
      } = {
        kind: "llm_response",
        source: "llm",
        mode: "live",
      };
      if (response.content !== null && response.content !== undefined) {
        responseEvent.contentPreview = response.content;
      }
      options.emitEvent(responseEvent as AgentRuntimeEvent);

      return response;
    },
  };
}
