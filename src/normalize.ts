/**
 * normalize.ts — 消息标准化模块
 *
 * 职责：在将消息发送给 LLM API 之前，对消息列表进行标准化处理。
 *
 * 为什么需要标准化？
 * - Agent 循环中可能产生不符合 API 要求的消息格式
 * - 某些消息可能包含内部元数据（以 "_" 开头的字段），API 无法识别
 * - 工具调用可能缺少对应的结果消息，导致 API 报错
 * - 连续同角色消息不符合 OpenAI API 的严格交替要求
 *
 * 标准化做三件事：
 * 1. 过滤 content block 内的元数据字段（顶层 _round 仍保留给压缩管线）
 * 2. 补全或移动缺失的 tool_result，让它紧跟对应 assistant tool_call
 * 3. 合并连续同角色消息（只合并普通 user/assistant 文本，不合并 tool_call）
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * normalizeMessages — 消息标准化主函数
 *
 * @param messages - 原始消息列表（可能包含不规范的格式）
 * @returns 标准化后的消息列表（符合 OpenAI API 要求）
 */
export function normalizeMessages(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  // 步骤 1：过滤元数据字段
  const cleaned = cleanMetadata(messages);

  // 步骤 2：补全缺失的 tool_result
  const withToolResults = ensureToolResults(cleaned);

  // 步骤 3：合并连续同角色消息
  const merged = mergeConsecutiveRoles(withToolResults);

  return merged;
}

/**
 * cleanMetadata — 过滤消息中的元数据字段
 *
 * 处理规则：
 * - content 是字符串 → clone 消息后保留（最常见的格式）
 * - content 是数组 → 过滤每个 block 中以 "_" 开头的键（如 _timestamp、_id）
 * - content 是 null/undefined → 保留不变
 *
 * 元数据字段（如 _timestamp）是内部系统使用的，LLM API 无法识别，
 * 发送过去可能导致 API 报错或行为异常。
 *
 * 注意：顶层 _round 是 prepareMessages → message-block 的内部协议字段，
 * normalize 阶段必须保留，最终由 flattenToMessages() 清除。
 */
function cleanMetadata(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  return messages.map(cloneMessage);
}

/**
 * ensureToolResults — 确保每个 tool_call 都有对应的 tool 消息
 *
 * OpenAI API 的要求：
 * - assistant 消息中的每个 tool_call（通过 tool_call_id 标识）
 *   都必须有且仅有一条 role="tool" 的消息作为回应
 * - 如果缺少 tool 消息，API 会报错
 *
 * 这个函数会按 assistant tool_calls 原始顺序重建 tool block：
 * 1. 先收集所有已有 tool 消息
 * 2. 遇到 assistant(tool_calls) 时，立即补上对应 tool 消息
 * 3. 已消费的 tool 消息在原位置跳过，孤立 tool 消息不发送给 LLM
 */
function ensureToolResults(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  const toolMessagesById = new Map<string, ChatCompletionMessageParam>();
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const toolCallId = readToolCallId(msg);
    if (toolCallId && !toolMessagesById.has(toolCallId)) {
      toolMessagesById.set(toolCallId, msg);
    }
  }

  const result: ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    // 已经被归入 assistant tool block 的 tool 消息，在原位置跳过；
    // 没有 assistant 引用的孤立 tool 消息也跳过，避免发送非法 provider 输入。
    if (msg.role === "tool") {
      continue;
    }

    result.push(cloneMessage(msg));
    if (!hasToolCalls(msg)) continue;

    const toolCalls = (msg as { tool_calls: Array<{ id?: string }> })
      .tool_calls;
    for (const toolCall of toolCalls) {
      if (!toolCall.id) continue;
      const existing = toolMessagesById.get(toolCall.id);
      if (existing) {
        result.push(cloneMessage(existing));
      } else {
        result.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "(cancelled)",
        } as unknown as ChatCompletionMessageParam);
      }
    }
  }

  return result;
}

/**
 * mergeConsecutiveRoles — 合并连续同角色消息
 *
 * OpenAI API 要求消息角色严格交替（user → assistant → tool → assistant → ...）。
 * 如果出现连续两条同角色消息（如 user + user），API 会报错。
 *
 * 合并策略：
 * - 只合并 user 和 assistant 角色（tool 角色有 tool_call_id，不能合并）
 * - 两条都是 string content → 拼接字符串
 * - 任一条是数组 content → 统一转为数组格式后拼接
 * - 不同角色 → 直接追加为新消息
 */
function mergeConsecutiveRoles(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  if (messages.length === 0) return [];

  const merged: ChatCompletionMessageParam[] = [cloneMessage(messages[0]!)];

  for (let i = 1; i < messages.length; i++) {
    const msg = cloneMessage(messages[i]!);
    const last = merged[merged.length - 1]!;

    if (canMergeMessages(last, msg)) {
      // 将两条消息的 content 都转为数组格式后拼接
      const prevContent = toArrayContent(last.content);
      const currContent = toArrayContent(msg.content);

      const mergedMsg = {
        ...last,
        content: prevContent.concat(currContent),
      } as unknown as ChatCompletionMessageParam;
      merged[merged.length - 1] = mergedMsg;
    } else {
      merged.push(msg);
    }
  }

  return merged;
}

/**
 * toArrayContent — 将消息 content 统一转为数组格式
 *
 * OpenAI 消息的 content 有两种格式：
 * - 字符串：普通文本，如 "hello"
 * - 数组：多部分内容（文本 + 图片等），如 [{type: "text", text: "hello"}]
 *
 * 为了合并消息，需要统一为数组格式再拼接。
 *
 * @param content - 原始 content（string、数组、或 null）
 * @returns 数组格式的 content
 */
function toArrayContent(
  content: string | unknown[] | null | undefined,
): Array<Record<string, unknown>> {
  if (Array.isArray(content)) {
    return content.map((block) => ({
      ...(block as Record<string, unknown>),
    }));
  }

  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  // null 或 undefined → 空数组
  return [];
}

function canMergeMessages(
  last: ChatCompletionMessageParam,
  msg: ChatCompletionMessageParam,
): boolean {
  if (last.role !== msg.role) return false;
  if (msg.role === "user") return true;
  if (msg.role !== "assistant") return false;
  return !hasToolCalls(last) && !hasToolCalls(msg);
}

function hasToolCalls(msg: ChatCompletionMessageParam): boolean {
  return (
    msg.role === "assistant" &&
    "tool_calls" in msg &&
    Array.isArray(msg.tool_calls) &&
    msg.tool_calls.length > 0
  );
}

function readToolCallId(msg: ChatCompletionMessageParam): string | undefined {
  if (msg.role !== "tool") return undefined;
  const toolCallId = (msg as unknown as { tool_call_id?: unknown })
    .tool_call_id;
  return typeof toolCallId === "string" ? toolCallId : undefined;
}

function cloneMessage(
  msg: ChatCompletionMessageParam,
): ChatCompletionMessageParam {
  const cloned = { ...(msg as unknown as Record<string, unknown>) };
  if ("content" in cloned) {
    cloned.content = cloneContent(cloned.content);
  }
  if (Array.isArray(cloned.tool_calls)) {
    cloned.tool_calls = cloned.tool_calls.map((toolCall) => ({
      ...(toolCall as Record<string, unknown>),
      function: {
        ...((toolCall as { function?: Record<string, unknown> }).function ??
          {}),
      },
    }));
  }
  return cloned as unknown as ChatCompletionMessageParam;
}

function cloneContent(content: unknown): unknown {
  if (Array.isArray(content)) {
    return content
      .filter((block) => typeof block === "object" && block !== null)
      .map((block) =>
        Object.fromEntries(
          Object.entries(block as Record<string, unknown>).filter(
            ([key]) => !key.startsWith("_"),
          ),
        ),
      );
  }
  return content;
}
