/**
 * schedule-store.ts — Schedule 持久化存储层
 *
 * 职责：负责 Schedule 的磁盘目录布局、JSON 读写、索引重建和读取校验。
 *
 * 设计边界：
 * - 本模块只处理文件和格式，不处理 LLM tool 参数。
 * - Schedule 的真实数据源是 `schedules/schedules/<schedule_id>/schedule.json`。
 * - `schedules/index.json` 是派生索引，可以随时从 schedule.json 重建。
 * - Reader 和 writer 使用同一套校验，避免写出自己读不了的数据。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Logger } from "./logger.js";
import { atomicWriteJsonFile } from "./atomic-write.js";

// ============================================================================
// 类型定义
// ============================================================================

export type ScheduleStatus = "active" | "completed" | "cancelled" | "archived";

export interface ScheduleIntent {
  prompt: string;
  summary?: string | undefined;
}

export type ScheduleTiming = OneTimeTiming | RecurringTiming;

export interface OneTimeTiming {
  type: "once";
  runAt: string;
}

export interface RecurringTiming {
  type: "recurring";
  startsAt: string;
  endsAt?: string | undefined;
  rule: RecurrenceRule;
}

export type RecurrenceRule =
  | EverySecondsRule
  | HourlyRule
  | DailyRule
  | WeeklyRule
  | MonthlyRule
  | YearlyRule;

export interface EverySecondsRule {
  kind: "every_seconds";
  intervalSeconds: number;
}

export interface HourlyRule {
  kind: "hourly";
  intervalHours: number;
  minute?: number | undefined;
  second?: number | undefined;
}

export interface DailyRule {
  kind: "daily";
  intervalDays: number;
  timeOfDay: string;
}

export interface WeeklyRule {
  kind: "weekly";
  intervalWeeks: number;
  daysOfWeek: Weekday[];
  timeOfDay: string;
}

export interface MonthlyRule {
  kind: "monthly";
  intervalMonths: number;
  dayOfMonth: number;
  timeOfDay: string;
}

export interface YearlyRule {
  kind: "yearly";
  intervalYears: number;
  month: number;
  dayOfMonth: number;
  timeOfDay: string;
}

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type OverlapPolicy = "allow" | "skip";

export type PermissionProfile = "readonly" | "ci" | "workspace_write";

export interface ScheduleResources {
  readPaths: string[];
  writePaths: string[];
}

export interface ScheduleExecution {
  mode: "async";
  executor: "subagent" | "command";
  command?: string | undefined;
  timeoutSeconds: number;
  overlapPolicy: OverlapPolicy;
  permissionProfile: PermissionProfile;
  resources: ScheduleResources;
}

export type LinkedTaskUpdatePolicy =
  | "never"
  | "append_note"
  | "mark_failed_on_failure";

export interface ScheduleOutputPolicy {
  saveRawOutput: boolean;
  notifyLlm: boolean;
  summaryPrompt?: string | undefined;
  linkedTaskUpdate: LinkedTaskUpdatePolicy;
}

export interface LinkedPersistentTask {
  groupId: string;
  taskId?: string | undefined;
}

export interface ScheduleFile {
  version: 1;
  kind: "schedule";
  id: string;
  title: string;
  description?: string | undefined;
  status: ScheduleStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | undefined;
  cancelledAt?: string | undefined;
  archivedAt?: string | undefined;

  projectRoot: string;
  cwd: string;
  timezone: string;

  intent: ScheduleIntent;
  timing: ScheduleTiming;
  execution: ScheduleExecution;
  outputPolicy: ScheduleOutputPolicy;
  linkedTask?: LinkedPersistentTask;

  lastEvaluatedAt?: string | undefined;
  lastScheduledAt?: string | undefined;
  nextRunAt?: string | undefined;
  triggeredCount: number;
  missedCount: number;
  skippedCount: number;
}

export type OccurrenceStatus =
  | "due"
  | "triggered"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "orphaned"
  | "missed"
  | "skipped_overlap";

export interface ScheduleOccurrenceFile {
  version: 1;
  kind: "schedule_occurrence";
  id: string;
  scheduleId: string;
  scheduledAt: string;
  status: OccurrenceStatus;
  createdAt: string;
  updatedAt: string;
  firedAt?: string | undefined;
  missedAt?: string | undefined;
  skippedAt?: string | undefined;
  completedAt?: string | undefined;
  asyncRunId?: string | undefined;
  outputId?: string | undefined;
  outputRef?: string | undefined;
  reason?: string | undefined;
  notificationDrainedAt?: string | undefined;
}

export interface ScheduleSummary {
  id: string;
  title: string;
  status: ScheduleStatus;
  executor: "subagent" | "command";
  nextRunAt?: string | undefined;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleListQuery {
  includeArchived?: boolean;
  includeCancelled?: boolean;
  currentProjectOnly?: boolean;
  projectRoot?: string;
}

export interface ScheduleIndexFile {
  version: 1;
  schedules: string[];
}

export interface ScheduleStore {
  scan(): ScheduleSummary[];
  list(query?: ScheduleListQuery): ScheduleSummary[];
  read(scheduleId: string): ScheduleFile | null;
  save(schedule: ScheduleFile): void;
  hardDelete(scheduleId: string): void;
  readOccurrence(scheduleId: string, occurrenceId: string): ScheduleOccurrenceFile | null;
  saveOccurrence(occurrence: ScheduleOccurrenceFile): void;
  listOccurrences(scheduleId: string, limit?: number): ScheduleOccurrenceFile[];
  rebuildIndex(): void;
  getSchedulesDir(): string;
}

// ============================================================================
// 常量
// ============================================================================

const SCHEDULE_ID_REGEX = /^sch_[0-9]{8}_[0-9]{6}_[a-z0-9_-]{1,48}$/;
const OCCURRENCE_ID_REGEX = /^occ_[0-9]{8}_[0-9]{6}(_[a-z0-9_-]{1,32})?$/;
const OUTPUT_ID_REGEX = /^out_[0-9]{8}_[0-9]{6}_[a-z0-9]{6}$/;

const VALID_SCHEDULE_STATUSES: ReadonlySet<string> = new Set([
  "active",
  "completed",
  "cancelled",
  "archived",
]);

const VALID_OCCURRENCE_STATUSES: ReadonlySet<string> = new Set([
  "due",
  "triggered",
  "running",
  "completed",
  "failed",
  "timeout",
  "orphaned",
  "missed",
  "skipped_overlap",
]);

const VALID_WEEKDAYS: ReadonlySet<string> = new Set([
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
]);

const VALID_PERMISSION_PROFILES: ReadonlySet<string> = new Set([
  "readonly",
  "ci",
  "workspace_write",
]);

const VALID_OVERLAP_POLICIES: ReadonlySet<string> = new Set(["allow", "skip"]);

const VALID_EXECUTORS: ReadonlySet<string> = new Set(["subagent", "command"]);

function isValidTimeZone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// 校验函数
// ============================================================================

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * validateScheduleFile — 读取和写入共用的完整校验
 *
 * 返回字符串数组而不是直接抛错，方便 reader 记录 warning 后跳过坏文件。
 */
export function validateScheduleFile(
  value: unknown,
  expectedScheduleId?: string,
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["Schedule must be an object"];

  if (value["version"] !== 1) errors.push("version must be 1");
  if (value["kind"] !== "schedule") errors.push('kind must be "schedule"');

  const id = value["id"];
  if (typeof id !== "string" || !SCHEDULE_ID_REGEX.test(id)) {
    errors.push("id has invalid format");
  }
  if (expectedScheduleId && id !== expectedScheduleId) {
    errors.push("directory id and content id do not match");
  }

  if (typeof value["title"] !== "string" || value["title"].trim() === "") {
    errors.push("title is required");
  }

  if (!VALID_SCHEDULE_STATUSES.has(String(value["status"] ?? ""))) {
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

  // projectRoot 必须是绝对路径
  const projectRoot = value["projectRoot"];
  if (typeof projectRoot !== "string" || !path.isAbsolute(projectRoot)) {
    errors.push("projectRoot must be an absolute path");
  }

  // cwd 必须是绝对路径且在 projectRoot 内
  const cwd = value["cwd"];
  if (typeof cwd !== "string" || !path.isAbsolute(cwd)) {
    errors.push("cwd must be an absolute path");
  } else if (typeof projectRoot === "string" && path.isAbsolute(projectRoot)) {
    const resolvedCwd = path.resolve(cwd);
    const resolvedRoot = path.resolve(projectRoot);
    if (
      resolvedCwd !== resolvedRoot &&
      !resolvedCwd.startsWith(resolvedRoot + path.sep)
    ) {
      errors.push("cwd must be within projectRoot");
    }
  }

  // timezone
  const timezone = value["timezone"];
  if (typeof timezone !== "string" || !isValidTimeZone(timezone)) {
    errors.push("timezone is invalid");
  }

  // intent
  const intent = value["intent"];
  if (!isRecord(intent)) {
    errors.push("intent must be an object");
  } else if (typeof intent["prompt"] !== "string" || intent["prompt"].trim() === "") {
    errors.push("intent.prompt is required");
  }

  // timing
  const timing = value["timing"];
  if (!isRecord(timing)) {
    errors.push("timing must be an object");
  } else {
    const timingType = timing["type"];
    if (timingType === "once") {
      if (typeof timing["runAt"] !== "string" || timing["runAt"].trim() === "") {
        errors.push("once timing requires runAt");
      }
    } else if (timingType === "recurring") {
      if (
        typeof timing["startsAt"] !== "string" ||
        timing["startsAt"].trim() === ""
      ) {
        errors.push("recurring timing requires startsAt");
      }
      const endsAt = timing["endsAt"];
      if (endsAt !== undefined) {
        if (typeof endsAt !== "string" || endsAt.trim() === "") {
          errors.push("endsAt must be a non-empty string");
        } else if (
          typeof timing["startsAt"] === "string" &&
          timing["startsAt"].trim() !== ""
        ) {
          if (new Date(endsAt).getTime() <= new Date(timing["startsAt"]).getTime()) {
            errors.push("endsAt must be later than startsAt");
          }
        }
      }
      const rule = timing["rule"];
      if (!isRecord(rule)) {
        errors.push("recurring timing requires rule");
      } else {
        errors.push(...validateRecurrenceRule(rule));
      }
    } else {
      errors.push('timing.type must be "once" or "recurring"');
    }
  }

  // execution
  const execution = value["execution"];
  if (!isRecord(execution)) {
    errors.push("execution must be an object");
  } else {
    if (execution["mode"] !== "async") {
      errors.push('execution.mode must be "async"');
    }
    const executor = execution["executor"];
    if (!VALID_EXECUTORS.has(String(executor ?? ""))) {
      errors.push('execution.executor must be "subagent" or "command"');
    }
    if (executor === "command" && (typeof execution["command"] !== "string" || execution["command"].trim() === "")) {
      errors.push("execution.command is required when executor is command");
    }
    if (
      typeof execution["timeoutSeconds"] !== "number" ||
      execution["timeoutSeconds"] <= 0
    ) {
      errors.push("execution.timeoutSeconds must be a positive number");
    }
    if (!VALID_OVERLAP_POLICIES.has(String(execution["overlapPolicy"] ?? ""))) {
      errors.push('execution.overlapPolicy must be "allow" or "skip"');
    }
    if (!VALID_PERMISSION_PROFILES.has(String(execution["permissionProfile"] ?? ""))) {
      errors.push("execution.permissionProfile is invalid");
    }
    const resources = execution["resources"];
    if (!isRecord(resources)) {
      errors.push("execution.resources must be an object");
    } else {
      if (!Array.isArray(resources["readPaths"])) {
        errors.push("execution.resources.readPaths must be an array");
      }
      if (!Array.isArray(resources["writePaths"])) {
        errors.push("execution.resources.writePaths must be an array");
      }
    }
  }

  // outputPolicy
  const outputPolicy = value["outputPolicy"];
  if (!isRecord(outputPolicy)) {
    errors.push("outputPolicy must be an object");
  } else {
    if (typeof outputPolicy["saveRawOutput"] !== "boolean") {
      errors.push("outputPolicy.saveRawOutput must be a boolean");
    }
    if (typeof outputPolicy["notifyLlm"] !== "boolean") {
      errors.push("outputPolicy.notifyLlm must be a boolean");
    }
    if (!VALID_LINKED_TASK_UPDATE_POLICIES.has(String(outputPolicy["linkedTaskUpdate"] ?? ""))) {
      errors.push("outputPolicy.linkedTaskUpdate is invalid");
    }
  }

  // linkedTask（可选）
  const linkedTask = value["linkedTask"];
  if (linkedTask !== undefined) {
    if (!isRecord(linkedTask)) {
      errors.push("linkedTask must be an object");
    } else {
      if (
        typeof linkedTask["groupId"] !== "string" ||
        linkedTask["groupId"].trim() === ""
      ) {
        errors.push("linkedTask.groupId is required");
      }
      if (
        linkedTask["taskId"] !== undefined &&
        (typeof linkedTask["taskId"] !== "string" || linkedTask["taskId"].trim() === "")
      ) {
        errors.push("linkedTask.taskId must be a non-empty string");
      }
    }
  }

  // counters
  if (typeof value["triggeredCount"] !== "number" || value["triggeredCount"] < 0) {
    errors.push("triggeredCount must be a non-negative number");
  }
  if (typeof value["missedCount"] !== "number" || value["missedCount"] < 0) {
    errors.push("missedCount must be a non-negative number");
  }
  if (typeof value["skippedCount"] !== "number" || value["skippedCount"] < 0) {
    errors.push("skippedCount must be a non-negative number");
  }

  return errors;
}

const VALID_LINKED_TASK_UPDATE_POLICIES: ReadonlySet<string> = new Set([
  "never",
  "append_note",
  "mark_failed_on_failure",
]);

function validateRecurrenceRule(rule: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const kind = rule["kind"];

  switch (kind) {
    case "every_seconds": {
      const interval = rule["intervalSeconds"];
      if (typeof interval !== "number" || interval <= 0 || !Number.isInteger(interval)) {
        errors.push("every_seconds.intervalSeconds must be a positive integer");
      }
      break;
    }
    case "hourly": {
      const interval = rule["intervalHours"];
      if (typeof interval !== "number" || interval <= 0 || !Number.isInteger(interval)) {
        errors.push("hourly.intervalHours must be a positive integer");
      }
      const minute = rule["minute"];
      if (minute !== undefined && (typeof minute !== "number" || minute < 0 || minute > 59)) {
        errors.push("hourly.minute must be between 0 and 59");
      }
      const second = rule["second"];
      if (second !== undefined && (typeof second !== "number" || second < 0 || second > 59)) {
        errors.push("hourly.second must be between 0 and 59");
      }
      break;
    }
    case "daily": {
      const interval = rule["intervalDays"];
      if (typeof interval !== "number" || interval <= 0 || !Number.isInteger(interval)) {
        errors.push("daily.intervalDays must be a positive integer");
      }
      if (typeof rule["timeOfDay"] !== "string" || !/^\d{2}:\d{2}:\d{2}$/.test(String(rule["timeOfDay"]))) {
        errors.push("daily.timeOfDay must be HH:mm:ss");
      }
      break;
    }
    case "weekly": {
      const interval = rule["intervalWeeks"];
      if (typeof interval !== "number" || interval <= 0 || !Number.isInteger(interval)) {
        errors.push("weekly.intervalWeeks must be a positive integer");
      }
      const daysOfWeek = rule["daysOfWeek"];
      if (!Array.isArray(daysOfWeek) || daysOfWeek.length === 0) {
        errors.push("weekly.daysOfWeek must be a non-empty array");
      } else {
        for (const day of daysOfWeek) {
          if (!VALID_WEEKDAYS.has(String(day))) {
            errors.push(`weekly.daysOfWeek contains invalid weekday: ${String(day)}`);
            break;
          }
        }
      }
      if (typeof rule["timeOfDay"] !== "string" || !/^\d{2}:\d{2}:\d{2}$/.test(String(rule["timeOfDay"]))) {
        errors.push("weekly.timeOfDay must be HH:mm:ss");
      }
      break;
    }
    case "monthly": {
      const interval = rule["intervalMonths"];
      if (typeof interval !== "number" || interval <= 0 || !Number.isInteger(interval)) {
        errors.push("monthly.intervalMonths must be a positive integer");
      }
      const dayOfMonth = rule["dayOfMonth"];
      if (typeof dayOfMonth !== "number" || dayOfMonth < 1 || dayOfMonth > 31) {
        errors.push("monthly.dayOfMonth must be between 1 and 31");
      }
      if (typeof rule["timeOfDay"] !== "string" || !/^\d{2}:\d{2}:\d{2}$/.test(String(rule["timeOfDay"]))) {
        errors.push("monthly.timeOfDay must be HH:mm:ss");
      }
      break;
    }
    case "yearly": {
      const interval = rule["intervalYears"];
      if (typeof interval !== "number" || interval <= 0 || !Number.isInteger(interval)) {
        errors.push("yearly.intervalYears must be a positive integer");
      }
      const month = rule["month"];
      if (typeof month !== "number" || month < 1 || month > 12) {
        errors.push("yearly.month must be between 1 and 12");
      }
      const dayOfMonth = rule["dayOfMonth"];
      if (typeof dayOfMonth !== "number" || dayOfMonth < 1 || dayOfMonth > 31) {
        errors.push("yearly.dayOfMonth must be between 1 and 31");
      }
      if (typeof rule["timeOfDay"] !== "string" || !/^\d{2}:\d{2}:\d{2}$/.test(String(rule["timeOfDay"]))) {
        errors.push("yearly.timeOfDay must be HH:mm:ss");
      }
      break;
    }
    default:
      errors.push(`unknown recurrence rule kind: ${String(kind)}`);
  }

  return errors;
}

/**
 * validateOccurrenceFile — occurrence 文件校验
 */
export function validateOccurrenceFile(
  value: unknown,
  expectedOccurrenceId?: string,
): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["Occurrence must be an object"];

  if (value["version"] !== 1) errors.push("version must be 1");
  if (value["kind"] !== "schedule_occurrence")
    errors.push('kind must be "schedule_occurrence"');

  const id = value["id"];
  if (typeof id !== "string" || !OCCURRENCE_ID_REGEX.test(id)) {
    errors.push("id has invalid format");
  }
  if (expectedOccurrenceId && id !== expectedOccurrenceId) {
    errors.push("filename id and content id do not match");
  }

  if (
    typeof value["scheduleId"] !== "string" ||
    !SCHEDULE_ID_REGEX.test(value["scheduleId"])
  ) {
    errors.push("scheduleId has invalid format");
  }

  if (typeof value["scheduledAt"] !== "string" || value["scheduledAt"].trim() === "") {
    errors.push("scheduledAt is required");
  }

  if (!VALID_OCCURRENCE_STATUSES.has(String(value["status"] ?? ""))) {
    errors.push("status is invalid");
  }

  if (
    value["outputId"] !== undefined &&
    (typeof value["outputId"] !== "string" ||
      !OUTPUT_ID_REGEX.test(value["outputId"]))
  ) {
    errors.push("outputId has invalid format");
  }

  for (const timeField of ["createdAt", "updatedAt"] as const) {
    if (
      typeof value[timeField] !== "string" ||
      value[timeField].trim() === ""
    ) {
      errors.push(`${timeField} is required`);
    }
  }

  return errors;
}

// ============================================================================
// 工厂函数
// ============================================================================

export function createScheduleStore(options: {
  schedulesDir: string;
  projectRoot: string;
  logger: Logger;
  now?: () => Date;
}): ScheduleStore {
  // 教学导读：
  // ScheduleStore 是 Schedule 系统的持久化层。
  // 它只负责保存 schedule.json、occurrence JSON 和 index.json；
  // 不负责判断“现在是否到点”，也不负责启动 Async Run。
  //
  // 物理布局：
  //   <schedulesDir>/schedules/<schedule_id>/schedule.json
  //   <schedulesDir>/schedules/<schedule_id>/occurrences/<occurrence_id>.json
  //   <schedulesDir>/index.json
  //
  // occurrence 单独成文件，是为了保留每次触发的审计轨迹。
  // 即使 schedule 后来被取消或完成，历史 occurrence 仍然可查询。

  const schedulesDir = path.resolve(options.schedulesDir);
  const schedulesSubDir = path.resolve(schedulesDir, "schedules");
  const indexPath = path.resolve(schedulesDir, "index.json");
  const currentProjectRoot = path.resolve(options.projectRoot);
  const logger = options.logger;

  // 内存缓存：scheduleId -> ScheduleFile
  // Store 的读写都围绕这份 Map 展开；磁盘是持久化来源，Map 是当前进程的查询缓存。
  // scan() 会重新从磁盘构建 Map，适合启动时或发现索引漂移时调用。
  const schedules = new Map<string, ScheduleFile>();

  function scheduleDir(scheduleId: string): string {
    // 每个 schedule 独占一个目录，方便把 schedule.json 和 occurrences/ 审计记录放在一起。
    return path.resolve(schedulesSubDir, scheduleId);
  }

  function schedulePath(scheduleId: string): string {
    return path.resolve(scheduleDir(scheduleId), "schedule.json");
  }

  function occurrencesDir(scheduleId: string): string {
    return path.resolve(scheduleDir(scheduleId), "occurrences");
  }

  function occurrencePath(scheduleId: string, occurrenceId: string): string {
    return path.resolve(occurrencesDir(scheduleId), `${occurrenceId}.json`);
  }

  function loadOne(scheduleId: string): ScheduleFile | null {
    // 目录名本身就是 schedule 的一部分身份。
    // 如果目录名不符合格式，直接跳过，避免读取任意文件路径。
    if (!SCHEDULE_ID_REGEX.test(scheduleId)) return null;
    const filePath = schedulePath(scheduleId);
    if (!fs.existsSync(filePath)) return null;

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
      // 读取时也传入 expectedId，让校验器确认“文件路径中的 id”和“JSON 内容中的 id”一致。
      const errors = validateScheduleFile(parsed, scheduleId);
      if (errors.length > 0) {
        logger.warn("Schedule %s skipped: %s", scheduleId, errors.join("; "));
        return null;
      }
      return parsed as ScheduleFile;
    } catch (error) {
      logger.warn("Schedule %s skipped: %s", scheduleId, String(error));
      return null;
    }
  }

  function loadOccurrence(
    scheduleId: string,
    occurrenceId: string,
  ): ScheduleOccurrenceFile | null {
    // occurrence 也是 append-only 审计记录的一部分，读取时宁可跳过坏文件，
    // 也不要因为单个损坏记录导致整个 ScheduleStore 不可用。
    if (!OCCURRENCE_ID_REGEX.test(occurrenceId)) return null;
    const filePath = occurrencePath(scheduleId, occurrenceId);
    if (!fs.existsSync(filePath)) return null;

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
      const errors = validateOccurrenceFile(parsed, occurrenceId);
      if (errors.length > 0) {
        logger.warn(
          "Occurrence %s/%s skipped: %s",
          scheduleId,
          occurrenceId,
          errors.join("; "),
        );
        return null;
      }
      return parsed as ScheduleOccurrenceFile;
    } catch (error) {
      logger.warn(
        "Occurrence %s/%s skipped: %s",
        scheduleId,
        occurrenceId,
        String(error),
      );
      return null;
    }
  }

  function writeIndex(): void {
    // index.json 是派生索引，不是事实来源。
    // 它可以随时从 schedules Map 或磁盘 schedule.json 重建，所以这里只存 id 列表。
    const allSchedules = [...schedules.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((s) => s.id);

    const index: ScheduleIndexFile = { version: 1, schedules: allSchedules };
    atomicWriteJsonFile(indexPath, index);
  }

  function assertValidForSave(schedule: ScheduleFile): void {
    const errors = validateScheduleFile(schedule, schedule.id);
    if (errors.length > 0) {
      throw new Error(`Invalid schedule "${schedule.id}": ${errors.join("; ")}`);
    }
  }

  function assertValidOccurrence(occurrence: ScheduleOccurrenceFile): void {
    const errors = validateOccurrenceFile(occurrence, occurrence.id);
    if (errors.length > 0) {
      throw new Error(
        `Invalid occurrence "${occurrence.id}": ${errors.join("; ")}`,
      );
    }
  }

  function createScheduleSummary(schedule: ScheduleFile): ScheduleSummary {
    return {
      id: schedule.id,
      title: schedule.title,
      status: schedule.status,
      executor: schedule.execution.executor,
      nextRunAt: schedule.nextRunAt,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
    };
  }

  return {
    scan() {
      // 启动扫描采用“能读多少读多少”的策略：
      // 坏 schedule 会被 warn 并跳过，合法 schedule 会进入内存缓存。
      schedules.clear();
      fs.mkdirSync(schedulesSubDir, { recursive: true });
      const entries = fs.readdirSync(schedulesSubDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const schedule = loadOne(entry.name);
        if (schedule) schedules.set(schedule.id, schedule);
      }
      writeIndex();
      return this.list({
        includeArchived: true,
        includeCancelled: true,
        currentProjectOnly: false,
      });
    },

    list(query = {}) {
      const includeArchived = query.includeArchived ?? false;
      const includeCancelled = query.includeCancelled ?? false;
      const currentProjectOnly = query.currentProjectOnly ?? true;
      // 默认只看当前 projectRoot，这是跨项目全局存储里的重要边界。
      // 只有调用方显式 currentProjectOnly=false 时，才会暴露其他项目的 schedule 摘要。
      const projectRootFilter =
        query.projectRoot !== undefined
          ? path.resolve(query.projectRoot)
          : currentProjectOnly
            ? currentProjectRoot
            : undefined;

      return [...schedules.values()]
        .filter((schedule) => {
          if (!includeArchived && schedule.status === "archived") return false;
          if (!includeCancelled && schedule.status === "cancelled") return false;
          if (
            projectRootFilter !== undefined &&
            path.resolve(schedule.projectRoot) !== projectRootFilter
          ) {
            return false;
          }
          return true;
        })
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(createScheduleSummary);
    },

    read(scheduleId) {
      if (!SCHEDULE_ID_REGEX.test(scheduleId)) return null;
      const cached = schedules.get(scheduleId);
      // 对外返回 clone，防止调用方修改缓存对象而绕过 save() 校验。
      if (cached) return cloneJson(cached);
      const loaded = loadOne(scheduleId);
      if (!loaded) return null;
      schedules.set(loaded.id, loaded);
      writeIndex();
      return cloneJson(loaded);
    },

    save(schedule) {
      // 写入前先做完整校验，让 writer 侧和 reader 侧规则对称。
      // 这样不会把 scan() 未来会拒绝的坏数据写到磁盘。
      assertValidForSave(schedule);
      const finalPath = schedulePath(schedule.id);

      atomicWriteJsonFile(finalPath, schedule);

      schedules.set(schedule.id, cloneJson(schedule));
      writeIndex();
    },

    hardDelete(scheduleId) {
      if (!SCHEDULE_ID_REGEX.test(scheduleId)) {
        throw new Error(`Invalid schedule id: ${scheduleId}`);
      }
      const dir = scheduleDir(scheduleId);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      schedules.delete(scheduleId);
      writeIndex();
    },

    readOccurrence(scheduleId, occurrenceId) {
      if (!SCHEDULE_ID_REGEX.test(scheduleId)) return null;
      return loadOccurrence(scheduleId, occurrenceId);
    },

    saveOccurrence(occurrence) {
      // occurrence 是执行审计，不进入 schedules Map；
      // 保存时仍要校验 id/status/timestamp 等字段，保证后续 listOccurrences 可安全读取。
      assertValidOccurrence(occurrence);
      const finalPath = occurrencePath(occurrence.scheduleId, occurrence.id);

      atomicWriteJsonFile(finalPath, occurrence);
    },

    listOccurrences(scheduleId, limit) {
      if (!SCHEDULE_ID_REGEX.test(scheduleId)) return [];
      const dir = occurrencesDir(scheduleId);
      if (!fs.existsSync(dir)) return [];

      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const occurrences: ScheduleOccurrenceFile[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const occurrenceId = entry.name.slice(0, -5);
        // 单个 occurrence 文件损坏时跳过，避免影响同一 schedule 的其他审计记录。
        const occ = loadOccurrence(scheduleId, occurrenceId);
        if (occ) occurrences.push(occ);
      }

      // 按 scheduledAt 倒序排列（最新的在前）
      occurrences.sort((a, b) => b.scheduledAt.localeCompare(a.scheduledAt));

      if (limit !== undefined && limit > 0) {
        return occurrences.slice(0, limit);
      }
      return occurrences;
    },

    rebuildIndex() {
      writeIndex();
    },

    getSchedulesDir() {
      return schedulesDir;
    },
  };
}
