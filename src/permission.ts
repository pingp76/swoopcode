/**
 * permission.ts — 权限管理模块
 *
 * 职责：在工具执行前统一拦截，根据运行模式决定放行、拒绝或要求用户确认。
 *
 * 设计思路：
 * - 三种模式：plan（只读）、auto（自动执行）、default（需确认）
 * - 权限检查流程：工具分类 → 黑名单 → 路径边界 → 白名单 → 模式规则 → 敏感确认
 * - 复用 bash.ts 的 isDangerousCommand() 和 files.ts 的 isPathSafe()
 * - 子智能体共享同一个 PermissionManager 实例
 *
 * 与工具内部安全检查的关系：
 * - 权限层是"门卫"，在 Agent 循环中提前拦截
 * - 工具内部检查是"最后防线"，防止绕过权限层的调用路径
 * - 两层互不冲突，共同保障安全
 */

import { resolve, sep, basename } from "node:path";
import { isDangerousCommand } from "./tools/bash.js";
import { isPathSafe } from "./tools/files.js";
import type { AsyncCommandPolicy } from "./tools/bash.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** Agent 的运行模式 */
export type PermissionMode = "plan" | "auto" | "default";

/** 权限决策结果 */
export type PermissionDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "ask"; message: string };

/** 权限上下文：权限检查器需要知道的信息 */
export interface PermissionContext {
  /** 工具名称（如 "run_bash"） */
  toolName: string;
  /** 工具参数（与 ToolExecutor 签名一致） */
  args: Record<string, unknown>;
}

/** 权限管理器接口 */
export interface PermissionManager {
  /** 检查权限，返回决策结果 */
  check(ctx: PermissionContext): PermissionDecision;
  /** 切换模式 */
  setMode(mode: PermissionMode): void;
  /** 获取当前模式 */
  getMode(): PermissionMode;
  /** 获取项目根目录 */
  getProjectDir(): string;
}

/** 用户确认回调函数的类型 */
export type AskUserFn = (message: string) => Promise<boolean>;

// ---------------------------------------------------------------------------
// 工具分类
// ---------------------------------------------------------------------------

/** 工具类别 */
type ToolCategory =
  | "bash"
  | "file-read"
  | "file-write"
  | "todo"
  | "task"
  | "memory"
  | "skill"
  | "subagent"
  | "async-run"
  | "unknown";

/** 根据工具名判断类别 */
function categorizeTool(toolName: string): ToolCategory {
  if (toolName === "run_bash") return "bash";
  if (toolName === "run_read") return "file-read";
  if (toolName === "run_write" || toolName === "run_edit") return "file-write";
  if (toolName.startsWith("run_todo_")) return "todo";
  if (toolName.startsWith("run_task_")) return "task";
  if (toolName.startsWith("run_memory_")) return "memory";
  if (toolName === "run_skill") return "skill";
  if (toolName === "run_subagent") return "subagent";
  if (toolName.startsWith("run_async_")) return "async-run";
  return "unknown";
}

// ---------------------------------------------------------------------------
// 路径辅助
// ---------------------------------------------------------------------------

/** 从工具参数中提取 path 字段 */
function getPathArg(args: Record<string, unknown>): string {
  return String(args["path"] ?? args["filePath"] ?? "");
}

/** 检查路径是否为敏感系统路径 */
function isSensitivePath(rawPath: string): string | null {
  const resolved = resolve(rawPath);

  // SSH 密钥目录
  if (rawPath.startsWith("~/.ssh") || rawPath.startsWith("~/.ssh/")) {
    return "SSH key directory";
  }

  // 系统配置
  if (resolved.startsWith(`/etc${sep}`)) {
    return "system configuration directory";
  }

  // 系统程序
  if (resolved.startsWith(`/usr${sep}`)) {
    return "system program directory";
  }

  // 凭证文件
  const name = basename(resolved);
  if (name.startsWith("credentials")) {
    return "credentials file";
  }

  return null;
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createPermissionManager — 创建权限管理器
 *
 * @param projectDir - 项目根目录，路径边界以此为基准
 * @returns PermissionManager 接口的实现
 */
export function createPermissionManager(projectDir: string): PermissionManager {
  // 当前模式，默认为 default
  let mode: PermissionMode = "default";
  // 规范化项目目录（确保末尾没有 separator）
  const projectRoot = resolve(projectDir);

  return {
    setMode(newMode: PermissionMode): void {
      mode = newMode;
    },

    getMode(): PermissionMode {
      return mode;
    },

    getProjectDir(): string {
      return projectRoot;
    },

    check(ctx: PermissionContext): PermissionDecision {
      const category = categorizeTool(ctx.toolName);

      // ── 步骤 1：未知工具放行，交给 ToolRegistry 返回 Unknown tool ──
      if (category === "unknown") {
        return { action: "allow" };
      }

      // ── 步骤 2：黑名单检查 ──

      // bash 命令黑名单：复用 bash.ts 的 isDangerousCommand
      if (category === "bash") {
        const command = String(ctx.args["command"] ?? "");
        if (isDangerousCommand(command)) {
          return {
            action: "deny",
            reason: `Dangerous command blocked: "${command.slice(0, 80)}"`,
          };
        }
      }

      // 文件路径黑名单
      if (category === "file-read" || category === "file-write") {
        const rawPath = getPathArg(ctx.args);
        const sensitiveReason = isSensitivePath(rawPath);
        if (sensitiveReason) {
          return {
            action: "deny",
            reason: `Access to ${sensitiveReason} is blocked`,
          };
        }
      }

      // ── 步骤 3：路径边界检查 ──
      if (category === "file-read" || category === "file-write") {
        const rawPath = getPathArg(ctx.args);
        if (!isPathSafe(rawPath, projectRoot)) {
          return {
            action: "deny",
            reason: `Path "${rawPath}" is outside project directory`,
          };
        }
      }

      // ── 步骤 4：白名单（无需确认） ──
      if (category === "file-read") return { action: "allow" };
      if (category === "todo") return { action: "allow" };
      if (category === "task") return { action: "allow" };
      if (category === "skill") return { action: "allow" };

      // ── 步骤 4.5：memory 工具权限 ──
      // run_memory_list/read 无需确认，run_memory_create/delete 所有模式都需确认
      if (category === "memory") {
        if (
          ctx.toolName === "run_memory_list" ||
          ctx.toolName === "run_memory_read"
        ) {
          return { action: "allow" };
        }
        // create 和 delete 在所有模式下都 ask（长期记忆影响未来会话）
        return {
          action: "ask",
          message: `Allow memory ${ctx.toolName.replace("run_memory_", "")}: ${String(ctx.args["name"] ?? "")}`,
        };
      }

      // ── 步骤 4.6：async-run 工具权限 ──
      if (category === "async-run") {
        // run_async_check / list / output_read: 所有模式 allow
        if (
          ctx.toolName === "run_async_check" ||
          ctx.toolName === "run_async_list" ||
          ctx.toolName === "run_async_output_read"
        ) {
          return { action: "allow" };
        }

        // run_async_start: 根据 executor 和模式决定
        if (ctx.toolName === "run_async_start") {
          const executor = String(ctx.args["executor"] ?? "");
          const title = String(ctx.args["title"] ?? "");
          const timeout =
            ctx.args["timeout_ms"] !== undefined
              ? Number(ctx.args["timeout_ms"])
              : 120_000;
          const readPaths = (
            (ctx.args["resources"] as Record<string, unknown> | undefined)?.[
              "read_paths"
            ] ?? []
          ) as string[];
          const writePaths = (
            (ctx.args["resources"] as Record<string, unknown> | undefined)?.[
              "write_paths"
            ] ?? []
          ) as string[];
          const command = ctx.args["command"]
            ? String(ctx.args["command"])
            : undefined;
          const prompt = ctx.args["prompt"]
            ? String(ctx.args["prompt"])
            : undefined;

          // 构建确认消息
          const parts: string[] = [`Allow async run: ${title}`];
          parts.push(`executor: ${executor}`);
          parts.push(`timeout: ${timeout}ms`);
          if (readPaths.length > 0)
            parts.push(`read paths: ${readPaths.join(", ")}`);
          if (writePaths.length > 0)
            parts.push(`write paths: ${writePaths.join(", ")}`);
          if (command) parts.push(`command: ${command.slice(0, 120)}`);
          if (prompt) parts.push(`prompt: ${prompt.slice(0, 120)}`);
          const message = parts.join("\n");

          // plan 模式：command deny，subagent allow
          if (mode === "plan") {
            if (executor === "command") {
              return {
                action: "deny",
                reason: "Async bash commands are not allowed in plan mode",
              };
            }
            return { action: "allow" };
          }

          // auto 模式：允许两种
          if (mode === "auto") {
            return { action: "allow" };
          }

          // default 模式：ask 两种
          return { action: "ask", message };
        }

        // 兜底：不应到达，安全起见放行
        return { action: "allow" };
      }

      // ── 步骤 5：模式权限检查 ──

      // plan 模式：bash 禁止，写操作只允许 .claude/plans/
      if (mode === "plan") {
        if (category === "bash") {
          return {
            action: "deny",
            reason: "bash commands are not allowed in plan mode",
          };
        }
        if (category === "file-write") {
          const rawPath = getPathArg(ctx.args);
          const plansDir = resolve(projectRoot, ".claude", "plans");
          const resolvedPath = resolve(projectRoot, rawPath);
          if (
            resolvedPath !== plansDir &&
            !resolvedPath.startsWith(plansDir + sep)
          ) {
            return {
              action: "deny",
              reason: `Write to "${rawPath}" not allowed in plan mode (only .claude/plans/)`,
            };
          }
          return { action: "allow" };
        }
        // plan 模式下 run_subagent 允许（子智能体继承同一模式）
        if (category === "subagent") return { action: "allow" };
      }

      // auto 模式：所有通过黑名单和路径边界的操作直接放行
      if (mode === "auto") {
        return { action: "allow" };
      }

      // ── 步骤 6：default 模式下的敏感操作确认 ──
      if (category === "bash") {
        const command = String(ctx.args["command"] ?? "");
        return {
          action: "ask",
          message: `Allow bash command: ${command.slice(0, 120)}`,
        };
      }
      if (category === "file-write") {
        const rawPath = getPathArg(ctx.args);
        return {
          action: "ask",
          message: `Allow ${ctx.toolName}: ${rawPath}`,
        };
      }
      if (category === "subagent") {
        const task = String(ctx.args["task"] ?? "");
        return {
          action: "ask",
          message: `Allow subagent task: ${task.slice(0, 120)}`,
        };
      }

      // 兜底：不应到达，安全起见放行
      return { action: "allow" };
    },
  };
}

// ---------------------------------------------------------------------------
// Scoped Subagent Permission Manager
// ---------------------------------------------------------------------------

/**
 * createScopedSubagentPermissionManager — 创建子智能体的受限权限管理器
 *
 * 设计目的：
 * - 子智能体不应该继承父 Agent 的 default 模式 ask 行为（没有确认回调会降级为 deny）
 * - 子智能体也不应该进入 auto 模式（安全边界太大）
 * - 应该给子智能体一个"已获授权的、只读诊断能力范围"
 *
 * 语义：用户在启动 subagent 时已经确认了一次，子智能体内部不再弹确认框，
 * 但也不能随意执行任意命令，只能跑白名单诊断命令。
 *
 * @param deps.parent - 父级 PermissionManager，用于继承硬性安全边界和项目目录
 * @param deps.commandPolicy - 命令策略，用于验证 bash 命令是否属于只读诊断命令
 *
 * 权限规则：
 * - 父级 hard deny（危险命令、越界路径、敏感路径）必须保留
 * - run_read / run_skill: allow
 * - run_bash: plan 模式下 deny；default/auto 模式下只允许 commandPolicy 通过的只读诊断命令
 * - 其他工具: deny
 */
export function createScopedSubagentPermissionManager(deps: {
  parent: PermissionManager;
  commandPolicy: AsyncCommandPolicy;
}): PermissionManager {
  const { parent, commandPolicy } = deps;

  return {
    check(ctx: PermissionContext): PermissionDecision {
      // 先让父级做一轮检查，继承硬性安全边界
      const parentDecision = parent.check(ctx);

      // 父级的硬拒绝必须保留（危险命令、越界路径、敏感路径）
      if (parentDecision.action === "deny") {
        return parentDecision;
      }

      // 文件读取和 skill 加载：子智能体需要这些能力做探索
      if (ctx.toolName === "run_read" || ctx.toolName === "run_skill") {
        return { action: "allow" };
      }

      // bash 命令：只允许只读诊断命令
      if (ctx.toolName === "run_bash") {
        const mode = parent.getMode();

        // plan 模式下完全禁止 bash（plan 模式语义是只读规划，不动手）
        if (mode === "plan") {
          return {
            action: "deny",
            reason: "bash is not allowed in plan mode",
          };
        }

        // default / auto 模式下用 commandPolicy 验证
        const command = String(ctx.args["command"] ?? "");
        const validation = commandPolicy.validate(command);
        return validation.allowed
          ? { action: "allow" }
          : {
              action: "deny",
              reason: validation.reason ?? "Only read-only diagnostic commands are allowed in subagent",
            };
      }

      // 其他工具：子智能体默认不允许
      // 明确列出常见的不允许工具，方便调试
      if (
        ctx.toolName === "run_write" ||
        ctx.toolName === "run_edit" ||
        ctx.toolName === "run_subagent" ||
        ctx.toolName === "run_todo_add" ||
        ctx.toolName === "run_todo_complete" ||
        ctx.toolName === "run_todo_list" ||
        ctx.toolName === "run_async_start"
      ) {
        return {
          action: "deny",
          reason: `${ctx.toolName} is not allowed inside a subagent`,
        };
      }

      return {
        action: "deny",
        reason: `Subagent scoped permissions do not allow ${ctx.toolName}`,
      };
    },

    // scoped manager 不响应模式切换（模式由父级控制，但子级行为不随模式变化）
    setMode(): void {
      // no-op: 子智能体的权限范围是固定的，不因父级模式切换而改变
    },

    // 返回父级当前模式（用于调试和日志）
    getMode(): PermissionMode {
      return parent.getMode();
    },

    // 继承父级的项目目录
    getProjectDir(): string {
      return parent.getProjectDir();
    },
  };
}
