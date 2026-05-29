/**
 * session-events.ts — 会话事件缓冲区
 *
 * 职责：收集 out-of-band 状态变化（如 mode 切换、memory reload），
 * 并在下一次用户请求时注入为 <system-reminder> 消息。
 *
 * 设计原则：
 * - 轻量：只保存短消息，不保存大型内容
 * - 一次性：drain() 后清空，避免重复注入
 * - 顺序保持：多条提醒按插入顺序输出
 * - 格式统一：Agent 负责包装 XML，各模块只提供纯文本
 *
 * 为什么不用 EventEmitter？
 * - 这个模块不需要订阅/广播模式
 * - 只需要简单的 push/drain/peek 语义
 * - 保持教学代码的简洁性
 */

// ============================================================
// 接口定义
// ============================================================

/**
 * SessionReminder — 单条会话提醒
 *
 * source 标识提醒来源，方便调试和分类。
 * message 是纯文本内容，由 Agent 统一包装成 <system-reminder> XML。
 */
export interface SessionReminder {
  /** 提醒来源 */
  source: "memory" | "mode" | "skill" | "cache" | "task" | "system";
  /** 提醒内容（纯文本，不含 XML 标签） */
  message: string;
}

/**
 * SessionEventBuffer — 会话事件缓冲区接口
 */
export interface SessionEventBuffer {
  /** 推送一条提醒到缓冲区 */
  push(reminder: SessionReminder): void;
  /** 取出所有提醒并清空缓冲区 */
  drain(): SessionReminder[];
  /** 查看当前所有提醒（不清空，用于测试和调试） */
  peek(): SessionReminder[];
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * createSessionEventBuffer — 创建会话事件缓冲区
 *
 * 内部使用数组存储提醒，保证插入顺序。
 * drain() 返回当前数组的浅拷贝后清空原数组。
 * peek() 返回浅拷贝但不清空。
 */
export function createSessionEventBuffer(): SessionEventBuffer {
  // 使用内部数组保存提醒，按 push 顺序排列
  const reminders: SessionReminder[] = [];

  return {
    push(reminder: SessionReminder): void {
      // 将新提醒追加到数组末尾，保持插入顺序
      reminders.push(reminder);
    },

    drain(): SessionReminder[] {
      // 先通过浅拷贝取出当前所有提醒
      const result = reminders.slice();
      // 清空原数组，确保同一条提醒不会被重复注入
      reminders.length = 0;
      return result;
    },

    peek(): SessionReminder[] {
      // 返回当前数组的浅拷贝，不修改原数组，用于调试或预览
      return reminders.slice();
    },
  };
}
