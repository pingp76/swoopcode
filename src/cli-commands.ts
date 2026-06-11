/**
 * cli-commands.ts — CLI 命令注册与分发
 *
 * 职责：管理 REPL 中的斜杠命令（如 /skill），提供统一的注册和分发机制。
 *
 * 为什么需要独立的命令系统？
 * - REPL 中有些操作不需要经过 LLM（如列出 skill、查看状态）
 * - 这些命令需要直接操作内部组件（SkillManager、TodoManager 等）
 * - 独立出来后，index.ts（组装根）不需要关心命令的具体实现
 *
 * 设计模式：命令注册表
 * - 每个命令用 registerCommand() 注册
 * - REPL 收到 "/" 开头的输入时，通过 dispatchCommand() 分发
 * - 未来添加新命令（如 /todo、/history）只需注册，不修改 REPL 代码
 */

import type { Logger } from "./logger.js";
import type { createSkillManager } from "./skills.js";
import type { PermissionManager, PermissionMode } from "./permission.js";
import type { MemoryManager } from "./memory.js";
import type { SessionEventBuffer } from "./session-events.js";
import type { TaskManager } from "./tasks.js";
import { formatTaskGroupList, formatTaskGroupView } from "./tasks.js";
import type { ScheduleManager } from "./schedules.js";
import type { RuntimePolicyStore } from "./runtime-policy-store.js";
import type { ThinkingDefaultMode } from "./foundation-models.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * CliCommand — CLI 命令接口
 *
 * 每个命令需要提供：
 * - name：命令名（如 "skill"）
 * - handler：命令执行函数
 */
export interface CliCommand {
  /** 命令名（不含前缀 "/"） */
  name: string;
  /** 可选别名列表（不含前缀 "/"） */
  aliases?: string[];
  /** 命令执行函数 */
  handler: (args: string[]) => void;
}

/**
 * CliCommandRegistry — CLI 命令注册表接口
 */
export interface CliCommandRegistry {
  /** 注册一个命令 */
  register(command: CliCommand): void;
  /** 分发命令：如果匹配已注册命令则执行并返回 true，否则返回 false */
  dispatch(input: string): boolean;
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createCliCommandRegistry — 创建 CLI 命令注册表
 */
export function createCliCommandRegistry(): CliCommandRegistry {
  const commands = new Map<string, CliCommand>();

  return {
    register(command: CliCommand): void {
      commands.set(command.name, command);
      if (command.aliases) {
        for (const alias of command.aliases) {
          commands.set(alias, command);
        }
      }
    },

    dispatch(input: string): boolean {
      // 只处理 "/" 开头的输入
      if (!input.startsWith("/")) return false;

      const parts = input.trim().split(/\s+/);
      const commandName = parts[0]!.slice(1); // 去掉前缀 "/"

      const command = commands.get(commandName);
      if (!command) return false;

      // 传入参数部分（不含命令名本身）
      command.handler(parts.slice(1));
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// 具体命令实现
// ---------------------------------------------------------------------------

/**
 * createSkillCliCommand — 创建 /skill CLI 命令
 *
 * 这些命令直接操作 SkillManager，不经过 LLM：
 * - /skill list         显示已安装的 skill 列表（本地缓存）
 * - /skill load         重新扫描 skills/ 目录，更新本地缓存
 * - /skill remove <name> 删除指定 skill
 *
 * 【静态快照语义】
 * run_skill 的 tool description 是启动时的静态快照。
 * /skill load 和 /skill remove 只影响本地缓存，不更新 LLM 可见的工具定义。
 * 要让 LLM 看到新的 skill 列表，需要重启 agent。
 */
export function createSkillCliCommand(
  manager: ReturnType<typeof createSkillManager>,
  logger: Logger,
  sessionEventBuffer?: SessionEventBuffer,
): CliCommand {
  return {
    name: "skill",
    handler(args: string[]): void {
      const subcommand = args[0];

      switch (subcommand) {
        case "list": {
          const metas = manager.listMeta();
          if (metas.length === 0) {
            console.log("No skills loaded.");
          } else {
            console.log("Available skills:");
            for (const m of metas) {
              console.log(`  - ${m.name}: ${m.description}`);
            }
          }
          break;
        }
        case "load": {
          // 重新扫描 skills/ 目录
          // 注意：这只是更新本地缓存，不会更新 run_skill 的 tool description
          // LLM 看到的 skill 列表仍然是启动时的快照
          manager.scan();
          const count = manager.listMeta().length;
          logger.info("Re-scanned skills: %d loaded", count);
          console.log(`Scanned skills: ${count} skill(s) in local cache.`);
          console.log(
            "Note: the LLM's tool definition is a static snapshot from startup.",
          );
          console.log(
            "Restart the agent to update which skills the LLM can see.",
          );
          if (sessionEventBuffer) {
            sessionEventBuffer.push({
              source: "skill",
              message:
                "Skills were re-scanned. Tool definitions remain the startup snapshot. Restart or explicitly refresh the prompt snapshot if the model must see new skill metadata.",
            });
          }
          break;
        }
        case "remove": {
          const skillName = args[1];
          if (!skillName) {
            console.log("Usage: /skill remove <name>");
            break;
          }
          const removed = manager.remove(skillName);
          if (removed) {
            logger.info("Skill removed: %s", skillName);
            console.log(`Skill "${skillName}" removed.`);
          } else {
            console.log(`Skill "${skillName}" not found.`);
          }
          break;
        }
        default:
          console.log("Usage: /skill <list|load|remove <name>>");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /mode 命令
// ---------------------------------------------------------------------------

/**
 * createModeCliCommand — 创建 /mode CLI 命令
 *
 * 切换 Agent 的运行模式：
 * - /mode        显示当前模式和用法
 * - /mode plan    切换到规划模式（只读）
 * - /mode auto    切换到自动模式（可自主执行）
 * - /mode default 切换到默认模式（敏感操作需确认）
 */
export function createModeCliCommand(
  permissionManager: PermissionManager,
  logger: Logger,
  sessionEventBuffer?: SessionEventBuffer,
): CliCommand {
  const validModes: PermissionMode[] = ["plan", "auto", "default"];

  return {
    name: "mode",
    handler(args: string[]): void {
      const subcommand = args[0];

      if (!subcommand) {
        console.log(`Current mode: ${permissionManager.getMode()}`);
        console.log("Usage: /mode <plan|auto|default>");
        return;
      }

      if (!validModes.includes(subcommand as PermissionMode)) {
        console.log(`Invalid mode: ${subcommand}`);
        console.log("Usage: /mode <plan|auto|default>");
        return;
      }

      permissionManager.setMode(subcommand as PermissionMode);
      logger.info("Mode switched to %s", subcommand);
      console.log(`Mode switched to ${subcommand}.`);

      // 向 sessionEventBuffer 推送 reminder，让下一轮 LLM 知道 mode 变化
      if (sessionEventBuffer) {
        sessionEventBuffer.push({
          source: "mode",
          message: `Mode changed to ${subcommand}. Keep all tool definitions stable; local permission checks enforce read-only behavior.`,
        });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /memory 命令
// ---------------------------------------------------------------------------

/**
 * createMemoryCliCommand — 创建 /memory CLI 命令
 *
 * 直接操作 MemoryManager，不经过 LLM：
 * - /memory list          显示所有 memory 摘要
 * - /memory show <name>   显示单条 memory 完整内容
 * - /memory remove <name> 删除一条 memory
 * - /memory reload        重新扫描 memory/ 目录并重建索引
 */
export function createMemoryCliCommand(
  manager: MemoryManager,
  logger: Logger,
  sessionEventBuffer?: SessionEventBuffer,
): CliCommand {
  return {
    name: "memory",
    handler(args: string[]): void {
      const subcommand = args[0];

      switch (subcommand) {
        case "list": {
          const metas = manager.list();
          if (metas.length === 0) {
            console.log("No memories stored.");
          } else {
            console.log("Memory:");
            for (const m of metas) {
              console.log(`  - ${m.name}: ${m.description} [${m.type}]`);
            }
          }
          break;
        }
        case "show": {
          const name = args[1];
          if (!name) {
            console.log("Usage: /memory show <name>");
            break;
          }
          const entry = manager.read(name);
          if (!entry) {
            console.log(`Memory "${name}" not found.`);
          } else {
            console.log(`[${entry.meta.type}] ${entry.meta.name}`);
            console.log(`Description: ${entry.meta.description}`);
            console.log(`Created: ${entry.meta.createdAt}`);
            console.log(`Updated: ${entry.meta.updatedAt}`);
            console.log("---");
            console.log(entry.body);
          }
          break;
        }
        case "remove": {
          const name = args[1];
          if (!name) {
            console.log("Usage: /memory remove <name>");
            break;
          }
          const removed = manager.delete(name);
          if (removed) {
            logger.info("Memory removed: %s", name);
            console.log(`Memory "${name}" removed.`);
            if (sessionEventBuffer) {
              sessionEventBuffer.push({
                source: "memory",
                message: `Memory entry "${name}" was removed. The stable system prompt memory snapshot may still mention it until snapshot refresh.`,
              });
            }
          } else {
            console.log(`Memory "${name}" not found.`);
          }
          break;
        }
        case "reload": {
          manager.scan();
          manager.rebuildIndex();
          const count = manager.list().length;
          logger.info("Memory reloaded: %d entries", count);
          console.log(`Reloaded memory: ${count} entry(s).`);
          if (sessionEventBuffer) {
            sessionEventBuffer.push({
              source: "memory",
              message:
                "Memory was reloaded. The stable system prompt memory snapshot was not automatically changed. Use run_memory_list/read if latest memory matters.",
            });
          }
          break;
        }
        default:
          console.log("Usage: /memory <list|show <name>|remove <name>|reload>");
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /schedule 命令
// ---------------------------------------------------------------------------

/**
 * createScheduleCliCommand — 创建 /schedule CLI 命令
 *
 * 直接操作 ScheduleManager，不经过 LLM：
 * - /schedule list [--all] [--all-projects] 列出 schedule 摘要
 * - /schedule show <schedule_id> 显示 schedule 详情和最近 occurrences
 * - /schedule cancel <schedule_id> 取消 schedule
 * - /schedule delete <schedule_id> 删除未执行的 schedule
 * - /schedule occurrences <schedule_id> 列出 occurrence 历史
 */
export function createScheduleCliCommand(
  manager: ScheduleManager,
  logger: Logger,
): CliCommand {
  return {
    name: "schedule",
    handler(args: string[]): void {
      const subcommand = args[0];

      switch (subcommand) {
        case "list": {
          const includeAll = args.includes("--all");
          const currentProjectOnly = !args.includes("--all-projects");
          const schedules = manager.list({
            includeArchived: includeAll,
            includeCancelled: includeAll,
            currentProjectOnly,
          });
          if (schedules.length === 0) {
            console.log("No schedules found.");
          } else {
            console.log("Schedules:");
            for (const s of schedules) {
              const next = s.nextRunAt ? ` (next: ${s.nextRunAt})` : "";
              console.log(`  - ${s.id}: ${s.title} [${s.status}]${next}`);
            }
          }
          break;
        }
        case "show": {
          const scheduleId = args[1];
          if (!scheduleId) {
            console.log("Usage: /schedule show <schedule_id>");
            break;
          }
          const view = manager.read(scheduleId, { recentOccurrences: 5 });
          if (!view) {
            console.log(`Schedule "${scheduleId}" not found.`);
            break;
          }
          console.log(`Schedule: ${view.id}`);
          console.log(`  Title: ${view.title}`);
          if (view.description)
            console.log(`  Description: ${view.description}`);
          console.log(`  Status: ${view.status}`);
          console.log(`  Executor: ${view.execution.executor}`);
          console.log(`  Overlap: ${view.execution.overlapPolicy}`);
          console.log(`  Next run: ${view.nextRunAt ?? "none"}`);
          const occurrences = manager.listOccurrences({ scheduleId, limit: 5 });
          if (occurrences.length > 0) {
            console.log("  Recent occurrences:");
            for (const occ of occurrences) {
              console.log(
                `    - ${occ.id}: ${occ.status} at ${occ.scheduledAt}`,
              );
            }
          }
          break;
        }
        case "cancel": {
          const scheduleId = args[1];
          if (!scheduleId) {
            console.log("Usage: /schedule cancel <schedule_id>");
            break;
          }
          try {
            const view = manager.cancel(scheduleId);
            logger.info("Schedule cancelled: %s", scheduleId);
            console.log(
              `Schedule "${scheduleId}" cancelled. Status: ${view.status}`,
            );
          } catch (error) {
            console.log(
              `Error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          break;
        }
        case "delete": {
          const scheduleId = args[1];
          if (!scheduleId) {
            console.log("Usage: /schedule delete <schedule_id>");
            break;
          }
          try {
            manager.delete(scheduleId);
            logger.info("Schedule deleted: %s", scheduleId);
            console.log(`Schedule "${scheduleId}" deleted.`);
          } catch (error) {
            console.log(
              `Error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          break;
        }
        case "occurrences": {
          const scheduleId = args[1];
          if (!scheduleId) {
            console.log("Usage: /schedule occurrences <schedule_id>");
            break;
          }
          const occurrences = manager.listOccurrences({ scheduleId });
          if (occurrences.length === 0) {
            console.log(`No occurrences found for "${scheduleId}".`);
          } else {
            console.log(`Occurrences for "${scheduleId}":`);
            for (const occ of occurrences) {
              console.log(
                `  - ${occ.id}: ${occ.status} (scheduled: ${occ.scheduledAt})`,
              );
            }
          }
          break;
        }
        default:
          console.log(
            "Usage: /schedule <list [--all] [--all-projects]|show <id>|cancel <id>|delete <id>|occurrences <id>>",
          );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /task 命令
// ---------------------------------------------------------------------------

/**
 * createTaskCliCommand — 创建 /task CLI 命令
 *
 * 直接操作持久化 TaskManager，不经过 LLM：
 * - /task list                列出当前项目未归档的 Task Group
 * - /task list --all          列出当前项目含归档的 Task Group
 * - /task list --all-projects 列出所有项目的 Task Group
 * - /task show <group_id>     显示单个 Task Group 详情
 * - /task archive <group_id>  归档已完成或已取消的 Task Group
 */
export function createTaskCliCommand(
  manager: TaskManager,
  logger: Logger,
): CliCommand {
  return {
    name: "task",
    handler(args: string[]): void {
      const subcommand = args[0];

      switch (subcommand) {
        case "list": {
          const includeArchived = args.includes("--all");
          const currentProjectOnly = !args.includes("--all-projects");
          const groups = manager.listGroups({
            includeArchived,
            currentProjectOnly,
          });
          console.log(formatTaskGroupList(groups));
          break;
        }
        case "show": {
          const groupId = args[1];
          if (!groupId) {
            console.log("Usage: /task show <group_id>");
            break;
          }
          const view = manager.readGroup(groupId);
          if (!view) {
            console.log(`Task group "${groupId}" not found.`);
          } else {
            console.log(formatTaskGroupView(view));
          }
          break;
        }
        case "archive": {
          const groupId = args[1];
          if (!groupId) {
            console.log("Usage: /task archive <group_id>");
            break;
          }
          try {
            const view = manager.archiveGroup(groupId);
            logger.info("Task group archived: %s", groupId);
            console.log(formatTaskGroupView(view));
          } catch (error) {
            console.log(
              `Error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          break;
        }
        default:
          console.log(
            "Usage: /task <list [--all] [--all-projects]|show <group_id>|archive <group_id>>",
          );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /m (model policy) 命令
// ---------------------------------------------------------------------------

/**
 * 解析带 k/K 后缀的 token 数
 */
function parseTokenCount(input: string | undefined): number | undefined {
  if (!input) return undefined;
  const trimmed = input.trim().toLowerCase();
  if (trimmed.endsWith("k")) {
    const num = Number(trimmed.slice(0, -1));
    return Number.isNaN(num) ? undefined : num * 1000;
  }
  const num = Number(trimmed);
  return Number.isNaN(num) ? undefined : num;
}

/**
 * createModelPolicyCliCommand — 创建 /m 模型策略 CLI 命令
 *
 * - /m           显示当前策略状态
 * - /m c 300k    设置 context budget
 * - /m out 32k   设置 max output tokens
 * - /m r         重置所有 override
 */
export function createModelPolicyCliCommand(
  store: RuntimePolicyStore,
  logger: Logger,
): CliCommand {
  return {
    name: "m",
    aliases: ["model", "模型"],
    handler(args: string[]): void {
      const subcommand = args[0];

      if (!subcommand) {
        // 显示当前策略状态
        const policy = store.getPolicy();
        const override = store.getOverride();

        const lines: string[] = ["Model policy"];
        lines.push(`  provider: ${policy.provider}`);
        lines.push(`  model: ${policy.model}`);
        lines.push(`  profile: ${policy.modelProfileId}`);
        lines.push(`  protocol: ${policy.protocol.selected}`);
        lines.push(
          `  context: ${policy.context.effectiveBudgetTokens} / ${policy.context.contextWindowTokens}`,
        );
        lines.push(`  compression: ${policy.context.compressionMode}`);
        lines.push(`  thinking: ${policy.request.thinkingMode}`);
        lines.push(`  effort: ${policy.request.reasoningEffort ?? "default"}`);
        lines.push(
          `  reasoning replay: ${policy.reasoning.mustReplayWithToolCalls ? "required for tool calls" : "not required"}`,
        );

        if (Object.keys(override).length > 0) {
          lines.push("Overrides:");
          const base = store.getBasePolicy();
          if (override.thinkingMode !== undefined) {
            lines.push(
              `  thinking: ${base.request.thinkingMode} -> ${override.thinkingMode}`,
            );
          }
          if (override.contextBudgetTokens !== undefined) {
            lines.push(
              `  context: ${base.context.effectiveBudgetTokens} -> ${override.contextBudgetTokens}`,
            );
          }
          if (override.maxOutputTokens !== undefined) {
            lines.push(
              `  max output: ${base.request.maxOutputTokens} -> ${override.maxOutputTokens}`,
            );
          }
          if (override.reasoningEffort !== undefined) {
            lines.push(
              `  effort: ${base.request.reasoningEffort ?? "default"} -> ${override.reasoningEffort ?? "cleared"}`,
            );
          }
          if (override.compressionMode !== undefined) {
            lines.push(
              `  compression: ${base.context.compressionMode} -> ${override.compressionMode}`,
            );
          }
        }

        console.log(lines.join("\n"));
        return;
      }

      if (subcommand === "r" || subcommand === "reset") {
        store.resetOverride("cli");
        logger.info("Runtime policy override reset");
        console.log("Runtime policy override reset.");
        return;
      }

      if (subcommand === "c" || subcommand === "context") {
        const value = parseTokenCount(args[1]);
        if (value === undefined) {
          console.log("Usage: /m c <tokens> (e.g., /m c 300k or /m c 300000)");
          return;
        }
        try {
          store.updateOverride({ contextBudgetTokens: value }, "cli");
          logger.info("Context budget updated to %d", value);
          console.log(`Context budget set to ${value}.`);
        } catch (err) {
          console.log(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      if (subcommand === "out" || subcommand === "output") {
        const value = parseTokenCount(args[1]);
        if (value === undefined) {
          console.log(
            "Usage: /m out <tokens> (e.g., /m out 32k or /m out 32000)",
          );
          return;
        }
        try {
          store.updateOverride({ maxOutputTokens: value }, "cli");
          logger.info("Max output tokens updated to %d", value);
          console.log(`Max output tokens set to ${value}.`);
        } catch (err) {
          console.log(
            `Error: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      console.log("Usage: /m [c <tokens>|out <tokens>|r]");
    },
  };
}

// ---------------------------------------------------------------------------
// /t (thinking) 命令
// ---------------------------------------------------------------------------

/**
 * 解析 thinking 命令参数
 */
function parseThinkingArg(arg: string): {
  thinkingMode?: ThinkingDefaultMode;
  reasoningEffort?: string | null;
} | null {
  switch (arg) {
    case "开":
    case "on":
      return { thinkingMode: "enabled" };
    case "关":
    case "off":
      return { thinkingMode: "disabled" };
    case "自":
    case "auto":
      return { thinkingMode: "adaptive" };
    case "高":
    case "high":
      return { reasoningEffort: "high" };
    case "最强":
    case "max":
      return { reasoningEffort: "max" };
    case "默认":
    case "default":
      return { reasoningEffort: null };
    default:
      return null;
  }
}

/**
 * createThinkingCliCommand — 创建 /t thinking CLI 命令
 *
 * - /t            显示当前 thinking 状态
 * - /t 开|on      thinking enabled
 * - /t 关|off     thinking disabled
 * - /t 自|auto    thinking adaptive
 * - /t 高|high    reasoning effort high
 * - /t 最强|max   reasoning effort max
 * - /t 默认       清除 reasoning effort override
 */
export function createThinkingCliCommand(
  store: RuntimePolicyStore,
  logger: Logger,
): CliCommand {
  return {
    name: "t",
    aliases: ["think", "thinking", "思考"],
    handler(args: string[]): void {
      const subcommand = args[0];

      if (!subcommand) {
        const policy = store.getPolicy();
        const override = store.getOverride();
        const lines: string[] = ["Thinking policy"];
        lines.push(`  thinking mode: ${policy.request.thinkingMode}`);
        lines.push(
          `  reasoning effort: ${policy.request.reasoningEffort ?? "default"}`,
        );
        if (override.thinkingMode !== undefined) {
          lines.push(`  override mode: ${override.thinkingMode}`);
        }
        if (override.reasoningEffort !== undefined) {
          lines.push(
            `  override effort: ${override.reasoningEffort ?? "cleared"}`,
          );
        }
        console.log(lines.join("\n"));
        return;
      }

      const parsed = parseThinkingArg(subcommand);
      if (!parsed) {
        console.log("Usage: /t [开|关|自|高|最强|默认]");
        return;
      }

      try {
        store.updateOverride(parsed, "cli");
        if (parsed.thinkingMode !== undefined) {
          logger.info("Thinking mode updated to %s", parsed.thinkingMode);
          console.log(`Thinking mode set to ${parsed.thinkingMode}.`);
        }
        if (parsed.reasoningEffort !== undefined) {
          if (parsed.reasoningEffort === null) {
            logger.info("Reasoning effort override cleared");
            console.log("Reasoning effort override cleared.");
          } else {
            logger.info(
              "Reasoning effort updated to %s",
              parsed.reasoningEffort,
            );
            console.log(`Reasoning effort set to ${parsed.reasoningEffort}.`);
          }
        }
      } catch (err) {
        console.log(
          `Error: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// /c (stable context) 命令
// ---------------------------------------------------------------------------

import type { StableContextManager } from "./stable-context.js";

/**
 * createStableContextCliCommand — 创建 /c stable context CLI 命令
 *
 * - /c              显示当前 stable context 状态
 * - /c 开           启用 stable context loader
 * - /c 关           禁用 stable context loader
 * - /c 扫           rebuild repo map
 * - /c 刷            invalidate stable snapshot (rebuild on next LLM call)
 * - /c 加 <path>    pin 文件
 * - /c 删 <path>    unpin 文件
 * - /c 列            列出已加载的资产
 * - /c 排            显示当前 top ranked files（PDD21-1）
 * - /c why <path>    显示某个文件的重要性分数和原因（PDD21-1）
 * - /c 因 <path>     why 的中文别名（PDD21-1）
 */
export function createStableContextCliCommand(
  manager: StableContextManager,
  logger: Logger,
): CliCommand {
  return {
    name: "c",
    aliases: ["ctx", "上下文", "文"],
    handler(args: string[]): void {
      const subcommand = args[0];

      if (!subcommand) {
        const state = manager.getState();
        const lines: string[] = ["Stable context"];
        lines.push(`  enabled: ${state.enabled ? "yes" : "no"}`);
        lines.push(`  pinned: ${state.pinnedPaths.length} file(s)`);
        if (state.pinnedPaths.length > 0) {
          for (const p of state.pinnedPaths) {
            lines.push(`    - ${p}`);
          }
        }
        lines.push(
          `  stable pack: ${state.stablePack?.tokenEstimate ?? 0} tokens`,
        );
        lines.push(
          `  working set: ${state.workingSetPack?.tokenEstimate ?? 0} tokens`,
        );
        lines.push(
          `  evidence: ${state.evidencePack?.tokenEstimate ?? 0} tokens`,
        );
        lines.push(`  total: ${state.totalTokens} tokens`);
        console.log(lines.join("\n"));
        return;
      }

      if (subcommand === "开" || subcommand === "on") {
        manager.setEnabled(true);
        logger.info("Stable context enabled");
        console.log("Stable context enabled.");
        return;
      }

      if (subcommand === "关" || subcommand === "off") {
        manager.setEnabled(false);
        logger.info("Stable context disabled");
        console.log("Stable context disabled.");
        return;
      }

      if (subcommand === "扫" || subcommand === "scan") {
        const pack = manager.rebuildRepoMap();
        logger.info("Repo map rebuilt: %d tokens", pack.tokenEstimate);
        console.log(`Repo map rebuilt. ${pack.tokenEstimate} tokens.`);
        return;
      }

      if (subcommand === "刷" || subcommand === "refresh") {
        manager.invalidateStableSnapshot();
        logger.info(
          "Stable snapshot invalidated, will rebuild on next LLM call",
        );
        console.log(
          "Stable snapshot invalidated. Will rebuild on next LLM call.",
        );
        return;
      }

      if (subcommand === "加" || subcommand === "add" || subcommand === "pin") {
        const filePath = args[1];
        if (!filePath) {
          console.log("Usage: /c 加 <path>");
          return;
        }
        manager.pinPath(filePath);
        logger.info("Pinned path: %s", filePath);
        console.log(`Pinned: ${filePath}`);
        return;
      }

      if (
        subcommand === "删" ||
        subcommand === "remove" ||
        subcommand === "unpin"
      ) {
        const filePath = args[1];
        if (!filePath) {
          console.log("Usage: /c 删 <path|id>");
          return;
        }
        manager.unpinPath(filePath);
        logger.info("Unpinned path: %s", filePath);
        console.log(`Unpinned: ${filePath}`);
        return;
      }

      if (subcommand === "列" || subcommand === "list") {
        const state = manager.getState();
        const assets = state.stablePack?.assets ?? [];
        if (assets.length === 0) {
          console.log("No assets loaded.");
          return;
        }
        const lines = ["Loaded assets:"];
        for (const a of assets) {
          lines.push(
            `  - ${a.source.label} (${a.kind}, ${a.tokenEstimate}t, hash=${a.contentHash})`,
          );
        }
        console.log(lines.join("\n"));
        return;
      }

      // PDD21-1: /c 排 — 显示当前 query-less 的 top ranked files
      if (subcommand === "排" || subcommand === "rank") {
        const ranked = manager.getRankedFiles(15);
        if (ranked.length === 0) {
          console.log(
            "No ranked files available (ContextRanker not configured).",
          );
          return;
        }
        const repo = manager.getRepoClassification();
        const lines: string[] = ["Top ranked files:"];
        if (repo) {
          lines.push(
            `  repo: ${repo.primary}${repo.primary === "mixed" ? ` (${repo.all.join(", ")})` : ""}`,
          );
          lines.push(`  confidence: ${repo.confidence.toFixed(2)}`);
        }
        lines.push("");
        for (const rf of ranked) {
          const topReasons = rf.reasons
            .filter((r) => r.points > 0)
            .slice(0, 2)
            .map((r) => r.note)
            .join(", ");
          lines.push(`  ${rf.path}  score=${rf.score}  [${topReasons}]`);
        }
        console.log(lines.join("\n"));
        return;
      }

      // PDD21-1: /c why <path> / /c 因 <path> — 显示某个文件的重要性分数和原因
      if (
        subcommand === "why" ||
        subcommand === "因" ||
        subcommand === "为什么"
      ) {
        const filePath = args[1];
        if (!filePath) {
          console.log("Usage: /c why <path>  or  /c 因 <path>");
          return;
        }
        const result = manager.explainFile(filePath);
        if (!result) {
          console.log(
            `File "${filePath}" not found in ranking (may be excluded or not scanned).`,
          );
          return;
        }
        const lines: string[] = [`Context rank: ${result.path}`];
        lines.push(`  score: ${result.score}`);
        for (const reason of result.reasons) {
          const sign = reason.points >= 0 ? "+" : "";
          lines.push(
            `  ${reason.signal}: ${reason.note} ${sign}${reason.points}`,
          );
        }
        console.log(lines.join("\n"));
        return;
      }

      console.log(
        "Usage: /c [开|关|扫|刷|加 <path>|删 <path>|列|排|why <path>]",
      );
    },
  };
}
