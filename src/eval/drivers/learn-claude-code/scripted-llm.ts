/**
 * scripted-llm.ts — Scripted LLM Client
 *
 * 职责：实现 LLMClient 接口，用预设的 response 序列按顺序驱动 Agent。
 *
 * 行为要求：
 * 1. 每次 chat() 消耗一个 response
 * 2. response 用完时抛错
 * 3. response 中的 args 自动序列化为 function.arguments
 * 4. 如果传入 assistantMessage，优先使用它
 * 5. 每次 chat() 都写标准化 llm_call / llm_response runtime event
 */

import type {
  ChatCompletionMessageParam,
  ChatCompletionMessageToolCall,
} from "openai/resources/chat/completions";
import type { LLMClient, LLMResponse } from "../../../llm.js";
import type { AgentRuntimeEvent } from "../../core/case-schema.js";
import type { ScriptedLLMResponse, ScriptedToolCall } from "../../core/case-schema.js";

/**
 * createScriptedLLMClient — 创建脚本化 LLM 客户端
 *
 * @param options.caseId - 当前 case 标识，用于报错信息
 * @param options.responses - 预设的 LLM 响应序列
 * @param options.emitEvent - 事件发射回调，用于记录 llm_call / llm_response
 */
export function createScriptedLLMClient(options: {
  caseId: string;
  responses: ScriptedLLMResponse[];
  emitEvent: (event: AgentRuntimeEvent) => void;
}): LLMClient {
  // 当前消耗到的 response 索引
  let callIndex = 0;

  return {
    async chat(messages, tools): Promise<LLMResponse> {
      const currentCall = callIndex;
      callIndex += 1;

      // 记录 llm_call 事件
      options.emitEvent({
        kind: "llm_call",
        source: "llm",
        mode: "scripted",
        messageCount: messages.length,
        toolDefinitionCount: tools?.length ?? 0,
      } as AgentRuntimeEvent);

      // response 耗尽时抛错，避免测试静默通过
      if (currentCall >= options.responses.length) {
        throw new Error(
          `Eval case ${options.caseId} has no scripted LLM response for call ${currentCall + 1}`,
        );
      }

      // 前面已做范围检查，此处可安全非空断言
      const scripted = options.responses[currentCall]!;

      // 构造 assistant message
      let assistantMessage: ChatCompletionMessageParam;
      let toolCalls: ChatCompletionMessageToolCall[];
      if (scripted.assistantMessage && typeof scripted.assistantMessage === "object") {
        // 当 case 显式提供 assistantMessage 时，优先使用它。
        // 为保证返回值一致性，toolCalls 从 assistantMessage.tool_calls 同步派生。
        assistantMessage = scripted.assistantMessage as ChatCompletionMessageParam;
        const am = assistantMessage as ChatCompletionMessageParam & {
          tool_calls?: ChatCompletionMessageToolCall[];
        };
        toolCalls = am.tool_calls ?? [];
      } else {
        toolCalls = (scripted.toolCalls ?? []).map((tc) =>
          toChatCompletionMessageToolCall(tc),
        );
        const msg: {
          role: "assistant";
          content: string | null;
          tool_calls?: ChatCompletionMessageToolCall[];
        } = {
          role: "assistant",
          content: scripted.content ?? null,
        };
        if (toolCalls.length > 0) {
          msg.tool_calls = toolCalls;
        }
        assistantMessage = msg as ChatCompletionMessageParam;
      }

      // 记录 llm_response 事件
      const responseEvent: {
        kind: "llm_response";
        source: "llm";
        mode: "scripted";
        contentPreview?: string;
      } = {
        kind: "llm_response",
        source: "llm",
        mode: "scripted",
      };
      if (scripted.content !== undefined && scripted.content !== null) {
        responseEvent.contentPreview = scripted.content;
      }
      options.emitEvent(responseEvent as AgentRuntimeEvent);

      return {
        content: scripted.content ?? null,
        toolCalls,
        finishReason: scripted.finishReason ?? (toolCalls.length > 0 ? "tool_calls" : "stop"),
        assistantMessage,
      };
    },
  };
}

/**
 * toChatCompletionMessageToolCall — 将 ScriptedToolCall 转换为 OpenAI 格式
 *
 * 如果提供了 rawArguments，直接使用；否则将 args 序列化为 JSON。
 */
function toChatCompletionMessageToolCall(
  tc: ScriptedToolCall,
): ChatCompletionMessageToolCall {
  const args = tc.rawArguments ?? JSON.stringify(tc.args ?? {});
  return {
    id: tc.id,
    type: "function",
    function: {
      name: tc.name,
      arguments: args,
    },
  };
}
