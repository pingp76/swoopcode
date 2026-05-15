/**
 * todo.ts — TODO manager 模块
 *
 * 职责：为 Agent 的当前对话 session 提供任务级别的 todo list 管理功能。
 * LLM 通过 tool 调用创建和管理任务列表，自主控制执行节奏。
 *
 * 设计思路：
 * - 通过工厂函数 createTodoManager() 创建，内部状态通过闭包保护
 * - 纯 tool 驱动：所有操作（创建/更新/添加/删除/查看/取消）都注册为工具
 * - agent 循环只需要一个额外调用：tickRound()，用于轮次上限检测
 *
 * 状态机（TodoList 级别）：
 *   idle ──[create]──→ active ──[all completed]──→ completed
 *                     │                          ↑
 *                     ├──[cancel]──→ cancelled    │
 *                     └──[interrupt]──→ interrupted ──[resume]──→ active
 *
 * 状态机（Task 级别）：
 *   pending ──[start]──→ in_progress ──[complete]──→ completed
 *                        │
 *                        ├──[skip]──→ skipped
 *                        ├──[cancel]──→ cancelled
 *                        └──[interrupt]──→ interrupted ──[resume]──→ in_progress
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolResult } from "./tools/types.js";

// ============================================================================
// 类型定义
// ============================================================================

/** Task 的所有可能状态 */
export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "skipped"
  | "cancelled"
  | "interrupted";

/** TodoList 的所有可能状态 */
export type TodoListStatus =
  | "idle"
  | "active"
  | "completed"
  | "cancelled"
  | "interrupted";

/** 单个任务的数据结构 */
export interface Task {
  /** 唯一标识，格式 "task_1", "task_2", ... */
  id: string;
  /** 任务描述 */
  description: string;
  /** 任务当前状态 */
  status: TaskStatus;
  /** LLM 附带的备注（可选），用于记录进展或中断原因 */
  note?: string;
  /** 当前已执行轮次（每次 agent loop 迭代 +1） */
  roundCount: number;
}

/** TodoList 的数据结构 */
interface TodoList {
  status: TodoListStatus;
  tasks: Task[];
}

/** 终态集合：处于这些状态的 task 不会再变化 */
const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "skipped",
  "cancelled",
]);

// ============================================================================
// Tool 定义 — 告诉 LLM 每个工具的接口（名称、参数、描述）
// ============================================================================

/**
 * run_todo_create — 创建新的 todo list
 *
 * 如果已有活跃的 list，自动取消旧的。
 * tasks 参数是一个字符串数组，按执行顺序排列。
 */
const todoCreateDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_todo_create",
    description:
      "Create a temporary TODO list for the current session's execution steps. Use TODO when the steps are short-lived and losing them after restart is acceptable. For durable long-running plans, use run_task_group_create instead. If a list already exists, it will be cancelled automatically.",
    parameters: {
      type: "object",
      properties: {
        tasks: {
          type: "array",
          items: { type: "string" },
          description: "任务描述列表，按执行顺序排列",
        },
      },
      required: ["tasks"],
    },
  },
};

/**
 * run_todo_update — 更新单个任务的状态
 *
 * LLM 通过此工具标记任务的进展：开始执行、完成、或跳过。
 * 可选附带 note 记录进展细节。
 */
const todoUpdateDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_todo_update",
    description:
      "Update the status of a temporary TODO item in the current session. Do not use this for persistent task groups; use run_task_update for durable work.\n" +
      "Tip: You can return multiple tool_calls in one response. For example, " +
      "mark task_1 as completed and task_2 as in_progress in the same response.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "任务 ID（从 run_todo_create 或 run_todo_list 获取）",
        },
        status: {
          type: "string",
          enum: ["in_progress", "completed", "skipped"],
          description: "目标状态",
        },
        note: {
          type: "string",
          description: "可选的备注，记录当前进展或中断原因",
        },
      },
      required: ["task_id", "status"],
    },
  },
};

/**
 * run_todo_add — 在列表中插入新任务
 *
 * 可通过 after_task_id 指定插入位置，不提供则追加到末尾。
 */
const todoAddDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_todo_add",
    description:
      "Add a temporary execution step to the current session TODO list. For durable cross-session tasks, use run_task_add.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "任务描述",
        },
        after_task_id: {
          type: "string",
          description: "可选：插入到指定 task 之后。不提供则追加到末尾",
        },
      },
      required: ["task"],
    },
  },
};

/**
 * run_todo_remove — 从列表中删除任务
 *
 * 只能删除 pending 状态的 task，防止误删正在执行或已完成的任务。
 */
const todoRemoveDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_todo_remove",
    description:
      "Remove a pending task from the todo list. Only pending tasks can be removed.",
    parameters: {
      type: "object",
      properties: {
        task_id: {
          type: "string",
          description: "要删除的任务 ID",
        },
      },
      required: ["task_id"],
    },
  },
};

/**
 * run_todo_list — 查看当前 todo list 的完整状态
 *
 * 无参数。返回格式化的任务列表，让 LLM 了解当前进度。
 */
const todoListDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_todo_list",
    description:
      "View the current session TODO list. This does not show persistent Task Groups; use run_task_group_list/read for durable plans.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

/**
 * run_todo_cancel — 取消当前 todo list
 *
 * 所有未完成的 task 标记为 cancelled，list 状态变为 cancelled。
 */
const todoCancelDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_todo_cancel",
    description:
      "Cancel the current todo list. All incomplete tasks will be marked as cancelled.",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

// ============================================================================
// 格式化输出 — 所有 todo tool 使用统一的展示格式
// ============================================================================

/** 每种状态对应的显示符号 */
const STATUS_SYMBOLS: Record<TaskStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  skipped: "[-]",
  cancelled: "[_]",
  interrupted: "[!]",
};

/**
 * formatTask — 格式化单个 task 为显示字符串
 *
 * 格式：`[符号] task_id: 任务描述`，如果有 note 则追加 `(note内容)`
 *
 * 重要：必须包含 task_id，否则 LLM 不知道如何引用这个 task。
 * 之前缺少 task_id 导致 LLM 猜测 task_id 为 "0"，实际是 "task_1"。
 */
function formatTask(task: Task): string {
  let line = `${STATUS_SYMBOLS[task.status]} ${task.id}: ${task.description}`;
  if (task.note) {
    line += ` (${task.note})`;
  }
  return line;
}

/**
 * formatTodoList — 格式化整个 todo list 为显示字符串
 *
 * 示例输出：
 * ```
 * [ ] 分析需求文档
 * [>] 编写数据库模型 (正在设计ER图)
 * [ ] 实现API接口
 * [-] 编写文档（已跳过）
 *
 * (1/4 completed, 1 skipped)
 * ```
 */
function formatTodoList(todoList: TodoList): string {
  // idle 状态：没有 todo list
  if (todoList.status === "idle") {
    return "No todo list active. Use run_todo_create to create one.";
  }

  // 每个 task 格式化为一行
  const lines = todoList.tasks.map(formatTask);

  // 统计各状态的 task 数量
  const total = todoList.tasks.length;
  const completed = todoList.tasks.filter(
    (t) => t.status === "completed",
  ).length;
  const skipped = todoList.tasks.filter((t) => t.status === "skipped").length;
  const cancelled = todoList.tasks.filter(
    (t) => t.status === "cancelled",
  ).length;

  // 构建统计摘要行
  let summary = `(${completed}/${total} completed`;
  if (skipped > 0) summary += `, ${skipped} skipped`;
  if (cancelled > 0) summary += `, ${cancelled} cancelled`;
  summary += ")";

  // 前导换行：确保在日志输出中，任务列表从新行开始显示
  return "\n" + [...lines, "", summary].join("\n");
}

// ============================================================================
// TodoManager 接口 — 供 agent.ts 使用的类型
// ============================================================================

/**
 * TodoManager — Agent 集成接口
 *
 * agent.ts 只需要这两个方法：
 * - tickRound()：每次循环迭代调用，检测轮次上限
 * - getActiveTask()：获取当前正在执行的 task
 */
export interface TodoManager {
  /**
   * 每次 agent loop 迭代时调用。
   * - 如果当前有 in_progress 的 task，roundCount +1
   * - 如果达到 maxRounds，自动中断并返回提示信息
   * - 否则返回 null（无操作）
   */
  tickRound(): string | null;

  /** 获取当前 in_progress 的 task（如果没有则返回 undefined） */
  getActiveTask(): Task | undefined;
}

/**
 * TodoToolProvider — 提供工具注册所需的数据
 *
 * 包含 6 个 todo tool 的定义和执行函数，
 * registry.ts 通过这个接口获取并注册到工具表中。
 */
export interface TodoToolProvider {
  /** 工具注册项数组：每个包含定义和执行函数 */
  toolEntries: Array<{
    definition: ChatCompletionTool;
    execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  }>;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * createTodoManager — 创建 TodoManager 实例
 *
 * @param maxRounds - 每个 task 允许的最大轮次（默认 10）
 * @returns TodoManager + TodoToolProvider 接口的实现
 *
 * 内部状态通过闭包保护，外部只能通过返回的方法访问。
 */
export function createTodoManager(
  maxRounds = 10,
): TodoManager & TodoToolProvider {
  // === 内部状态（闭包保护） ===

  /** 当前的 todo list，初始为 idle 状态 */
  let todoList: TodoList = { status: "idle", tasks: [] };

  /** 自增 task ID 计数器，确保每个 task ID 唯一 */
  let nextTaskId = 1;

  // === 内部辅助方法 ===

  /**
   * checkAutoComplete — 检查是否所有 task 都已处于终态
   *
   * 如果是，自动将 list 状态设为 completed。
   * 在 update、cancel 等操作后调用。
   */
  function checkAutoComplete(): void {
    if (todoList.status !== "active" && todoList.status !== "interrupted")
      return;
    if (todoList.tasks.length === 0) return;
    if (todoList.tasks.every((t) => TERMINAL_STATUSES.has(t.status))) {
      todoList.status = "completed";
    }
  }

  /** 根据 ID 查找 task */
  function findTask(taskId: string): Task | undefined {
    return todoList.tasks.find((t) => t.id === taskId);
  }

  // === Tool 实现函数（内部逻辑） ===

  /**
   * doCreate — 创建新的 todo list
   *
   * 如果已有活跃的 list，先自动取消旧的。
   * 所有新 task 初始为 pending 状态。
   */
  function doCreate(tasks: string[]): ToolResult {
    // 如果已有活跃/中断的 list，先取消
    if (todoList.status === "active" || todoList.status === "interrupted") {
      for (const task of todoList.tasks) {
        if (!TERMINAL_STATUSES.has(task.status)) {
          task.status = "cancelled";
        }
      }
      todoList.status = "cancelled";
    }

    // 创建新 list
    todoList = {
      status: "active",
      tasks: tasks.map((desc) => ({
        id: `task_${nextTaskId++}`,
        description: desc,
        status: "pending" as TaskStatus,
        roundCount: 0,
      })),
    };

    return { output: formatTodoList(todoList), error: false };
  }

  /**
   * doUpdate — 更新单个 task 的状态
   *
   * 状态转换规则：
   * - in_progress：自动将之前的 in_progress task 设为 interrupted
   * - completed/skipped：标记为终态
   * 当所有 task 都处于终态时，list 自动变为 completed。
   */
  function doUpdate(taskId: string, status: string, note?: string): ToolResult {
    // 前置检查：必须有活跃或中断中的 list
    if (todoList.status !== "active" && todoList.status !== "interrupted") {
      return { output: "Error: No active todo list.", error: true };
    }

    // 查找目标 task
    const task = findTask(taskId);
    if (!task) {
      return {
        output: `Error: Task "${taskId}" not found.`,
        error: true,
      };
    }

    // 校验目标状态
    const validStatuses = ["in_progress", "completed", "skipped"];
    if (!validStatuses.includes(status)) {
      return {
        output: `Error: Invalid status "${status}". Must be one of: ${validStatuses.join(", ")}`,
        error: true,
      };
    }

    // 更新 task 状态
    task.status = status as TaskStatus;
    if (note !== undefined) {
      task.note = note;
    }

    // 如果设为 in_progress：
    // 1. 重置轮次计数
    // 2. 将之前 in_progress 的 task 自动设为 interrupted
    // 3. 如果 list 之前是 interrupted，恢复为 active
    if (status === "in_progress") {
      task.roundCount = 0;
      for (const other of todoList.tasks) {
        if (other.id !== task.id && other.status === "in_progress") {
          other.status = "interrupted";
        }
      }
      if (todoList.status === "interrupted") {
        todoList.status = "active";
      }
    }

    // 检查是否所有 task 都完成了
    checkAutoComplete();

    return { output: formatTodoList(todoList), error: false };
  }

  /**
   * doAdd — 在列表中插入新 task
   *
   * 通过 afterTaskId 指定插入位置，不提供则追加到末尾。
   * 新 task 初始为 pending 状态。
   */
  function doAdd(task: string, afterTaskId?: string): ToolResult {
    if (todoList.status !== "active" && todoList.status !== "interrupted") {
      return { output: "Error: No active todo list.", error: true };
    }

    const newTask: Task = {
      id: `task_${nextTaskId++}`,
      description: task,
      status: "pending",
      roundCount: 0,
    };

    if (afterTaskId) {
      const index = todoList.tasks.findIndex((t) => t.id === afterTaskId);
      if (index === -1) {
        return {
          output: `Error: Task "${afterTaskId}" not found.`,
          error: true,
        };
      }
      // 插入到指定 task 之后
      todoList.tasks.splice(index + 1, 0, newTask);
    } else {
      // 追加到末尾
      todoList.tasks.push(newTask);
    }

    return { output: formatTodoList(todoList), error: false };
  }

  /**
   * doRemove — 删除 pending 状态的 task
   *
   * 只能删除 pending 状态的 task，防止误删正在执行或已完成的任务。
   */
  function doRemove(taskId: string): ToolResult {
    if (todoList.status !== "active" && todoList.status !== "interrupted") {
      return { output: "Error: No active todo list.", error: true };
    }

    const task = findTask(taskId);
    if (!task) {
      return {
        output: `Error: Task "${taskId}" not found.`,
        error: true,
      };
    }

    if (task.status !== "pending") {
      return {
        output: `Error: Can only remove pending tasks. Task "${taskId}" is ${task.status}.`,
        error: true,
      };
    }

    todoList.tasks = todoList.tasks.filter((t) => t.id !== taskId);
    return { output: formatTodoList(todoList), error: false };
  }

  /**
   * doList — 返回当前 todo list 的格式化视图
   */
  function doList(): ToolResult {
    return { output: formatTodoList(todoList), error: false };
  }

  /**
   * doCancel — 取消整个 todo list
   *
   * 所有未完成的 task 标记为 cancelled，list 状态变为 cancelled。
   */
  function doCancel(): ToolResult {
    if (todoList.status !== "active" && todoList.status !== "interrupted") {
      return {
        output: "Error: No active todo list to cancel.",
        error: true,
      };
    }

    for (const task of todoList.tasks) {
      if (!TERMINAL_STATUSES.has(task.status)) {
        task.status = "cancelled";
      }
    }
    todoList.status = "cancelled";

    return { output: formatTodoList(todoList), error: false };
  }

  // === Agent 集成方法 ===

  /**
   * tickRound — 轮次计数器
   *
   * 每次 agent loop 迭代时调用（在 llm.chat() 之前）：
   * - 如果没有 active list → 无操作，返回 null
   * - 如果没有 in_progress 的 task → 无操作，返回 null
   * - 否则 roundCount +1，检查是否超限
   * - 达到上限时：task 和 list 都设为 interrupted，返回提示信息
   */
  function tickRound(): string | null {
    if (todoList.status !== "active") return null;

    const active = todoList.tasks.find((t) => t.status === "in_progress");
    if (!active) return null;

    active.roundCount++;

    // 达到轮次上限，自动中断
    if (active.roundCount >= maxRounds) {
      active.status = "interrupted";
      active.note = `达到轮次上限 (${maxRounds})`;
      todoList.status = "interrupted";

      // 返回给 LLM 的提示信息，引导其决定下一步操作
      return [
        `任务 "${active.description}" 已达到轮次上限 (${active.roundCount}/${maxRounds})，执行被中断。`,
        "",
        "你可以选择：",
        `- 调用 run_todo_update("${active.id}", "in_progress") 继续执行此任务`,
        `- 调用 run_todo_update("${active.id}", "skipped") 跳过此任务`,
        `- 调用 run_todo_update("${active.id}", "completed") 如果认为任务已完成`,
        "- 调用 run_todo_cancel 取消整个列表",
      ].join("\n");
    }

    return null;
  }

  /** 获取当前 in_progress 的 task */
  function getActiveTask(): Task | undefined {
    return todoList.tasks.find((t) => t.status === "in_progress");
  }

  // === 构建 Tool 注册项 ===

  // 每个 tool entry 包含定义和执行函数，registry.ts 会将这些注册到工具表
  const toolEntries: TodoToolProvider["toolEntries"] = [
    {
      definition: todoCreateDef,
      // run_todo_create：解析 tasks 数组参数
      execute: async (args) => {
        // args["tasks"] 运行时是 string[]（由 JSON.parse 产生）
        const tasks = args["tasks"] as string[] | undefined;
        return doCreate(tasks ?? []);
      },
    },
    {
      definition: todoUpdateDef,
      // run_todo_update：解析 task_id、status、可选 note
      execute: async (args) =>
        doUpdate(
          String(args["task_id"] ?? ""),
          String(args["status"] ?? ""),
          args["note"] as string | undefined,
        ),
    },
    {
      definition: todoAddDef,
      // run_todo_add：解析 task 描述、可选 after_task_id
      execute: async (args) =>
        doAdd(
          String(args["task"] ?? ""),
          args["after_task_id"] as string | undefined,
        ),
    },
    {
      definition: todoRemoveDef,
      // run_todo_remove：解析要删除的 task_id
      execute: async (args) => doRemove(String(args["task_id"] ?? "")),
    },
    {
      definition: todoListDef,
      // run_todo_list：无参数
      execute: async () => doList(),
    },
    {
      definition: todoCancelDef,
      // run_todo_cancel：无参数
      execute: async () => doCancel(),
    },
  ];

  return { tickRound, getActiveTask, toolEntries };
}
