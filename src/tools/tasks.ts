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
  const sessionEventBuffer = options?.sessionEventBuffer;

  function pushActiveReminder(): void {
    const activeId = manager.getActiveGroupId();
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
      const group = manager.createGroup(parseCreateInput(args));
      pushActiveReminder();
      const view = manager.readGroup(group.id);
      return {
        output: view
          ? formatTaskGroupView(view)
          : `Task group created: ${group.id}`,
        error: false,
      };
    } catch (error) {
      return errorResult(error);
    }
  }

  async function executeList(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      const status = optionalStatus(args["status"]);
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
      const groupId = requiredString(args, "group_id");
      const view = manager.readGroup(groupId);
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
  const input: CreateTaskGroupInput = {
    title: requiredString(args, "title"),
    tasks: parseTaskArray(args["tasks"]),
  };
  const description = optionalString(args["description"]);
  const projectRoots = optionalStringArray(args["project_roots"]);
  const primaryProjectRoot = optionalString(args["primary_project_root"]);
  if (description) input.description = description;
  if (projectRoots) input.projectRoots = projectRoots;
  if (primaryProjectRoot) input.primaryProjectRoot = primaryProjectRoot;
  return input;
}

function parseAddInput(args: Record<string, unknown>): AddTaskInput {
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
  const patch: UpdateTaskPatch = {};
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
  const owner = optionalString(args["owner"]);
  const note = optionalString(args["note"]);
  const blockedBy = optionalStringArray(args["blocked_by"]);
  if (owner) patch.owner = owner;
  if (note !== undefined) patch.note = note;
  if (blockedBy) patch.blockedBy = blockedBy;
  return patch;
}

function parseTaskArray(value: unknown): CreateTaskGroupInput["tasks"] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("'tasks' must be a non-empty array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`tasks[${index}] must be an object`);
    const task: CreateTaskGroupInput["tasks"][number] = {
      subject: requiredString(item, "subject"),
    };
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
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`'${key}' is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new Error("Expected string value");
  return value;
}

function optionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error("Expected string array");
  return value.map((item) => {
    if (typeof item !== "string") throw new Error("Expected string array");
    return item;
  });
}

function optionalStatus(value: unknown): TaskGroupStatus | undefined {
  const status = optionalString(value);
  if (!status) return undefined;
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
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
