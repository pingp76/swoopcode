/**
 * system-prompt.ts — System Prompt 组合器（Cache-Ready 版本）
 *
 * 职责：将 system prompt 分为三层管理，保证 prompt cache 前缀稳定：
 * 1. Static — 进程启动后固定不变
 * 2. Session Snapshot — 会话内固定，显式 refresh 才变化
 * 3. Turn Reminder — 单轮动态，通过 user message 注入
 *
 * 核心原则：
 * - 不要在每轮 run() 中重建 system prompt
 * - 动态状态变化（如忽略 memory）通过 <system-reminder> 消息表达
 * - Session Snapshot 只在启动或显式 /prompt refresh 时更新
 */

import type { SessionReminder } from "./session-events.js";

// ============================================================================
// 类型定义
// ============================================================================

/** System prompt 的各个片段 */
export interface SystemPromptParts {
  /** Skill 提示（有可用 skill 时注入） */
  skillHint?: string | null;
  /** Memory 摘要提示（有 memory 时注入） */
  memoryHint?: string | null;
}

/** System prompt 稳定快照 */
export interface SystemPromptSnapshot {
  /** 组合后的完整 system prompt */
  systemPrompt: string | null;
  /** 当前 snapshot 中的 skill hint（用于调试） */
  skillHint: string | null;
  /** 当前 snapshot 中的 memory hint（用于调试） */
  memoryHint: string | null;
}

/** 本轮 prompt 上下文 */
export interface TurnPromptContext {
  /** 用户当前输入 */
  query: string;
}

/** System Prompt 提供者接口（Cache-Ready） */
export interface SystemPromptProvider {
  /** 获取当前稳定快照（不会自动刷新） */
  getSnapshot(): SystemPromptSnapshot;
  /** 显式刷新快照，重新读取 Skill/Memory */
  refreshSnapshot(): SystemPromptSnapshot;
  /** 根据本轮 query 构建 turn reminders（不改变 system prompt） */
  buildTurnReminders(ctx: TurnPromptContext): SessionReminder[];
}

// ============================================================================
// 组合函数
// ============================================================================

/**
 * buildSystemPrompt — 将多个片段组合成最终 system prompt
 *
 * 规则：
 * 1. 没有任何片段时返回 null
 * 2. 有多个片段时用空行分隔
 * 3. Skill hint 在前，Memory hint 在后
 */
export function buildSystemPrompt(parts: SystemPromptParts): string | null {
  const segments: string[] = [];
  if (parts.skillHint) segments.push(parts.skillHint);
  if (parts.memoryHint) segments.push(parts.memoryHint);
  if (segments.length === 0) return null;
  return segments.join("\n\n");
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * 匹配用户要求忽略 memory 的各种表达：
 * "忽略 memory"、"不要使用 memory"、"本轮不要使用 memory"、
 * "不使用 memory"、"ignore memory"、"don't use memory"、"do not use memory"
 */
const IGNORE_MEMORY_PATTERN =
  /(?:忽略|不使用|不要使用|don'?t use|do not use|ignore)\s*memory/i;

/**
 * createSystemPromptProvider — 创建 Cache-Ready 的 SystemPromptProvider
 *
 * @param deps.getSkillHint - 返回当前 Skill hint 的函数
 * @param deps.getMemoryHint - 返回当前 Memory hint 的函数
 *
 * 内部行为：
 * - 创建时立即生成一次 snapshot
 * - getSnapshot() 返回缓存的快照，不重新读取
 * - refreshSnapshot() 重新读取并更新缓存
 * - buildTurnReminders() 检测忽略 memory 关键词，返回 reminder 列表
 */
export function createSystemPromptProvider(deps: {
  getSkillHint: () => string | null;
  getMemoryHint: () => string | null;
}): SystemPromptProvider {
  // 内部缓存当前快照
  let cachedSnapshot: SystemPromptSnapshot;

  /**
   * buildCurrentSnapshot — 根据当前 Skill/Memory hint 构建快照
   */
  function buildCurrentSnapshot(): SystemPromptSnapshot {
    const skillHint = deps.getSkillHint();
    const memoryHint = deps.getMemoryHint();
    return {
      systemPrompt: buildSystemPrompt({ skillHint, memoryHint }),
      skillHint,
      memoryHint,
    };
  }

  // 初始化：创建时立即生成一次快照
  cachedSnapshot = buildCurrentSnapshot();

  return {
    getSnapshot(): SystemPromptSnapshot {
      return cachedSnapshot;
    },

    refreshSnapshot(): SystemPromptSnapshot {
      cachedSnapshot = buildCurrentSnapshot();
      return cachedSnapshot;
    },

    buildTurnReminders(ctx: TurnPromptContext): SessionReminder[] {
      const reminders: SessionReminder[] = [];

      // 检测用户是否要求本轮忽略 memory
      if (IGNORE_MEMORY_PATTERN.test(ctx.query)) {
        reminders.push({
          source: "memory",
          message:
            "For this turn, do not use long-term memory. Ignore the memory snapshot unless the user explicitly asks to inspect it.",
        });
      }

      return reminders;
    },
  };
}
