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
  // 用数组保存所有会话记录，保持创建顺序
  const records: SessionRecord[] = [];
  // 用 Map 建立 sessionId -> 记录的快速索引，方便 O(1) 查找
  const byId = new Map<string, SessionRecord>();
  // 若调用方未提供时间函数，则使用系统当前时间
  const now = options.now ?? (() => new Date());
  // 若调用方未提供 id 生成器，则使用 UUID，测试时可注入确定性生成器
  const idGenerator = options.idGenerator ?? randomUUID;
  // 若未指定 cwd，则默认使用项目根目录
  const cwd = options.cwd ?? options.projectRoot;

  function createRecord(input: {
    kind: SessionKind;
    parentSessionId?: string;
    title?: string;
  }): SessionRecord {
    // 构造基础会话记录，id 和开始时间由运行时生成
    const record: SessionRecord = {
      id: idGenerator(),
      kind: input.kind,
      startedAt: now().toISOString(),
      projectRoot: options.projectRoot,
      cwd,
      model: options.model,
    };
    // 仅在传入时设置可选字段，避免对象上出现 undefined 值
    if (input.parentSessionId) record.parentSessionId = input.parentSessionId;
    if (input.title) record.title = input.title;

    // 同时注册到数组和 Map，保证顺序遍历与快速查找都能满足
    records.push(record);
    byId.set(record.id, record);
    return record;
  }

  return {
    createMainSession(title) {
      // 主会话的 kind 固定为 "main"，标题可选
      const input: { kind: SessionKind; title?: string } = { kind: "main" };
      if (title) input.title = title;
      return createRecord(input);
    },

    createChildSession(parentSessionId, title) {
      // 子会话必须携带父会话 id，以便后续追踪血缘关系
      const input: {
        kind: SessionKind;
        parentSessionId: string;
        title?: string;
      } = { kind: "subagent", parentSessionId };
      if (title) input.title = title;
      return createRecord(input);
    },

    endSession(sessionId) {
      // 先通过 Map 快速定位记录
      const record = byId.get(sessionId);
      // 若记录不存在或已结束，则幂等返回，避免重复设置结束时间
      if (!record || record.endedAt) return;
      // 标记会话结束时间
      record.endedAt = now().toISOString();
    },

    get(sessionId) {
      // 通过 Map 实现 O(1) 的按 id 查询
      return byId.get(sessionId);
    },

    list() {
      // 返回数组的浅拷贝，防止外部直接修改内部 records 数组
      return [...records];
    },
  };
}
