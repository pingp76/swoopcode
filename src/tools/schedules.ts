/**
 * tools/schedules.ts — Schedule 工具提供者
 *
 * 职责：定义 6 个 schedule 工具，让 LLM 可以创建、查询和管理定时规则。
 *
 * 六个工具：
 * - run_schedule_create: 创建一次性或重复 schedule
 * - run_schedule_list: 列出 schedule 摘要
 * - run_schedule_read: 读取 schedule 详情和最近 occurrences
 * - run_schedule_cancel: 取消已创建 schedule
 * - run_schedule_delete: 删除从未执行过的 schedule
 * - run_schedule_occurrence_list: 列出某 schedule 的 occurrence 历史
 *
 * 设计要点：
 * - 工具返回 JSON 格式的结构化数据
 * - schedule_id 是唯一身份，避免与 task_id / run_id 混淆
 * - 参数校验严格，错误直接返回 error
 * - 工具描述明确区分 Schedule / Task / Async Run / TODO
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolResult } from "./types.js";
import type {
  ScheduleManager,
  CreateScheduleInput,
} from "../schedules.js";

/**
 * ScheduleToolProvider — schedule 工具提供者接口
 */
export interface ScheduleToolProvider {
  toolEntries: Array<{
    definition: ChatCompletionTool;
    execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  }>;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const runScheduleCreateDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_schedule_create",
    description:
      "Create a one-time or recurring schedule. " +
      "Schedules are durable time-based triggers that automatically start Async Runs at the scheduled time. " +
      "Use schedules for periodic tasks (e.g., 'run CI every night') or one-time reminders. " +
      "Do NOT use schedules for long-term work tracking — use Task Groups for that. " +
      "Do NOT use schedules for temporary session steps — use TODO lists for that.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Short descriptive title for the schedule",
        },
        description: {
          type: "string",
          description: "Optional longer description",
        },
        intent: {
          type: "object",
          description: "The user's intent and summary for this schedule",
          properties: {
            prompt: {
              type: "string",
              description:
                "Core user intent passed to the executor when triggered. " +
                "For subagent executor, this is the task prompt. " +
                "Be specific about what to do and what NOT to do.",
            },
            summary: {
              type: "string",
              description: "Short summary for listing and notifications",
            },
          },
          required: ["prompt"],
        },
        timing: {
          type: "object",
          description: "When and how often to trigger",
          properties: {
            type: {
              type: "string",
              enum: ["once", "recurring"],
              description: "'once' for single trigger, 'recurring' for repeated triggers",
            },
            run_at: {
              type: "string",
              description: "ISO 8601 timestamp for one-time schedules (required when type='once')",
            },
            starts_at: {
              type: "string",
              description: "ISO 8601 timestamp for recurring schedules start time",
            },
            ends_at: {
              type: "string",
              description: "Optional ISO 8601 timestamp for recurring schedules end time",
            },
            rule: {
              type: "object",
              description: "Recurrence rule (required when type='recurring')",
              properties: {
                kind: {
                  type: "string",
                  enum: [
                    "every_seconds",
                    "hourly",
                    "daily",
                    "weekly",
                    "monthly",
                    "yearly",
                  ],
                  description: "Recurrence kind",
                },
                interval_seconds: { type: "number" },
                interval_hours: { type: "number" },
                interval_days: { type: "number" },
                interval_weeks: { type: "number" },
                interval_months: { type: "number" },
                interval_years: { type: "number" },
                minute: { type: "number" },
                second: { type: "number" },
                time_of_day: {
                  type: "string",
                  description: "HH:mm:ss format",
                },
                days_of_week: {
                  type: "array",
                  items: {
                    type: "string",
                    enum: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"],
                  },
                },
                day_of_month: { type: "number" },
                month: { type: "number" },
              },
              required: ["kind"],
            },
          },
          required: ["type"],
        },
        execution: {
          type: "object",
          description: "How to execute when triggered",
          properties: {
            executor: {
              type: "string",
              enum: ["subagent", "command"],
              description:
                "'subagent' for adaptive AI execution (recommended for goals/intents). " +
                "'command' for predictable shell commands.",
            },
            command: {
              type: "string",
              description: "Shell command (required when executor='command')",
            },
            timeout_seconds: {
              type: "number",
              description: "Timeout in seconds (default 300, max 300)",
              default: 300,
            },
            overlap_policy: {
              type: "string",
              enum: ["allow", "skip"],
              description:
                "'allow' permits parallel occurrences. 'skip' skips new triggers while one is running.",
              default: "skip",
            },
            permission_profile: {
              type: "string",
              enum: ["readonly"],
              description:
                "Permission boundary. The current implementation exposes only 'readonly'; broader profiles are reserved for a later ExecutionPolicy lesson.",
              default: "readonly",
            },
            resources: {
              type: "object",
              properties: {
                read_paths: {
                  type: "array",
                  items: { type: "string" },
                  default: ["."],
                },
                write_paths: {
                  type: "array",
                  items: { type: "string" },
                  default: [],
                },
              },
              required: ["read_paths", "write_paths"],
            },
          },
          required: ["executor", "resources"],
        },
        output_policy: {
          type: "object",
          description:
            "What to do with the output after execution. Raw-output suppression and linked Task updates are reserved for a later lesson and are not configurable in the current implementation.",
          properties: {
            notify_llm: {
              type: "boolean",
              default: true,
            },
            summary_prompt: {
              type: "string",
              description: "Optional prompt for summarizing results",
            },
          },
        },
      },
      required: ["title", "intent", "timing", "execution"],
    },
  },
};

const runScheduleListDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_schedule_list",
    description:
      "List schedules. Default shows active and completed schedules for the current project only. Set current_project_only=false only when the user explicitly asks for a cross-project summary.",
    parameters: {
      type: "object",
      properties: {
        include_archived: {
          type: "boolean",
          description: "Include archived schedules (default false)",
          default: false,
        },
        include_cancelled: {
          type: "boolean",
          description: "Include cancelled schedules (default false)",
          default: false,
        },
        current_project_only: {
          type: "boolean",
          description:
            "When true or omitted, list only schedules for the current project. Set false for an explicit cross-project summary.",
          default: true,
        },
      },
    },
  },
};

const runScheduleReadDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_schedule_read",
    description: "Read a schedule by ID, including its details and recent occurrences.",
    parameters: {
      type: "object",
      properties: {
        schedule_id: {
          type: "string",
          description: "The schedule ID",
        },
        recent_occurrences: {
          type: "number",
          description: "Number of recent occurrences to include (default 5)",
          default: 5,
        },
      },
      required: ["schedule_id"],
    },
  },
};

const runScheduleCancelDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_schedule_cancel",
    description: "Cancel a schedule. Cancelled schedules no longer produce future occurrences.",
    parameters: {
      type: "object",
      properties: {
        schedule_id: {
          type: "string",
          description: "The schedule ID to cancel",
        },
        reason: {
          type: "string",
          description: "Optional reason for cancellation",
        },
      },
      required: ["schedule_id"],
    },
  },
};

const runScheduleDeleteDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_schedule_delete",
    description:
      "Delete a schedule that has NEVER been triggered. " +
      "If the schedule has occurrences or has been triggered, use run_schedule_cancel instead.",
    parameters: {
      type: "object",
      properties: {
        schedule_id: {
          type: "string",
          description: "The schedule ID to delete",
        },
      },
      required: ["schedule_id"],
    },
  },
};

const runScheduleOccurrenceListDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_schedule_occurrence_list",
    description: "List occurrence history for a schedule.",
    parameters: {
      type: "object",
      properties: {
        schedule_id: {
          type: "string",
          description: "The schedule ID",
        },
        limit: {
          type: "number",
          description: "Maximum number of occurrences to return (default 20)",
          default: 20,
        },
      },
      required: ["schedule_id"],
    },
  },
};

// ---------------------------------------------------------------------------
// 格式化辅助函数
// ---------------------------------------------------------------------------

function formatScheduleView(
  schedule: import("../schedules.js").ScheduleView,
  occurrences: import("../schedule-store.js").ScheduleOccurrenceFile[],
): string {
  // 将 schedule 详情和最近 occurrences 组装为结构化对象，再序列化为 JSON 字符串
  return JSON.stringify(
    {
      type: "schedule",
      schedule_id: schedule.id,
      title: schedule.title,
      description: schedule.description ?? null,
      status: schedule.status,
      executor: schedule.execution.executor,
      next_run_at: schedule.nextRunAt ?? null,
      timing: schedule.timing,
      intent: schedule.intent,
      output_policy: schedule.outputPolicy,
      triggered_count: schedule.triggeredCount,
      missed_count: schedule.missedCount,
      skipped_count: schedule.skippedCount,
      // 将每个 occurrence 映射为轻量级摘要对象，减少返回体积
      recent_occurrences: occurrences.map((o) => ({
        occurrence_id: o.id,
        status: o.status,
        scheduled_at: o.scheduledAt,
        async_run_id: o.asyncRunId ?? null,
        output_id: o.outputId ?? null,
        output_ref: o.outputRef ?? null,
      })),
    },
    null,
    2,
  );
}

function formatScheduleList(
  schedules: import("../schedule-store.js").ScheduleSummary[],
): string {
  // 将 schedule 列表摘要序列化为 JSON，只保留核心字段供 LLM 快速浏览
  return JSON.stringify(
    {
      type: "schedule_list",
      count: schedules.length,
      schedules: schedules.map((s) => ({
        schedule_id: s.id,
        title: s.title,
        status: s.status,
        executor: s.executor,
        next_run_at: s.nextRunAt ?? null,
      })),
    },
    null,
    2,
  );
}

function formatOccurrenceList(
  occurrences: import("../schedule-store.js").ScheduleOccurrenceFile[],
): string {
  // 将 occurrence 历史列表序列化为 JSON，包含执行状态和关联输出信息
  return JSON.stringify(
    {
      type: "occurrence_list",
      count: occurrences.length,
      occurrences: occurrences.map((o) => ({
        occurrence_id: o.id,
        status: o.status,
        scheduled_at: o.scheduledAt,
        fired_at: o.firedAt ?? null,
        completed_at: o.completedAt ?? null,
        async_run_id: o.asyncRunId ?? null,
        output_id: o.outputId ?? null,
        output_ref: o.outputRef ?? null,
        reason: o.reason ?? null,
      })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// 参数解析辅助
// ---------------------------------------------------------------------------

function parseTiming(args: Record<string, unknown>): ScheduleTimingInput {
  // 教学导读：
  // tool schema 中的 timing 是一个带 type 的嵌套对象。
  // 解析时先看 type，再按不同 type 读取不同字段，这是处理 tagged union 的常见方式。
  // 这样比“把所有可能字段都读出来再猜”更清晰，也能给出更准确的错误信息。

  // 从参数中提取 timing 对象，校验其类型必须为 object 且不能是数组
  const timing = args["timing"];
  if (!timing || typeof timing !== "object" || Array.isArray(timing)) {
    throw new Error("timing must be an object");
  }
  const t = timing as Record<string, unknown>;
  // 校验 timing.type 只能是 once 或 recurring
  const type = String(t["type"] ?? "");
  if (type !== "once" && type !== "recurring") {
    throw new Error('timing.type must be "once" or "recurring"');
  }

  // 一次性 schedule：必须提供 run_at 字段
  if (type === "once") {
    // once schedule 只运行一次。
    // schedules.ts 触发它之后会把状态推进到 completed，不再计算下一次 nextRunAt。
    const runAt = String(t["run_at"] ?? "");
    if (!runAt) throw new Error("timing.run_at is required for once schedules");
    return { type: "once", runAt };
  }

  // 重复性 schedule：必须提供 starts_at，ends_at 为可选
  // starts_at 是重复规则的锚点：hourly/daily/weekly 等规则都从这个时间往未来推。
  const startsAt = String(t["starts_at"] ?? "");
  if (!startsAt) throw new Error("timing.starts_at is required for recurring schedules");
  const endsAt = t["ends_at"] ? String(t["ends_at"]) : undefined;

  // 重复性 schedule 必须携带 rule 对象，用于描述重复规则
  // rule 里也有自己的 kind 字段，决定是 every_seconds、daily、weekly 等哪种规则。
  const ruleRaw = t["rule"];
  if (!ruleRaw || typeof ruleRaw !== "object" || Array.isArray(ruleRaw)) {
    throw new Error("timing.rule is required for recurring schedules");
  }
  const r = ruleRaw as Record<string, unknown>;
  const kind = String(r["kind"] ?? "");

  // 根据 kind 分支解析具体的重复规则字段
  const rule = parseRecurrenceRule(kind, r);

  // 组装重复性 timing 结果，仅在 endsAt 存在时加入该字段
  const result: ScheduleTimingInput = { type: "recurring", startsAt, rule };
  if (endsAt !== undefined) {
    (result as Record<string, unknown>).endsAt = endsAt;
  }
  return result;
}

function parseRecurrenceRule(kind: string, r: Record<string, unknown>): import("../schedule-store.js").RecurrenceRule {
  // 每种 recurrence rule 都返回一个带 kind 的对象。
  // 这种结构的好处是：后续 computeNextRunAt 只需要 switch(rule.kind)，
  // 就能获得 TypeScript 的类型缩窄和清晰的规则分支。

  // 根据 kind 的不同，分别提取并组装对应的重复规则对象
  switch (kind) {
    case "every_seconds":
      return {
        kind: "every_seconds",
        intervalSeconds: Number(r["interval_seconds"] ?? 60),
      };
    case "hourly":
      return {
        kind: "hourly",
        intervalHours: Number(r["interval_hours"] ?? 1),
        minute: r["minute"] !== undefined ? Number(r["minute"]) : undefined,
        second: r["second"] !== undefined ? Number(r["second"]) : undefined,
      };
    case "daily":
      return {
        kind: "daily",
        intervalDays: Number(r["interval_days"] ?? 1),
        timeOfDay: String(r["time_of_day"] ?? "00:00:00"),
      };
    case "weekly":
      return {
        kind: "weekly",
        intervalWeeks: Number(r["interval_weeks"] ?? 1),
        daysOfWeek: Array.isArray(r["days_of_week"]) ? r["days_of_week"].map(String) as import("../schedule-store.js").Weekday[] : ["mon"],
        timeOfDay: String(r["time_of_day"] ?? "00:00:00"),
      };
    case "monthly":
      return {
        kind: "monthly",
        intervalMonths: Number(r["interval_months"] ?? 1),
        dayOfMonth: Number(r["day_of_month"] ?? 1),
        timeOfDay: String(r["time_of_day"] ?? "00:00:00"),
      };
    case "yearly":
      return {
        kind: "yearly",
        intervalYears: Number(r["interval_years"] ?? 1),
        month: Number(r["month"] ?? 1),
        dayOfMonth: Number(r["day_of_month"] ?? 1),
        timeOfDay: String(r["time_of_day"] ?? "00:00:00"),
      };
    default:
      // 遇到未知的 kind，抛出异常阻止非法 schedule 创建
      throw new Error(`Unknown recurrence kind: ${kind}`);
  }
}

type ScheduleTimingInput =
  | {
      type: "once";
      runAt: string;
    }
  | {
      type: "recurring";
      startsAt: string;
      endsAt?: string;
      rule: import("../schedule-store.js").RecurrenceRule;
    };

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

export function createScheduleToolProvider(
  manager: ScheduleManager,
): ScheduleToolProvider {
  // 教学导读：
  // Schedule 工具参数是本项目最复杂的 tool schema 之一，因为它同时包含：
  // - intent：到点后要做什么
  // - timing：什么时候触发
  // - execution：用 command 还是 subagent 执行、声明哪些资源
  // - output_policy：结果如何通知 LLM
  //
  // 这个 provider 的任务是把 LLM 传入的 JSON 翻译为 CreateScheduleInput。
  // 真正的时间计算、跨项目边界、occurrence 审计和 Async Run 触发，
  // 都由 schedules.ts / schedule-store.ts 负责。

  async function executeCreate(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // 提取并校验 title，不能为空
    const title = String(args["title"] ?? "").trim();
    if (!title) {
      return { output: "Error: title is required", error: true };
    }

    // 提取并校验 intent 对象，必须为 object 类型且包含非空 prompt
    const intentRaw = args["intent"];
    if (!intentRaw || typeof intentRaw !== "object" || Array.isArray(intentRaw)) {
      return { output: "Error: intent must be an object", error: true };
    }
    const intent = intentRaw as Record<string, unknown>;
    const prompt = String(intent["prompt"] ?? "").trim();
    if (!prompt) {
      return { output: "Error: intent.prompt is required", error: true };
    }

    // 解析 timing 参数，异常时直接返回错误给 LLM
    let timing: ScheduleTimingInput;
    try {
      // timing 是最容易出错的部分，所以单独抽成 parseTiming。
      // 这样 create 的主流程能保持可读，错误也能明确指向时间参数。
      timing = parseTiming(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error: ${message}`, error: true };
    }

    // 提取并校验 execution 对象，executor 只能是 subagent 或 command
    const executionRaw = args["execution"];
    if (!executionRaw || typeof executionRaw !== "object" || Array.isArray(executionRaw)) {
      return { output: "Error: execution must be an object", error: true };
    }
    const execution = executionRaw as Record<string, unknown>;
    const executor = String(execution["executor"] ?? "");
    if (executor !== "subagent" && executor !== "command") {
      return { output: "Error: execution.executor must be 'subagent' or 'command'", error: true };
    }

    // 当 executor 为 command 时，必须提供 command 字符串
    const command = execution["command"] ? String(execution["command"]) : undefined;
    if (executor === "command" && !command) {
      return { output: "Error: execution.command is required when executor='command'", error: true };
    }

    // 提取 resources 对象，分别处理 read_paths 和 write_paths 的默认值
    const resourcesRaw = execution["resources"];
    if (!resourcesRaw || typeof resourcesRaw !== "object" || Array.isArray(resourcesRaw)) {
      return { output: "Error: execution.resources must be an object", error: true };
    }
    const resources = resourcesRaw as Record<string, unknown>;
    // read_paths 默认 "."，表示 schedule 触发时可以读取当前项目。
    // write_paths 默认 []，因为当前 permissionProfile 固定 readonly。
    const readPaths = Array.isArray(resources["read_paths"]) ? resources["read_paths"].map(String) : ["."];
    const writePaths = Array.isArray(resources["write_paths"]) ? resources["write_paths"].map(String) : [];

    // 提取超时、重叠策略等可选参数，未传入时使用默认值
    const timeoutSeconds = execution["timeout_seconds"] !== undefined
      ? Number(execution["timeout_seconds"])
      : 300;
    const overlapPolicy = String(execution["overlap_policy"] ?? "skip") as "allow" | "skip";
    const permissionProfile = "readonly";
    // 第一版工具 schema 不暴露 ci/workspace_write。
    // 这是有意裁剪：学生先理解 readonly 定时执行，再在后续课程扩展写能力。

    // 解析 output_policy 对象，若未传入或类型不符则视为空对象
    const outputPolicyRaw = args["output_policy"];
    const outputPolicy = outputPolicyRaw && typeof outputPolicyRaw === "object" && !Array.isArray(outputPolicyRaw)
      ? (outputPolicyRaw as Record<string, unknown>)
      : {};

    // 组装 CreateScheduleInput，将前端参数映射为内部数据结构
    const input: CreateScheduleInput = {
      title,
      intent: { prompt },
      timing,
      execution: {
        mode: "async",
        executor,
        timeoutSeconds,
        overlapPolicy,
        permissionProfile,
        resources: { readPaths, writePaths },
      },
      outputPolicy: {
        saveRawOutput: true,
        notifyLlm: outputPolicy["notify_llm"] !== false,
        linkedTaskUpdate: "never",
      },
    };
    // 仅在参数存在时添加可选字段，避免传入 undefined
    // 这里同样受 exactOptionalPropertyTypes 约束：
    // 可选字段要么不存在，要么有真实值，不写 field: undefined。
    if (args["description"] !== undefined) {
      input.description = String(args["description"]);
    }
    if (intent["summary"] !== undefined) {
      input.intent.summary = String(intent["summary"]);
    }
    if (command !== undefined) {
      (input.execution as Record<string, unknown>).command = command;
    }
    if (outputPolicy["summary_prompt"] !== undefined) {
      input.outputPolicy.summaryPrompt = String(outputPolicy["summary_prompt"]);
    }

    try {
      // 调用 manager 创建 schedule，成功后返回 schedule 摘要
      // 返回 JSON 而不是长文本，是为了让 LLM 能稳定提取 schedule_id 和 next_run_at。
      const schedule = manager.create(input);
      return {
        output: JSON.stringify(
          {
            type: "schedule_created",
            schedule_id: schedule.id,
            title: schedule.title,
            next_run_at: schedule.nextRunAt ?? null,
            executor: schedule.execution.executor,
            permission_profile: schedule.execution.permissionProfile,
            overlap_policy: schedule.execution.overlapPolicy,
          },
          null,
          2,
        ),
        error: false,
      };
    } catch (err) {
      // 捕获创建过程中的异常，将错误信息返回给 LLM
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error creating schedule: ${message}`, error: true };
    }
  }

  async function executeList(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // 构建查询条件对象，仅当参数存在时才设置对应字段
    // list 是只读工具，所以这里不 catch；manager.list 正常情况下不会抛业务异常。
    const query: import("../schedule-store.js").ScheduleListQuery = {};
    if (args["include_archived"] !== undefined) {
      query.includeArchived = Boolean(args["include_archived"]);
    }
    if (args["include_cancelled"] !== undefined) {
      query.includeCancelled = Boolean(args["include_cancelled"]);
    }
    if (args["current_project_only"] !== undefined) {
      query.currentProjectOnly = Boolean(args["current_project_only"]);
    }

    // 调用 manager 查询 schedule 列表，并格式化为 JSON 返回
    const schedules = manager.list(query);
    return {
      output: formatScheduleList(schedules),
      error: false,
    };
  }

  async function executeRead(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // 提取 schedule_id 并校验其非空
    const scheduleId = String(args["schedule_id"] ?? "");
    if (!scheduleId) {
      return { output: "Error: schedule_id is required", error: true };
    }

    // 通过 manager 读取 schedule 详情，若不存在则返回错误
    const schedule = manager.read(scheduleId);
    if (!schedule) {
      return { output: `Error: Schedule not found: ${scheduleId}`, error: true };
    }

    // 解析 recent_occurrences 参数，默认返回最近 5 条 occurrence
    const recentOccurrences = args["recent_occurrences"] !== undefined
      ? Number(args["recent_occurrences"])
      : 5;
    const occurrences = manager.listOccurrences({ scheduleId, limit: recentOccurrences });
    return {
      output: formatScheduleView(schedule, occurrences),
      error: false,
    };
  }

  async function executeCancel(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // 提取并校验 schedule_id
    const scheduleId = String(args["schedule_id"] ?? "");
    if (!scheduleId) {
      return { output: "Error: schedule_id is required", error: true };
    }

    try {
      // 调用 manager 取消 schedule，reason 为可选参数
      const schedule = manager.cancel(scheduleId, args["reason"] ? String(args["reason"]) : undefined);
      return {
        output: JSON.stringify(
          {
            type: "schedule_cancelled",
            schedule_id: schedule.id,
            status: schedule.status,
          },
          null,
          2,
        ),
        error: false,
      };
    } catch (err) {
      // 捕获取消异常并返回结构化错误信息
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error cancelling schedule: ${message}`, error: true };
    }
  }

  async function executeDelete(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // 提取并校验 schedule_id
    const scheduleId = String(args["schedule_id"] ?? "");
    if (!scheduleId) {
      return { output: "Error: schedule_id is required", error: true };
    }

    try {
      // 调用 manager 删除 schedule（仅允许删除从未触发过的 schedule）
      manager.delete(scheduleId);
      return {
        output: JSON.stringify(
          { type: "schedule_deleted", schedule_id: scheduleId },
          null,
          2,
        ),
        error: false,
      };
    } catch (err) {
      // 捕获删除异常并返回错误信息
      const message = err instanceof Error ? err.message : String(err);
      return { output: `Error deleting schedule: ${message}`, error: true };
    }
  }

  async function executeOccurrenceList(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // 提取并校验 schedule_id
    const scheduleId = String(args["schedule_id"] ?? "");
    if (!scheduleId) {
      return { output: "Error: schedule_id is required", error: true };
    }

    // 解析 limit 参数，默认返回 20 条 occurrence 记录
    const limit = args["limit"] !== undefined ? Number(args["limit"]) : 20;
    const occurrences = manager.listOccurrences({ scheduleId, limit });
    return {
      output: formatOccurrenceList(occurrences),
      error: false,
    };
  }

  return {
    toolEntries: [
      { definition: runScheduleCreateDefinition, execute: executeCreate },
      { definition: runScheduleListDefinition, execute: executeList },
      { definition: runScheduleReadDefinition, execute: executeRead },
      { definition: runScheduleCancelDefinition, execute: executeCancel },
      { definition: runScheduleDeleteDefinition, execute: executeDelete },
      { definition: runScheduleOccurrenceListDefinition, execute: executeOccurrenceList },
    ],
  };
}
