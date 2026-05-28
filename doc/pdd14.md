# PDD14: Schedule 定时运行系统

## 审阅结论

本设计要实现的是一个 **Schedule 定时运行系统**，而不是新的 Task 系统，也不是新的后台执行生命周期。

当前项目已经有三类相邻概念：

```text
Task Group / Task = 跨会话的长期工作目标和进度
TODO = 当前 session 内的短期执行步骤
Async Run = 一次非阻塞运行实例
```

PDD14 新增的概念应该命名为 **Schedule**：

```text
Schedule = 持久化的定时规则，描述用户希望在什么时候周期性或一次性触发什么 intention
Occurrence = Schedule 的某一次应触发实例，用于防重复、审计和通知
Async Run = Occurrence 触发后真正创建的运行实例
```

不要把这个功能命名为 `Cron Task` 或 `Background Task`。原因有两个：

1. 项目里已经有 PDD12 的 Persistent Task，`task` 一词应保留给长期工作目标。
2. PDD13 已经明确 Async Run 是后台运行实例，PDD14 不应该再实现一套后台状态机。

本设计的核心原则是：

```text
Schedule stores durable user intent, execution boundaries, and output policy.
At trigger time, Schedule creates an Async Run.
Async Run records one execution result.
Persistent Task records durable work progress only when explicitly linked and allowed.
```

换句话说，Schedule 不是“到点运行一条死命令”，也不是“到点让模型完全重新猜”。它保存用户的长期意图和运行边界；到点后由 scheduler 主动发动，并通过 Async Run 执行。

## 背景

PDD13 已经为 scheduler 预留了触发元数据：

```ts
export interface AsyncRunTrigger {
  kind: "manual" | "schedule";
  scheduleId?: string;
  occurrenceId?: string;
  firedAt?: string;
}
```

并明确约定：

```text
Schedule
  -> 描述什么时候触发
  -> 到时间后调用 AsyncRunManager.start()

Async Run
  -> 描述这一次触发产生的运行实例
  -> 管理 run_id/status/output/notification/timeout
```

因此 PDD14 应该补齐：

1. Schedule 如何持久化。
2. Scheduler 如何判断到点、错过和重复。
3. Occurrence 如何防止同一次触发重复执行。
4. 到点后如何创建 Async Run。
5. 如何通知 LLM 定时任务已经触发、错过、完成或失败。
6. 如何表达用户期望的输出行为。

## 设计目标

1. 新增持久化 Schedule，用于一次性或重复触发用户定义的 intention。
2. Schedule 存放在 Agent 全局运行目录，不写入用户项目源码目录。
3. 支持一次性触发和重复触发。
4. 重复触发可以有 `endsAt`，也可以没有结束时间，表示持续有效直到删除或取消。
5. 时间粒度支持从年到秒的表达，但不承诺按秒精确触发。
6. 到点时主动发动，不依赖用户下一轮输入。
7. 到点后创建 PDD13 Async Run，不重新实现后台执行生命周期。
8. 支持 `executor: "subagent" | "command"`，默认更推荐 `subagent` 保存 AI agent 的适应性。
9. 支持持久化 occurrence 记录，避免同一次触发重复执行。
10. 支持错过触发的记录和通知，但第一版默认不补跑错过的 occurrence。
11. 支持重叠策略，允许同一个 schedule 的多次 occurrence 并行，也可以选择跳过重叠触发。
12. 支持输出策略：保存原始输出、通知 LLM、生成摘要、按规则更新关联 Task。
13. 支持删除未执行 schedule；已经触发过的 schedule 不物理删除，改为取消或归档。
14. 保持 prompt cache 友好：工具定义启动时稳定注册，动态定时状态通过 reminder 或主动 agent run 输入传递。

## 非目标

1. 第一版不实现完整 cron 表达式解析器。
2. 第一版不实现 pause/resume。用户需要暂停时，可以删除未执行 schedule，或取消已触发 schedule；恢复时重新创建。
3. 第一版不实现排队重叠策略 `queue`。
4. 第一版不实现分布式 scheduler、多进程锁、云端执行器或跨机器协同。
5. 第一版不保证秒级准时，只保证在进程在线且 tick 运行时尽快触发。
6. 第一版不追溯补跑所有历史 missed occurrences。
7. 第一版不自动修改 Persistent Task，除非 schedule 明确关联 Task 且 output policy 允许。
8. 第一版不允许 schedule 绕过 permission profile 自动执行危险操作，例如 `git push`、删除文件、重置分支。
9. 第一版不把 schedule 的动态状态注入稳定 system prompt。
10. 第一版不实现可视化日历、复杂提醒渠道或外部通知系统。

## 术语

| 术语 | 含义 |
| --- | --- |
| Schedule | 持久化定时规则，保存用户 intention、触发规则、运行上下文、执行边界和输出策略 |
| Occurrence | Schedule 的一次应触发实例，例如某天 09:00 的那次运行 |
| Scheduler | 进程内定时检查器，负责发现 due occurrence 并触发 Async Run |
| Missed Occurrence | 进程未在线或 scheduler 未运行导致错过的 occurrence |
| Overlap Policy | 同一个 schedule 上一次还没完成时，下一次 due occurrence 如何处理 |
| Output Policy | 一次运行完成后如何保存、总结、通知或更新关联 Task |
| Permission Profile | Schedule 触发 Async Run 时可使用的权限边界 |
| Linked Task | Schedule 可选关联的 PDD12 Task Group / Task |

## 和现有能力的边界

| 能力 | 回答的问题 | 生命周期 | 是否持久化 | 典型用途 |
| --- | --- | --- | --- | --- |
| TODO | 本轮怎么一步步做 | 当前 session | 否 | 当前对话内的执行步骤 |
| Task Group / Task | 长期目标和进度是什么 | 跨 session / 跨重启 | 是 | 多天、多轮、可恢复工作计划 |
| Async Run | 某次执行是否完成、输出在哪里 | 当前进程/session | 记录在内存，输出落盘 | 慢命令、异步探索、schedule 触发结果 |
| Schedule | 什么时候自动发动某个 intention | 跨 session / 跨重启 | 是 | 每天 CI、每周研究、一次性提醒执行 |

推荐 routing policy：

```text
Use Schedule for durable time-based triggers.
Use Task Group for durable work state and progress.
Use TODO for current-session execution steps.
Use Async Run for one non-blocking execution instance.
Do not use Schedule as a Task Group, and do not use Task Group as a timer.
```

## 用户意图模型

Schedule 应该采用 **intent-first + fixed envelope** 的设计。

例如用户说：

```text
每天晚上帮我跑 CI，如果失败就总结原因。
```

Schedule 不应该只保存：

```text
npm test
```

也不应该只保存：

```text
每天看看项目。
```

更合适的是同时保存：

1. 用户要周期性达成什么目标。
2. 在哪个项目和 cwd 下执行。
3. 使用什么 executor。
4. 允许读写哪些资源。
5. 运行结果如何保存和汇报。

因此 Schedule 的核心语义是：

```text
用户最初 intention 是稳定的。
具体执行步骤可以由 subagent 在触发时根据当前项目状态判断。
运行边界、权限和输出行为在创建 schedule 时固定。
```

### Executor 选择

| Executor | 适合场景 | 特点 |
| --- | --- | --- |
| `subagent` | “每天检查项目健康并总结问题”“每周研究某主题并汇总” | 保存 AI agent 的适应性，触发时可根据当前环境决定步骤 |
| `command` | “每天 9 点运行 `npm test`” | 可预测、易测试，适合用户明确指定命令 |

默认推荐：

```text
用户表达的是目标或意图 -> executor: "subagent"
用户明确指定一条命令 -> executor: "command"
```

## 存储位置

Schedule 是 Agent 运行数据，不是用户项目源码。默认存放在 `agentHome` 下：

```text
<agentHome>/
└── schedules/
    ├── schedules/
    │   └── sch_20260525_220000_ci/
    │       ├── schedule.json
    │       └── occurrences/
    │           ├── occ_20260525_230000.json
    │           └── occ_20260526_230000.json
    └── index.json
```

说明：

- `ProjectContext` 应新增 `schedulesDir`，默认 `<agentHome>/schedules`。
- `schedules/<schedule_id>/schedule.json` 是 Schedule 的唯一真实数据源。
- `occurrences/<occurrence_id>.json` 保存每次 due/missed/triggered/skipped 的审计记录。
- `index.json` 是派生索引，可从所有 `schedule.json` 重建。
- Schedule 不写入被操作项目的 `.schedule/` 或 `.cron/`，避免污染用户仓库。

## 身份命名

Schedule ID：

```text
^sch_[0-9]{8}_[0-9]{6}_[a-z0-9_-]{1,48}$
```

Occurrence ID：

```text
^occ_[0-9]{8}_[0-9]{6}(_[a-z0-9_-]{1,32})?$
```

推荐 occurrence id 由 schedule id 和 scheduled time 派生，而不是完全随机：

```text
occurrenceId = occ_<scheduledAt local yyyyMMdd_HHmmss>_<shortHash(scheduleId)>
```

这样同一个 schedule 的同一个 scheduledAt 会稳定得到同一个 occurrence id，天然防止重复触发。

读取时必须校验：

- 目录名中的 schedule id 和 `schedule.json.id` 完全一致。
- `kind === "schedule"`。
- `version` 是当前支持版本。
- `projectRoot` 和 `cwd` 是绝对路径。
- `cwd` 必须在 `projectRoot` 内。
- `timezone` 合法。
- 一次性 schedule 必须有 `runAt`。
- 重复 schedule 必须有 repeat 规则；`endsAt` 可选。
- 如果 `endsAt` 存在，必须晚于开始时间。
- 如果关联 Task，`groupId` 和 `taskId` 格式必须合法；是否存在可在执行前再检查。
- `writePaths` 必须在 `projectRoot` 内或明确属于允许的 agent output 目录。

任一校验失败时，该 schedule 不进入 active 列表，并记录 warning。第一版不自动删除坏文件。

## 数据结构

### ScheduleFile

```ts
export interface ScheduleFile {
  version: 1;
  kind: "schedule";
  id: string;
  title: string;
  description?: string;
  status: ScheduleStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
  archivedAt?: string;

  projectRoot: string;
  cwd: string;
  timezone: string;

  intent: ScheduleIntent;
  timing: ScheduleTiming;
  execution: ScheduleExecution;
  outputPolicy: ScheduleOutputPolicy;
  linkedTask?: LinkedPersistentTask;

  lastEvaluatedAt?: string;
  lastScheduledAt?: string;
  nextRunAt?: string;
  triggeredCount: number;
  missedCount: number;
  skippedCount: number;
}

export type ScheduleStatus =
  | "active"
  | "completed"
  | "cancelled"
  | "archived";
```

说明：

- 第一版不设计 `paused` 状态。
- 一次性 schedule 触发后进入 `completed`。
- 重复 schedule 如果有 `endsAt`，超过结束时间后进入 `completed`。
- 用户删除已触发 schedule 时，进入 `cancelled` 或 `archived`，不物理删除。
- `nextRunAt` 是派生缓存，读取时可以重新计算；写入时需要保持一致。

### ScheduleIntent

```ts
export interface ScheduleIntent {
  prompt: string;
  summary?: string;
}
```

`prompt` 是触发时传给 executor 的核心用户意图。例如：

```text
Run CI for this project. If it fails, inspect the likely cause and summarize with file references.
Do not modify source files.
```

`summary` 是给列表展示和通知使用的短描述。

### ScheduleTiming

```ts
export type ScheduleTiming = OneTimeTiming | RecurringTiming;

export interface OneTimeTiming {
  type: "once";
  runAt: string;
}

export interface RecurringTiming {
  type: "recurring";
  startsAt: string;
  endsAt?: string;
  rule: RecurrenceRule;
}
```

第一版支持结构化 repeat rule，不引入完整 cron 表达式：

```ts
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
  minute?: number;
  second?: number;
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

export type Weekday =
  | "mon"
  | "tue"
  | "wed"
  | "thu"
  | "fri"
  | "sat"
  | "sun";
```

说明：

- `timeOfDay` 使用 `HH:mm:ss`。
- `timezone` 存在 `ScheduleFile.timezone`，所有本地时间规则都按该时区解释。
- 秒级 rule 可以表达，但 scheduler tick 不保证秒级精确。
- 完整 cron 字符串留给未来版本。

### ScheduleExecution

```ts
export interface ScheduleExecution {
  mode: "async";
  executor: "subagent" | "command";
  command?: string;
  timeoutSeconds: number;
  overlapPolicy: OverlapPolicy;
  permissionProfile: PermissionProfile;
  resources: ScheduleResources;
}

export type OverlapPolicy = "allow" | "skip";

export type PermissionProfile =
  | "readonly"
  | "ci"
  | "workspace_write";

export interface ScheduleResources {
  readPaths: string[];
  writePaths: string[];
}
```

说明：

- `mode` 第一版固定为 `async`。
- `executor: "command"` 必须提供 `command`。
- `executor: "subagent"` 不应提供 `command`，而是使用 `intent.prompt`。
- `overlapPolicy: "allow"` 表示到点就触发新的 occurrence，即使前一次还在 running。
- `overlapPolicy: "skip"` 表示如果同一个 schedule 还有 running occurrence，本次标记为 `skipped_overlap`。
- 第一版不实现 `queue`，避免引入任务队列语义。

### Permission Profile

Schedule 不能绕过现有权限系统。它应该把长期授权边界固定在 `permissionProfile` 和 `resources` 中。

| Profile | 语义 | 允许 | 禁止 |
| --- | --- | --- | --- |
| `readonly` | 只读检查 | 读取项目文件、运行只读诊断命令、写 agentHome 输出 | 修改项目文件、生成构建产物、git 写操作 |
| `ci` | CI / 构建 / 测试 | 运行测试、typecheck、lint、build，允许 coverage/dist/cache 等工具产物 | 编辑源码、git commit/push/reset、删除用户文件 |
| `workspace_write` | 指定路径写入 | 写入 `writePaths` 内的文件 | 超出声明路径写入、危险 git 操作 |

创建 `workspace_write` schedule 时必须要求用户确认。第一版可以先实现 `readonly` 和 `ci`，把 `workspace_write` 作为类型和设计预留；如果实现 `workspace_write`，必须增加专门测试。

### ScheduleOutputPolicy

```ts
export interface ScheduleOutputPolicy {
  saveRawOutput: boolean;
  notifyLlm: boolean;
  summaryPrompt?: string;
  linkedTaskUpdate: LinkedTaskUpdatePolicy;
}

export type LinkedTaskUpdatePolicy =
  | "never"
  | "append_note"
  | "mark_failed_on_failure";
```

说明：

- `saveRawOutput: true` 表示保留 Async Run output reference 和 occurrence 记录。
- `notifyLlm: true` 表示触发、错过、完成或失败时通知 LLM。
- `summaryPrompt` 用于要求 LLM 如何总结结果。例如“如果 CI 失败，只总结失败测试和可能原因”。
- `linkedTaskUpdate` 只有在 `linkedTask` 存在时才生效。
- 默认不自动更新 Task，避免 schedule 悄悄改变长期计划状态。

推荐默认值：

```ts
{
  saveRawOutput: true,
  notifyLlm: true,
  linkedTaskUpdate: "never"
}
```

### LinkedPersistentTask

```ts
export interface LinkedPersistentTask {
  groupId: string;
  taskId?: string;
}
```

Schedule 可以关联 PDD12 Task Group / Task，但这只是上下文关联，不代表每次运行都自动修改任务状态。

如果 `linkedTaskUpdate` 不是 `never`：

- `append_note`：LLM 可以把 schedule 结果摘要追加到 Task note。
- `mark_failed_on_failure`：当 Async Run 失败或 CI 失败时，允许 LLM 把关联 Task 标为 `failed` 或追加 failure note。

第一版建议只实现 notification 中携带 linked task 信息；自动更新 Task 可以作为可选步骤，必须经过正常 `run_task_update` 工具和权限路径。

### ScheduleOccurrenceFile

```ts
export interface ScheduleOccurrenceFile {
  version: 1;
  kind: "schedule_occurrence";
  id: string;
  scheduleId: string;
  scheduledAt: string;
  status: OccurrenceStatus;
  createdAt: string;
  updatedAt: string;
  firedAt?: string;
  missedAt?: string;
  skippedAt?: string;
  completedAt?: string;
  asyncRunId?: string;
  outputRef?: string;
  reason?: string;
  notificationDrainedAt?: string;
}

export type OccurrenceStatus =
  | "due"
  | "triggered"
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "missed"
  | "skipped_overlap";
```

说明：

- occurrence 是防重复执行的核心记录。
- 创建 Async Run 前，必须先持久化 occurrence，并把状态置为 `triggered`。
- 如果进程在创建 occurrence 后崩溃，重启时看到 `triggered` 但没有 `asyncRunId`，第一版可标记为 `failed`，并通知 LLM。
- `notificationDrainedAt` 防止同一条 occurrence notification 重复注入。

## Scheduler 运行流程

### 启动扫描

进程启动时：

1. 创建 `ScheduleStore`。
2. 扫描 `<agentHome>/schedules/schedules/*/schedule.json`。
3. 校验 schedule 文件。
4. 重建 `index.json`。
5. 对 active schedule 计算 `nextRunAt`。
6. 检查进程离线期间是否有 missed occurrence。
7. 对 missed occurrence 只记录最近一次，不补跑历史所有 occurrence。
8. 将 missed notification 放入 schedule notification queue。

错过触发的第一版规则：

```text
如果 now 已经晚于某个 occurrence 的触发时间，并且该 occurrence 在进程离线期间错过：
  - 标记最近一次 missed occurrence
  - 不创建 Async Run
  - 通知 LLM
  - 重新计算下一次 future nextRunAt
```

这样避免 Agent 启动后补跑一串过期任务。

### Tick 循环

Scheduler 使用轻量 `setInterval` tick，例如每 1 秒或 5 秒检查一次。

伪代码：

```text
for each active schedule:
  now = current time
  due = compute due occurrence at or before now

  if no due:
    continue

  occurrenceId = stable id from scheduleId + scheduledAt

  if occurrence already exists:
    continue

  if overlapPolicy is skip and schedule has running occurrence:
    create occurrence with status skipped_overlap
    enqueue notification
    update nextRunAt
    continue

  create occurrence with status triggered
  start AsyncRunManager.start({
    executor,
    command or prompt,
    resources,
    timeoutSeconds,
    persistentTaskGroupId,
    persistentTaskId,
    trigger: {
      kind: "schedule",
      scheduleId,
      occurrenceId,
      firedAt: now
    }
  })
  update occurrence with asyncRunId and status running
  enqueue triggered notification
  update schedule counters and nextRunAt
```

关键点：

- 必须先写 occurrence，再启动 async run。
- 同一个 scheduleId + scheduledAt 只能创建一个 occurrence。
- Scheduler 不直接执行命令，也不直接运行 LLM；执行统一交给 Async Run。
- Scheduler 不直接改 Task；需要通过 LLM 后续调用 Task 工具。

### Async Run 完成回写

PDD13 的 AsyncRunManager 已有 notification queue。PDD14 有两种选择：

1. Scheduler 轮询 AsyncRunManager，发现 schedule 触发的 run 进入终态后更新 occurrence。
2. AsyncRunManager 在 finishRun 时通过 callback 通知 ScheduleManager。

第一版建议采用 callback，减少轮询：

```ts
export interface AsyncRunLifecycleHooks {
  onFinish?(record: AsyncRunRecord): void;
}
```

当 `record.trigger.kind === "schedule"` 时：

1. 找到对应 occurrence。
2. 根据 async run status 更新 occurrence 为 `completed` / `failed` / `timeout`。
3. 保存 output reference。
4. enqueue schedule completion notification。

如果不想改 AsyncRunManager 接口，也可以让 ScheduleManager 在 tick 中顺手检查 running occurrences；但要在 PDD 实现时明确选择一种，不要两套都做。

## LLM 通知语义

Schedule notification 不进入稳定 system prompt。它们应该通过已有动态 reminder 机制进入主 Agent。

通知来源：

1. due occurrence 已触发。
2. occurrence 因 overlap 被跳过。
3. occurrence missed。
4. schedule 触发的 async run completed / failed / timeout。
5. schedule cancelled / completed。

推荐 reminder 格式：

```xml
<system-reminder source="schedule">
Schedule updates:
- sch_20260525_220000_ci triggered occurrence occ_20260525_230000_x7a9 at 2026-05-25T23:00:00+08:00.
  Async run: ar_...
  Intent: Run CI for this project. If it fails, summarize likely causes.
  Use run_async_check or run_async_output_read if you need details.
</system-reminder>
```

Missed 示例：

```xml
<system-reminder source="schedule">
Schedule updates:
- sch_20260525_220000_ci missed occurrence scheduled at 2026-05-25T23:00:00+08:00 while the agent process was offline.
  The missed occurrence was not backfilled.
</system-reminder>
```

Completed 示例：

```xml
<system-reminder source="schedule">
Schedule updates:
- sch_20260525_220000_ci completed occurrence occ_20260525_230000_x7a9.
  Async run: ar_...
  Output: use run_async_output_read with run_id ar_...
  Output policy: summarize failures only; do not modify source files.
</system-reminder>
```

如果 `outputPolicy.notifyLlm === false`，可以只保存 occurrence，不注入 reminder。

## 主动发动语义

用户已经明确：定时任务到点就是要发动。

第一版的主动发动不是“等用户下一次输入再执行”，而是：

```text
进程在线
  -> scheduler tick 发现 due occurrence
  -> 立即创建 Async Run
  -> 把触发事实通知 LLM
```

如果主 Agent 此刻正在处理用户请求：

- Scheduler 仍可创建 Async Run。
- 通知进入 queue。
- 下一次 LLM 调用前通过 reminder 注入。

如果需要“主动让 LLM 汇报结果给用户”，REPL 层可以在 notification 到达后启动一次内部 agent run。第一版可以先只实现 reminder queue；后续再扩展真正的 user-facing proactive output。

重要边界：

```text
Schedule 到点主动创建 Async Run。
Schedule 不直接在用户终端打印长报告。
结果汇报仍经过 Agent/LLM 的正常消息路径。
```

## 删除、取消和归档

第一版不支持 pause/resume。

删除语义：

```text
triggeredCount === 0 且没有 occurrence:
  可以 hard delete schedule 目录。

已经触发过、missed 过、skipped 过或有关联 async run:
  不物理删除。
  用户说删除时，改为 status: "cancelled"。
  cancelled schedule 不再产生 future occurrence。
```

归档语义：

```text
completed / cancelled schedule 可以 archive。
archived schedule 默认不在 active list 展示。
```

这样可以保留执行历史、output reference 和审计线索。

## 工具设计

新增 `src/tools/schedules.ts`，提供 ScheduleToolProvider。

工具名使用 `run_schedule_*`，避免 `task` 命名混淆。

| 工具 | 用途 |
| --- | --- |
| `run_schedule_create` | 创建一次性或重复 schedule |
| `run_schedule_list` | 列出 schedule 摘要 |
| `run_schedule_read` | 读取 schedule 详情和最近 occurrences |
| `run_schedule_cancel` | 取消已创建 schedule |
| `run_schedule_delete` | 删除从未执行过的 schedule |
| `run_schedule_occurrence_list` | 列出某 schedule 的 occurrence 历史 |

### `run_schedule_create`

输入示例：

```json
{
  "title": "Nightly CI",
  "intent": {
    "prompt": "Run CI for this project. If it fails, inspect likely causes and summarize with file references. Do not modify source files.",
    "summary": "Run nightly CI and summarize failures."
  },
  "timing": {
    "type": "recurring",
    "startsAt": "2026-05-25T23:00:00+08:00",
    "rule": {
      "kind": "daily",
      "intervalDays": 1,
      "timeOfDay": "23:00:00"
    }
  },
  "execution": {
    "mode": "async",
    "executor": "subagent",
    "timeoutSeconds": 300,
    "overlapPolicy": "skip",
    "permissionProfile": "ci",
    "resources": {
      "readPaths": ["."],
      "writePaths": []
    }
  },
  "outputPolicy": {
    "saveRawOutput": true,
    "notifyLlm": true,
    "linkedTaskUpdate": "never"
  }
}
```

返回摘要：

```text
Created schedule sch_20260525_220000_nightly_ci
Next run: 2026-05-25T23:00:00+08:00
Executor: subagent
Permission profile: ci
Overlap policy: skip
```

### `run_schedule_list`

支持参数：

```ts
export interface ScheduleListQuery {
  includeArchived?: boolean;
  includeCancelled?: boolean;
  projectRoot?: string;
}
```

默认列出当前 project 的 active/completed schedule，不展示 archived。

### `run_schedule_read`

读取完整 schedule，并附带最近 N 条 occurrence：

```ts
export interface ScheduleReadInput {
  scheduleId: string;
  recentOccurrences?: number;
}
```

### `run_schedule_cancel`

用于已经触发过或用户不想继续触发的 schedule。

```ts
export interface ScheduleCancelInput {
  scheduleId: string;
  reason?: string;
}
```

### `run_schedule_delete`

只允许删除从未执行过的 schedule。

```ts
export interface ScheduleDeleteInput {
  scheduleId: string;
}
```

如果 schedule 已有 occurrence，返回错误并提示使用 cancel。

### `run_schedule_occurrence_list`

用于查看执行历史。

```ts
export interface ScheduleOccurrenceListInput {
  scheduleId: string;
  limit?: number;
}
```

## REPL 命令

新增 `/schedule` 命令，直接操作 ScheduleManager，便于教学和调试。

建议第一版：

```text
/schedule list
/schedule list --all
/schedule show <schedule_id>
/schedule cancel <schedule_id>
/schedule delete <schedule_id>
/schedule occurrences <schedule_id>
```

创建 schedule 主要由 LLM tool 完成，因为自然语言意图需要模型转成结构化规则。

## 权限设计

Schedule 的风险比普通一次性工具调用更高，因为它会在未来自动执行。因此创建 schedule 的权限要比运行普通只读命令更严格。

建议：

| 操作 | plan | default | auto |
| --- | --- | --- | --- |
| list/read/occurrence_list | allow | allow | allow |
| create readonly | deny | ask | ask |
| create ci | deny | ask | ask |
| create workspace_write | deny | ask | ask |
| cancel/delete | deny | ask | ask |

原因：

- 即使是 readonly schedule，也会影响未来行为，应让用户确认。
- `auto` 模式不应自动创建长期定时行为。
- `plan` 模式不应改变持久化 schedule 状态。

Schedule 触发时的权限不再交互式 ask，而是使用创建时确认过的 `permissionProfile` 和 resources。

## Command Policy

`executor: "command"` 必须复用或扩展 PDD13 Async Command Policy。

第一版建议：

- `readonly` profile 只允许严格只读命令。
- `ci` profile 允许 `npm test`、`npm run typecheck`、`npm run lint`、`npm run build`、`npx vitest`、`npx eslint`、`npx tsc` 等。
- `workspace_write` profile 仍必须禁止危险 git 命令，除非未来 PDD 单独设计。

必须拒绝：

```text
git push
git reset
git checkout
git clean
rm
find -delete
shell control operators
redirection to undeclared paths
```

## 和 Async Run 的接线

`ScheduleManager` 不直接执行任务，只调用：

```ts
asyncRunManager.start({
  executor,
  command,
  prompt,
  resources,
  timeoutSeconds,
  persistentTaskGroupId,
  persistentTaskId,
  trigger: {
    kind: "schedule",
    scheduleId,
    occurrenceId,
    firedAt
  }
});
```

`executor: "subagent"` 时，prompt 应包含：

```text
<schedule-context>
Schedule ID: ...
Occurrence ID: ...
Scheduled at: ...
Intent: ...
Output policy: ...
Permission profile: ...
Linked persistent task: ...
</schedule-context>
```

并明确告诉 async subagent：

```text
This run was triggered by a persisted schedule.
Follow the schedule intent and output policy.
Do not update the persistent Task Group directly unless the parent Agent later chooses to do so through task tools.
```

## ScheduleManager 接口

新增 `src/schedules.ts`：

```ts
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
```

说明：

- `start()` 启动 `setInterval`。
- `stop()` 清理 timer，用于测试和 REPL 退出。
- `tick(now?)` 是可测试的核心逻辑，单元测试应直接调用。
- `drainNotifications()` 供 Agent 在每次 LLM 调用前注入 reminder。

## ScheduleStore 接口

新增 `src/schedule-store.ts`：

```ts
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
```

写入规则：

- `schedule.json` 使用原子写入。
- occurrence 文件也使用原子写入。
- reader 和 writer 校验规则必须对称。
- 文件名和内容 id 必须匹配。

## Agent 集成

`index.ts` 组装顺序：

1. 创建 ProjectContext，新增 `schedulesDir`。
2. 创建 TaskStore / TaskManager。
3. 创建 AsyncRunManager。
4. 创建 ScheduleStore。
5. 创建 ScheduleManager，并注入 AsyncRunManager、ProjectContext、Logger。
6. 注册 ScheduleToolProvider。
7. 主 Agent 注入 ScheduleManager 或 notification provider。
8. REPL 启动时调用 `scheduleManager.start()`。
9. REPL 退出时调用 `scheduleManager.stop()`。

Agent 每轮 LLM 调用前：

```text
drain async run notifications
drain schedule notifications
build dynamic reminders
append as user message
```

注意：

- 不要把 active schedules 放进稳定 system prompt。
- 不要根据 mode 动态增删 schedule tools。
- 工具定义顺序保持稳定。

## 测试计划

### ScheduleStore

1. 保存和读取 schedule。
2. 目录名和内容 id 不一致时拒绝。
3. 非法 `kind/version` 拒绝。
4. `cwd` 不在 `projectRoot` 内时拒绝。
5. recurring schedule 无 `endsAt` 合法。
6. `endsAt` 早于 `startsAt` 拒绝。
7. occurrence 文件保存和读取。
8. index 损坏后可重建。
9. hard delete 只删除指定未执行 schedule。

### ScheduleManager

1. once schedule 到点只触发一次。
2. recurring schedule 计算下一次 `nextRunAt`。
3. recurring schedule 无 `endsAt` 持续有效。
4. recurring schedule 超过 `endsAt` 后 completed。
5. missed occurrence 不补跑，只通知。
6. 离线多天只记录最近一次 missed，不追溯刷屏。
7. stable occurrence id 防止重复 tick 重复触发。
8. overlapPolicy allow 时允许多个 running occurrences。
9. overlapPolicy skip 时已有 running occurrence 会跳过本次。
10. AsyncRunManager.start 收到 trigger.kind schedule。
11. Async run 完成后 occurrence 更新为 completed。
12. Async run failed/timeout 后 occurrence 更新为 failed/timeout。
13. cancel 后不再产生 future occurrence。
14. delete 已触发 schedule 报错并提示 cancel。

### Tools

1. `run_schedule_create` 参数校验。
2. `run_schedule_list` 默认过滤 archived/cancelled。
3. `run_schedule_read` 返回最近 occurrences。
4. `run_schedule_cancel` 写入 cancelled 状态。
5. `run_schedule_delete` 只允许未执行 schedule。
6. `run_schedule_occurrence_list` limit 生效。
7. 工具描述清楚区分 Schedule / Task / Async Run。

### Permission

1. plan 模式拒绝 create/cancel/delete。
2. default 模式 create/cancel/delete 需要 ask。
3. auto 模式 create/cancel/delete 仍需要 ask。
4. list/read 允许。
5. schedule 触发后使用创建时确认的 profile，不再交互式 ask。

### Agent 集成

1. schedule notification 以 `<system-reminder source="schedule">` 注入。
2. schedule tools 注册顺序稳定。
3. schedule notifications 不修改 stable system prompt。
4. async run completion notification 和 schedule completion notification 不重复污染 history。
5. REPL 退出时 stop scheduler，测试中不遗留 timer。

## 实现步骤

1. 扩展 `ProjectContext`，新增 `schedulesDir`。
2. 新增 `src/schedule-store.ts` 和测试。
3. 新增 `src/schedules.ts` 和测试，先实现纯 `tick(now)` 逻辑。
4. 修改 `AsyncRunManager`，支持 schedule lifecycle hook 或让 ScheduleManager 可查询并回写终态。
5. 新增 `src/tools/schedules.ts` 和测试。
6. 修改 `permission.ts`，加入 schedule 工具权限。
7. 修改 `tools/registry.ts`，注册 schedule tools。
8. 修改 `agent.ts`，在 LLM 调用前 drain schedule notifications。
9. 修改 `cli-commands.ts`，加入 `/schedule` 命令。
10. 修改 `index.ts`，组装 ScheduleStore / ScheduleManager / ScheduleToolProvider，并 start/stop scheduler。
11. 更新 `system-prompt.ts` 或工具描述中的 routing policy，明确 Schedule / Task / TODO / Async Run 边界。
12. 更新 `doc/summary.md`。
13. 运行 typecheck、相关测试、全量测试和 lint。

## 验收标准

1. 用户可以创建一次性 schedule，到点后自动创建 Async Run。
2. 用户可以创建重复 schedule，支持无结束时间和有 `endsAt` 两种形式。
3. 同一个 occurrence 不会因为重复 tick 被触发两次。
4. 进程离线错过触发时不补跑，但会记录 missed occurrence 并通知 LLM。
5. `overlapPolicy: "allow"` 允许同一 schedule 多个 occurrence 并行。
6. `overlapPolicy: "skip"` 在已有 running occurrence 时跳过新触发并通知 LLM。
7. schedule 运行结果通过 Async Run 输出引用保存。
8. output policy 决定是否通知 LLM、是否生成摘要、是否允许关联 Task 更新。
9. 未执行 schedule 可以 hard delete。
10. 已触发 schedule 删除时变成 cancelled，不再产生 future occurrence，历史保留。
11. Schedule 数据保存在 `<agentHome>/schedules`，不污染用户项目目录。
12. Schedule 不改变 stable system prompt，动态状态通过 reminder 注入。
13. Schedule 和 Task / TODO / Async Run 的工具描述边界清晰，LLM 不应把定时规则当成 Persistent Task。
