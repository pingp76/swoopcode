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
import { isDangerousCommand } from "./command-safety.js";
import { isPathSafe } from "./tools/files.js";
import type { AsyncCommandPolicy } from "./execution-policy.js";

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
  | "output"
  | "schedule"
  | "unknown";

/** 根据工具名判断类别 */
function categorizeTool(toolName: string): ToolCategory {
  // run_bash 单独归类为 bash，后续会做危险命令检测
  if (toolName === "run_bash") return "bash";
  // run_read 归类为 file-read，属于只读操作
  if (toolName === "run_read") return "file-read";
  // 写操作相关的三个工具统一归类为 file-write，后续统一做路径安全检查
  if (
    toolName === "run_write" ||
    toolName === "run_edit" ||
    toolName === "run_edit_exact"
  )
    return "file-write";
  // todo 系列工具以 run_todo_ 为前缀
  if (toolName.startsWith("run_todo_")) return "todo";
  // task 系列工具以 run_task_ 为前缀
  if (toolName.startsWith("run_task_")) return "task";
  // memory 系列工具以 run_memory_ 为前缀
  if (toolName.startsWith("run_memory_")) return "memory";
  // run_skill 用于加载技能
  if (toolName === "run_skill") return "skill";
  // run_subagent 用于启动子智能体
  if (toolName === "run_subagent") return "subagent";
  // async 系列工具以 run_async_ 为前缀
  if (toolName.startsWith("run_async_")) return "async-run";
  // run_output_read 用于读取子任务输出
  if (toolName === "run_output_read") return "output";
  // schedule 系列工具以 run_schedule_ 为前缀
  if (toolName.startsWith("run_schedule_")) return "schedule";
  // 未匹配到任何已知类别，交给 ToolRegistry 后续处理
  return "unknown";
}

// ---------------------------------------------------------------------------
// 路径辅助
// ---------------------------------------------------------------------------

/** 从工具参数中提取 path 字段 */
function getPathArg(args: Record<string, unknown>): string {
  // 兼容两种可能的参数名：path（新接口）和 filePath（旧接口），取第一个存在的值
  return String(args["path"] ?? args["filePath"] ?? "");
}

/** 检查路径是否为敏感系统路径 */
function isSensitivePath(rawPath: string): string | null {
  // 先将路径解析为绝对路径，用于后续的系统目录比对
  const resolved = resolve(rawPath);

  // SSH 密钥目录：任何对 ~/.ssh 的访问都视为敏感操作
  if (rawPath.startsWith("~/.ssh") || rawPath.startsWith("~/.ssh/")) {
    return "SSH key directory";
  }

  // /etc 目录包含系统全局配置文件，不应被访问
  if (resolved.startsWith(`/etc${sep}`)) {
    return "system configuration directory";
  }

  // /usr 目录包含系统程序文件，不应被修改
  if (resolved.startsWith(`/usr${sep}`)) {
    return "system program directory";
  }

  // 文件名以 credentials 开头的文件通常包含敏感凭证信息
  const name = basename(resolved);
  if (name.startsWith("credentials")) {
    return "credentials file";
  }

  // 路径通过了所有敏感检查，返回 null 表示非敏感路径
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
  // 内部状态：当前运行模式，初始化为 default（需要用户确认敏感操作）
  let mode: PermissionMode = "default";
  // 将传入的项目目录解析为绝对路径，作为后续路径边界检查的基准
  const projectRoot = resolve(projectDir);

  return {
    setMode(newMode: PermissionMode): void {
      // 更新当前运行模式，权限决策会随模式变化而改变
      mode = newMode;
    },

    getMode(): PermissionMode {
      // 返回当前运行模式，供外部查询和调试
      return mode;
    },

    getProjectDir(): string {
      // 返回缓存的项目根目录绝对路径
      return projectRoot;
    },

    check(ctx: PermissionContext): PermissionDecision {
      // 教学导读：
      // 权限管理器不是“工具能不能运行”的唯一判断点。
      // 这个项目采用多层防线：
      //   1. PermissionManager：按模式和工具类别决定 allow/ask/deny
      //   2. 具体工具实现：再次检查路径、参数、文件是否存在
      //   3. ExecutionPolicy：给 async/schedule 这种非交互路径提供更窄的命令白名单
      //
      // 为什么要多层？
      // 因为 LLM 生成的 tool args 是不可信输入，而教学项目要展示真实 agent
      // 常见的“纵深防御”：上一层漏掉时，下一层仍能挡住危险行为。

      // 第一步：根据工具名确定其所属类别，后续按类别做统一处理
      const category = categorizeTool(ctx.toolName);

      // ── 步骤 1：未知工具放行，交给 ToolRegistry 返回 Unknown tool ──
      // 未知工具通常是新加入的工具或拼写错误，权限层不拦截，让工具注册层处理
      if (category === "unknown") {
        // 权限层不负责判断工具是否存在。
        // 如果这里 deny，LLM 只能看到权限错误，而看不到更准确的 Unknown tool；
        // 放行给 ToolRegistry 处理，错误信息更利于模型自我纠正。
        return { action: "allow" };
      }

      // ── 步骤 2：黑名单检查 ──

      // bash 命令黑名单：复用 command-safety.ts 的 isDangerousCommand 进行危险命令检测
      if (category === "bash") {
        const command = String(ctx.args["command"] ?? "");
        // 如果命令被判定为危险（如 rm -rf /、格式化磁盘等），直接拒绝
        if (isDangerousCommand(command)) {
          // 黑名单命中时直接 deny，不进入 ask。
          // “让用户确认危险命令”在真实 agent 中通常不是好设计，
          // 因为用户可能被长命令或模型解释误导。
          return {
            action: "deny",
            reason: `Dangerous command blocked: "${command.slice(0, 80)}"`,
          };
        }
      }

      // 文件路径黑名单：检查目标路径是否属于敏感系统路径
      if (category === "file-read" || category === "file-write") {
        const rawPath = getPathArg(ctx.args);
        const sensitiveReason = isSensitivePath(rawPath);
        // 如果路径命中敏感路径规则，直接拒绝访问
        if (sensitiveReason) {
          // 敏感路径是绝对禁区，不受 auto/default/plan 模式影响。
          return {
            action: "deny",
            reason: `Access to ${sensitiveReason} is blocked`,
          };
        }
      }

      // ── 步骤 3：路径边界检查 ──
      // 确保文件操作的目标路径在项目目录内，防止越界访问
      if (category === "file-read" || category === "file-write") {
        const rawPath = getPathArg(ctx.args);
        if (!isPathSafe(rawPath, projectRoot)) {
          // projectRoot 是当前被操作项目的边界。
          // Memory、logs、tasks 等 Agent 自身数据有自己的工具和存储层，
          // 不能通过普通文件工具跨出去读取或修改。
          return {
            action: "deny",
            reason: `Path "${rawPath}" is outside project directory`,
          };
        }
      }

      // ── 步骤 4：白名单（无需确认） ──
      // 以下工具在任何模式下都不需要确认，属于安全操作
      if (category === "file-read") return { action: "allow" };
      if (category === "todo") return { action: "allow" };
      if (category === "task") return { action: "allow" };
      if (category === "skill") return { action: "allow" };
      if (category === "output") return { action: "allow" };

      // ── 步骤 4.5：memory 工具权限 ──
      // run_memory_list/read 属于查询操作，无需确认；run_memory_create/delete 会影响长期记忆，需谨慎
      if (category === "memory") {
        // Memory 和 Task 的差异值得学生注意：
        // Task 是用户明确创建的工作计划，工具操作属于 Agent 运行数据；
        // Memory 会影响未来会话的系统提示内容，所以 create/delete 更敏感。
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
        // run_async_check / list / output_read: 属于查询状态的操作，所有模式直接放行
        if (
          ctx.toolName === "run_async_check" ||
          ctx.toolName === "run_async_list" ||
          ctx.toolName === "run_async_output_read"
        ) {
          return { action: "allow" };
        }

        // run_async_start: 启动异步任务，需要根据 executor 类型和当前模式决定权限
        if (ctx.toolName === "run_async_start") {
          // 从参数中提取异步任务的关键信息，用于构建确认消息和权限判断
          const executor = String(ctx.args["executor"] ?? "");
          const title = String(ctx.args["title"] ?? "");
          const timeout =
            ctx.args["timeout_ms"] !== undefined
              ? Number(ctx.args["timeout_ms"])
              : 120_000;
          // 从 resources 参数中解析读写路径列表，用于展示给用户的确认信息
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

          // 构建用户确认消息，将任务关键信息拼接成可读字符串
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

          // plan 模式语义是只读规划，不允许执行 bash 命令，但允许启动 subagent 做分析
          if (mode === "plan") {
            // plan 模式下允许 async subagent 的原因：
            // subagent 仍受 scoped permission 限制，可以做只读分析；
            // 但 command executor 会真正执行 shell 命令，所以拒绝。
            if (executor === "command") {
              return {
                action: "deny",
                reason: "Async bash commands are not allowed in plan mode",
              };
            }
            return { action: "allow" };
          }

          // auto 模式下，通过黑名单和路径边界检查后即可自动放行
          if (mode === "auto") {
            // 注意：这里的 auto 放行不是“无条件放行”。
            // 前面的黑名单、敏感路径、projectRoot 边界已经先执行过。
            return { action: "allow" };
          }

          // default 模式下，启动异步任务前需要用户确认任务详情
          return { action: "ask", message };
        }

        // 兜底：如果命中了 async-run 类别但没有匹配到上述具体工具，安全起见放行
        return { action: "allow" };
      }

      // ── 步骤 4.7：schedule 工具权限 ──
      // 必须放在 auto 模式放行之前，因为 durable schedule 变更即使在 auto 模式下也需要确认
      if (category === "schedule") {
        // list/read/occurrence_list 属于查询操作，所有模式直接放行
        if (
          ctx.toolName === "run_schedule_list" ||
          ctx.toolName === "run_schedule_read" ||
          ctx.toolName === "run_schedule_occurrence_list"
        ) {
          return { action: "allow" };
        }

        // create/cancel/delete 会改变调度状态，plan 模式下完全禁止，其他模式需要确认
        if (
          ctx.toolName === "run_schedule_create" ||
          ctx.toolName === "run_schedule_cancel" ||
          ctx.toolName === "run_schedule_delete"
        ) {
          if (mode === "plan") {
            // Schedule 是持久化行为，计划阶段不应该悄悄创建未来会自动运行的任务。
            return {
              action: "deny",
              reason: "Schedule modifications are not allowed in plan mode",
            };
          }
          return {
            action: "ask",
            // 确认文案尽量包含 title 或 schedule_id，让用户知道要授权的是哪个 durable schedule。
            message: `Allow ${ctx.toolName}: ${String(ctx.args["title"] ?? ctx.args["schedule_id"] ?? "")}`,
          };
        }

        // 兜底：安全起见放行未明确列出的 schedule 工具
        return { action: "allow" };
      }

      // ── 步骤 5：模式权限检查 ──

      // plan 模式：bash 禁止，写操作只允许 .claude/plans/ 目录（用于保存规划文件）
      if (mode === "plan") {
        if (category === "bash") {
          return {
            action: "deny",
            reason: "bash commands are not allowed in plan mode",
          };
        }
        if (category === "file-write") {
          const rawPath = getPathArg(ctx.args);
          // 计算 plans 目录和目标文件的绝对路径，用于路径前缀比对
          const plansDir = resolve(projectRoot, ".claude", "plans");
          const resolvedPath = resolve(projectRoot, rawPath);
          // plan 模式允许写 .claude/plans/ 是一个教学折中：
          // agent 可以把计划落盘给用户审阅，但不能修改真实项目代码。
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
        // plan 模式下 run_subagent 允许（子智能体继承同一模式，保持只读语义）
        if (category === "subagent") return { action: "allow" };
      }

      // auto 模式：所有通过黑名单和路径边界检查的操作直接放行
      if ((mode as string) === "auto") {
        // auto 是“用户已经信任当前 agent 自主执行”的模式。
        // 但它仍然在硬性安全边界之后执行，所以不会绕过危险命令和越界路径。
        return { action: "allow" };
      }

      // ── 步骤 6：default 模式下的敏感操作确认 ──
      // default 模式下，bash、文件写入、子智能体等敏感操作需要用户逐一确认
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

      // 兜底：前面白名单、模式规则、敏感确认均未命中，安全起见放行
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
      // 第一步：先委托父级做完整的安全检查，继承危险命令、越界路径等硬性拒绝规则
      const parentDecision = parent.check(ctx);

      // 父级的硬拒绝必须保留，子智能体不能绕过这些安全边界
      if (parentDecision.action === "deny") {
        return parentDecision;
      }

      // 文件读取和 skill 加载：子智能体需要这些能力做代码探索和诊断
      if (ctx.toolName === "run_read" || ctx.toolName === "run_skill") {
        return { action: "allow" };
      }

      // bash 命令：只允许经过 commandPolicy 验证的只读诊断命令
      if (ctx.toolName === "run_bash") {
        const mode = parent.getMode();

        // plan 模式下完全禁止 bash（plan 模式语义是只读规划，不允许执行任何命令）
        if (mode === "plan") {
          return {
            action: "deny",
            reason: "bash is not allowed in plan mode",
          };
        }

        // default / auto 模式下，用 commandPolicy 判断命令是否属于安全的只读诊断命令
        const command = String(ctx.args["command"] ?? "");
        const validation = commandPolicy.validate(command);
        return validation.allowed
          ? { action: "allow" }
          : {
              action: "deny",
              reason: validation.reason ?? "Only read-only diagnostic commands are allowed in subagent",
            };
      }

      // 其他工具：子智能体默认不允许，避免子智能体执行写操作、再次创建子智能体等高风险行为
      // 明确列出常见的不允许工具，方便调试时快速定位拒绝原因
      if (
        ctx.toolName === "run_write" ||
        ctx.toolName === "run_edit" ||
        ctx.toolName === "run_edit_exact" ||
        ctx.toolName === "run_subagent" ||
        ctx.toolName === "run_todo_add" ||
        ctx.toolName === "run_todo_complete" ||
        ctx.toolName === "run_todo_list" ||
        ctx.toolName === "run_async_start" ||
        ctx.toolName.startsWith("run_schedule_")
      ) {
        return {
          action: "deny",
          reason: `${ctx.toolName} is not allowed inside a subagent`,
        };
      }

      // 兜底：所有未明确允许的工具，在子智能体范围内一律拒绝
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
