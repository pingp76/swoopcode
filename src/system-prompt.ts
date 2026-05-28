/**
 * system-prompt.ts — System Prompt 组合器（Cache-Ready 版本）
 *
 * 职责：将 system prompt 分为三层管理，保证 prompt cache 前缀稳定：
 * 1. Project Instructions — projectRoot/AGENTS.md，启动时读取，放在最前面
 * 2. Session Snapshot — Skill/Memory 等会话内固定片段，显式 refresh 才变化
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
  /** 项目级 AGENTS.md 指令（存在时放在 system prompt 最前面） */
  projectInstructions?: string | null;
  /** Task/TODO 选择规则（稳定固定片段） */
  taskPlanningHint?: string | null;
  /** Skill 提示（有可用 skill 时注入） */
  skillHint?: string | null;
  /** Memory 摘要提示（有 memory 时注入） */
  memoryHint?: string | null;
}

/** System prompt 稳定快照 */
export interface SystemPromptSnapshot {
  /** 组合后的完整 system prompt */
  systemPrompt: string | null;
  /** 当前 snapshot 中的项目级 AGENTS.md 指令（用于调试） */
  projectInstructions: string | null;
  /** 当前 snapshot 中的 Task/TODO 选择规则（用于调试） */
  taskPlanningHint: string | null;
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
 * 3. AGENTS.md 项目指令在最前，然后是 Task/TODO 选择规则、Skill hint、Memory hint
 */
export function buildSystemPrompt(parts: SystemPromptParts): string | null {
  const segments: string[] = [];
  if (parts.projectInstructions) segments.push(parts.projectInstructions);
  if (parts.taskPlanningHint) segments.push(parts.taskPlanningHint);
  if (parts.skillHint) segments.push(parts.skillHint);
  if (parts.memoryHint) segments.push(parts.memoryHint);
  if (segments.length === 0) return null;
  return segments.join("\n\n");
}

/**
 * TASK_PLANNING_SYSTEM_HINT — Planning vs Execution 分层指引
 *
 * 核心 mental model：Task Group / TODO = 规划与追踪；direct tool / subagent / async run = 执行。
 * 这个分层一旦立住，LLM 判断会清楚很多。
 *
 * 这是稳定 system prompt 的固定片段，不包含任何动态任务状态，因此不会破坏 prompt cache 前缀。
 */
export const TASK_PLANNING_SYSTEM_HINT = [
  "## Planning vs Execution",
  "",
  "Task Groups, TODO lists, Schedules, and Async Runs have distinct responsibilities. Do not mix them.",
  "",
  "Use `run_task_*` for durable work plans that may span sessions, restarts, projects, owners, or dependency graphs. Task Groups persist under the Agent runtime directory. Every modifying Task tool call must pass an explicit `group_id`. Task Groups do not run code by themselves.",
  "",
  "Use `run_todo_*` for temporary execution steps inside the current session. TODO lists are not durable and are appropriate when losing the list after restart is acceptable.",
  "",
  "Use `run_schedule_*` for durable time-based triggers. Schedules persist under the Agent runtime directory and automatically create Async Runs at the scheduled time. Schedules store user intent, timing rules, execution boundaries, and output policy. Do not use a Schedule as a Task Group, and do not use a Task Group as a timer.",
  "",
  "For complex current-session work, a good default workflow is:",
  "1. Use a Task Group only if the work itself needs durable tracking.",
  "2. Use a TODO list if the current task has multiple local steps.",
  "3. For each TODO step, choose the appropriate execution path: direct tool call, `run_subagent`, or `run_async_start`.",
  "4. Use a Schedule only when the user wants periodic or one-time automatic triggering.",
  "",
  "## Execution Tool Routing",
  "",
  "Choose execution tools by whether the work needs independent reasoning and whether the parent must wait.",
  "",
  "- Direct tools such as `run_bash`, `run_read`, `run_write`, and `run_edit`: use when the next action is clear and the parent Agent can do it directly.",
  "- `run_subagent`: use for synchronous delegated read-only exploration or diagnosis that needs an independent child Agent. The parent blocks until the child returns a final text result. Use only when the next parent step depends on that result.",
  "- `run_async_start` with `executor=\"command\"`: use for non-blocking shell commands where the exact command is already known and raw stdout/stderr is sufficient, such as typecheck, tests, lint, or `git diff`.",
  "- `run_async_start` with `executor=\"subagent\"`: use for non-blocking delegated read-only work where the goal is clear but the exact steps require Agent reasoning. The parent does not block and can continue other useful work.",
  "",
  "Important rules:",
  "- Task Groups do not run code by themselves.",
  "- Async runs do not automatically update Task Groups or TODO lists. After checking async output, update planning state manually if needed.",
  "- Multiple async runs may execute in parallel, up to the configured concurrency limit.",
  "- Multiple `run_subagent` calls in one response execute sequentially. Do not use them to express parallelism.",
  "- If the result is required before the next step, prefer `run_subagent` or a direct tool call. If useful work can continue meanwhile, prefer `run_async_start`.",
  "",
  "## Dynamic Runtime Context",
  "",
  "The stable system prompt contains durable behavior rules only.",
  "Changes to memory, skills, async run notifications, task state summaries, TODO summaries, schedule updates, and other changing runtime facts are provided later as system reminders.",
  "",
  "Treat system reminders as current runtime context. If a reminder conflicts with user messages, observed files, or tool results, prefer the more direct and recent evidence.",
].join("\n");

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
 * @param deps.getProjectInstructions - 返回项目级 AGENTS.md 指令的函数
 *
 * 内部行为：
 * - 创建时立即生成一次 snapshot
 * - getSnapshot() 返回缓存的快照，不重新读取
 * - refreshSnapshot() 重新读取并更新缓存
 * - buildTurnReminders() 检测忽略 memory 关键词，返回 reminder 列表
 */
export function createSystemPromptProvider(deps: {
  getProjectInstructions?: () => string | null;
  getSkillHint: () => string | null;
  getMemoryHint: () => string | null;
}): SystemPromptProvider {
  // 内部缓存当前快照
  let cachedSnapshot: SystemPromptSnapshot;

  /**
   * buildCurrentSnapshot — 根据当前 Skill/Memory hint 构建快照
   */
  function buildCurrentSnapshot(): SystemPromptSnapshot {
    const projectInstructions = deps.getProjectInstructions?.() ?? null;
    const taskPlanningHint = TASK_PLANNING_SYSTEM_HINT;
    const skillHint = deps.getSkillHint();
    const memoryHint = deps.getMemoryHint();
    return {
      systemPrompt: buildSystemPrompt({
        projectInstructions,
        taskPlanningHint,
        skillHint,
        memoryHint,
      }),
      projectInstructions,
      taskPlanningHint,
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
