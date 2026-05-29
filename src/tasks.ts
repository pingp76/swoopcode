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
  // 教学导读：
  // TaskManager 是持久化 Task 的业务层。
  // 它不关心 group.json 写在哪里，也不关心 LLM tool 参数长什么样；
  // 它只负责长期任务组的状态机：
  // - 创建 group / task
  // - 校验依赖图
  // - 控制 task 状态转换
  // - 自动派生 group 完成状态
  //
  // 这和 todo.ts 的 session TODO 不同：
  // TODO 是当前会话的短期执行清单；Task 是跨会话、可恢复、带依赖图的长期计划。

  const store = options.store;
  const currentProjectRoot = normalizeProjectRoot(options.projectRoot);
  const now = options.now ?? (() => new Date());
  const eventIdGenerator =
    options.eventIdGenerator ??
    (() => `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
  // activeTaskGroupId 是 session 级状态，不写入磁盘。
  // 它只是帮助工具输出和 reminder 告诉模型“当前正在关注哪个长期任务组”。
  let activeTaskGroupId: string | null = null;

  function timestamp(): string {
    return now().toISOString();
  }

  function createEvent(input: {
    type: TaskEvent["type"];
    taskId?: string;
    message: string;
  }): TaskEvent {
    // 所有业务修改都追加 event，形成轻量审计线索。
    // event 不驱动状态机，状态仍以 tasks[] 当前字段为准。
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
    // 每次保存前统一归一化 group 状态。
    // 例如所有未删除任务完成后，group 自动进入 completed。
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
      // 初始任务按输入顺序生成 task_1/task_2/...。
      // 这样学生在文件里可以很直观看到任务 id 与创建顺序的关系。
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

      // 创建时就检查依赖图，避免把有环或引用不存在 task 的 group 写入持久化层。
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

      // patch 是部分更新：只修改调用方显式提供的字段。
      // 这让工具可以只改状态或只改 owner，而不会覆盖其他信息。
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
      // 依赖完成检查放在 patch 应用之后：
      // 如果本次 patch 同时修改 blockedBy 和 status，就按最新依赖关系判断。
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
        // 不能删除仍被其他任务依赖的节点。
        // 否则依赖图会出现悬空引用，后续 ready/blocked 派生状态无法解释。
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
      // 激活已有 group 前先读 store，避免 session 状态指向不存在的持久化对象。
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
  // 创建 Task 时只写入“事实字段”：
  // status、blockedBy、owner、时间戳等。
  // ready、blocks、blockedReason 这些展示字段不写入文件，
  // 因为它们会随着其他任务状态变化而变化，属于读取时派生状态。
  // 常见坑：把派生状态持久化，最后真实状态和派生状态互相打架。
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
  // group_id 既要稳定可读，也要避免碰撞。
  // 这里把 UTC 时间戳 + title slug 组合起来：
  // - 时间戳方便人类按创建时间排查
  // - slug 方便从目录名看出大致任务主题
  // - 碰撞时追加 _2/_3，避免覆盖已有 group
  //
  // 注意：id 不是安全边界，只是持久化身份。安全校验仍在 store/permission 层。
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
  // projectRoots 表示这个 Task Group 关联哪些项目。
  // 默认绑定当前项目；如果用户显式传多个 root，就成为 multi_project group。
  //
  // 这里要求绝对路径，是为了避免“同一个相对路径在不同 cwd 下指向不同项目”的歧义。
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
  // title/subject/owner 等字段要求单行。
  // 这是一个小但重要的持久化约束：单行字段更适合列表展示、日志摘要和事件消息。
  // 多行详细内容应该放 description/note，而不是塞进 subject。
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
  // 只有 active group 可以编辑。
  // completed/cancelled/archived 都是 group 级终态或准终态；
  // 如果允许继续编辑，event log 和状态语义会变得难以解释。
  if (group.status !== "active") {
    throw new Error(`Task group ${group.id} is not editable (${group.status})`);
  }
}

function ensureTaskMutable(task: TaskItem): void {
  // terminal task 不允许再改，是为了保持历史事件的可信度。
  // 如果 completed 后还能改回 pending，依赖它的任务可能已经开始执行，
  // 整个依赖图的时间线就会倒流。
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
  // Task 状态机的核心入口。
  // 不要在调用方直接写 task.status = xxx，否则会绕过依赖检查、时间戳和 completedAt 维护。
  //
  // 允许的关键流向：
  // - pending/failed -> in_progress
  // - pending/in_progress/failed -> completed/failed/cancelled
  // - terminal 状态由 ensureTaskMutable 提前拦住
  if (nextStatus === "in_progress") {
    if (task.status !== "pending" && task.status !== "failed") {
      throw new Error(`Cannot start task ${task.id} from ${task.status}`);
    }
    ensureDependenciesCompleted(group, task);
    // startedAt 只在真正进入 in_progress 时设置。
    // 如果任务从 failed 重新开始，会刷新 startedAt，表示新一轮执行开始。
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
    // completedAt 只对 completed 有意义。
    // failed/cancelled 不保留 completedAt，避免展示层误判任务已经成功完成。
    task.completedAt = nowIso;
  } else {
    delete task.completedAt;
  }
}

function ensureDependenciesCompleted(
  group: TaskGroupFile,
  task: TaskItem,
): void {
  // 依赖检查使用“必须 completed”，而不是“非 pending/非 failed”。
  // cancelled/deleted/failed 都不能算完成，否则下游任务会建立在失败前提上继续推进。
  const byId = new Map(group.tasks.map((item) => [item.id, item]));
  const missing = task.blockedBy.filter(
    (id) => byId.get(id)?.status !== "completed",
  );
  if (missing.length > 0) {
    throw new Error(`Task ${task.id} is blocked by ${missing.join(", ")}`);
  }
}

function ensureDependencyGraphValid(group: TaskGroupFile): void {
  // 依赖图校验是 Task 系统最重要的防御之一。
  // 需要同时防三类错误：
  // 1. 悬空依赖：blockedBy 指向不存在的 task
  // 2. 删除依赖：blockedBy 指向 deleted task
  // 3. 环形依赖：A 等 B，B 又等 A，永远无法 ready
  //
  // 这个函数在 create/add/update 后都会调用，确保不会把坏图写入 store。
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
    // DFS 三色标记的简化版：
    // visiting = 当前递归栈上的节点；再次遇到说明成环。
    // visited = 已经确认无环的节点；再次遇到可以跳过。
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
  // group 状态是由 task 状态派生推进的。
  // 只要所有非 deleted task 都 completed，active group 自动 completed。
  //
  // deleted task 不参与完成度计算：它表示“从计划中移除”，不是“需要完成的工作”。
  // 常见坑：把 deleted 也算进完成度，导致 group 永远无法 completed。
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
