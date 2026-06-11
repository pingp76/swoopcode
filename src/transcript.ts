/**
 * transcript.ts — 原始对话事件存储模块
 *
 * 职责：以 append-only 方式保存原始事件，为未来搜索、回放和分析打基础。
 *
 * 重要边界：
 * - TranscriptStore 不参与 prompt 构建。
 * - History 可以被 compact/replace；TranscriptStore 不会改写旧事件。
 * - 每条事件都带 sessionId，后续可以自然扩展到多 session 和子智能体。
 * - TranscriptEvent.sequence 是事件流顺序，不等同于 History.messageSequence。
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { MessageTimingInput } from "./timeline.js";

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
  /** 第几次外部用户输入触发的 agent.run() */
  turnIndex?: number;
  /** 当前 turn 内第几次 LLM 调用 */
  loopRound?: number;
  /** 当前 Agent 实例内第几次 LLM 调用 */
  loopIndex?: number;
  /** 对应 History messageSequence；非 message 事件可以没有 */
  historySequence?: number;
  /** 原始负载，不参与 prompt 处理 */
  payload: unknown;
}

export interface TranscriptStore {
  append(input: {
    sessionId: string;
    type: TranscriptEventType;
    round?: number;
    timing?: MessageTimingInput;
    payload: unknown;
  }): TranscriptEvent;
  appendMessage(input: {
    sessionId: string;
    round?: number;
    timing?: MessageTimingInput;
    historySequence?: number;
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
  // 设计导读：
  // Transcript 是“原始审计流”，不是“给 LLM 的上下文”。
  //
  // 很多 agent 初学实现会只保存一份 messages，然后在 compact 时直接替换它。
  // 这样虽然能继续对话，但会丢掉原始工具调用、错误恢复、Hook 注入等过程证据。
  // 本项目把 History 和 Transcript 分开：
  // - History 可以为了上下文窗口被压缩
  // - Transcript append-only，未来可用于搜索、回放、统计和调试
  //
  // 当前实现仍是内存版，不做磁盘持久化；这是教学阶段的范围裁剪。

  // 所有事件的中心存储，append-only，不删除不修改
  const events: TranscriptEvent[] = [];
  // 每个 session 维护自己的递增序号，保证同一 session 内事件顺序稳定
  const sequenceBySession = new Map<string, number>();
  // 时间生成器与 id 生成器均可注入，方便测试控制
  const now = options?.now ?? (() => new Date());
  const idGenerator = options?.idGenerator ?? defaultIdGenerator;

  function append(input: {
    sessionId: string;
    type: TranscriptEventType;
    round?: number;
    timing?: MessageTimingInput;
    historySequence?: number;
    payload: unknown;
  }): TranscriptEvent {
    // 每个 session 独立递增 sequence。
    // 这比全局 sequence 更适合回放单个 session；父子 session 之间通过 parentSessionId 关联，
    // 不强行混成一条全局线性历史。

    // 从 Map 中取出当前 session 的已有序号，若不存在则视为 0，再加 1 得到新序号
    const nextSequence = (sequenceBySession.get(input.sessionId) ?? 0) + 1;
    sequenceBySession.set(input.sessionId, nextSequence);

    // 构建事件对象，payload 先做深拷贝，防止外部后续修改影响已存储的数据
    // 常见坑：直接保存 payload 对象引用。
    // 后续 history 或工具结果如果被 normalize/compact 修改，transcript 也会被“回头改写”。
    const event: TranscriptEvent = {
      id: idGenerator(),
      sessionId: input.sessionId,
      sequence: nextSequence,
      timestamp: now().toISOString(),
      type: input.type,
      payload: cloneJson(input.payload),
    };
    // 将 timing 信息（如 turnIndex、loopRound）展开到事件顶层字段
    applyTiming(event, input.timing ?? timingFromRound(input.round));
    // historySequence 仅在传入时写入，非 message 类事件可以不提供
    if (input.historySequence !== undefined) {
      event.historySequence = input.historySequence;
    }

    // 追加到全局事件数组，完成存储
    events.push(event);
    return event;
  }

  return {
    append,

    appendMessage(input) {
      // 优先使用调用方显式传入的 timing，否则尝试从 round 推导
      const timing = input.timing ?? timingFromRound(input.round);
      return append({
        sessionId: input.sessionId,
        // 根据 message 的 role 和内容前缀判断具体事件类型
        type: classifyMessage(input.message),
        // timing 仅在有效时传入，避免传入空对象
        ...(timing ? { timing } : {}),
        // historySequence 仅在已定义时传入，保持字段精简
        ...(input.historySequence !== undefined
          ? { historySequence: input.historySequence }
          : {}),
        payload: { message: input.message },
      });
    },

    readSession(sessionId) {
      // 按 sessionId 过滤全局事件，返回该会话的全部事件
      return events.filter((e) => e.sessionId === sessionId);
    },

    list() {
      // 返回全局事件数组的浅拷贝，隔离外部修改
      return [...events];
    },

    search(query) {
      // search 当前是教学版的朴素实现：把 payload JSON 化后做子串匹配。
      // 它不是高性能全文检索，但足够表达 Transcript 的用途。
      // 未来如果要持久化 transcript，可以把这里替换为索引或数据库查询。
      // 若提供了 text 查询条件，统一转小写以实现大小写不敏感匹配
      const text = query.text?.toLowerCase();
      return events.filter((event) => {
        // sessionId 条件：不匹配则直接排除
        if (query.sessionId && event.sessionId !== query.sessionId)
          return false;
        // type 条件：不匹配则直接排除
        if (query.type && event.type !== query.type) return false;
        // text 条件：将 payload 序列化为 JSON 后在小写文本中查找子串
        if (
          text &&
          !JSON.stringify(event.payload).toLowerCase().includes(text)
        ) {
          return false;
        }
        // 通过全部条件则保留
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
  // role=user 不一定等于“真实用户说的话”。
  // Agent 为了保持 system prompt 稳定，会把 system-reminder、Hook 消息也用 user role 注入。
  // Transcript 在这里做轻量分类，未来搜索时才能区分用户原话和系统提醒。

  // 根据 role 快速分流
  if (message.role === "assistant") return "assistant_message";
  if (message.role === "tool") return "tool_result";
  if (message.role === "user") {
    // content 可能不是字符串，此时按空字符串处理以避免运行时异常
    const content = typeof message.content === "string" ? message.content : "";
    // 通过 XML 标签前缀识别系统提醒
    if (content.startsWith("<system-reminder")) return "system_reminder";
    // 通过 Hook 前缀识别 Hook 注入消息
    if (content.startsWith("[Hook:")) return "hook_message";
    // 其余 user role 消息视为真实用户输入
    return "user_message";
  }
  // 其他未识别的 role（如 system）统一归入 system_reminder，保证穷尽覆盖
  return "system_reminder";
}

function applyTiming(
  event: TranscriptEvent,
  timing: MessageTimingInput | undefined,
): void {
  // 无 timing 信息时直接返回，不做任何修改
  if (!timing) return;
  // loopRound 优先取显式值，未定义时回退到 round，保持兼容
  const loopRound = timing.loopRound ?? timing.round;
  if (timing.turnIndex !== undefined) event.turnIndex = timing.turnIndex;
  if (loopRound !== undefined) {
    event.loopRound = loopRound;
    event.round = loopRound;
  }
  if (timing.loopIndex !== undefined) event.loopIndex = timing.loopIndex;
}

function timingFromRound(
  round: number | undefined,
): MessageTimingInput | undefined {
  // 仅在 round 有效时构造 timing 对象，否则返回 undefined 以允许上层忽略
  return round !== undefined ? { round } : undefined;
}

function defaultIdGenerator(): string {
  // 使用时间戳保证单调递增趋势，再拼接随机字符串保证唯一性
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function cloneJson<T>(value: T): T {
  // 通过 JSON 序列化与反序列化实现深拷贝，简单但无法处理函数、循环引用等
  return JSON.parse(JSON.stringify(value)) as T;
}
