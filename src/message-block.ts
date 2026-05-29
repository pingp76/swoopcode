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
 * timing 字段记录该消息块在 Agent 时间线中的位置。
 * - loopIndex 用于衰减压缩判断"新旧"
 * - loopRound / round 只描述当前 turn 内循环次数，round 是兼容字段
 * - messageSequence 用于 debug 和 compact round-trip
 * 这些字段由 groupToBlocks() 从消息的内部 _xxx 元数据中提取。
 */
interface BlockTiming {
  turnIndex?: number;
  loopRound?: number;
  loopIndex?: number;
  messageSequence?: number;
  round?: number;
}

export type MessageBlock =
  | ({ type: "text"; user?: ChatCompletionMessageParam; assistant?: ChatCompletionMessageParam } & BlockTiming)
  | ({ type: "tool_use"; user?: ChatCompletionMessageParam; assistant: ChatCompletionMessageParam; toolResults: ChatCompletionMessageParam[] } & BlockTiming)
  | ({ type: "summary"; user: ChatCompletionMessageParam } & BlockTiming);

/**
 * 带有内部 timing 元数据的消息类型（内部使用）
 *
 * 这些字段在 normalize 中不会被清除（normalize 只清理 content 数组中的 _ 前缀键），
 * 但会在 flattenToMessages 中被清除，不会发送给 LLM API。
 */
type AnnotatedMessage = ChatCompletionMessageParam & {
  _turnIndex?: number;
  _loopRound?: number;
  _loopIndex?: number;
  _messageSequence?: number;
  _round?: number;
};

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
  // 累加块内所有消息的 token 估算值

  if (block.type === "text") {
    if (block.user) {
      total += estimateTokens(extractContent(block.user));
    }
    if (block.assistant) {
      total += estimateTokens(extractContent(block.assistant));
    }
  } else if (block.type === "tool_use") {
    // tool_use 块：累加 user、assistant、tool_calls 参数和 tool results
    if (block.user) {
      total += estimateTokens(extractContent(block.user));
    }
    total += estimateTokens(extractContent(block.assistant));
    // tool_calls 的参数也计入
    // 将 assistant 中每个 tool_call 的 function arguments 也计入 token
    if ("tool_calls" in block.assistant && Array.isArray(block.assistant.tool_calls)) {
      for (const tc of block.assistant.tool_calls) {
        total += estimateTokens(tc.function.arguments ?? "");
      }
    }
    // 累加所有 tool result 消息的 content
    for (const tr of block.toolResults) {
      total += estimateTokens(extractContent(tr));
    }
  } else if (block.type === "summary") {
    // summary 块：只累加摘要消息的 content
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
  // 遍历每条消息，累加 content 和 tool_calls 参数的 token
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
 * readTiming — 从消息中读取内部 timing 元数据
 *
 * @param msg - 消息（可能带有 _turnIndex / _loopIndex 等字段）
 * @returns timing 字段集合
 */
function readTiming(msg: ChatCompletionMessageParam): BlockTiming {
  // 将消息断言为内部类型，以便读取 _ 前缀的 timing 字段
  const annotated = msg as AnnotatedMessage;
  // 逐个检查内部字段，存在则写入 timing 对象
  const timing: BlockTiming = {};
  if (annotated._turnIndex !== undefined) timing.turnIndex = annotated._turnIndex;
  if (annotated._loopRound !== undefined) timing.loopRound = annotated._loopRound;
  if (annotated._loopIndex !== undefined) timing.loopIndex = annotated._loopIndex;
  if (annotated._messageSequence !== undefined) {
    timing.messageSequence = annotated._messageSequence;
  }
  if (annotated._round !== undefined) timing.round = annotated._round;
  return timing;
}

/**
 * mergeTiming — 从多条消息的 timing 中取最早值
 *
 * 用于确定消息块所属的聚合时间：取块内所有消息中最早的值。
 */
function mergeTiming(messages: ChatCompletionMessageParam[]): BlockTiming {
  const result: BlockTiming = {};
  // 读取所有消息的 timing，取每个字段的最小值（即最早时间）
  const timings = messages.map(readTiming);
  const turnIndex = minNumber(timings.map((t) => t.turnIndex));
  const loopRound = minNumber(timings.map((t) => t.loopRound));
  const loopIndex = minNumber(timings.map((t) => t.loopIndex));
  const messageSequence = minNumber(timings.map((t) => t.messageSequence));
  const round = minNumber(timings.map((t) => t.round));

  if (turnIndex !== undefined) result.turnIndex = turnIndex;
  if (loopRound !== undefined) result.loopRound = loopRound;
  if (loopIndex !== undefined) result.loopIndex = loopIndex;
  if (messageSequence !== undefined) result.messageSequence = messageSequence;
  if (round !== undefined) result.round = round;
  return result;
}

function minNumber(values: Array<number | undefined>): number | undefined {
  // 过滤掉 undefined 后取最小值，无有效值则返回 undefined
  const defined = values.filter((value): value is number => value !== undefined);
  return defined.length > 0 ? Math.min(...defined) : undefined;
}

function applyTiming(block: MessageBlock, timing: BlockTiming): void {
  // 将 timing 对象的每个字段写入消息块（如果字段存在）
  if (timing.turnIndex !== undefined) block.turnIndex = timing.turnIndex;
  if (timing.loopRound !== undefined) block.loopRound = timing.loopRound;
  if (timing.loopIndex !== undefined) block.loopIndex = timing.loopIndex;
  if (timing.messageSequence !== undefined) {
    block.messageSequence = timing.messageSequence;
  }
  if (timing.round !== undefined) block.round = timing.round;
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
 * @param messages - 扁平消息列表（已标准化，可能带内部 timing 元数据）
 * @returns 消息块数组
 */
export function groupToBlocks(
  messages: ChatCompletionMessageParam[],
): MessageBlock[] {
  // 教学导读：
  // LLM API 看到的是一条条扁平消息，但压缩器需要知道哪些消息属于同一个“语义单元”。
  // 例如一次工具调用并不是三段互不相关的文本，而是：
  //   1. 用户提出需求
  //   2. assistant 发起 tool_calls
  //   3. tool 返回 tool_result
  // 这三者必须一起压缩、一起衰减，否则会出现“保留了 tool result，
  // 却丢了它对应的 assistant tool_call”的非法上下文。
  //
  // 因此这里先把扁平消息分组成 MessageBlock：
  // - text block：普通 user/assistant 对话
  // - tool_use block：一次 assistant tool_calls 以及其紧随的 tool results
  // - summary block：历史压缩后生成的摘要消息
  const blocks: MessageBlock[] = [];

  // pendingUser 是一个“等待配对”的用户消息。
  // 用户消息通常会被下一条 assistant 消息回应，所以先暂存在这里；
  // 等看到 assistant 时，再决定它属于 text block 还是 tool_use block。
  let pendingUser: ChatCompletionMessageParam | undefined;

  let i = 0;
  // 使用索引遍历而不是 for...of：
  // 当遇到 assistant tool_calls 时，需要一次性向后吞掉多条连续 tool 消息，
  // 所以循环步长不是固定的 1。
  while (i < messages.length) {
    // 取出当前消息（非空断言：i 在范围内）
    const msg = messages[i]!;

    // system prompt 是稳定前缀，不参与历史压缩。
    // prepareMessages() 会在压缩管道结束后把 system 消息重新插回最前面。
    if (msg.role === "system") {
      i++;
      continue;
    }

    if (msg.role === "user") {
      const content = extractContent(msg);
      // 以 [Context Summary] 开头的 user 消息是压缩器生成的历史摘要。
      // 它虽然 role 是 user，但语义上不是新的用户请求，而是“历史压缩后的替身”，
      // 所以要单独做成 summary block，避免后面错误地与 assistant 配对。
      if (content.startsWith("[Context Summary]")) {
        const block: MessageBlock = {
          type: "summary",
          user: msg,
        };
        // 将消息的内部 timing 元数据提取并写入块
        applyTiming(block, readTiming(msg));
        blocks.push(block);
      } else {
        // 普通 user 消息先进入缓冲区。
        // 如果连续出现多条 user，normalizeMessages() 通常已经合并过；
        // 这里仍然使用单个 pendingUser，是为了保持分组逻辑简单。
        pendingUser = msg;
      }
      i++;
      continue;
    }

    if (msg.role === "assistant") {
      // assistant 是否包含 tool_calls 是分组的关键分叉：
      // 有 tool_calls 的 assistant 后面必须跟 tool 消息；
      // 没有 tool_calls 的 assistant 只是普通文本回复。
      const hasToolCalls =
        "tool_calls" in msg &&
        Array.isArray(msg.tool_calls) &&
        msg.tool_calls.length > 0;

      if (hasToolCalls) {
        // assistant 有 tool_calls → 收集后续 tool 消息组成 tool_use 块。
        // OpenAI 协议要求 tool 消息必须紧跟对应 assistant tool_calls；
        // 因此这里把“assistant + 紧随其后的所有 tool”视为不可拆开的整体。
        const toolResults: ChatCompletionMessageParam[] = [];
        i++; // 跳过 assistant

        // 收集所有紧跟 assistant 的 tool 消息。
        // 一条 assistant 可能一次调用多个工具，所以这里不是只取一条。
        while (i < messages.length && messages[i]!.role === "tool") {
          toolResults.push(messages[i]!);
          i++;
        }

        const block: MessageBlock = {
          type: "tool_use",
          assistant: msg,
          toolResults,
        };
        if (pendingUser !== undefined) {
          // 如果 assistant tool_calls 是为了回应刚才的用户请求，
          // 就把那个 user 一起并入 tool_use block，保留完整因果链。
          block.user = pendingUser;
          pendingUser = undefined;
        }
        // block 的 timing 使用块内所有消息的合并结果。
        // 例如 user 来自 loopRound=0，而 tool result 来自 loopRound=1，
        // mergeTiming 会保留足够信息供衰减压缩判断。
        applyTiming(
          block,
          mergeTiming([
            ...(block.user ? [block.user] : []),
            msg,
            ...toolResults,
          ]),
        );
        blocks.push(block);
      } else {
        // assistant 无 tool_calls → 普通文本回复。
        // 如果前面有 pendingUser，就形成完整的 user/assistant text block；
        // 如果没有，也允许单独 assistant block，兼容恢复/压缩产生的特殊上下文。
        const block: MessageBlock = {
          type: "text",
          assistant: msg,
        };
        if (pendingUser !== undefined) block.user = pendingUser;
        applyTiming(
          block,
          mergeTiming([...(pendingUser ? [pendingUser] : []), msg]),
        );
        blocks.push(block);
        // user 已配对，清空缓冲
        pendingUser = undefined;
        i++;
      }
      continue;
    }

    // tool 消息未被前面的 assistant 收集（异常情况），跳过避免无限循环
    // tool 消息如果没有被 assistant tool_use 块收集到（理论上不应发生），
    // 跳过它避免无限循环
    i++;
  }

  if (pendingUser !== undefined) {
    // 循环结束后仍有未配对 user，通常表示“当前轮用户刚刚提问，
    // assistant 还没回答”。这是正常状态，必须保留给下一次 LLM 调用。
    const block: MessageBlock = {
      type: "text",
      user: pendingUser,
    };
    applyTiming(block, readTiming(pendingUser));
    blocks.push(block);
  }

  return blocks;
}

/**
 * flattenToMessages — 将消息块数组还原为扁平消息列表
 *
 * 同时清除所有消息中的内部 timing 元数据，确保不会发送给 LLM API。
 *
 * @param blocks - 消息块数组
 * @returns 扁平消息列表（不含内部 timing 元数据）
 */
export function flattenToMessages(
  blocks: MessageBlock[],
): ChatCompletionMessageParam[] {
  const result: ChatCompletionMessageParam[] = [];

  // flatten 是 groupToBlocks 的反向操作。
  // 压缩器处理的是 block，LLM API 需要的是扁平 messages；
  // 因此在发给 LLM 前必须按协议顺序展开。

  for (const block of blocks) {
    if (block.type === "text") {
      // text 块：按 user → assistant 顺序展开
      if (block.user) {
        result.push(stripTiming(block.user));
      }
      if (block.assistant) {
        result.push(stripTiming(block.assistant));
      }
    } else if (block.type === "tool_use") {
      // tool_use 块：按 user → assistant → tool results 顺序展开
      if (block.user) {
        result.push(stripTiming(block.user));
      }
      result.push(stripTiming(block.assistant));
      for (const tr of block.toolResults) {
        result.push(stripTiming(tr));
      }
    } else if (block.type === "summary") {
      // summary 块：只包含 user 消息
      result.push(stripTiming(block.user));
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
  // 根据 content 的不同类型，统一提取为字符串
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    // 只保留带有 text 字段的 block（过滤掉图片等非文本内容）
    return content
      .filter((b): b is { type: "text"; text: string } =>
        typeof b === "object" && b !== null && "text" in b,
      )
      // 提取每个文本块的 text 字段
      .map((b) => b.text)
      // 用换行符连接多段文本
      .join("\n");
  }
  return "";
}

/**
 * stripTiming — 清除消息中的内部 timing 元数据
 *
 * 确保发送给 LLM API 的消息不会包含内部元数据。
 * 使用 spread 操作创建新对象，不修改原消息。
 */
export function stripTiming(
  msg: ChatCompletionMessageParam,
): ChatCompletionMessageParam {
  // 将消息断言为内部类型，以便访问 _ 前缀字段
  const annotated = msg as AnnotatedMessage;
  // 检查消息是否包含任何内部 timing 字段
  if (
    !("_turnIndex" in annotated) &&
    !("_loopRound" in annotated) &&
    !("_loopIndex" in annotated) &&
    !("_messageSequence" in annotated) &&
    !("_round" in annotated)
  ) {
    // 无任何内部字段，直接返回原消息，避免不必要的对象创建
    return msg;
  }

  // 存在内部字段，创建新对象排除这些字段，不修改原消息
  // 创建新对象，排除所有内部 timing 字段
  const {
    _turnIndex,
    _loopRound,
    _loopIndex,
    _messageSequence,
    _round,
    ...rest
  } = annotated;
  // 显式标记这些变量被有意忽略，避免未使用变量警告
  void _turnIndex;
  void _loopRound;
  void _loopIndex;
  void _messageSequence;
  void _round;
  return rest as ChatCompletionMessageParam;
}

export const stripRound = stripTiming;
