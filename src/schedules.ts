/**
 * schedules.ts — Schedule 定时运行系统业务层
 *
 * 职责：在 ScheduleStore 之上实现调度逻辑、occurrence 管理、
 * Async Run 触发和通知队列。
 *
 * 核心设计：
 * - ScheduleManager.tick(now) 是可测试的核心调度逻辑
 * - Schedule 到点后创建 Async Run，不直接执行命令或运行 LLM
 * - occurrence 的 stable id 防止重复触发
 * - 启动时检测 missed occurrence，只记录最近一次，不补跑
 */

import * as path from "node:path";
import type { Logger } from "./logger.js";
import type {
  AsyncRunManager,
  AsyncRunRecord,
  StartAsyncRunInput,
} from "./async-runs.js";
import type { AsyncCommandPolicy } from "./tools/bash.js";
import type {
  ScheduleFile,
  ScheduleOccurrenceFile,
  ScheduleSummary,
  ScheduleStore,
  ScheduleListQuery,
  OccurrenceStatus,
  ScheduleTiming,
  RecurrenceRule,
  Weekday,
  EverySecondsRule,
  HourlyRule,
  DailyRule,
  WeeklyRule,
  MonthlyRule,
  YearlyRule,
} from "./schedule-store.js";

// ============================================================================
// 业务层类型定义
// ============================================================================

export interface CreateScheduleInput {
  title: string;
  description?: string;
  intent: {
    prompt: string;
    summary?: string;
  };
  timing: ScheduleTiming;
  execution: {
    mode: "async";
    executor: "subagent" | "command";
    command?: string;
    timeoutSeconds: number;
    overlapPolicy: "allow" | "skip";
    permissionProfile: "readonly" | "ci" | "workspace_write";
    resources: {
      readPaths: string[];
      writePaths: string[];
    };
  };
  outputPolicy: {
    saveRawOutput: boolean;
    notifyLlm: boolean;
    summaryPrompt?: string;
    linkedTaskUpdate: "never" | "append_note" | "mark_failed_on_failure";
  };
  linkedTask?: {
    groupId: string;
    taskId?: string;
  };
}

export type ScheduleView = ScheduleFile;

export interface ScheduleReadOptions {
  recentOccurrences?: number;
}

export interface ListOccurrencesInput {
  scheduleId: string;
  limit?: number;
}

export interface ScheduleNotification {
  id: string;
  scheduleId: string;
  occurrenceId: string;
  type: "triggered" | "skipped_overlap" | "missed" | "completed" | "failed" | "timeout" | "cancelled";
  message: string;
  timestamp: string;
  asyncRunId?: string;
  outputRef?: string;
}

export interface ScheduleManager {
  create(input: CreateScheduleInput): ScheduleView;
  list(query?: ScheduleListQuery): ScheduleSummary[];
  read(scheduleId: string, options?: ScheduleReadOptions): ScheduleView | null;
  cancel(scheduleId: string, reason?: string): ScheduleView;
  delete(scheduleId: string): void;
  listOccurrences(input: ListOccurrencesInput): ScheduleOccurrenceFile[];
  start(): void;
  stop(): void;
  tick(now?: Date): void;
  drainNotifications(): ScheduleNotification[];
}

// ============================================================================
// 常量
// ============================================================================

const TICK_INTERVAL_MS = 5000;

const WEEKDAY_INDEX: Record<Weekday, number> = {
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 0,
};

// ============================================================================
// ID 生成
// ============================================================================

function generateScheduleId(now: Date): string {
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const H = String(now.getHours()).padStart(2, "0");
  const M = String(now.getMinutes()).padStart(2, "0");
  const S = String(now.getSeconds()).padStart(2, "0");
  const randomSuffix = Math.random().toString(36).slice(2, 6);
  return `sch_${y}${m}${d}_${H}${M}${S}_${randomSuffix}`;
}

function generateOccurrenceId(scheduleId: string, scheduledAt: Date): string {
  const y = String(scheduledAt.getFullYear());
  const m = String(scheduledAt.getMonth() + 1).padStart(2, "0");
  const d = String(scheduledAt.getDate()).padStart(2, "0");
  const H = String(scheduledAt.getHours()).padStart(2, "0");
  const M = String(scheduledAt.getMinutes()).padStart(2, "0");
  const S = String(scheduledAt.getSeconds()).padStart(2, "0");
  const shortHash = scheduleId.slice(-4);
  return `occ_${y}${m}${d}_${H}${M}${S}_${shortHash}`;
}

// ============================================================================
// 时区辅助函数
// ============================================================================

interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getPartsInTimeZone(date: Date, timeZone: string): TimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    hour12: false,
  });
  const raw: Record<string, number> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      raw[part.type] = parseInt(part.value, 10);
    }
  }
  return {
    year: raw.year!,
    month: raw.month!,
    day: raw.day!,
    hour: raw.hour!,
    minute: raw.minute!,
    second: raw.second!,
  };
}

/**
 * localToUtc — 将指定时区的本地时间转换为 UTC Date
 *
 * 通过迭代修正，快速收敛到正确的 UTC 时间戳。
 */
function localToUtc(
  y: number,
  m: number,
  d: number,
  H: number,
  M: number,
  S: number,
  timeZone: string,
): Date {
  let t = Date.UTC(y, m - 1, d, H, M, S);
  for (let i = 0; i < 6; i++) {
    const parts = getPartsInTimeZone(new Date(t), timeZone);
    const dy = y - parts.year;
    const dm = m - parts.month;
    const dd = d - parts.day;
    const dH = H - parts.hour;
    const dM = M - parts.minute;
    const dS = S - parts.second;
    if (dy === 0 && dm === 0 && dd === 0 && dH === 0 && dM === 0 && dS === 0) {
      break;
    }
    // 粗略修正，通常 1-2 轮即可收敛
    t +=
      (dy * 365 + dm * 30 + dd) * 24 * 60 * 60 * 1000 +
      (dH * 60 * 60 + dM * 60 + dS) * 1000;
  }
  return new Date(t);
}

function parseTimeOfDay(timeOfDay: string): { hour: number; minute: number; second: number } {
  const [hour, minute, second] = timeOfDay.split(":").map((s) => parseInt(s, 10));
  return { hour: hour ?? 0, minute: minute ?? 0, second: second ?? 0 };
}

// ============================================================================
// nextRunAt 计算
// ============================================================================

/**
 * computeNextRunAt — 计算 schedule 的下一次触发时间
 *
 * @returns 下一次应触发的时间，或 null（已过期/无 future occurrence）
 */
export function computeNextRunAt(
  timing: ScheduleTiming,
  timeZone: string,
  after: Date,
): Date | null {
  if (timing.type === "once") {
    const runAt = new Date(timing.runAt);
    return runAt;
  }

  // recurring
  const startsAt = new Date(timing.startsAt);
  const endsAt = timing.endsAt ? new Date(timing.endsAt) : null;

  // 如果 endsAt 存在且 after 已超过 endsAt，则无 future occurrence
  if (endsAt !== null && after.getTime() >= endsAt.getTime()) {
    return null;
  }

  // 从 startsAt 开始，按规则逐步递增，找到第一个 > after 的时间
  let candidate: Date | null = startsAt;
  if (candidate.getTime() <= after.getTime()) {
    candidate = findNextOccurrence(timing.rule, timeZone, after, startsAt);
  }

  if (candidate === null) return null;
  if (endsAt !== null && candidate.getTime() >= endsAt.getTime()) {
    return null;
  }
  return candidate;
}

/**
 * findNextOccurrence — 从 startsAt 锚定，找到 after 之后的下一个符合 rule 的时间点
 */
function findNextOccurrence(
  rule: RecurrenceRule,
  timeZone: string,
  after: Date,
  startsAt: Date,
): Date | null {
  switch (rule.kind) {
    case "every_seconds":
      return findNextEverySeconds(rule as EverySecondsRule, after, startsAt);
    case "hourly":
      return findNextHourly(rule as HourlyRule, timeZone, after, startsAt);
    case "daily":
      return findNextDaily(rule as DailyRule, timeZone, after, startsAt);
    case "weekly":
      return findNextWeekly(rule as WeeklyRule, timeZone, after, startsAt);
    case "monthly":
      return findNextMonthly(rule as MonthlyRule, timeZone, after, startsAt);
    case "yearly":
      return findNextYearly(rule as YearlyRule, timeZone, after, startsAt);
    default:
      return null;
  }
}

function findNextEverySeconds(
  rule: EverySecondsRule,
  after: Date,
  startsAt: Date,
): Date | null {
  const intervalMs = rule.intervalSeconds * 1000;

  // 用算术直接跳到第一个 > after 的周期，避免线性循环
  const elapsed = after.getTime() - startsAt.getTime();
  const steps = Math.floor(elapsed / intervalMs) + 1;
  return new Date(startsAt.getTime() + steps * intervalMs);
}

function findNextHourly(
  rule: HourlyRule,
  timeZone: string,
  after: Date,
  startsAt: Date,
): Date | null {
  const minute = rule.minute ?? 0;
  const second = rule.second ?? 0;
  const parts = getPartsInTimeZone(startsAt, timeZone);

  // 从 startsAt 所在小时开始锚定
  let candidate = localToUtc(
    parts.year, parts.month, parts.day,
    parts.hour, minute, second,
    timeZone,
  );

  const intervalMs = rule.intervalHours * 60 * 60 * 1000;

  // 按周期推进到第一个 > after 的时间
  while (candidate.getTime() <= after.getTime()) {
    candidate = new Date(candidate.getTime() + intervalMs);
  }

  return candidate;
}

function findNextDaily(
  rule: DailyRule,
  timeZone: string,
  after: Date,
  startsAt: Date,
): Date | null {
  const { hour, minute, second } = parseTimeOfDay(rule.timeOfDay);
  const parts = getPartsInTimeZone(startsAt, timeZone);

  // 从 startsAt 当天开始锚定
  let candidate = localToUtc(
    parts.year, parts.month, parts.day,
    hour, minute, second,
    timeZone,
  );

  const intervalMs = rule.intervalDays * 24 * 60 * 60 * 1000;

  // 按周期推进到第一个 > after 的时间
  while (candidate.getTime() <= after.getTime()) {
    candidate = new Date(candidate.getTime() + intervalMs);
  }

  return candidate;
}

function findNextWeekly(
  rule: WeeklyRule,
  timeZone: string,
  after: Date,
  startsAt: Date,
): Date | null {
  const { hour, minute, second } = parseTimeOfDay(rule.timeOfDay);
  const targetDays = rule.daysOfWeek
    .map((d: Weekday) => WEEKDAY_INDEX[d])
    .sort((a: number, b: number) => a - b);

  if (targetDays.length === 0) return null;

  // 从 startsAt 开始搜索，最多搜索 2 年
  let search = new Date(startsAt.getTime());
  const maxSearchDays = 365 * 2;

  for (let dayOffset = 0; dayOffset < maxSearchDays; dayOffset++) {
    const parts = getPartsInTimeZone(search, timeZone);
    const candidate = localToUtc(
      parts.year, parts.month, parts.day,
      hour, minute, second,
      timeZone,
    );

    // 检查 candidate 是否落在正确的星期几（使用目标时区）
    const localDay = (() => {
      const d = new Date(candidate.getTime());
      const f = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" });
      const wd = f.formatToParts(d).find((p) => p.type === "weekday")!.value;
      const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      return map[wd] ?? 0;
    })();

    if (targetDays.includes(localDay as 0 | 1 | 2 | 3 | 4 | 5 | 6)) {
      // 计算从 startsAt 到 candidate 经过了多少个 7 天周期
      const daysDiff = Math.floor(
        (candidate.getTime() - startsAt.getTime()) / (24 * 60 * 60 * 1000),
      );
      const weekIndex = Math.floor(daysDiff / 7);
      if (weekIndex % rule.intervalWeeks === 0) {
        if (candidate.getTime() > after.getTime()) {
          return candidate;
        }
      }
    }
    search = new Date(search.getTime() + 24 * 60 * 60 * 1000);
  }

  return null;
}

function findNextMonthly(
  rule: MonthlyRule,
  timeZone: string,
  after: Date,
  startsAt: Date,
): Date | null {
  const { hour, minute, second } = parseTimeOfDay(rule.timeOfDay);
  const parts = getPartsInTimeZone(startsAt, timeZone);

  let year = parts.year;
  let month = parts.month;

  // 从 startsAt 的月份开始，每次增加 intervalMonths
  for (let i = 0; i < 120; i++) {
    const day = Math.min(rule.dayOfMonth, daysInMonth(year, month));
    const candidate = localToUtc(year, month, day, hour, minute, second, timeZone);

    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }

    month += rule.intervalMonths;
    while (month > 12) {
      month -= 12;
      year++;
    }
  }

  return null;
}

function findNextYearly(
  rule: YearlyRule,
  timeZone: string,
  after: Date,
  startsAt: Date,
): Date | null {
  const { hour, minute, second } = parseTimeOfDay(rule.timeOfDay);
  const parts = getPartsInTimeZone(startsAt, timeZone);

  let year = parts.year;

  // 从 startsAt 的年份开始，每次增加 intervalYears
  for (let i = 0; i < 50; i++) {
    const day = Math.min(rule.dayOfMonth, daysInMonth(year, rule.month));
    const candidate = localToUtc(year, rule.month, day, hour, minute, second, timeZone);

    if (candidate.getTime() > after.getTime()) {
      return candidate;
    }

    year += rule.intervalYears;
  }

  return null;
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

// ============================================================================
// ScheduleManager 工厂函数
// ============================================================================

export function createScheduleManager(deps: {
  store: ScheduleStore;
  asyncRunManager: Pick<AsyncRunManager, "start" | "setOnFinish">;
  projectRoot: string;
  logger: Logger;
  now?: () => Date;
  commandPolicy?: AsyncCommandPolicy;
}): ScheduleManager {
  const { store, asyncRunManager, projectRoot, logger, commandPolicy } = deps;
  const now = deps.now ?? (() => new Date());

  // 注册 async run 完成回调
  asyncRunManager.setOnFinish?.(onAsyncRunFinish);

  // 内存中缓存 active schedules（由 scan/tick 维护）
  let activeSchedules: ScheduleFile[] = [];
  // 通知队列
  const notificationQueue: ScheduleNotification[] = [];
  // timer handle
  let timer: ReturnType<typeof setInterval> | null = null;
  // 跟踪正在 running 的 occurrence，用于 overlap 检测
  const runningOccurrences = new Map<string, Set<string>>(); // scheduleId -> Set<occurrenceId>

  // -------------------------------------------------------------------------
  // 初始化扫描
  // -------------------------------------------------------------------------

  function reloadActiveSchedules(): void {
    store.scan();
    activeSchedules = store
      .list({ includeArchived: false, includeCancelled: false })
      .map((summary) => store.read(summary.id))
      .filter((s): s is ScheduleFile => s !== null);

    // 先检查 missed occurrences（使用 persisted 的 nextRunAt）
    checkMissedOccurrences();

    // 再重新计算每个 active schedule 的 nextRunAt
    for (const schedule of activeSchedules) {
      if (schedule.status !== "active") continue;
      const nextRunAt = computeNextRunAt(schedule.timing, schedule.timezone, now());
      if (nextRunAt) {
        schedule.nextRunAt = nextRunAt.toISOString();
      } else {
        // 没有 future occurrence，自动标记为 completed
        schedule.status = "completed";
        schedule.completedAt = now().toISOString();
        (schedule as { nextRunAt?: string | undefined }).nextRunAt = undefined;
      }
      schedule.lastEvaluatedAt = now().toISOString();
      store.save(schedule);
    }
  }

  function checkMissedOccurrences(): void {
    const currentNow = now();
    for (const schedule of activeSchedules) {
      if (schedule.status !== "active") continue;
        // 找到 lastScheduledAt 之后、currentNow 之前是否有 missed occurrence
      // 简化：如果 nextRunAt 存在但已经过期，说明 missed 了
      if (schedule.nextRunAt) {
        const nextRun = new Date(schedule.nextRunAt);
        if (nextRun.getTime() <= currentNow.getTime()) {
          // 这是一个 missed occurrence
          const occurrenceId = generateOccurrenceId(schedule.id, nextRun);
          const existingOcc = store.readOccurrence(schedule.id, occurrenceId);
          if (!existingOcc) {
            // 创建 missed occurrence
            const missedOcc: ScheduleOccurrenceFile = {
              version: 1,
              kind: "schedule_occurrence",
              id: occurrenceId,
              scheduleId: schedule.id,
              scheduledAt: nextRun.toISOString(),
              status: "missed",
              createdAt: currentNow.toISOString(),
              updatedAt: currentNow.toISOString(),
              missedAt: currentNow.toISOString(),
            };
            store.saveOccurrence(missedOcc);

            schedule.missedCount++;
            schedule.lastScheduledAt = nextRun.toISOString();
            // 重新计算 nextRunAt
            const next = computeNextRunAt(schedule.timing, schedule.timezone, currentNow);
            if (next) {
        schedule.nextRunAt = next.toISOString();
      } else {
        schedule.nextRunAt = undefined;
      }
            store.save(schedule);

            if (schedule.outputPolicy.notifyLlm) {
              enqueueNotification({
                id: `missed_${schedule.id}_${occurrenceId}_${currentNow.getTime()}`,
                scheduleId: schedule.id,
                occurrenceId,
                type: "missed",
                message: `Schedule "${schedule.title}" missed occurrence ${occurrenceId} scheduled at ${nextRun.toISOString()} while the agent process was offline. The missed occurrence was not backfilled.`,
                timestamp: currentNow.toISOString(),
              });
            }
          }
        }
      }
    }
  }

  // -------------------------------------------------------------------------
  // tick — 核心调度逻辑
  // -------------------------------------------------------------------------

  function tick(inputNow?: Date): void {
    const currentNow = inputNow ?? now();

    for (const schedule of activeSchedules) {
      if (schedule.status !== "active") continue;

      const nextRunAt = schedule.nextRunAt ? new Date(schedule.nextRunAt) : null;
      if (!nextRunAt || nextRunAt.getTime() > currentNow.getTime()) {
        continue; // 还没到时间
      }

      const occurrenceId = generateOccurrenceId(schedule.id, nextRunAt);

      // 检查 occurrence 是否已存在（防重复）
      const existingOcc = store.readOccurrence(schedule.id, occurrenceId);
      if (existingOcc) {
        // 已经处理过，只需更新 nextRunAt 并继续
        advanceSchedule(schedule, currentNow);
        continue;
      }

      // overlap 检测
      const running = runningOccurrences.get(schedule.id) ?? new Set();
      if (schedule.execution.overlapPolicy === "skip" && running.size > 0) {
        // 创建 skipped_overlap occurrence
        const skippedOcc: ScheduleOccurrenceFile = {
          version: 1,
          kind: "schedule_occurrence",
          id: occurrenceId,
          scheduleId: schedule.id,
          scheduledAt: nextRunAt.toISOString(),
          status: "skipped_overlap",
          createdAt: currentNow.toISOString(),
          updatedAt: currentNow.toISOString(),
          skippedAt: currentNow.toISOString(),
          reason: "Skipped because another occurrence is still running",
        };
        store.saveOccurrence(skippedOcc);

        schedule.skippedCount++;
        schedule.lastScheduledAt = nextRunAt.toISOString();
        advanceSchedule(schedule, currentNow);

        if (schedule.outputPolicy.notifyLlm) {
          enqueueNotification({
            id: `skip_${schedule.id}_${occurrenceId}_${currentNow.getTime()}`,
            scheduleId: schedule.id,
            occurrenceId,
            type: "skipped_overlap",
            message: `Schedule "${schedule.title}" skipped occurrence ${occurrenceId} because another occurrence is still running (overlapPolicy=skip).`,
            timestamp: currentNow.toISOString(),
          });
        }
        continue;
      }

      // 创建 triggered occurrence
      const triggeredOcc: ScheduleOccurrenceFile = {
        version: 1,
        kind: "schedule_occurrence",
        id: occurrenceId,
        scheduleId: schedule.id,
        scheduledAt: nextRunAt.toISOString(),
        status: "triggered",
        createdAt: currentNow.toISOString(),
        updatedAt: currentNow.toISOString(),
        firedAt: currentNow.toISOString(),
      };
      store.saveOccurrence(triggeredOcc);

      // command executor 必须经过 commandPolicy 预检
      if (
        schedule.execution.executor === "command" &&
        schedule.execution.command &&
        commandPolicy
      ) {
        const validation = commandPolicy.validate(schedule.execution.command);
        if (!validation.allowed) {
          triggeredOcc.status = "failed";
          triggeredOcc.reason = validation.reason;
          triggeredOcc.updatedAt = currentNow.toISOString();
          store.saveOccurrence(triggeredOcc);

          schedule.lastScheduledAt = nextRunAt.toISOString();
          advanceSchedule(schedule, currentNow);

          if (schedule.outputPolicy.notifyLlm) {
            enqueueNotification({
              id: `fail_policy_${schedule.id}_${occurrenceId}_${currentNow.getTime()}`,
              scheduleId: schedule.id,
              occurrenceId,
              type: "failed",
              message: `Schedule "${schedule.title}" failed to trigger occurrence ${occurrenceId}: command policy rejected: ${validation.reason}`,
              timestamp: currentNow.toISOString(),
            });
          }
          continue;
        }
      }

      // 启动 Async Run
      const asyncRunInput: StartAsyncRunInput = {
        title: schedule.title,
        executor: schedule.execution.executor,
        resources: {
          read_paths: schedule.execution.resources.readPaths,
          write_paths: schedule.execution.resources.writePaths,
        },
        timeoutMs: schedule.execution.timeoutSeconds * 1000,
        trigger: {
          kind: "schedule",
          scheduleId: schedule.id,
          occurrenceId,
          firedAt: currentNow.toISOString(),
        },
      };
      if (schedule.execution.command) {
        ((asyncRunInput as unknown) as Record<string, unknown>).command = schedule.execution.command;
      }
      if (schedule.execution.executor === "subagent") {
        ((asyncRunInput as unknown) as Record<string, unknown>).prompt = buildSubagentPrompt(schedule, occurrenceId, nextRunAt);
      }

      try {
        const record = asyncRunManager.start(asyncRunInput);

        // 更新 occurrence 为 running
        triggeredOcc.status = "running";
        triggeredOcc.asyncRunId = record.id;
        triggeredOcc.updatedAt = currentNow.toISOString();
        store.saveOccurrence(triggeredOcc);

        // 跟踪 running occurrence
        if (!runningOccurrences.has(schedule.id)) {
          runningOccurrences.set(schedule.id, new Set());
        }
        runningOccurrences.get(schedule.id)!.add(occurrenceId);

        schedule.triggeredCount++;
        schedule.lastScheduledAt = nextRunAt.toISOString();
        advanceSchedule(schedule, currentNow);

        if (schedule.outputPolicy.notifyLlm) {
          enqueueNotification({
            id: `trigger_${schedule.id}_${occurrenceId}_${currentNow.getTime()}`,
            scheduleId: schedule.id,
            occurrenceId,
            type: "triggered",
            message: `Schedule "${schedule.title}" triggered occurrence ${occurrenceId} at ${currentNow.toISOString()}. Async run: ${record.id}. Intent: ${schedule.intent.prompt.slice(0, 120)}`,
            timestamp: currentNow.toISOString(),
            asyncRunId: record.id,
          });
        }
      } catch (err) {
        // Async Run 启动失败
        triggeredOcc.status = "failed";
        triggeredOcc.reason = err instanceof Error ? err.message : String(err);
        triggeredOcc.updatedAt = currentNow.toISOString();
        store.saveOccurrence(triggeredOcc);

        schedule.lastScheduledAt = nextRunAt.toISOString();
        advanceSchedule(schedule, currentNow);

        if (schedule.outputPolicy.notifyLlm) {
          enqueueNotification({
            id: `fail_${schedule.id}_${occurrenceId}_${currentNow.getTime()}`,
            scheduleId: schedule.id,
            occurrenceId,
            type: "failed",
            message: `Schedule "${schedule.title}" failed to trigger occurrence ${occurrenceId}: ${triggeredOcc.reason}`,
            timestamp: currentNow.toISOString(),
          });
        }
      }
    }
  }

  function advanceSchedule(schedule: ScheduleFile, currentNow: Date): void {
    // 一次性 schedule 触发后直接标记为 completed
    if (schedule.timing.type === "once") {
      schedule.status = "completed";
      schedule.completedAt = currentNow.toISOString();
      schedule.nextRunAt = undefined;
      schedule.lastEvaluatedAt = currentNow.toISOString();
      store.save(schedule);
      return;
    }

    const next = computeNextRunAt(schedule.timing, schedule.timezone, currentNow);
    if (next) {
      schedule.nextRunAt = next.toISOString();
    } else {
      schedule.status = "completed";
      schedule.completedAt = currentNow.toISOString();
      schedule.nextRunAt = undefined;
    }
    schedule.lastEvaluatedAt = currentNow.toISOString();
    store.save(schedule);
  }

  function buildSubagentPrompt(
    schedule: ScheduleFile,
    occurrenceId: string,
    scheduledAt: Date,
  ): string {
    const lines: string[] = [
      "<schedule-context>",
      `Schedule ID: ${schedule.id}`,
      `Occurrence ID: ${occurrenceId}`,
      `Scheduled at: ${scheduledAt.toISOString()}`,
      `Intent: ${schedule.intent.prompt}`,
    ];
    if (schedule.outputPolicy.summaryPrompt) {
      lines.push(`Output policy: ${schedule.outputPolicy.summaryPrompt}`);
    }
    lines.push(`Permission profile: ${schedule.execution.permissionProfile}`);
    if (schedule.linkedTask) {
      lines.push(`Linked persistent task: groupId=${schedule.linkedTask.groupId}${schedule.linkedTask.taskId ? `, taskId=${schedule.linkedTask.taskId}` : ""}`);
    }
    lines.push("</schedule-context>");
    lines.push("");
    lines.push("This run was triggered by a persisted schedule.");
    lines.push("Follow the schedule intent and output policy.");
    lines.push("Do not update the persistent Task Group directly unless the parent Agent later chooses to do so through task tools.");
    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Async Run 完成回调
  // -------------------------------------------------------------------------

  function onAsyncRunFinish(record: AsyncRunRecord): void {
    if (record.trigger.kind !== "schedule") return;
    const { scheduleId, occurrenceId } = record.trigger;
    if (!scheduleId || !occurrenceId) return;

    const occurrence = store.readOccurrence(scheduleId, occurrenceId);
    if (!occurrence) return;

    const currentNow = now();
    let nextStatus: OccurrenceStatus;
    if (record.status === "completed") {
      nextStatus = "completed";
    } else if (record.status === "timeout") {
      nextStatus = "timeout";
    } else {
      nextStatus = "failed";
    }

    occurrence.status = nextStatus;
    occurrence.completedAt = currentNow.toISOString();
    if (record.outputPath) {
      occurrence.outputRef = record.outputPath;
    } else {
      occurrence.outputRef = undefined;
    }
    occurrence.updatedAt = currentNow.toISOString();
    store.saveOccurrence(occurrence);

    // 从 running set 中移除
    runningOccurrences.get(scheduleId)?.delete(occurrenceId);

    const schedule = store.read(scheduleId);
    if (schedule && schedule.outputPolicy.notifyLlm) {
      const notif: ScheduleNotification = {
        id: `finish_${scheduleId}_${occurrenceId}_${currentNow.getTime()}`,
        scheduleId,
        occurrenceId,
        type: nextStatus === "completed" ? "completed" : nextStatus === "timeout" ? "timeout" : "failed",
        message: `Schedule "${schedule.title}" completed occurrence ${occurrenceId}. Async run: ${record.id}. Status: ${record.status}. Output: use run_async_output_read with run_id ${record.id}.`,
        timestamp: currentNow.toISOString(),
        asyncRunId: record.id,
      };
      if (record.outputPath) {
        notif.outputRef = record.outputPath;
      }
      enqueueNotification(notif);
    }
  }

  // -------------------------------------------------------------------------
  // 通知队列
  // -------------------------------------------------------------------------

  function enqueueNotification(notification: ScheduleNotification): void {
    notificationQueue.push(notification);
  }

  function drainNotifications(): ScheduleNotification[] {
    const result = notificationQueue.slice();
    notificationQueue.length = 0;
    return result;
  }

  // -------------------------------------------------------------------------
  // CRUD 操作
  // -------------------------------------------------------------------------

  function create(input: CreateScheduleInput): ScheduleView {
    const currentNow = now();
    const id = generateScheduleId(currentNow);

    const schedule: ScheduleFile = {
      version: 1,
      kind: "schedule",
      id,
      title: input.title,
      status: "active",
      createdAt: currentNow.toISOString(),
      updatedAt: currentNow.toISOString(),
      projectRoot,
      cwd: path.resolve(projectRoot, input.execution.resources.readPaths[0] ?? "."),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      intent: input.intent,
      timing: input.timing,
      execution: {
        mode: "async",
        executor: input.execution.executor,
        timeoutSeconds: input.execution.timeoutSeconds,
        overlapPolicy: input.execution.overlapPolicy,
        permissionProfile: input.execution.permissionProfile,
        resources: {
          readPaths: [...input.execution.resources.readPaths],
          writePaths: [...input.execution.resources.writePaths],
        },
      },
      outputPolicy: {
        saveRawOutput: input.outputPolicy.saveRawOutput,
        notifyLlm: input.outputPolicy.notifyLlm,
        linkedTaskUpdate: input.outputPolicy.linkedTaskUpdate,
      },
      triggeredCount: 0,
      missedCount: 0,
      skippedCount: 0,
    };
    if (input.description !== undefined) {
      schedule.description = input.description;
    }
    if (input.execution.command !== undefined) {
      schedule.execution.command = input.execution.command;
    }
    if (input.outputPolicy.summaryPrompt !== undefined) {
      schedule.outputPolicy.summaryPrompt = input.outputPolicy.summaryPrompt;
    }
    if (input.linkedTask !== undefined) {
      schedule.linkedTask = input.linkedTask;
    }

    // 计算初始 nextRunAt
    const nextRunAt = computeNextRunAt(schedule.timing, schedule.timezone, currentNow);
    if (nextRunAt) {
      schedule.nextRunAt = nextRunAt.toISOString();
    }

    store.save(schedule);
    activeSchedules.push(schedule);

    logger.info("Schedule created: %s (%s)", id, schedule.title);
    return schedule;
  }

  function list(query?: ScheduleListQuery): ScheduleSummary[] {
    return store.list(query);
  }

  function read(scheduleId: string, options?: ScheduleReadOptions): ScheduleView | null {
    const schedule = store.read(scheduleId);
    if (!schedule) return null;

    if (options?.recentOccurrences !== undefined && options.recentOccurrences > 0) {
      // occurrence 不嵌入 ScheduleView，调用方通过 listOccurrences 获取
    }
    return schedule;
  }

  function cancel(scheduleId: string, reason?: string): ScheduleView {
    const schedule = store.read(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    if (schedule.status === "cancelled") {
      return schedule;
    }

    const currentNow = now();
    schedule.status = "cancelled";
    schedule.cancelledAt = currentNow.toISOString();
    schedule.updatedAt = currentNow.toISOString();
    schedule.nextRunAt = undefined;
    store.save(schedule);

    // 从 active schedules 中移除
    activeSchedules = activeSchedules.filter((s) => s.id !== scheduleId);

    if (schedule.outputPolicy.notifyLlm) {
      enqueueNotification({
        id: `cancel_${scheduleId}_${currentNow.getTime()}`,
        scheduleId,
        occurrenceId: "none",
        type: "cancelled",
        message: `Schedule "${schedule.title}" was cancelled.${reason ? ` Reason: ${reason}` : ""}`,
        timestamp: currentNow.toISOString(),
      });
    }

    logger.info("Schedule cancelled: %s", scheduleId);
    return schedule;
  }

  function deleteSchedule(scheduleId: string): void {
    const schedule = store.read(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }

    const occurrences = store.listOccurrences(scheduleId);
    if (occurrences.length > 0 || schedule.triggeredCount > 0) {
      throw new Error(
        `Schedule "${scheduleId}" has already been triggered or has occurrences. Use cancel instead of delete.`,
      );
    }

    store.hardDelete(scheduleId);
    activeSchedules = activeSchedules.filter((s) => s.id !== scheduleId);
    logger.info("Schedule deleted: %s", scheduleId);
  }

  function listOccurrences(input: ListOccurrencesInput): ScheduleOccurrenceFile[] {
    return store.listOccurrences(input.scheduleId, input.limit);
  }

  // -------------------------------------------------------------------------
  // timer 管理
  // -------------------------------------------------------------------------

  function start(): void {
    if (timer !== null) return;
    reloadActiveSchedules();
    timer = setInterval(() => tick(), TICK_INTERVAL_MS);
    logger.info("Schedule manager started (tick every %dms)", TICK_INTERVAL_MS);
  }

  function stop(): void {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
      logger.info("Schedule manager stopped");
    }
  }

  // -------------------------------------------------------------------------
  // 返回接口
  // -------------------------------------------------------------------------

  return {
    create,
    list,
    read,
    cancel,
    delete: deleteSchedule,
    listOccurrences,
    start,
    stop,
    tick,
    drainNotifications,
    // 暴露内部回调供 AsyncRunManager 注册
    _onAsyncRunFinish: onAsyncRunFinish,
  } as ScheduleManager & { _onAsyncRunFinish: (record: AsyncRunRecord) => void };
}
