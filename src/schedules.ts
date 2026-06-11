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
import {
  createExecutionPolicy,
  type AsyncCommandPolicy,
  type ExecutionPolicy,
} from "./execution-policy.js";
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
  type:
    | "triggered"
    | "skipped_overlap"
    | "missed"
    | "orphaned"
    | "completed"
    | "failed"
    | "timeout"
    | "cancelled";
  message: string;
  timestamp: string;
  asyncRunId?: string;
  outputId?: string;
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
  // Intl.DateTimeFormat 是本教学项目选择的“轻依赖”方案：
  // 不引入 luxon/date-fns-tz 等库，也能把同一个 UTC instant 转成目标时区下的年月日时分秒。
  //
  // 注意这里不是格式化给用户看，而是为了后续计算本地日历规则：
  // daily/weekly/monthly/yearly 这类规则是“当地时间”的概念，
  // 不能只用 UTC 日期做加减，否则跨时区和 DST 时会偏移。
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
  // 这是本文件最容易踩坑的地方之一：
  // JS Date 本身只表示 UTC timestamp，没有“某时区本地时间”这个值类型。
  // 我们想表达的是“在 timeZone 这个地区，y-m-d H:M:S 对应哪个 UTC timestamp”。
  //
  // 简化做法是先用 Date.UTC 猜一个 timestamp，再反复查看这个 timestamp
  // 在目标 timeZone 下显示成什么本地时间，然后按差值修正。
  //
  // corner case：
  // - DST 跳时：某些本地时间不存在，迭代可能只能收敛到最接近的可表示时间。
  // - DST 重复小时：同一个本地时间可能对应两个 UTC instant，本实现不做 disambiguation。
  // - 教学取舍：不用复杂库，保留可读算法；生产系统建议使用成熟时区库并显式定义 DST 策略。
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

function parseTimeOfDay(timeOfDay: string): {
  hour: number;
  minute: number;
  second: number;
} {
  // timeOfDay 来自已通过 ScheduleStore 校验的规则，正常应是 HH:mm:ss。
  // 这里仍然给缺失字段默认 0，是为了让计算函数保持宽容；
  // 严格格式错误应该在 validateRecurrenceRule 阶段被拦住。
  const [hour, minute, second] = timeOfDay
    .split(":")
    .map((s) => parseInt(s, 10));
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
  // 设计注意点：
  // computeNextRunAt 是纯计算函数，不读写 store，也不创建 occurrence。
  // 这让时间规则可以被单元测试独立覆盖，不依赖 AsyncRunManager 或文件系统。
  //
  // 语义约定：返回“严格大于 after”的下一次时间。
  // 如果 nextRunAt 正好等于 after，说明这一刻已经到点或已被处理，
  // 下一次应继续往后找，避免重复触发同一个 occurrence。
  if (timing.type === "once") {
    const runAt = new Date(timing.runAt);
    // once 规则不在这里判断 runAt 是否已经过去。
    // Manager 会根据 nextRunAt <= now 决定触发；触发后 advanceSchedule 标记 completed。
    return runAt;
  }

  // recurring
  const startsAt = new Date(timing.startsAt);
  const endsAt = timing.endsAt ? new Date(timing.endsAt) : null;

  // 如果 endsAt 存在且 after 已超过 endsAt，则无 future occurrence
  // endsAt 是排他边界：candidate >= endsAt 都不再触发。
  // 这种约定比“包含 endsAt”更容易避免边界时间重复运行。
  if (endsAt !== null && after.getTime() >= endsAt.getTime()) {
    return null;
  }

  // 从 startsAt 开始，按规则逐步递增，找到第一个 > after 的时间
  // startsAt 是所有 recurring 规则的锚点。
  // 常见错误是从 after 所在时间直接套规则，这会让 intervalDays/intervalWeeks
  // 这类“每 N 个周期”失去原始相位。
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
  // every_seconds 是唯一可以安全用 UTC 毫秒差直接计算的规则：
  // 它表达的是固定秒数间隔，不是本地日历时间。
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
  // hourly 的语义是“从 startsAt 所在本地小时开始，每 N 小时一次，
  // 并使用 rule.minute/rule.second 指定小时内的位置”。
  //
  // 注意：这里后续用固定毫秒 interval 推进，意味着 DST 切换附近会按绝对时间推进。
  // 这是教学实现的简化；如果要严格表达“当地墙上时间每 N 小时”，需要更复杂的时区规则。
  const minute = rule.minute ?? 0;
  const second = rule.second ?? 0;
  const parts = getPartsInTimeZone(startsAt, timeZone);

  // 从 startsAt 所在小时开始锚定
  let candidate = localToUtc(
    parts.year,
    parts.month,
    parts.day,
    parts.hour,
    minute,
    second,
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
  // daily/monthly/yearly 属于“日历规则”，不是简单秒数规则。
  // 当前 daily 使用 intervalDays * 24h 推进，代码简单，但 DST 切换日可能导致本地时间偏移。
  // 这是一个值得学生记住的坑：日历周期和绝对时长不是同一个概念。
  const { hour, minute, second } = parseTimeOfDay(rule.timeOfDay);
  const parts = getPartsInTimeZone(startsAt, timeZone);

  // 从 startsAt 当天开始锚定
  let candidate = localToUtc(
    parts.year,
    parts.month,
    parts.day,
    hour,
    minute,
    second,
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
  // weekly 是本文件最复杂的规则：
  // - 一周内可以有多个目标 weekday
  // - 还要支持 intervalWeeks（每 N 周）
  // - weekday 判断必须基于目标 timeZone 的本地日期
  //
  // 本实现采用有限搜索而不是复杂公式：
  // 从 startsAt 开始最多搜索 2 年，每天构造候选本地时间。
  // 对教学项目来说，可读性优先；生产系统可以用更高效但更难读的日历算法。
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
      parts.year,
      parts.month,
      parts.day,
      hour,
      minute,
      second,
      timeZone,
    );

    // 检查 candidate 是否落在正确的星期几（使用目标时区）
    const localDay = (() => {
      const d = new Date(candidate.getTime());
      const f = new Intl.DateTimeFormat("en-US", {
        timeZone,
        weekday: "short",
      });
      const wd = f.formatToParts(d).find((p) => p.type === "weekday")!.value;
      const map: Record<string, number> = {
        Sun: 0,
        Mon: 1,
        Tue: 2,
        Wed: 3,
        Thu: 4,
        Fri: 5,
        Sat: 6,
      };
      return map[wd] ?? 0;
    })();

    if (targetDays.includes(localDay as 0 | 1 | 2 | 3 | 4 | 5 | 6)) {
      // 计算从 startsAt 到 candidate 经过了多少个 7 天周期
      // 注意这里用 candidate 与 startsAt 的 UTC 毫秒差近似周数。
      // DST 周附近可能存在 23/25 小时日造成边界偏差，这是轻量实现的已知取舍。
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
  // monthly 的典型 corner case 是“每月 31 号”。
  // 不是每个月都有 31 号，所以这里用 Math.min(dayOfMonth, daysInMonth)
  // 把 31 号收敛到当月最后一天。这个策略要写进代码，否则不同读者会猜测：
  // 是跳过短月份？还是报错？还是用月底？
  const { hour, minute, second } = parseTimeOfDay(rule.timeOfDay);
  const parts = getPartsInTimeZone(startsAt, timeZone);

  let year = parts.year;
  let month = parts.month;

  // 从 startsAt 的月份开始，每次增加 intervalMonths
  // 设置 120 次上限是防御性边界：避免坏规则导致无限循环。
  // 120 个月约等于 10 年，足够教学场景使用。
  for (let i = 0; i < 120; i++) {
    const day = Math.min(rule.dayOfMonth, daysInMonth(year, month));
    const candidate = localToUtc(
      year,
      month,
      day,
      hour,
      minute,
      second,
      timeZone,
    );

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
  // yearly 同样要处理 2 月 29 日这类不存在日期。
  // 当前策略和 monthly 一致：收敛到目标月份最后一天。
  // 这是一种明确的业务选择，不是“日期库自动行为”。
  const { hour, minute, second } = parseTimeOfDay(rule.timeOfDay);
  const parts = getPartsInTimeZone(startsAt, timeZone);

  let year = parts.year;

  // 从 startsAt 的年份开始，每次增加 intervalYears
  // 50 次上限避免无限循环，也提醒学生：任何规则搜索都应该有停止条件。
  for (let i = 0; i < 50; i++) {
    const day = Math.min(rule.dayOfMonth, daysInMonth(year, rule.month));
    const candidate = localToUtc(
      year,
      rule.month,
      day,
      hour,
      minute,
      second,
      timeZone,
    );

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
  executionPolicy?: ExecutionPolicy;
  commandPolicy?: AsyncCommandPolicy;
}): ScheduleManager {
  // 教学导读：
  // ScheduleManager 是“时间触发器”，不是“执行器”。
  // 它只负责判断某个 schedule 是否到点、创建 occurrence 审计记录、
  // 然后把真正执行交给 AsyncRunManager。
  //
  // 这样设计可以避免两套执行生命周期：
  // - Async Run 管 running/completed/failed/timeout
  // - Schedule 管 active/cancelled/completed 和 occurrence 审计
  //
  // 学生读这段代码时，可以把它想成一个小型调度循环：
  // scan/reload -> 计算 nextRunAt -> tick 到点 -> 创建 occurrence -> start async run -> finish callback 写回终态

  const { store, asyncRunManager, projectRoot, logger } = deps;
  const now = deps.now ?? (() => new Date());
  const currentProjectRoot = path.resolve(projectRoot);
  const executionPolicy = deps.executionPolicy ?? createExecutionPolicy();

  // 注册 async run 完成回调
  // Schedule 自己不执行任务，它只负责“到点触发”；
  // 真实执行生命周期交给 AsyncRunManager，完成后再通过这个回调写回 occurrence。
  asyncRunManager.setOnFinish?.(onAsyncRunFinish);

  // 内存中缓存 active schedules（由 scan/tick 维护）
  // 只缓存当前项目的 active schedule，跨项目 schedule 不会被当前 manager 触发。
  let activeSchedules: ScheduleFile[] = [];
  // 通知队列
  // 与 async run 通知一样，schedule 通知先排队，再由 agent.ts 注入给 LLM。
  const notificationQueue: ScheduleNotification[] = [];
  // timer handle
  let timer: ReturnType<typeof setInterval> | null = null;
  // 跟踪正在 running 的 occurrence，用于 overlap 检测
  const runningOccurrences = new Map<string, Set<string>>(); // scheduleId -> Set<occurrenceId>

  // -------------------------------------------------------------------------
  // 初始化扫描
  // -------------------------------------------------------------------------

  function reloadActiveSchedules(): void {
    // 每次重载都先让 store 从磁盘重建缓存。
    // 这样即使 index.json 是旧的，也能以 schedule.json 为事实来源恢复。
    store.scan();
    activeSchedules = store
      .list({
        includeArchived: false,
        includeCancelled: false,
        projectRoot: currentProjectRoot,
      })
      .map((summary) => store.read(summary.id))
      .filter(
        (s): s is ScheduleFile => s !== null && isCurrentProjectSchedule(s),
      );

    // 先收敛上个进程遗留的 running occurrence，再检查 missed occurrences。
    // 顺序很重要：running 代表“上个进程已触发但没等到结果”，
    // missed 代表“到点时进程不在线所以根本没触发”。
    reconcileOrphanedOccurrences();
    checkMissedOccurrences();

    // 再重新计算每个 active schedule 的 nextRunAt
    for (const schedule of activeSchedules) {
      if (schedule.status !== "active") continue;
      const nextRunAt = computeNextRunAt(
        schedule.timing,
        schedule.timezone,
        now(),
      );
      if (nextRunAt) {
        schedule.nextRunAt = nextRunAt.toISOString();
      } else {
        // 没有 future occurrence，自动标记为 completed
        // 这让 once 或有限规则在没有下一次运行时自然退出 active 集合。
        schedule.status = "completed";
        schedule.completedAt = now().toISOString();
        (schedule as { nextRunAt?: string | undefined }).nextRunAt = undefined;
      }
      schedule.lastEvaluatedAt = now().toISOString();
      store.save(schedule);
    }
  }

  function isCurrentProjectSchedule(schedule: ScheduleFile): boolean {
    return path.resolve(schedule.projectRoot) === currentProjectRoot;
  }

  function assertCurrentProjectSchedule(
    schedule: ScheduleFile,
    scheduleId: string,
  ): void {
    if (!isCurrentProjectSchedule(schedule)) {
      throw new Error(`Schedule not found in current project: ${scheduleId}`);
    }
  }

  function reconcileOrphanedOccurrences(): void {
    const currentNow = now();
    for (const schedule of activeSchedules) {
      const occurrences = store.listOccurrences(schedule.id);
      for (const occurrence of occurrences) {
        if (occurrence.status !== "running") continue;

        // Async Run 当前是 session-local，重启后无法恢复旧 run。
        // 因此 persisted running occurrence 在新进程启动时必须收敛为 orphaned，
        // 避免 UI/LLM 永远以为它仍在执行。
        occurrence.status = "orphaned";
        occurrence.completedAt = currentNow.toISOString();
        occurrence.updatedAt = currentNow.toISOString();
        occurrence.reason =
          "Async run was session-local and the agent process restarted before completion";
        store.saveOccurrence(occurrence);

        runningOccurrences.get(schedule.id)?.delete(occurrence.id);

        if (schedule.outputPolicy.notifyLlm) {
          const notification: ScheduleNotification = {
            id: `orphaned_${schedule.id}_${occurrence.id}_${currentNow.getTime()}`,
            scheduleId: schedule.id,
            occurrenceId: occurrence.id,
            type: "orphaned",
            message: `Schedule "${schedule.title}" occurrence ${occurrence.id} was marked orphaned because its async run was session-local and the agent process restarted before completion.`,
            timestamp: currentNow.toISOString(),
          };
          if (occurrence.asyncRunId !== undefined) {
            notification.asyncRunId = occurrence.asyncRunId;
          }
          enqueueNotification(notification);
        }
      }
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
            // 当前教学实现不回补 missed run，只记录审计并推进到未来下一次。
            const next = computeNextRunAt(
              schedule.timing,
              schedule.timezone,
              currentNow,
            );
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

      const nextRunAt = schedule.nextRunAt
        ? new Date(schedule.nextRunAt)
        : null;
      if (!nextRunAt || nextRunAt.getTime() > currentNow.getTime()) {
        continue; // 还没到时间
      }

      const occurrenceId = generateOccurrenceId(schedule.id, nextRunAt);

      // 检查 occurrence 是否已存在（防重复）
      // tick 可能被定时器和测试手动调用多次；同一个 scheduledAt 只能产生一个 occurrence。
      const existingOcc = store.readOccurrence(schedule.id, occurrenceId);
      if (existingOcc) {
        // 已经处理过，只需更新 nextRunAt 并继续
        advanceSchedule(schedule, currentNow);
        continue;
      }

      // overlap 检测
      // overlapPolicy=skip 只看当前进程内 runningOccurrences。
      // 重启遗留的 running 会在 reload 阶段先变成 orphaned，不参与这里的 overlap。
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
      // 先写 triggered，再启动 Async Run。
      // 如果 start() 抛错，catch 分支会把同一个 occurrence 更新成 failed，保留完整审计链。
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
      // Schedule 是持久化对象，可能由旧版本或手工编辑留下不再安全的 command。
      // 因此即使 create 时校验过，触发时也必须再校验一次。
      if (
        schedule.execution.executor === "command" &&
        schedule.execution.command
      ) {
        const validation = executionPolicy.validateCommand({
          command: schedule.execution.command,
          profile: schedule.execution.permissionProfile,
        });
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
      // Schedule 只把触发上下文转成 Async Run input。
      // occurrenceId 会进入 trigger，方便 onAsyncRunFinish 找回对应 occurrence。
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
        (asyncRunInput as unknown as Record<string, unknown>).command =
          schedule.execution.command;
      }
      if (schedule.execution.executor === "subagent") {
        (asyncRunInput as unknown as Record<string, unknown>).prompt =
          buildSubagentPrompt(schedule, occurrenceId, nextRunAt);
      }

      try {
        const record = asyncRunManager.start(asyncRunInput);

        // 更新 occurrence 为 running
        // 只有 Async Run 成功返回 run_id 后，occurrence 才进入 running。
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

    const next = computeNextRunAt(
      schedule.timing,
      schedule.timezone,
      currentNow,
    );
    // 递归规则每次触发后都从 currentNow 往未来找下一次。
    // 这样不会因为进程暂停很久而尝试补跑历史所有 occurrence。
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
      // 子智能体拿到的是普通 prompt，而不是新的 system prompt。
      // 这保持父/子 stable prompt 前缀一致，同时把动态 schedule 信息放进用户消息。
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
      lines.push(
        `Linked persistent task: groupId=${schedule.linkedTask.groupId}${schedule.linkedTask.taskId ? `, taskId=${schedule.linkedTask.taskId}` : ""}`,
      );
    }
    lines.push("</schedule-context>");
    lines.push("");
    lines.push("This run was triggered by a persisted schedule.");
    lines.push("Follow the schedule intent and output policy.");
    lines.push(
      "Do not update the persistent Task Group directly unless the parent Agent later chooses to do so through task tools.",
    );
    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Async Run 完成回调
  // -------------------------------------------------------------------------

  function onAsyncRunFinish(record: AsyncRunRecord): void {
    // AsyncRunManager 会通知所有完成的 run；这里只处理由 schedule 触发的 run。
    if (record.trigger.kind !== "schedule") return;
    const { scheduleId, occurrenceId } = record.trigger;
    if (!scheduleId || !occurrenceId) return;

    const schedule = store.read(scheduleId);
    // 当前项目 manager 不能写其他项目的 occurrence。
    // 即使全局 store 能读到，也要在业务层再次收窄。
    if (!schedule || !isCurrentProjectSchedule(schedule)) return;

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

    // completion callback 是 occurrence 审计从 running 进入终态的唯一正常路径。
    // outputId/outputRef 都在这里落盘，后续工具展示和 LLM notification 才能引用完整输出。
    occurrence.status = nextStatus;
    occurrence.completedAt = currentNow.toISOString();
    if (record.outputId) {
      occurrence.outputId = record.outputId;
    } else {
      occurrence.outputId = undefined;
    }
    if (record.outputPath) {
      occurrence.outputRef = record.outputPath;
    } else {
      occurrence.outputRef = undefined;
    }
    occurrence.updatedAt = currentNow.toISOString();
    store.saveOccurrence(occurrence);

    // 从 running set 中移除
    runningOccurrences.get(scheduleId)?.delete(occurrenceId);

    if (schedule.outputPolicy.notifyLlm) {
      const outputHint = record.outputId
        ? `use run_output_read with output_id ${record.outputId}`
        : `use run_async_output_read with run_id ${record.id}`;
      const notif: ScheduleNotification = {
        id: `finish_${scheduleId}_${occurrenceId}_${currentNow.getTime()}`,
        scheduleId,
        occurrenceId,
        type:
          nextStatus === "completed"
            ? "completed"
            : nextStatus === "timeout"
              ? "timeout"
              : "failed",
        message: `Schedule "${schedule.title}" completed occurrence ${occurrenceId}. Async run: ${record.id}. Status: ${record.status}. Output: ${outputHint}.`,
        timestamp: currentNow.toISOString(),
        asyncRunId: record.id,
      };
      if (record.outputId) {
        notif.outputId = record.outputId;
      }
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
    // 返回当前队列快照并清空。
    // 新通知会留到下一轮 LLM 调用前再注入，避免重复提醒。
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
      cwd: path.resolve(
        projectRoot,
        input.execution.resources.readPaths[0] ?? ".",
      ),
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

    const resourceValidation = executionPolicy.validateResources({
      projectRoot,
      readPaths: schedule.execution.resources.readPaths,
      writePaths: schedule.execution.resources.writePaths,
      profile: schedule.execution.permissionProfile,
    });
    if (!resourceValidation.allowed) {
      throw new Error(
        resourceValidation.reason ?? "Invalid schedule resources",
      );
    }

    // 计算初始 nextRunAt
    const nextRunAt = computeNextRunAt(
      schedule.timing,
      schedule.timezone,
      currentNow,
    );
    if (nextRunAt) {
      schedule.nextRunAt = nextRunAt.toISOString();
    }

    store.save(schedule);
    activeSchedules.push(schedule);

    logger.info("Schedule created: %s (%s)", id, schedule.title);
    return schedule;
  }

  function list(query?: ScheduleListQuery): ScheduleSummary[] {
    if (query?.currentProjectOnly === false) {
      return store.list({ ...query, currentProjectOnly: false });
    }
    return store.list({
      ...query,
      projectRoot: currentProjectRoot,
      currentProjectOnly: true,
    });
  }

  function read(
    scheduleId: string,
    options?: ScheduleReadOptions,
  ): ScheduleView | null {
    const schedule = store.read(scheduleId);
    if (!schedule) return null;
    if (!isCurrentProjectSchedule(schedule)) return null;

    if (
      options?.recentOccurrences !== undefined &&
      options.recentOccurrences > 0
    ) {
      // occurrence 不嵌入 ScheduleView，调用方通过 listOccurrences 获取
    }
    return schedule;
  }

  function cancel(scheduleId: string, reason?: string): ScheduleView {
    const schedule = store.read(scheduleId);
    if (!schedule) {
      throw new Error(`Schedule not found: ${scheduleId}`);
    }
    assertCurrentProjectSchedule(schedule, scheduleId);
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
    assertCurrentProjectSchedule(schedule, scheduleId);

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

  function listOccurrences(
    input: ListOccurrencesInput,
  ): ScheduleOccurrenceFile[] {
    const schedule = store.read(input.scheduleId);
    if (!schedule || !isCurrentProjectSchedule(schedule)) return [];
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
  };
}
