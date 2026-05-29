/**
 * task-store.ts — 持久化 Task Group 文件存储层
 *
 * 职责：负责 Task Group 的磁盘目录布局、JSON 读写、索引重建和读取校验。
 *
 * 设计边界：
 * - 本模块只处理文件和格式，不处理 LLM tool 参数。
 * - Task Group 的真实数据源是 `tasks/groups/<group_id>/group.json`。
 * - `tasks/index.json` 是派生索引，可以随时从 group.json 重建。
 * - Reader 和 writer 使用同一套校验，避免写出自己读不了的数据。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Logger } from "./logger.js";
import { atomicWriteJsonFile } from "./atomic-write.js";

// ============================================================================
// 类型定义
// ============================================================================

export type TaskGroupScope = "project" | "multi_project";
export type TaskGroupStatus = "active" | "completed" | "cancelled" | "archived";

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "deleted";

export interface TaskEvent {
  id: string;
  timestamp: string;
  actor: string;
  type:
    | "group_created"
    | "task_added"
    | "task_updated"
    | "task_deleted"
    | "group_completed"
    | "group_cancelled"
    | "group_archived";
  taskId?: string;
  message: string;
}

export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  blockedBy: string[];
  owner: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export interface TaskGroupFile {
  version: 1;
  kind: "task_group";
  id: string;
  scope: TaskGroupScope;
  projectRoots: string[];
  primaryProjectRoot?: string;
  title: string;
  description?: string;
  status: TaskGroupStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  tasks: TaskItem[];
  events: TaskEvent[];
}

export interface TaskGroupProgress {
  total: number;
  completed: number;
  inProgress: number;
  ready: number;
  blocked: number;
  failed: number;
  cancelled: number;
  deleted: number;
}

export interface TaskGroupSummary {
  id: string;
  title: string;
  status: TaskGroupStatus;
  scope: TaskGroupScope;
  projectRoots: string[];
  primaryProjectRoot?: string;
  updatedAt: string;
  progress: TaskGroupProgress;
}

export interface TaskListQuery {
  status?: TaskGroupStatus;
  includeArchived?: boolean;
  currentProjectOnly?: boolean;
}

export interface TaskIndexFile {
  version: 1;
  byProjectKey: Record<string, string[]>;
  allGroups: string[];
}

export interface TaskStore {
  scan(): TaskGroupSummary[];
  list(query?: TaskListQuery): TaskGroupSummary[];
  read(groupId: string): TaskGroupFile | null;
  save(group: TaskGroupFile): void;
  archive(groupId: string): TaskGroupFile;
  rebuildIndex(): void;
  cleanupTempFiles(): void;
  getTasksDir(): string;
}

// ============================================================================
// 常量
// ============================================================================

const TASK_GROUP_ID_REGEX = /^tg_[0-9]{8}_[0-9]{6}_[a-z0-9_-]{1,48}$/;
const TASK_ID_REGEX = /^task_[1-9][0-9]*$/;
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const VALID_GROUP_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "completed",
  "cancelled",
  "archived",
]);

const VALID_TASK_STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "in_progress",
  "completed",
  "failed",
  "cancelled",
  "deleted",
]);

// ============================================================================
// 公共辅助函数
// ============================================================================

/**
 * createProjectKey — 为 projectRoot 生成稳定索引键
 *
 * projectRoot 可能包含斜杠、空格和用户目录信息，不适合直接作为 JSON key。
 * 这里使用短 hash，只作为索引键，不作为安全边界。
 */
export function createProjectKey(projectRoot: string): string {
  const normalized = path.resolve(projectRoot);
  const hash = createHash("sha256")
    .update(normalized)
    .digest("hex")
    .slice(0, 12);
  return `p_${hash}`;
}

/**
 * normalizeProjectRoot — 统一项目路径格式
 */
export function normalizeProjectRoot(projectRoot: string): string {
  return path.resolve(projectRoot);
}

/**
 * computeTaskGroupProgress — 从 tasks 派生展示用进度
 *
 * ready/blocked 都是计算状态，不写入文件，避免和真实状态漂移。
 */
export function computeTaskGroupProgress(
  group: TaskGroupFile,
): TaskGroupProgress {
  const completedIds = new Set(
    group.tasks.filter((task) => task.status === "completed").map((t) => t.id),
  );
  const progress: TaskGroupProgress = {
    total: group.tasks.filter((task) => task.status !== "deleted").length,
    completed: 0,
    inProgress: 0,
    ready: 0,
    blocked: 0,
    failed: 0,
    cancelled: 0,
    deleted: 0,
  };

  for (const task of group.tasks) {
    if (task.status === "completed") progress.completed += 1;
    if (task.status === "in_progress") progress.inProgress += 1;
    if (task.status === "failed") progress.failed += 1;
    if (task.status === "cancelled") progress.cancelled += 1;
    if (task.status === "deleted") progress.deleted += 1;
    if (task.status === "pending") {
      const ready = task.blockedBy.every((id) => completedIds.has(id));
      if (ready) progress.ready += 1;
      else progress.blocked += 1;
    }
  }

  return progress;
}

/**
 * createTaskGroupSummary — 从完整 group 派生列表摘要
 */
export function createTaskGroupSummary(group: TaskGroupFile): TaskGroupSummary {
  const summary: TaskGroupSummary = {
    id: group.id,
    title: group.title,
    status: group.status,
    scope: group.scope,
    projectRoots: [...group.projectRoots],
    updatedAt: group.updatedAt,
    progress: computeTaskGroupProgress(group),
  };
  if (group.primaryProjectRoot)
    summary.primaryProjectRoot = group.primaryProjectRoot;
  return summary;
}

/**
 * validateTaskGroupFile — 读取和写入共用的完整校验
 *
 * 返回字符串数组而不是直接抛错，方便 reader 记录 warning 后跳过坏文件。
 */
export function validateTaskGroupFile(
  value: unknown,
  expectedGroupId?: string,
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["Task group must be an object"];

  if (value["version"] !== 1) errors.push("version must be 1");
  if (value["kind"] !== "task_group") errors.push('kind must be "task_group"');

  const id = value["id"];
  if (typeof id !== "string" || !TASK_GROUP_ID_REGEX.test(id)) {
    errors.push("id has invalid format");
  }
  if (expectedGroupId && id !== expectedGroupId) {
    errors.push("directory id and content id do not match");
  }

  const scope = value["scope"];
  if (scope !== "project" && scope !== "multi_project") {
    errors.push("scope must be project or multi_project");
  }

  const projectRoots = value["projectRoots"];
  if (!Array.isArray(projectRoots) || projectRoots.length === 0) {
    errors.push("projectRoots must be a non-empty array");
  } else {
    for (const root of projectRoots) {
      if (typeof root !== "string" || !path.isAbsolute(root)) {
        errors.push("projectRoots must contain absolute paths");
        break;
      }
    }
  }

  const primary = value["primaryProjectRoot"];
  if (primary !== undefined) {
    if (typeof primary !== "string" || !path.isAbsolute(primary)) {
      errors.push("primaryProjectRoot must be an absolute path");
    } else if (Array.isArray(projectRoots) && !projectRoots.includes(primary)) {
      errors.push("primaryProjectRoot must be included in projectRoots");
    }
  }

  if (typeof value["title"] !== "string" || value["title"].trim() === "") {
    errors.push("title is required");
  }
  if (!VALID_GROUP_STATUSES.has(String(value["status"] ?? ""))) {
    errors.push("status is invalid");
  }
  for (const timeField of ["createdAt", "updatedAt"] as const) {
    if (
      typeof value[timeField] !== "string" ||
      value[timeField].trim() === ""
    ) {
      errors.push(`${timeField} is required`);
    }
  }

  const tasks = value["tasks"];
  if (!Array.isArray(tasks)) {
    errors.push("tasks must be an array");
  } else {
    validateTasks(tasks, errors);
  }

  const events = value["events"];
  if (!Array.isArray(events)) {
    errors.push("events must be an array");
  }

  return errors;
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createTaskStore(options: {
  tasksDir: string;
  projectRoot: string;
  logger: Logger;
  now?: () => Date;
}): TaskStore {
  const tasksDir = path.resolve(options.tasksDir);
  const groupsDir = path.resolve(tasksDir, "groups");
  const indexPath = path.resolve(tasksDir, "index.json");
  const currentProjectRoot = normalizeProjectRoot(options.projectRoot);
  const logger = options.logger;
  const now = options.now ?? (() => new Date());
  const groups = new Map<string, TaskGroupFile>();

  function groupDir(groupId: string): string {
    return path.resolve(groupsDir, groupId);
  }

  function groupPath(groupId: string): string {
    return path.resolve(groupDir(groupId), "group.json");
  }

  function loadOne(groupId: string): TaskGroupFile | null {
    if (!TASK_GROUP_ID_REGEX.test(groupId)) return null;
    const filePath = groupPath(groupId);
    if (!fs.existsSync(filePath)) return null;

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
      const errors = validateTaskGroupFile(parsed, groupId);
      if (errors.length > 0) {
        logger.warn("Task group %s skipped: %s", groupId, errors.join("; "));
        return null;
      }
      return parsed as TaskGroupFile;
    } catch (error) {
      logger.warn("Task group %s skipped: %s", groupId, String(error));
      return null;
    }
  }

  function writeIndex(): void {
    const byProjectKey: Record<string, string[]> = {};
    const allGroups = [...groups.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((group) => group.id);

    for (const group of groups.values()) {
      for (const root of group.projectRoots) {
        const key = createProjectKey(root);
        byProjectKey[key] ??= [];
        byProjectKey[key]!.push(group.id);
      }
    }

    for (const ids of Object.values(byProjectKey)) {
      ids.sort((a, b) => a.localeCompare(b));
    }

    const index: TaskIndexFile = { version: 1, byProjectKey, allGroups };
    atomicWriteJsonFile(indexPath, index);
  }

  function assertValidForSave(group: TaskGroupFile): void {
    const errors = validateTaskGroupFile(group, group.id);
    if (errors.length > 0) {
      throw new Error(`Invalid task group "${group.id}": ${errors.join("; ")}`);
    }
  }

  return {
    scan() {
      groups.clear();
      fs.mkdirSync(groupsDir, { recursive: true });
      const entries = fs.readdirSync(groupsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const group = loadOne(entry.name);
        if (group) groups.set(group.id, group);
      }
      writeIndex();
      return this.list({ includeArchived: true, currentProjectOnly: false });
    },

    list(query = {}) {
      const includeArchived = query.includeArchived ?? false;
      const currentProjectOnly = query.currentProjectOnly ?? true;
      return [...groups.values()]
        .filter((group) => {
          if (!includeArchived && group.status === "archived") return false;
          if (query.status && group.status !== query.status) return false;
          if (
            currentProjectOnly &&
            !group.projectRoots.includes(currentProjectRoot)
          ) {
            return false;
          }
          return true;
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(createTaskGroupSummary);
    },

    read(groupId) {
      if (!TASK_GROUP_ID_REGEX.test(groupId)) return null;
      const cached = groups.get(groupId);
      if (cached) return cloneJson(cached);
      const loaded = loadOne(groupId);
      if (!loaded) return null;
      groups.set(loaded.id, loaded);
      writeIndex();
      return cloneJson(loaded);
    },

    save(group) {
      assertValidForSave(group);
      const finalPath = groupPath(group.id);

      atomicWriteJsonFile(finalPath, group);

      groups.set(group.id, cloneJson(group));
      writeIndex();
    },

    archive(groupId) {
      const group = this.read(groupId);
      if (!group) throw new Error(`Task group not found: ${groupId}`);
      if (group.status !== "completed" && group.status !== "cancelled") {
        throw new Error(
          "Only completed or cancelled task groups can be archived",
        );
      }
      const timestamp = now().toISOString();
      group.status = "archived";
      group.archivedAt = timestamp;
      group.updatedAt = timestamp;
      this.save(group);
      return group;
    },

    rebuildIndex() {
      writeIndex();
    },

    cleanupTempFiles() {
      if (!fs.existsSync(groupsDir)) return;
      const cutoff = now().getTime() - TMP_MAX_AGE_MS;
      for (const entry of fs.readdirSync(groupsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const tmpDir = path.resolve(groupsDir, entry.name, ".tmp");
        if (!fs.existsSync(tmpDir)) continue;
        for (const tmpEntry of fs.readdirSync(tmpDir, {
          withFileTypes: true,
        })) {
          const tmpPath = path.resolve(tmpDir, tmpEntry.name);
          const stat = fs.statSync(tmpPath);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(tmpPath, { recursive: true, force: true });
          }
        }
      }
    },

    getTasksDir() {
      return tasksDir;
    },
  };
}

// ============================================================================
// 内部辅助函数
// ============================================================================

function validateTasks(tasks: unknown[], errors: string[]): void {
  const ids = new Set<string>();
  const idList: string[] = [];
  for (const rawTask of tasks) {
    if (!isRecord(rawTask)) {
      errors.push("each task must be an object");
      continue;
    }
    const id = rawTask["id"];
    if (typeof id !== "string" || !TASK_ID_REGEX.test(id)) {
      errors.push("task id has invalid format");
    } else {
      if (ids.has(id)) errors.push(`duplicate task id: ${id}`);
      ids.add(id);
      idList.push(id);
    }
    if (
      typeof rawTask["subject"] !== "string" ||
      rawTask["subject"].trim() === "" ||
      rawTask["subject"].includes("\n")
    ) {
      errors.push(`task ${String(id)} subject must be a non-empty single line`);
    }
    if (!VALID_TASK_STATUSES.has(String(rawTask["status"] ?? ""))) {
      errors.push(`task ${String(id)} status is invalid`);
    }
    if (
      typeof rawTask["owner"] !== "string" ||
      rawTask["owner"].trim() === ""
    ) {
      errors.push(`task ${String(id)} owner is required`);
    }
    if (!Array.isArray(rawTask["blockedBy"])) {
      errors.push(`task ${String(id)} blockedBy must be an array`);
    } else {
      for (const dep of rawTask["blockedBy"]) {
        if (typeof dep !== "string") {
          errors.push(`task ${String(id)} blockedBy must contain task ids`);
          break;
        }
      }
    }
  }

  for (const rawTask of tasks) {
    if (!isRecord(rawTask) || typeof rawTask["id"] !== "string") continue;
    const id = rawTask["id"];
    const blockedBy = Array.isArray(rawTask["blockedBy"])
      ? rawTask["blockedBy"]
      : [];
    for (const dep of blockedBy) {
      if (typeof dep !== "string") continue;
      if (dep === id) errors.push(`task ${id} cannot depend on itself`);
      if (!ids.has(dep))
        errors.push(`task ${id} depends on missing task ${dep}`);
    }
  }

  const cycle = findCycle(tasks, idList);
  if (cycle) errors.push(`dependency cycle detected: ${cycle.join(" -> ")}`);
}

function findCycle(tasks: unknown[], ids: string[]): string[] | null {
  const deps = new Map<string, string[]>();
  for (const rawTask of tasks) {
    if (!isRecord(rawTask) || typeof rawTask["id"] !== "string") continue;
    const blockedBy = Array.isArray(rawTask["blockedBy"])
      ? rawTask["blockedBy"].filter(
          (dep): dep is string => typeof dep === "string",
        )
      : [];
    deps.set(rawTask["id"], blockedBy);
  }

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  function visit(id: string): string[] | null {
    if (visiting.has(id)) {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    if (visited.has(id)) return null;

    visiting.add(id);
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      const cycle = visit(dep);
      if (cycle) return cycle;
    }
    stack.pop();
    visiting.delete(id);
    visited.add(id);
    return null;
  }

  for (const id of ids) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
