/**
 * tools/tasks.ts — 持久化 Task 系统工具提供者
 *
 * 职责：将 TaskManager 包装成 LLM 可调用的 function calling tools。
 *
 * 设计原则：
 * - 所有修改类工具都必须显式传入 group_id。
 * - activeTaskGroupId 只用于 reminder，不作为隐式写入目标。
 * - 工具错误返回 ToolResult.error，不向 Agent 主循环抛出普通参数错误。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolResult } from "./types.js";
import type {
  AddTaskInput,
  CreateTaskGroupInput,
  TaskManager,
  UpdateTaskPatch,
} from "../tasks.js";
import { formatTaskGroupList, formatTaskGroupView } from "../tasks.js";
import type { TaskGroupStatus } from "../task-store.js";
import type { SessionEventBuffer } from "../session-events.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface TaskToolProvider {
  /** 工具注册项数组：每个包含定义和执行函数 */
  toolEntries: Array<{
    definition: ChatCompletionTool;
    execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  }>;
}

// ============================================================================
// 工具定义
// ============================================================================

const taskGroupCreateDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_task_group_create",
    description:
      "Create a persistent Task Group for long-running durable work. Use this when the plan may span sessions, restarts, projects, owners, or dependency graphs. Do not use this for short current-session execution steps; use run_todo_create for that.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Task group title, single line",
        },
        description: {
          type: "string",
          description: "Optional longer description",
        },
        project_roots: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional absolute project roots related to this group. Defaults to current project.",
        },
        primary_project_root: {
          type: "string",
          description:
            "Optional primary project root. Must be included in project_roots.",
        },
        tasks: {
          type: "array",
          items: {
            type: "object",
            properties: {
              subject: { type: "string" },
              description: { type: "string" },
              owner: { type: "string" },
              blocked_by: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["subject"],
          },
          description: "Initial task list. Must contain at least one task.",
        },
      },
      required: ["title", "tasks"],
    },
  },
};

const taskGroupListDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_task_group_list",
    description:
      "List persistent Task Groups. Use this to resume or inspect durable long-running work, not to inspect the current session TODO list. By default, only groups related to the current project are returned.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["active", "completed", "cancelled", "archived"],
        },
        include_archived: { type: "boolean" },
        current_project_only: { type: "boolean" },
      },
    },
  },
};

const taskGroupReadDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_task_group_read",
    description:
      "Read a persistent Task Group with all tasks and dependencies. Use after selecting durable work to continue; use run_todo_list for current-session execution steps.",
    parameters: {
      type: "object",
      properties: {
        group_id: { type: "string" },
      },
      required: ["group_id"],
    },
  },
};

const taskAddDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_task_add",
    description:
      "Add a durable task to an existing persistent Task Group. For short-lived execution steps in the current session, use run_todo_add.",
    parameters: {
      type: "object",
      properties: {
        group_id: { type: "string" },
        subject: { type: "string" },
        description: { type: "string" },
        owner: { type: "string" },
        blocked_by: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["group_id", "subject"],
    },
  },
};

const taskUpdateDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_task_update",
    description:
      "Update durable Task Group task status, owner, note, or dependencies. group_id and task_id are always required. For temporary TODO items, use run_todo_update.",
    parameters: {
      type: "object",
      properties: {
        group_id: { type: "string" },
        task_id: { type: "string" },
        status: {
          type: "string",
          enum: ["in_progress", "completed", "failed", "cancelled"],
        },
        owner: { type: "string" },
        note: { type: "string" },
        blocked_by: {
          type: "array",
          items: { type: "string" },
        },
      },
      required: ["group_id", "task_id"],
    },
  },
};

const taskDeleteDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_task_delete",
    description:
      "Soft-delete a task from a persistent task group. Refuses deletion when other non-deleted tasks depend on it.",
    parameters: {
      type: "object",
      properties: {
        group_id: { type: "string" },
        task_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["group_id", "task_id"],
    },
  },
};

// ============================================================================
// 工厂函数
// ============================================================================

export function createTaskToolProvider(
  manager: TaskManager,
  options?: {
    sessionEventBuffer?: SessionEventBuffer;
  },
): TaskToolProvider {
  // 教学导读：
  // Task 工具层刻意不直接读写 task-store 文件。
  // 文件格式、状态机、依赖图校验都封装在 TaskManager/TaskStore；
  // 工具层只负责把 LLM 传来的 JSON 参数转换成 manager 的输入对象，
  // 再把 manager 返回的 view 格式化成 LLM 容易阅读的文本。
  //
  // 这样学生可以看到一个清晰分层：
  // - tools/tasks.ts：协议适配和错误包装
  // - tasks.ts：业务规则与状态转移
  // - task-store.ts：持久化布局和读写校验

  const sessionEventBuffer = options?.sessionEventBuffer;

  /**
   * pushActiveReminder — 向会话事件缓冲区推送当前活跃任务组提醒
   *
   * 仅在存在活跃 group_id 且有 sessionEventBuffer 时生效，
   * 用于提醒 LLM 后续修改操作需要显式传入 group_id。
   */
  function pushActiveReminder(): void {
    const activeId = manager.getActiveGroupId();
    // 没有活跃 group 或没有事件缓冲区时直接返回，避免无效推送
    if (!activeId || !sessionEventBuffer) return;
    sessionEventBuffer.push({
      source: "task",
      message: `Current active task group: ${activeId}. Pass this group_id explicitly when updating tasks.`,
    });
  }

  async function executeCreate(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      // 解析并校验创建参数后调用 manager 创建任务组
      // parseCreateInput 会把 tool schema 的字段转换成内部 CreateTaskGroupInput。
      // 如果缺少 title/tasks，错误会在这里变成 ToolResult 返回给 LLM。
      const group = manager.createGroup(parseCreateInput(args));
      // 创建成功后推送活跃提醒，方便 LLM 后续操作
      pushActiveReminder();
      // 读取刚创建的任务组完整视图返回给 LLM
      const view = manager.readGroup(group.id);
      return {
        output: view
          ? formatTaskGroupView(view)
          : `Task group created: ${group.id}`,
        error: false,
      };
    } catch (error) {
      // 参数校验失败或 manager 异常时统一包装为 ToolResult 错误
      return errorResult(error);
    }
  }

  async function executeList(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      // 将可选的 status 参数转换为合法枚举值
      const status = optionalStatus(args["status"]);
      // 构建查询条件：status 有值时加入筛选，include_archived 只接受 true，current_project_only 默认 true
      // current_project_only 默认 true 是跨项目全局存储的重要防线：
      // LLM 不会在普通 list 中意外看到其他项目的长期任务。
      const summaries = manager.listGroups({
        ...(status ? { status } : {}),
        includeArchived: args["include_archived"] === true,
        currentProjectOnly: args["current_project_only"] !== false,
      });
      return { output: formatTaskGroupList(summaries), error: false };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function executeRead(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      // group_id 为必填参数，缺失或为空时 requiredString 会抛出异常
      const groupId = requiredString(args, "group_id");
      const view = manager.readGroup(groupId);
      // 找不到指定任务组时返回错误，不抛异常
      if (!view)
        return { output: `Task group not found: ${groupId}`, error: true };
      pushActiveReminder();
      return { output: formatTaskGroupView(view), error: false };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function executeAdd(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      // 校验 group_id 和 task 必填字段后调用 manager 添加任务
      const groupId = requiredString(args, "group_id");
      const view = manager.addTask(groupId, parseAddInput(args));
      pushActiveReminder();
      return { output: formatTaskGroupView(view), error: false };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function executeUpdate(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      // group_id 和 task_id 均为必填，缺一不可
      const groupId = requiredString(args, "group_id");
      const taskId = requiredString(args, "task_id");
      const view = manager.updateTask(groupId, taskId, parseUpdatePatch(args));
      pushActiveReminder();
      return { output: formatTaskGroupView(view), error: false };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function executeDelete(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      // 获取必填的 group_id 和 task_id，reason 为可选
      const groupId = requiredString(args, "group_id");
      const taskId = requiredString(args, "task_id");
      const reason = optionalString(args["reason"]);
      const view = manager.deleteTask(groupId, taskId, reason);
      pushActiveReminder();
      return { output: formatTaskGroupView(view), error: false };
    } catch (error) {
      return errorResult(error);
    }
  }

  return {
    toolEntries: [
      { definition: taskGroupCreateDef, execute: executeCreate },
      { definition: taskGroupListDef, execute: executeList },
      { definition: taskGroupReadDef, execute: executeRead },
      { definition: taskAddDef, execute: executeAdd },
      { definition: taskUpdateDef, execute: executeUpdate },
      { definition: taskDeleteDef, execute: executeDelete },
    ],
  };
}

// ============================================================================
// 参数解析
// ============================================================================

function parseCreateInput(args: Record<string, unknown>): CreateTaskGroupInput {
  // 参数解析函数有两个教学目的：
  // 1. 把外部 snake_case 参数转为内部 camelCase；
  // 2. 明确哪些字段是“未传入”，哪些字段是“传入了但类型错误”。
  // 这比在 executeCreate 里写一大坨 if 更容易测试和复用。

  // 先构造包含必填字段的基础对象
  const input: CreateTaskGroupInput = {
    title: requiredString(args, "title"),
    tasks: parseTaskArray(args["tasks"]),
  };
  // 可选字段只在有值时才附加到对象，避免传入 undefined
  const description = optionalString(args["description"]);
  const projectRoots = optionalStringArray(args["project_roots"]);
  const primaryProjectRoot = optionalString(args["primary_project_root"]);
  if (description) input.description = description;
  if (projectRoots) input.projectRoots = projectRoots;
  if (primaryProjectRoot) input.primaryProjectRoot = primaryProjectRoot;
  return input;
}

function parseAddInput(args: Record<string, unknown>): AddTaskInput {
  // subject 为必填，其余字段可选
  const input: AddTaskInput = {
    subject: requiredString(args, "subject"),
  };
  const description = optionalString(args["description"]);
  const owner = optionalString(args["owner"]);
  const blockedBy = optionalStringArray(args["blocked_by"]);
  if (description) input.description = description;
  if (owner) input.owner = owner;
  if (blockedBy) input.blockedBy = blockedBy;
  return input;
}

function parseUpdatePatch(args: Record<string, unknown>): UpdateTaskPatch {
  // Patch 和 Create 不同：
  // Create 要求必填字段齐全；Patch 只包含调用方真正想修改的字段。
  // 因此这里从空对象开始，逐个判断字段是否出现。
  const patch: UpdateTaskPatch = {};
  // status 可选，但如果传入则必须是四个合法值之一
  const status = optionalString(args["status"]);
  if (status) {
    if (
      status !== "in_progress" &&
      status !== "completed" &&
      status !== "failed" &&
      status !== "cancelled"
    ) {
      throw new Error(`Invalid status: ${status}`);
    }
    patch.status = status;
  }
  // owner、note、blocked_by 均为可选更新字段
  const owner = optionalString(args["owner"]);
  const note = optionalString(args["note"]);
  const blockedBy = optionalStringArray(args["blocked_by"]);
  if (owner) patch.owner = owner;
  // note 允许传入空字符串，所以用 undefined 判断而非 falsy 判断
  if (note !== undefined) patch.note = note;
  if (blockedBy) patch.blockedBy = blockedBy;
  return patch;
}

function parseTaskArray(value: unknown): CreateTaskGroupInput["tasks"] {
  // tasks 必须是数组且不能为空
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("'tasks' must be a non-empty array");
  }
  return value.map((item, index) => {
    // 逐个校验数组元素是否为普通对象
    if (!isRecord(item)) throw new Error(`tasks[${index}] must be an object`);
    // 每个 task 的 subject 是唯一必填字段；owner/blocked_by 等都可以缺省，
    // 由 tasks.ts 的业务层补默认 owner 和空依赖。
    const task: CreateTaskGroupInput["tasks"][number] = {
      subject: requiredString(item, "subject"),
    };
    // 解析每个 task 的可选字段
    const description = optionalString(item["description"]);
    const owner = optionalString(item["owner"]);
    const blockedBy = optionalStringArray(item["blocked_by"]);
    if (description) task.description = description;
    if (owner) task.owner = owner;
    if (blockedBy) task.blockedBy = blockedBy;
    return task;
  });
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  // 校验类型和空值，两者任一不满足都视为缺失
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`'${key}' is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  // undefined 和 null 都视为未传入
  if (value === undefined || value === null) return undefined;
  // 传入非字符串类型则抛出错误，防止类型混乱
  // 注意这里不 trim，也不把空字符串当 undefined。
  // 某些 patch 字段（如 note）需要允许空字符串表示“清空备注”。
  if (typeof value !== "string") throw new Error("Expected string value");
  return value;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("Expected string array");
  // 遍历数组，确保每个元素都是字符串
  return value.map((item) => {
    if (typeof item !== "string") throw new Error("Expected string array");
    return item;
  });
}

function optionalStatus(value: unknown): TaskGroupStatus | undefined {
  const status = optionalString(value);
  if (!status) return undefined;
  // 校验状态值是否在预定义枚举内
  if (
    status !== "active" &&
    status !== "completed" &&
    status !== "cancelled" &&
    status !== "archived"
  ) {
    throw new Error(`Invalid task group status: ${status}`);
  }
  return status;
}

function errorResult(error: unknown): ToolResult {
  return {
    output: `Error: ${error instanceof Error ? error.message : String(error)}`,
    error: true,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  // 排除 null 和数组，确保是普通对象
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
