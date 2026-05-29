/**
 * history.ts — 对话历史管理模块
 *
 * 职责：管理与 LLM 的对话上下文（消息历史）及消息时间元信息。
 *
 * 为什么需要对话历史？
 * - LLM 是无状态的：每次调用 API 时，需要把之前的对话全部发过去
 * - Agent 循环中会产生多轮对话（用户提问 → 模型回答 → 调用工具 → 工具结果 → 模型再回答）
 * - 所有这些消息都需要按顺序保存，下一次调用 API 时作为上下文传入
 *
 * 为什么把 timing 元信息存在 history 里？
 * - 之前 agent.ts 维护了一个与 messages 平行的 messageRounds 数组
 * - 任何绕过 appendMessage() 直接调用 history.add() 的地方都会破坏对齐
 * - 把 timing 收归 history 统一管理后，add() 是唯一的写入路径，不可能失同步
 * - 同时消除了 annotateWithRounds() 中的 system prompt 偏移计算
 *
 * 设计模式：工厂函数 + 闭包（与 logger.ts 相同的模式）
 * - messages 和 timings 数组被闭包捕获，外部无法直接修改
 * - 通过五个方法操作，保证数据一致性
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { MessageTiming, MessageTimingInput } from "./timeline.js";

/**
 * HistoryEntry — 带元信息的消息条目
 *
 * 用于压缩管道（prepareMessages → groupToBlocks）读取 timing 元数据。
 * 对外暴露的结构化视图，不暴露内部存储细节。
 */
export interface HistoryEntry extends MessageTiming {
  /** 原始消息 */
  message: ChatCompletionMessageParam;
}

export type HistoryEntryInput = Omit<HistoryEntry, "messageSequence"> & {
  messageSequence?: number;
};

/**
 * History — 对话历史管理接口
 *
 * 五个核心操作：
 * - add：添加一条消息，可附带 timing 元信息
 * - getMessages：获取纯消息列表的副本（含 system prompt 在头部），用于 LLM API 调用
 * - getEntries：获取带元信息的条目列表（不含 system prompt），用于压缩管道
 * - clear：清空所有消息和元信息
 * - setSystemPrompt / getSystemPrompt：设置/获取 system prompt
 */
export interface History {
  /**
   * 添加一条消息到历史末尾。
   *
   * @param message - 消息（可能是用户消息、模型回复、工具结果等）
   * @param meta - 可选的时间元信息，仍兼容旧 round 字段
   */
  add(
    message: ChatCompletionMessageParam,
    meta?: MessageTimingInput,
  ): HistoryEntry;
  /**
   * 获取纯消息列表的浅拷贝（含 system prompt 在头部）。
   * 用于传给 LLM API — 不含任何内部元数据。
   */
  getMessages(): ChatCompletionMessageParam[];
  /**
   * 获取带元信息的条目列表（不含 system prompt）。
   * 用于压缩管道：prepareMessages() 需要读取 timing 来做衰减压缩。
   *
   * 为什么不含 system prompt？
   * - system prompt 不参与压缩管道（groupToBlocks 会跳过 system 消息）
   * - 调用方可通过 getSystemPrompt() 单独获取
   */
  getEntries(): HistoryEntry[];
  /** 清空所有消息和元信息 */
  clear(): void;
  /**
   * 设置 system prompt，会在 getMessages() 时自动插入到消息列表头部。
   *
   * 为什么不直接 add({ role: "system" })？
   * - system prompt 不是对话的一部分，不应该参与消息标准化
   *   （合并连续同角色、补全 tool_result 等逻辑都不应处理 system 消息）
   * - 独立存储，getMessages() 时拼接到头部，更干净
   */
  setSystemPrompt(prompt: string): void;
  /** 获取当前 system prompt（未设置时返回 null） */
  getSystemPrompt(): string | null;
  /**
   * 替换所有普通对话消息和对应 timing 元信息。
   *
   * 用于错误恢复中的强制 compact：将压缩后的历史写回，
   * 确保下一次请求携带的上下文真的变短。
   * 不修改 system prompt。
   */
  replaceEntries(entries: HistoryEntryInput[]): void;
}

/**
 * createHistory — 创建对话历史管理器
 *
 * @returns History 接口的实现
 *
 * 内部使用两个平行数组存储消息和时间元信息：
 * - messages: 消息数组
 * - timings: 时间元信息数组（与 messages 一一对应）
 *
 * 这两个数组封装在闭包内，外部只能通过接口方法访问，
 * 因此不可能出现失同步的情况（之前 agent.ts 的 messageRounds 就有这个风险）。
 */
export function createHistory(): History {
  // 消息数组，按时间顺序存储所有对话消息
  const messages: ChatCompletionMessageParam[] = [];

  // 时间元信息数组，与 messages 一一对应。
  // messageSequence 由 History 统一分配，避免外部维护平行数组。
  const timings: MessageTiming[] = [];
  let nextMessageSequence = 1;

  // system prompt 独立存储，不放入 messages 数组
  // 这样它不会干扰消息标准化逻辑（合并、补全 tool_result 等）
  let systemPrompt: string | null = null;

  return {
    // 添加一条消息到历史末尾，同时记录 timing 元信息
    add(message, meta) {
      const timing = createTiming(meta, nextMessageSequence++);
      messages.push(message);
      timings.push(timing);
      return createEntry(message, timing);
    },

    // 返回消息数组的浅拷贝（纯消息，不含元数据）
    // 如果设置了 system prompt，自动在头部插入 system 消息
    getMessages() {
      const result = [...messages];
      if (systemPrompt) {
        result.unshift({
          role: "system",
          content: systemPrompt,
        } as ChatCompletionMessageParam);
      }
      return result;
    },

    // 返回带 timing 元信息的条目列表（不含 system prompt）
    // 供压缩管道使用：prepareMessages() 通过此方法获取 timing 信息
    getEntries() {
      return messages.map((msg, i) => {
        return createEntry(msg, timings[i]!);
      });
    },

    // 清空所有消息和元信息
    // length = 0 是清空数组的高效方式，不会创建新数组
    clear() {
      messages.length = 0;
      timings.length = 0;
      nextMessageSequence = 1;
    },

    // 设置 system prompt
    setSystemPrompt(prompt: string): void {
      systemPrompt = prompt;
    },

    // 获取当前 system prompt
    getSystemPrompt(): string | null {
      return systemPrompt;
    },

    // 替换所有普通对话消息和对应 timing 元信息
    // system prompt 独立存储，不受此操作影响
    replaceEntries(entries: HistoryEntryInput[]): void {
      messages.length = 0;
      timings.length = 0;
      let maxSequence = entries.reduce(
        (max, entry) => Math.max(max, entry.messageSequence ?? 0),
        0,
      );
      let fallbackSequence = maxSequence + 1;
      for (const entry of entries) {
        messages.push(entry.message);
        const fallback =
          entry.messageSequence !== undefined
            ? entry.messageSequence
            : fallbackSequence++;
        const timing = timingFromEntry(entry, fallback);
        timings.push(timing);
        maxSequence = Math.max(maxSequence, timing.messageSequence);
      }
      nextMessageSequence = maxSequence + 1;
    },
  };
}

function createTiming(
  meta: MessageTimingInput | undefined,
  messageSequence: number,
): MessageTiming {
  const loopRound = meta?.loopRound ?? meta?.round;
  const timing: MessageTiming = { messageSequence };

  if (meta?.turnIndex !== undefined) timing.turnIndex = meta.turnIndex;
  if (loopRound !== undefined) {
    timing.loopRound = loopRound;
    timing.round = loopRound;
  }
  if (meta?.loopIndex !== undefined) timing.loopIndex = meta.loopIndex;

  return timing;
}

function timingFromEntry(
  entry: HistoryEntryInput,
  fallbackSequence: number,
): MessageTiming {
  const timing: MessageTiming = {
    messageSequence: entry.messageSequence ?? fallbackSequence,
  };
  if (entry.turnIndex !== undefined) timing.turnIndex = entry.turnIndex;
  if (entry.loopRound !== undefined) timing.loopRound = entry.loopRound;
  if (entry.loopIndex !== undefined) timing.loopIndex = entry.loopIndex;
  if (entry.round !== undefined) timing.round = entry.round;
  return timing;
}

function createEntry(
  message: ChatCompletionMessageParam,
  timing: MessageTiming,
): HistoryEntry {
  const entry: HistoryEntry = {
    message,
    messageSequence: timing.messageSequence,
  };
  if (timing.turnIndex !== undefined) entry.turnIndex = timing.turnIndex;
  if (timing.loopRound !== undefined) entry.loopRound = timing.loopRound;
  if (timing.loopIndex !== undefined) entry.loopIndex = timing.loopIndex;
  if (timing.round !== undefined) entry.round = timing.round;
  return entry;
}
