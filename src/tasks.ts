/**
 * tasks.ts — 持久化 Task 任务系统业务层
 *
 * 职责：在 TaskStore 的文件读写之上，实现 Task Group 的状态机、
 * 依赖校验、activeTaskGroupId 以及面向 tool/CLI 的格式化输出。
 *
 * 设计思路：
 * - TaskStore 管文件，TaskManager 管业务规则。
 * - ready、blocks、blockedReason 都是读取时派生状态，不写入磁盘。
 * - activeTaskGroupId 是当前进程的轻状态，只用于提醒 LLM，不作为隐式写入目标。
 */

import * as path from "node:path";
import type {
  TaskEvent,
  TaskGroupFile,
  TaskGroupSummary,
  TaskItem,
  TaskListQuery,
  TaskStatus,
  TaskStore,
} from "./task-store.js";
import {
  computeTaskGroupProgress,
  normalizeProjectRoot,
} from "./task-store.js";

// ============================================================================
// 类型定义
// ============================================================================

export interface CreateTaskInput {
  subject: string;
  description?: string;
  owner?: string;
  blockedBy?: string[];
}

export interface CreateTaskGroupInput {
  title: string;
  description?: string;
  projectRoots?: string[];
  primaryProjectRoot?: string;
  tasks: CreateTaskInput[];
}

export interface AddTaskInput {
  subject: string;
  description?: string;
  owner?: string;
  blockedBy?: string[];
}

export interface UpdateTaskPatch {
  status?: "in_progress" | "completed" | "failed" | "cancelled";
  owner?: string;
  note?: string;
  blockedBy?: string[];
}

export interface TaskView extends TaskItem {
  ready: boolean;
  blocks: string[];
  blockedReason?: string;
}

export interface TaskGroupView {
  group: TaskGroupFile;
  tasks: TaskView[];
}

export interface TaskManager {
  createGroup(input: CreateTaskGroupInput): TaskGroupFile;
  listGroups(query?: TaskListQuery): TaskGroupSummary[];
  readGroup(groupId: string): TaskGroupView | null;
  addTask(groupId: string, input: AddTaskInput): TaskGroupView;
  updateTask(
    groupId: string,
    taskId: string,
    patch: UpdateTaskPatch,
  ): TaskGroupView;
  deleteTask(groupId: string, taskId: string, reason?: string): TaskGroupView;
  archiveGroup(groupId: string): TaskGroupView;
  getActiveGroupId(): string | null;
  setActiveGroupId(groupId: string | null): void;
}

// ============================================================================
// 常量
// ============================================================================

const TERMINAL_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "completed",
  "cancelled",
  "deleted",
]);

const STATUS_SYMBOLS: Record<TaskStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[x]",
  failed: "[!]",
  cancelled: "[_]",
  deleted: "[-]",
};

// ============================================================================
// 工厂函数
// ============================================================================

export function createTaskManager(options: {
  store: TaskStore;
  projectRoot: string;
  now?: () => Date;
  eventIdGenerator?: () => string;
}): TaskManager {
  const store = options.store;
  const currentProjectRoot = normalizeProjectRoot(options.projectRoot);
  const now = options.now ?? (() => new Date());
  const eventIdGenerator =
    options.eventIdGenerator ??
    (() => `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  let activeTaskGroupId: string | null = null;

  function timestamp(): string {
    return now().toISOString();
  }

  function createEvent(input: {
    type: TaskEvent["type"];
    taskId?: string;
    message: string;
  }): TaskEvent {
    const event: TaskEvent = {
      id: eventIdGenerator(),
      timestamp: timestamp(),
      actor: "main",
      type: input.type,
      message: truncateEventMessage(input.message),
    };
    if (input.taskId) event.taskId = input.taskId;
    return event;
  }

  function loadMutableGroup(groupId: string): TaskGroupFile {
    const group = store.read(groupId);
    if (!group) throw new Error(`Task group not found: ${groupId}`);
    return group;
  }

  function saveAndView(group: TaskGroupFile): TaskGroupView {
    normalizeGroupStatus(group, () =>
      createEvent({
        type: "group_completed",
        message: `Completed task group: ${group.title}`,
      }),
    );
    store.save(group);
    activeTaskGroupId = group.id;
    return buildTaskGroupView(group);
  }

  return {
    createGroup(input) {
      const title = normalizeSingleLine(input.title, "title");
      if (!Array.isArray(input.tasks) || input.tasks.length === 0) {
        throw new Error("Task group must contain at least one task");
      }

      const projectRoots = normalizeProjectRoots(
        input.projectRoots,
        currentProjectRoot,
      );
      const primaryProjectRoot = normalizePrimaryProjectRoot(
        input.primaryProjectRoot,
        projectRoots,
      );
      const groupId = createUniqueGroupId(store, timestamp(), title);
      const createdAt = timestamp();
      const tasks = input.tasks.map((taskInput, index) =>
        createTaskFromInput(`task_${index + 1}`, taskInput, createdAt),
      );

      const group: TaskGroupFile = {
        version: 1,
        kind: "task_group",
        id: groupId,
        scope: projectRoots.length > 1 ? "multi_project" : "project",
        projectRoots,
        title,
        status: "active",
        createdAt,
        updatedAt: createdAt,
        tasks,
        events: [
          {
            id: eventIdGenerator(),
            timestamp: createdAt,
            actor: "main",
            type: "group_created",
            message: `Created task group: ${title}`,
          },
        ],
      };
      if (input.description?.trim()) group.description = input.description;
      if (primaryProjectRoot) group.primaryProjectRoot = primaryProjectRoot;

      ensureDependencyGraphValid(group);
      store.save(group);
      activeTaskGroupId = group.id;
      return group;
    },

    listGroups(query) {
      return store.list(query);
    },

    readGroup(groupId) {
      const group = store.read(groupId);
      if (!group) return null;
      activeTaskGroupId = group.id;
      return buildTaskGroupView(group);
    },

    addTask(groupId, input) {
      const group = loadMutableGroup(groupId);
      ensureGroupEditable(group);
      const taskId = nextTaskId(group.tasks);
      const nowIso = timestamp();
      const task = createTaskFromInput(taskId, input, nowIso);
      group.tasks.push(task);
      group.updatedAt = nowIso;
      group.events.push(
        createEvent({
          type: "task_added",
          taskId,
          message: `Added task ${taskId}: ${task.subject}`,
        }),
      );
      ensureDependencyGraphValid(group);
      return saveAndView(group);
    },

    updateTask(groupId, taskId, patch) {
      const group = loadMutableGroup(groupId);
      ensureGroupEditable(group);
      const task = findTask(group, taskId);
      ensureTaskMutable(task);
      const nowIso = timestamp();

      if (patch.blockedBy !== undefined) {
        task.blockedBy = normalizeBlockedBy(patch.blockedBy);
      }
      if (patch.owner !== undefined) {
        task.owner = normalizeSingleLine(patch.owner, "owner");
      }
      if (patch.note !== undefined) {
        const note = patch.note.trim();
        if (note) task.note = note;
        else delete task.note;
      }
      if (patch.status !== undefined) {
        applyStatusTransition(group, task, patch.status, nowIso);
      }

      task.updatedAt = nowIso;
      group.updatedAt = nowIso;
      group.events.push(
        createEvent({
          type: "task_updated",
          taskId,
          message: `Updated task ${taskId}`,
        }),
      );
      ensureDependencyGraphValid(group);
      if (task.status === "in_progress")
        ensureDependenciesCompleted(group, task);
      return saveAndView(group);
    },

    deleteTask(groupId, taskId, reason) {
      const group = loadMutableGroup(groupId);
      ensureGroupEditable(group);
      const task = findTask(group, taskId);
      ensureTaskMutable(task);
      const blockers = group.tasks.filter(
        (candidate) =>
          candidate.status !== "deleted" &&
          candidate.blockedBy.includes(taskId),
      );
      if (blockers.length > 0) {
        throw new Error(
          `Cannot delete ${taskId}; it is required by ${blockers
            .map((t) => t.id)
            .join(", ")}`,
        );
      }

      const nowIso = timestamp();
      task.status = "deleted";
      task.updatedAt = nowIso;
      if (reason?.trim()) task.note = reason.trim();
      group.updatedAt = nowIso;
      group.events.push(
        createEvent({
          type: "task_deleted",
          taskId,
          message: reason?.trim()
            ? `Deleted task ${taskId}: ${reason.trim()}`
            : `Deleted task ${taskId}`,
        }),
      );
      return saveAndView(group);
    },

    archiveGroup(groupId) {
      const group = loadMutableGroup(groupId);
      if (group.status !== "completed" && group.status !== "cancelled") {
        throw new Error(
          "Only completed or cancelled task groups can be archived",
        );
      }
      const nowIso = timestamp();
      group.status = "archived";
      group.archivedAt = nowIso;
      group.updatedAt = nowIso;
      group.events.push(
        createEvent({
          type: "group_archived",
          message: `Archived task group: ${group.title}`,
        }),
      );
      store.save(group);
      if (activeTaskGroupId === group.id) activeTaskGroupId = null;
      return buildTaskGroupView(group);
    },

    getActiveGroupId() {
      return activeTaskGroupId;
    },

    setActiveGroupId(groupId) {
      if (groupId !== null && !store.read(groupId)) {
        throw new Error(`Task group not found: ${groupId}`);
      }
      activeTaskGroupId = groupId;
    },
  };
}

// ============================================================================
// 格式化输出
// ============================================================================

export function formatTaskGroupList(summaries: TaskGroupSummary[]): string {
  if (summaries.length === 0) return "No task groups found.";
  const lines = ["Task Groups:", ""];
  for (const summary of summaries) {
    const progress = summary.progress;
    lines.push(`[${summary.status}] ${summary.id}: ${summary.title}`);
    lines.push(
      `  progress: ${progress.completed}/${progress.total} completed, ${progress.inProgress} in_progress, ${progress.ready} ready, ${progress.blocked} blocked`,
    );
    lines.push(`  updated: ${summary.updatedAt}`);
    if (summary.scope === "multi_project") {
      lines.push(`  projects: ${summary.projectRoots.length}`);
    }
  }
  return lines.join("\n");
}

export function formatTaskGroupView(view: TaskGroupView): string {
  const { group, tasks } = view;
  const lines = [`[${group.status}] ${group.id}: ${group.title}`];
  if (group.description) lines.push(group.description);
  lines.push("");

  for (const task of tasks) {
    const symbol =
      task.ready && task.status === "pending"
        ? "[?]"
        : STATUS_SYMBOLS[task.status];
    lines.push(`${symbol} ${task.id}: ${task.subject}`);
    lines.push(`    owner: ${task.owner}`);
    lines.push(
      `    blockedBy: ${task.blockedBy.length > 0 ? task.blockedBy.join(", ") : "-"}`,
    );
    if (task.blockedReason) lines.push(`    blocked: ${task.blockedReason}`);
    if (task.note) lines.push(`    note: ${task.note}`);
    lines.push("");
  }

  const progress = computeTaskGroupProgress(group);
  lines.push(
    `progress: ${progress.completed}/${progress.total} completed, ${progress.inProgress} in_progress, ${progress.ready} ready, ${progress.blocked} blocked`,
  );
  return lines.join("\n").trimEnd();
}

// ============================================================================
// 派生视图
// ============================================================================

export function buildTaskGroupView(group: TaskGroupFile): TaskGroupView {
  const completedIds = new Set(
    group.tasks.filter((task) => task.status === "completed").map((t) => t.id),
  );
  const blocksById = new Map<string, string[]>();
  for (const task of group.tasks) {
    for (const dep of task.blockedBy) {
      blocksById.set(dep, [...(blocksById.get(dep) ?? []), task.id]);
    }
  }

  const tasks: TaskView[] = group.tasks.map((task) => {
    const missing = task.blockedBy.filter((id) => !completedIds.has(id));
    const view: TaskView = {
      ...task,
      blockedBy: [...task.blockedBy],
      ready: task.status === "pending" && missing.length === 0,
      blocks: blocksById.get(task.id) ?? [],
    };
    if (task.status === "pending" && missing.length > 0) {
      view.blockedReason = `waiting for ${missing.join(", ")}`;
    }
    return view;
  });

  return { group, tasks };
}

// ============================================================================
// 内部业务规则
// ============================================================================

function createTaskFromInput(
  id: string,
  input: CreateTaskInput | AddTaskInput,
  createdAt: string,
): TaskItem {
  const task: TaskItem = {
    id,
    subject: normalizeSingleLine(input.subject, "subject"),
    status: "pending",
    blockedBy: normalizeBlockedBy(input.blockedBy ?? []),
    owner: input.owner ? normalizeSingleLine(input.owner, "owner") : "main",
    createdAt,
    updatedAt: createdAt,
  };
  if (input.description?.trim()) task.description = input.description;
  return task;
}

function createUniqueGroupId(
  store: TaskStore,
  isoTime: string,
  title: string,
): string {
  const date = new Date(isoTime);
  const stamp = `${date.getUTCFullYear()}${pad2(date.getUTCMonth() + 1)}${pad2(
    date.getUTCDate(),
  )}_${pad2(date.getUTCHours())}${pad2(date.getUTCMinutes())}${pad2(
    date.getUTCSeconds(),
  )}`;
  const slug = slugify(title).slice(0, 48) || "task_group";
  let candidate = `tg_${stamp}_${slug}`;
  let suffix = 2;
  while (store.read(candidate)) {
    const suffixText = `_${suffix}`;
    candidate = `tg_${stamp}_${slug.slice(0, 48 - suffixText.length)}${suffixText}`;
    suffix += 1;
  }
  return candidate;
}

function normalizeProjectRoots(
  projectRoots: string[] | undefined,
  currentProjectRoot: string,
): string[] {
  const roots =
    projectRoots && projectRoots.length > 0
      ? projectRoots
      : [currentProjectRoot];
  const normalized = [
    ...new Set(roots.map((root) => normalizeProjectRoot(root))),
  ];
  for (const root of normalized) {
    if (!path.isAbsolute(root)) {
      throw new Error(`project root must be absolute: ${root}`);
    }
  }
  return normalized;
}

function normalizePrimaryProjectRoot(
  primaryProjectRoot: string | undefined,
  projectRoots: string[],
): string | undefined {
  if (!primaryProjectRoot) return undefined;
  const normalized = normalizeProjectRoot(primaryProjectRoot);
  if (!projectRoots.includes(normalized)) {
    throw new Error("primaryProjectRoot must be included in projectRoots");
  }
  return normalized;
}

function normalizeSingleLine(value: string, fieldName: string): string {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) throw new Error(`${fieldName} is required`);
  if (trimmed.includes("\n")) {
    throw new Error(`${fieldName} must be a single line`);
  }
  return trimmed;
}

function normalizeBlockedBy(blockedBy: string[]): string[] {
  return [
    ...new Set(blockedBy.map((id) => normalizeSingleLine(id, "blockedBy"))),
  ];
}

function findTask(group: TaskGroupFile, taskId: string): TaskItem {
  const task = group.tasks.find((item) => item.id === taskId);
  if (!task) throw new Error(`Task not found: ${taskId}`);
  return task;
}

function ensureGroupEditable(group: TaskGroupFile): void {
  if (group.status !== "active") {
    throw new Error(`Task group ${group.id} is not editable (${group.status})`);
  }
}

function ensureTaskMutable(task: TaskItem): void {
  if (TERMINAL_TASK_STATUSES.has(task.status)) {
    throw new Error(`Task ${task.id} is terminal (${task.status})`);
  }
}

function applyStatusTransition(
  group: TaskGroupFile,
  task: TaskItem,
  nextStatus: NonNullable<UpdateTaskPatch["status"]>,
  nowIso: string,
): void {
  if (nextStatus === "in_progress") {
    if (task.status !== "pending" && task.status !== "failed") {
      throw new Error(`Cannot start task ${task.id} from ${task.status}`);
    }
    ensureDependenciesCompleted(group, task);
    task.status = "in_progress";
    task.startedAt = nowIso;
    return;
  }

  if (
    task.status !== "in_progress" &&
    task.status !== "pending" &&
    task.status !== "failed"
  ) {
    throw new Error(
      `Cannot move task ${task.id} from ${task.status} to ${nextStatus}`,
    );
  }

  task.status = nextStatus;
  if (nextStatus === "completed") {
    task.completedAt = nowIso;
  } else {
    delete task.completedAt;
  }
}

function ensureDependenciesCompleted(
  group: TaskGroupFile,
  task: TaskItem,
): void {
  const byId = new Map(group.tasks.map((item) => [item.id, item]));
  const missing = task.blockedBy.filter(
    (id) => byId.get(id)?.status !== "completed",
  );
  if (missing.length > 0) {
    throw new Error(`Task ${task.id} is blocked by ${missing.join(", ")}`);
  }
}

function ensureDependencyGraphValid(group: TaskGroupFile): void {
  const byId = new Map(group.tasks.map((task) => [task.id, task]));
  for (const task of group.tasks) {
    for (const dep of task.blockedBy) {
      const depTask = byId.get(dep);
      if (!depTask)
        throw new Error(`Task ${task.id} depends on missing task ${dep}`);
      if (depTask.status === "deleted") {
        throw new Error(`Task ${task.id} depends on deleted task ${dep}`);
      }
      if (dep === task.id)
        throw new Error(`Task ${task.id} cannot depend on itself`);
    }
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  function visit(id: string): void {
    if (visiting.has(id)) throw new Error(`Dependency cycle detected at ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    const task = byId.get(id);
    for (const dep of task?.blockedBy ?? []) visit(dep);
    visiting.delete(id);
    visited.add(id);
  }

  for (const task of group.tasks) visit(task.id);
}

function normalizeGroupStatus(
  group: TaskGroupFile,
  createCompletedEvent: () => TaskEvent,
): void {
  if (group.status !== "active" && group.status !== "completed") return;
  const effectiveTasks = group.tasks.filter(
    (task) => task.status !== "deleted",
  );
  if (
    effectiveTasks.length > 0 &&
    effectiveTasks.every((task) => task.status === "completed")
  ) {
    if (group.status !== "completed") {
      group.status = "completed";
      group.events.push(createCompletedEvent());
    }
  }
}

function nextTaskId(tasks: TaskItem[]): string {
  const max = tasks.reduce((current, task) => {
    const match = /^task_([0-9]+)$/.exec(task.id);
    if (!match) return current;
    return Math.max(current, Number(match[1]));
  }, 0);
  return `task_${max + 1}`;
}

function slugify(value: string): string {
  const ascii = value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
  return ascii || "task_group";
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function truncateEventMessage(message: string): string {
  const trimmed = message.trim();
  return trimmed.length <= 240 ? trimmed : `${trimmed.slice(0, 237)}...`;
}
