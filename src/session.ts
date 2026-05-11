/**
 * session.ts — 会话管理模块
 *
 * 职责：给主 Agent 和子 Agent 分配稳定的 sessionId，并记录父子关系。
 *
 * 这里的 session 是 transcript/event 层的概念，不是 prompt working
 * context。History 仍然只负责当前 LLM 上下文；SessionManager 负责说明
 * “这些原始事件属于哪一次会话”。
 */

import { randomUUID } from "node:crypto";

export type SessionKind = "main" | "subagent";

/**
 * SessionRecord — 一个会话的元信息
 */
export interface SessionRecord {
  /** 会话唯一 id */
  id: string;
  /** 主会话或子智能体会话 */
  kind: SessionKind;
  /** 子会话指向父会话 */
  parentSessionId?: string;
  /** 会话开始时间 */
  startedAt: string;
  /** 会话结束时间（第一版只预留，不强制调用） */
  endedAt?: string;
  /** 可读标题，主会话可为空，子会话默认来自 task 预览 */
  title?: string;
  /** 会话所属项目根目录 */
  projectRoot: string;
  /** 会话启动时的 cwd */
  cwd: string;
  /** 会话使用的模型名 */
  model: string;
}

export interface SessionManager {
  createMainSession(title?: string): SessionRecord;
  createChildSession(parentSessionId: string, title?: string): SessionRecord;
  endSession(sessionId: string): void;
  get(sessionId: string): SessionRecord | undefined;
  list(): SessionRecord[];
}

/**
 * createSessionManager — 创建进程内 session registry
 *
 * idGenerator 便于单元测试注入可预测 id。
 */
export function createSessionManager(options: {
  projectRoot: string;
  model: string;
  cwd?: string;
  now?: () => Date;
  idGenerator?: () => string;
}): SessionManager {
  const records: SessionRecord[] = [];
  const byId = new Map<string, SessionRecord>();
  const now = options.now ?? (() => new Date());
  const idGenerator = options.idGenerator ?? randomUUID;
  const cwd = options.cwd ?? options.projectRoot;

  function createRecord(input: {
    kind: SessionKind;
    parentSessionId?: string;
    title?: string;
  }): SessionRecord {
    const record: SessionRecord = {
      id: idGenerator(),
      kind: input.kind,
      startedAt: now().toISOString(),
      projectRoot: options.projectRoot,
      cwd,
      model: options.model,
    };
    if (input.parentSessionId) record.parentSessionId = input.parentSessionId;
    if (input.title) record.title = input.title;

    records.push(record);
    byId.set(record.id, record);
    return record;
  }

  return {
    createMainSession(title) {
      const input: { kind: SessionKind; title?: string } = { kind: "main" };
      if (title) input.title = title;
      return createRecord(input);
    },

    createChildSession(parentSessionId, title) {
      const input: {
        kind: SessionKind;
        parentSessionId: string;
        title?: string;
      } = { kind: "subagent", parentSessionId };
      if (title) input.title = title;
      return createRecord(input);
    },

    endSession(sessionId) {
      const record = byId.get(sessionId);
      if (!record || record.endedAt) return;
      record.endedAt = now().toISOString();
    },

    get(sessionId) {
      return byId.get(sessionId);
    },

    list() {
      return [...records];
    },
  };
}
