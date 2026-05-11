/**
 * transcript.ts — 原始对话事件存储模块
 *
 * 职责：以 append-only 方式保存原始事件，为未来搜索、回放和分析打基础。
 *
 * 重要边界：
 * - TranscriptStore 不参与 prompt 构建。
 * - History 可以被 compact/replace；TranscriptStore 不会改写旧事件。
 * - 每条事件都带 sessionId，后续可以自然扩展到多 session 和子智能体。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

export type TranscriptEventType =
  | "user_message"
  | "assistant_message"
  | "tool_result"
  | "system_reminder"
  | "hook_message"
  | "history_replaced"
  | "recovery_event";

/**
 * TranscriptEvent — append-only 原始事件
 */
export interface TranscriptEvent {
  /** 事件唯一 id */
  id: string;
  /** 所属 session */
  sessionId: string;
  /** session 内递增序号，便于稳定排序 */
  sequence: number;
  /** 事件时间 */
  timestamp: string;
  /** 事件类型 */
  type: TranscriptEventType;
  /** Agent loop 轮次（如果适用） */
  round?: number;
  /** 原始负载，不参与 prompt 处理 */
  payload: unknown;
}

export interface TranscriptStore {
  append(input: {
    sessionId: string;
    type: TranscriptEventType;
    round?: number;
    payload: unknown;
  }): TranscriptEvent;
  appendMessage(input: {
    sessionId: string;
    round: number;
    message: ChatCompletionMessageParam;
  }): TranscriptEvent;
  readSession(sessionId: string): TranscriptEvent[];
  list(): TranscriptEvent[];
  search(query: {
    sessionId?: string;
    type?: TranscriptEventType;
    text?: string;
  }): TranscriptEvent[];
}

/**
 * createTranscriptStore — 创建进程内原始事件存储
 *
 * 第一版先用内存数组，避免给 prompt 路径引入文件 IO 副作用。
 * 后续可以在 append() 里加 JSONL writer，而不改变调用方 API。
 */
export function createTranscriptStore(options?: {
  now?: () => Date;
  idGenerator?: () => string;
}): TranscriptStore {
  const events: TranscriptEvent[] = [];
  const sequenceBySession = new Map<string, number>();
  const now = options?.now ?? (() => new Date());
  const idGenerator = options?.idGenerator ?? defaultIdGenerator;

  function append(input: {
    sessionId: string;
    type: TranscriptEventType;
    round?: number;
    payload: unknown;
  }): TranscriptEvent {
    const nextSequence = (sequenceBySession.get(input.sessionId) ?? 0) + 1;
    sequenceBySession.set(input.sessionId, nextSequence);

    const event: TranscriptEvent = {
      id: idGenerator(),
      sessionId: input.sessionId,
      sequence: nextSequence,
      timestamp: now().toISOString(),
      type: input.type,
      payload: cloneJson(input.payload),
    };
    if (input.round !== undefined) event.round = input.round;

    events.push(event);
    return event;
  }

  return {
    append,

    appendMessage(input) {
      return append({
        sessionId: input.sessionId,
        type: classifyMessage(input.message),
        round: input.round,
        payload: { message: input.message },
      });
    },

    readSession(sessionId) {
      return events.filter((e) => e.sessionId === sessionId);
    },

    list() {
      return [...events];
    },

    search(query) {
      const text = query.text?.toLowerCase();
      return events.filter((event) => {
        if (query.sessionId && event.sessionId !== query.sessionId)
          return false;
        if (query.type && event.type !== query.type) return false;
        if (
          text &&
          !JSON.stringify(event.payload).toLowerCase().includes(text)
        ) {
          return false;
        }
        return true;
      });
    },
  };
}

/**
 * classifyMessage — 将 ChatCompletionMessageParam 分类成 transcript 事件类型
 *
 * role=user 中既有真实用户输入，也有 system-reminder 和 Hook 注入消息。
 * 这里先做轻量区分，方便未来搜索时过滤掉非用户原话。
 */
export function classifyMessage(
  message: ChatCompletionMessageParam,
): TranscriptEventType {
  if (message.role === "assistant") return "assistant_message";
  if (message.role === "tool") return "tool_result";
  if (message.role === "user") {
    const content = typeof message.content === "string" ? message.content : "";
    if (content.startsWith("<system-reminder")) return "system_reminder";
    if (content.startsWith("[Hook:")) return "hook_message";
    return "user_message";
  }
  return "system_reminder";
}

function defaultIdGenerator(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
