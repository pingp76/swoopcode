/**
 * message-block.ts — 消息块模块
 *
 * 职责：定义消息块类型，提供消息列表与消息块数组之间的转换函数，
 * 以及 token 估算工具。
 *
 * 为什么需要消息块？
 * - 在 Agent 对话中，assistant 的 tool_calls 与对应的 tool 消息是逻辑配对的
 * - 压缩操作必须以完整的"消息块"为最小单位，不能拆散配对
 * - 消息块就是压缩操作的原子单位
 *
 * 三种消息块类型：
 * - text: 纯文本对话（user + assistant 无工具调用）
 * - tool_use: 工具调用轮次（assistant 含 tool_calls + 所有对应的 tool 消息）
 * - summary: 全量压缩产生的摘要消息
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * MessageBlock — 消息块，压缩操作的最小原子单位
 *
 * round 字段记录该消息块所属的 agent loop 轮次，用于衰减压缩判断"新旧"。
 * 由 groupToBlocks() 从消息的 _round 元数据中提取。
 */
export type MessageBlock =
  | { type: "text"; user?: ChatCompletionMessageParam; assistant?: ChatCompletionMessageParam; round?: number }
  | { type: "tool_use"; user?: ChatCompletionMessageParam; assistant: ChatCompletionMessageParam; toolResults: ChatCompletionMessageParam[]; round?: number }
  | { type: "summary"; user: ChatCompletionMessageParam; round?: number };

/**
 * 带有 _round 元数据的消息类型（内部使用）
 *
 * _round 在 normalize 中不会被清除（normalize 只清理 content 数组中的 _ 前缀键），
 * 但会在 flattenToMessages 中被清除，不会发送给 LLM API。
 */
type AnnotatedMessage = ChatCompletionMessageParam & { _round?: number };

// ---------------------------------------------------------------------------
// Token 估算
// ---------------------------------------------------------------------------

/**
 * estimateTokens — 基于字符数的 token 估算
 *
 * 估算规则：
 * - 中文：1 字符 ≈ 1.5 token
 * - 英文：1 字符 ≈ 0.25 token
 * - 取两者较大值作为估算结果
 *
 * 为什么不用 tiktoken？
 * - tiktoken 是精确的 tokenizer，但需要额外安装 WASM 依赖
 * - 对于压缩判断"是否需要压缩"这个场景，估算值足够了
 * - 教学项目优先简洁
 *
 * @param text - 要估算的文本
 * @returns 估算的 token 数
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // 统计中文字符数（CJK 统一汉字范围）
  const chineseCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
  const totalChars = text.length;

  // 取两种估算的较大值，避免纯中文文本被低估
  return Math.max(chineseCount * 1.5, totalChars * 0.25);
}

/**
 * estimateBlockTokens — 估算一个消息块的 token 数
 *
 * 将块内所有消息的文本内容（content）累加估算。
 * tool_calls 的参数也会被计入（因为它是重要的上下文信息）。
 *
 * @param block - 消息块
 * @returns 估算的 token 数
 */
export function estimateBlockTokens(block: MessageBlock): number {
  let total = 0;

  if (block.type === "text") {
    if (block.user) {
      total += estimateTokens(extractContent(block.user));
    }
    if (block.assistant) {
      total += estimateTokens(extractContent(block.assistant));
    }
  } else if (block.type === "tool_use") {
    if (block.user) {
      total += estimateTokens(extractContent(block.user));
    }
    total += estimateTokens(extractContent(block.assistant));
    // tool_calls 的参数也计入
    if ("tool_calls" in block.assistant && Array.isArray(block.assistant.tool_calls)) {
      for (const tc of block.assistant.tool_calls) {
        total += estimateTokens(tc.function.arguments ?? "");
      }
    }
    for (const tr of block.toolResults) {
      total += estimateTokens(extractContent(tr));
    }
  } else if (block.type === "summary") {
    total += estimateTokens(extractContent(block.user));
  }

  return total;
}

/**
 * estimateMessagesTokens — 估算消息列表的总 token 数
 *
 * @param messages - 消息列表
 * @returns 估算的 token 数
 */
export function estimateMessagesTokens(
  messages: ChatCompletionMessageParam[],
): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateTokens(extractContent(msg));
    // tool_calls 参数也计入
    if ("tool_calls" in msg && Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function.arguments ?? "");
      }
    }
  }
  return total;
}

// ---------------------------------------------------------------------------

/**
 * truncateToTokens — 按估算 token 数截断文本
 *
 * 用于衰减压缩：将过长的 tool result 截断为前 N 个 token 对应的字符数。
 *
 * @param text - 要截断的文本
 * @param maxTokens - 最大 token 数
 * @returns 截断后的文本
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  if (!text) return "";

  // 以英文字符估算为准，反算字符数
  // 这样对中英文混合文本是保守估计（不会截断过多）
  const maxChars = Math.floor(maxTokens / 0.25);

  if (text.length <= maxChars) return text;

  return text.slice(0, maxChars)!;
}

// ---------------------------------------------------------------------------
// 消息块分组与还原
// ---------------------------------------------------------------------------

/**
 * readRound — 从消息中读取 _round 元数据
 *
 * @param msg - 消息（可能带有 _round 字段）
 * @returns 轮次号，如果不存在返回 undefined
 */
function readRound(msg: ChatCompletionMessageParam): number | undefined {
  return (msg as AnnotatedMessage)._round;
}

/**
 * minRound — 从多个轮次号中取最小值
 *
 * 用于确定消息块所属的轮次：取块内所有消息中最早的轮次。
 */
function minRound(...rounds: (number | undefined)[]): number | undefined {
  const defined = rounds.filter((r): r is number => r !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

/**
 * groupToBlocks — 将扁平消息列表分组为消息块数组
 *
 * 核心算法（状态机遍历）：
 * 1. 跳过 system 消息（由 history 独立管理）
 * 2. user 且内容以 "[Context Summary]" 开头 → summary 块
 * 3. user → 缓冲，等待配对 assistant
 * 4. assistant 有 tool_calls → tool_use 块，收集后续匹配的 tool 消息
 * 5. assistant 无 tool_calls → 与缓冲的 user 组成 text 块
 *
 * @param messages - 扁平消息列表（已标准化，可能带 _round 元数据）
 * @returns 消息块数组
 */
export function groupToBlocks(
  messages: ChatCompletionMessageParam[],
): MessageBlock[] {
  const blocks: MessageBlock[] = [];
  // 缓冲的 user 消息，等待与 assistant 配对
  let pendingUser: ChatCompletionMessageParam | undefined;

  let i = 0;
  while (i < messages.length) {
    const msg = messages[i]!;

    // 跳过 system 消息
    if (msg.role === "system") {
      i++;
      continue;
    }

    // user 消息：判断是否为 summary，否则缓冲
    if (msg.role === "user") {
      const content = extractContent(msg);
      if (content.startsWith("[Context Summary]")) {
        const block: MessageBlock = {
          type: "summary",
          user: msg,
        };
        const r = readRound(msg);
        if (r !== undefined) block.round = r;
        blocks.push(block);
      } else {
        pendingUser = msg;
      }
      i++;
      continue;
    }

    // assistant 消息
    if (msg.role === "assistant") {
      const hasToolCalls =
        "tool_calls" in msg &&
        Array.isArray(msg.tool_calls) &&
        msg.tool_calls.length > 0;

      if (hasToolCalls) {
        // tool_use 块：[user] + assistant + 后续所有 tool 消息
        // 如果前面有缓冲的 user 消息，一并纳入此块，避免丢失
        const toolResults: ChatCompletionMessageParam[] = [];
        i++; // 跳过 assistant

        // 收集后续的 tool 消息
        while (i < messages.length && messages[i]!.role === "tool") {
          toolResults.push(messages[i]!);
          i++;
        }

        const block: MessageBlock = {
          type: "tool_use",
          assistant: msg,
          toolResults,
        };
        // 将缓冲的 user 消息纳入 tool_use 块
        if (pendingUser !== undefined) {
          block.user = pendingUser;
          pendingUser = undefined;
        }
        const r = minRound(
          block.user ? readRound(block.user) : undefined,
          readRound(msg),
          ...toolResults.map(readRound),
        );
        if (r !== undefined) block.round = r;
        blocks.push(block);
      } else {
        // text 块：user + assistant
        const block: MessageBlock = {
          type: "text",
          assistant: msg,
        };
        if (pendingUser !== undefined) block.user = pendingUser;
        const r = minRound(
          pendingUser ? readRound(pendingUser) : undefined,
          readRound(msg),
        );
        if (r !== undefined) block.round = r;
        blocks.push(block);
        pendingUser = undefined;
        pendingUser = undefined;
        i++;
      }
      continue;
    }

    // tool 消息如果没有被 assistant tool_use 块收集到（理论上不应发生），
    // 跳过它避免无限循环
    i++;
  }

  // 循环结束后，如果还有未配对的 user 消息（通常是当前轮最新的用户 query），
  // 将其作为一个独立的 text 块加入，避免消息丢失。
  if (pendingUser !== undefined) {
    const block: MessageBlock = {
      type: "text",
      user: pendingUser,
    };
    const r = readRound(pendingUser);
    if (r !== undefined) block.round = r;
    blocks.push(block);
  }

  return blocks;
}

/**
 * flattenToMessages — 将消息块数组还原为扁平消息列表
 *
 * 同时清除所有消息中的 _round 元数据，确保不会发送给 LLM API。
 *
 * @param blocks - 消息块数组
 * @returns 扁平消息列表（不含 _round 元数据）
 */
export function flattenToMessages(
  blocks: MessageBlock[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  for (const block of blocks) {
    if (block.type === "text") {
      if (block.user) {
        result.push(stripRound(block.user));
      }
      if (block.assistant) {
        result.push(stripRound(block.assistant));
      }
    } else if (block.type === "tool_use") {
      if (block.user) {
        result.push(stripRound(block.user));
      }
      result.push(stripRound(block.assistant));
      for (const tr of block.toolResults) {
        result.push(stripRound(tr));
      }
    } else if (block.type === "summary") {
      result.push(stripRound(block.user));
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

/**
 * extractContent — 从消息中提取文本内容
 *
 * 消息的 content 有多种格式：
 * - string：普通文本
 * - array：多模态内容（如 [{type: "text", text: "hello"}]）
 * - null/undefined：无内容
 *
 * 统一转为 string 返回。
 */
function extractContent(msg: ChatCompletionMessageParam): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && "text" in b,
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/**
 * stripRound — 清除消息中的 _round 元数据
 *
 * 确保发送给 LLM API 的消息不会包含内部元数据。
 * 使用 spread 操作创建新对象，不修改原消息。
 */
export function stripRound(
  msg: ChatCompletionMessageParam,
): ChatCompletionMessageParam {
  const annotated = msg as AnnotatedMessage;
  if (!("_round" in annotated)) return msg;

  // 创建新对象，排除 _round 字段
  const { _round, ...rest } = annotated;
  void _round; // 显式丢弃，避免 ESLint 未使用变量警告
  return rest as ChatCompletionMessageParam;
}
