# PDD13: Async Run 非阻塞运行实例

## 审阅结论

本设计是 PDD12 持久化 Task 系统之后的下一层运行时能力，但它不再使用
`Background Task` 这个名称。

原因很简单：项目里已经有 PDD12 的 `Task Group / Task`，它们表示“长期工作目标和进度”。如果再引入
`Background Task`，LLM 很容易把“持久化任务”和“后台运行实例”混在一起。

新的概念命名为 **Async Run**：

```text
Task Group / Task = 要完成的长期工作目标
TODO = 当前 session 的短期执行步骤
Subagent = 带独立上下文的 child Agent 执行器
Async Run = 一次非阻塞运行实例，记录 run_id/status/output/notification
```

PDD13 要实现的不是新的任务计划系统，而是一个 session-local 的异步运行层：

```text
run_subagent
  -> 同步启动 subagent
  -> 父 Agent 阻塞等待最终结果

run_async_start({ executor: "subagent", ... })
  -> 异步启动 subagent
  -> 立刻返回 run_id
  -> 完成/失败/超时后写 notification

run_async_start({ executor: "command", ... })
  -> 异步启动命令
  -> 立刻返回 run_id
  -> 完成/失败/超时后写 notification

run_async_check({ run_id })
  -> 查询运行实例状态
```

这保留了参考文章 s13 的核心模型：

> 主循环仍然只有一条，并行的是等待，不是主循环本身。

但本项目的命名和抽象边界更清晰：

- `subagent` 是执行器，表示“谁来思考和执行”。
- `command` 是执行器，表示“一条明确的 shell 命令”。
- `async run` 是运行实例，表示“这次执行是否完成、输出在哪里”。
- PDD14 如果实现定时任务，应该由 scheduler 触发一次 `AsyncRunManager.start()`，而不是再发明一套后台执行生命周期。

本 PDD 假设代码已经回滚到 PDD12 完成后的状态。旧的 `run_background_task_*`、`BackgroundTaskManager`、`background-tasks.ts`
不作为本设计的接口名称；如果工作树中仍存在旧实现，coding agent 应删除或替换，不要兼容旧工具名。

## 背景

当前 PDD12 后项目已有这些相邻能力：

- `src/tasks.ts` + `src/tools/tasks.ts`：持久化 Task Group，负责长期计划、依赖和进度。
- `src/todo.ts`：当前 session 的短期 TODO list，负责本轮执行节奏。
- `src/tools/subagent.ts`：同步子智能体工具 `run_subagent`，用于隔离探索并立即返回结果。
- `src/agent.ts`：主 Agent 的 think-act-observe 循环，同步处理 tool calls。
- `src/compressor.ts`：大工具输出可以写入 Agent 全局 `.task_outputs/`。
- `src/project-context.ts`：区分 `projectRoot` 和 `agentHome`，Agent 运行数据不污染用户项目。
- `src/session.ts` + `src/transcript.ts`：记录 main/subagent session 与原始事件流。
- `src/permission.ts`：集中处理工具权限、模式和用户确认。
- `src/session-events.ts`：已有动态 reminder 注入机制，可作为 async run notification drain 的近亲。

现在缺少的是：

1. 父 Agent 能启动一个慢执行单元后继续工作。
2. 慢执行单元完成后，不直接把全文塞回 prompt，而是写通知和输出引用。
3. LLM 能通过 `run_id` 查询状态、读取完整输出。
4. 未来 scheduler 能复用同一套运行实例生命周期。

## 设计目标

1. 新增 session-local 的 `AsyncRunManager`，管理异步运行记录、通知队列、并发限制和输出落盘。
2. 新增 `run_async_start`，支持 `executor: "command" | "subagent"`，启动后立刻返回 `run_id`。
3. 新增 `run_async_check` / `run_async_list` / `run_async_output_read`，让 LLM 查询状态和读取完整输出。
4. 保留现有 `run_subagent` 的同步语义：调用后父 Agent 等待最终文本结果。
5. 每次 LLM 调用前 drain async run notifications，并以动态 reminder 形式注入 history。
6. 第一版最多允许 3 个同时 running 的 async runs。
7. 第一版 async run 只允许只读探索和诊断命令，不允许修改源码。
8. async run 必须声明 `resources.read_paths` / `resources.write_paths`，其中 `write_paths` 第一版必须为空。
9. `executor: "command"` 只执行严格白名单内的诊断命令。
10. `executor: "subagent"` 使用隔离 child Agent，但工具集是只读过滤版。
11. default 模式下启动 async run 需要用户确认；async run 内部不再交互式 ask。
12. 完整输出写入 Agent 全局 `.task_outputs/async-runs/<run_id>/`，通知和 tool result 只包含摘要。
13. 支持可选关联 PDD12 `group_id/task_id`，但 async run 不自动更新持久化 Task。
14. 为 PDD14 scheduler 预留触发元数据；scheduler 未来触发 async run，而不是自己管理执行生命周期。
15. 保持 prompt cache 友好：工具定义启动时注册，动态状态通过 reminder 注入，不改稳定 system prompt。

## 非目标

1. 第一版不实现跨进程恢复 async run。
2. 第一版不实现定时任务本身；PDD14 再设计 schedule 存储、触发和 proactive wake-up。
3. 第一版不实现长期守护进程、任务队列数据库或云端执行器。
4. 第一版不实现人工 cancel。可靠取消需要 LLM call、child process 和 Agent loop 都支持中断，留给后续版本。
5. 第一版不允许 async run 写源码、编辑文件、提交 git 或 push。
6. 第一版不允许 async subagent 调用 `run_task_*`、`run_memory_*`、`run_todo_*`、`run_subagent` 或 `run_async_*`。
7. 第一版不实现 async runs 之间的锁、等待、依赖或冲突重试。
8. 第一版不把完整日志注入 prompt。
9. 第一版不自动把 async run 结果写回 PDD12 Task Group。
10. 第一版不实现 `run_parallel_tasks` 或 `run_async_wait`。并行来自多个 `run_async_start`，汇总由父 Agent 通过 check/list/output_read 完成。

## 术语

| 术语 | 含义 |
| --- | --- |
| Persistent Task | PDD12 的长期任务，表示工作目标、依赖和进度 |
| TODO | 当前 session 的短期执行步骤清单 |
| Subagent | 带独立 history / tools / permission / session 的 child Agent 执行器 |
| Command | 一条明确的 shell 命令，不包含独立 Agent 上下文 |
| Executor | async run 的实际执行器，第一版为 `command` 或 `subagent` |
| Async Run | 当前 session 内的一次非阻塞运行实例 |
| AsyncRunRecord | async run 表中的记录，保存 run id、executor、状态、资源声明、输出引用等 |
| Notification | async run 完成、失败或超时后写入的简短通知 |
| Notification Queue | 等待主循环领取的通知收件箱 |
| Output Reference | 完整输出在 `.task_outputs/async-runs/` 下的引用 |
| Resource Claim | LLM 启动 async run 时声明的 `read_paths` / `write_paths` |
| Schedule | PDD14 未来的定时触发规则；触发后创建 async run |

## 四类任务能力的边界

LLM 需要清晰地区分 Task Group、TODO、Subagent 和 Async Run。

| 能力 | 回答的问题 | 生命周期 | 是否阻塞父 Agent | 典型用途 |
| --- | --- | --- | --- | --- |
| Task Group | 长期目标是什么，依赖和进度怎样 | 跨 session / 跨重启 | 不适用 | 多天、多轮、可恢复的工作计划 |
| TODO | 当前 session 怎么一步步推进 | 当前 session 内存 | 不适用 | 本轮执行步骤、避免忘记节奏 |
| `run_subagent` | 让独立 child Agent 做一个旁支探索 | 单次 tool call | 阻塞 | 父 Agent 立刻需要结果 |
| Async Run | 某个执行器正在后台跑到什么状态 | 当前进程/session | 不阻塞 | 慢命令、慢探索、未来定时触发结果 |

推荐 routing policy 写入稳定 system prompt 或工具描述：

```text
Use Task Group for durable work state: long-running goals, dependencies, cross-session progress.
Use TODO for current-session execution steps only.
Use run_subagent for synchronous isolated exploration when the parent needs the result before continuing.
Use run_async_start for non-blocking command or subagent work that can finish later.
Do not use Async Run as a durable plan, and do not use Task Group as a runtime execution slot.
```

推荐执行路径：

```text
Task Group 中的 ready/current task
  -> 如当前任务较复杂，创建 TODO 拆成本轮步骤
  -> 每个 TODO step 具体执行时再选择：
       - 直接 run_read/run_bash/run_write 等普通工具
       - run_subagent 同步探索
       - run_async_start 异步运行 command/subagent
  -> 汇总结果
  -> 更新 TODO
  -> 必要时更新 Task Group 中的持久化 task 状态和 note
```

注意：不是每个 current task 都必须创建 TODO。小任务可以直接执行。TODO 适合 3 步以上、容易跨多轮工具调用或容易丢上下文的当前任务。

## Executor 选择规则

Async Run 第一版支持两个 executor。

| Executor | 本质 | 独立 Agent 上下文 | 会调用 LLM | 适合 |
| --- | --- | --- | --- | --- |
| `command` | 直接跑一条明确 shell 命令 | 否 | 否 | `npm run typecheck`、`git diff`、`rg ...` |
| `subagent` | 启动一个 child Agent 自己探索 | 是 | 是 | 多步调查、分析失败原因、代码审查、综合总结 |

选择规则：

1. 已经知道要执行哪条命令，且原始 stdout/stderr 足够用，选择 `executor: "command"`。
2. 只知道目标，需要它自己决定读哪些文件、跑哪些诊断命令、如何归纳，选择 `executor: "subagent"`。
3. 结果必须立即用于下一步，选择同步 `run_subagent`，不要用 async run。
4. 结果可以稍后回来，选择 `run_async_start({ executor: "subagent" })`。

示例：

```json
{
  "executor": "command",
  "command": "npm run typecheck"
}
```

```json
{
  "executor": "subagent",
  "prompt": "Run typecheck, inspect failures, and summarize likely fixes with file references."
}
```

## 和 PDD14 Scheduler 的关系

PDD14 的定时任务不应该直接实现一套新的执行生命周期。

推荐层级：

```text
Schedule
  -> 描述什么时候触发
  -> 到时间后调用 AsyncRunManager.start()

Async Run
  -> 描述这一次触发产生的运行实例
  -> 管理 run_id/status/output/notification/timeout

Executor
  -> command 或 subagent
  -> 负责实际执行
```

例子：

```text
每天 9 点运行 npm test
  = Schedule
  -> 触发 executor: "command" 的 async run

每天 9 点检查测试失败原因并总结
  = Schedule
  -> 触发 executor: "subagent" 的 async run
```

为 PDD14 预留但不在 PDD13 暴露给 LLM 的内部字段：

```ts
export interface AsyncRunTrigger {
  kind: "manual" | "schedule";
  scheduleId?: string;
  occurrenceId?: string;
  firedAt?: string;
}
```

第一版 LLM tool 启动的 async run 一律使用：

```ts
trigger: { kind: "manual" }
```

未来 scheduler 触发时使用：

```ts
trigger: {
  kind: "schedule",
  scheduleId: "sch_...",
  occurrenceId: "occ_...",
  firedAt: "2026-05-19T09:00:00.000Z"
}
```

PDD13 只要求 `AsyncRunRecord` 能保存这些元数据；不实现 schedule 的创建、持久化、触发循环或 proactive 用户通知。

## 生命周期边界

### 可以跨什么

Async run 可以跨：

1. 多次 LLM call：启动后，模型可以继续调用其他工具；完成通知会在后续 call 前注入。
2. 多个用户 turn：如果 Agent 已经回复用户但 async run 还在 running，下一次用户输入时仍会先 drain 已完成通知。
3. 当前 main session 内的多轮推理：记录保存在进程内 `AsyncRunManager` 闭包中。

### 不能跨什么

Async run 不能跨：

1. 进程重启。
2. 新 main session。
3. timeout 后继续执行新一轮 Agent loop 或新工具调用。
4. 用户项目切换后的路径边界。

### 终态

```ts
export type AsyncRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "abandoned";
```

状态含义：

| 状态 | 含义 |
| --- | --- |
| `running` | 已登记并正在执行 |
| `completed` | 执行成功，输出已落盘 |
| `failed` | 执行失败，错误已落盘 |
| `timeout` | 超过 timeout，record 已收敛为终态 |
| `abandoned` | session 结束时仍未完成，第一版可选实现 |

不设置 `pending`，因为第一版没有队列等待语义。`run_async_start` 要么拒绝，要么创建并立即启动 running 记录。

### 终态收敛规则

必须实现一个中心化的 `finishRun()`：

```ts
function finishRun(record, nextStatus, output, error?): boolean
```

要求：

1. 只有 `record.status === "running"` 时才允许进入终态。
2. 第一个进入终态的路径负责写输出、写 finishedAt、递减 runningCount、推送 notification。
3. late result 不能覆盖 timeout。
4. late result 不能重复递减 runningCount。
5. late result 不能重复推送 notification。

这是 PDD13 的核心正确性要求。

## 工具设计

### `run_subagent`

现有同步工具保留，不在 PDD13 中重命名。

语义：

```text
run_subagent(task, max_rounds?)
  -> 创建 child Agent
  -> 父 Agent 阻塞等待 child Agent 最终结果
  -> 结果作为当前 tool_result 回到父 Agent
```

使用场景：

- 父 Agent 必须马上依赖结果才能继续。
- 子任务需要独立上下文、多步推理或隔离探索。
- 子任务预计不需要并行等待。

PDD13 只需要更新 `run_subagent` 的工具描述，让 LLM 知道：

```text
For non-blocking delegated work, use run_async_start with executor="subagent".
Use run_subagent only when you need the result before continuing.
```

### `run_async_start`

启动一个 async run，立刻返回 `run_id`，不等待执行完成。

参数草案：

```json
{
  "title": "Run typecheck",
  "executor": "command",
  "command": "npm run typecheck",
  "prompt": "可选：当 executor=subagent 时，这里是子 Agent 任务说明",
  "group_id": "tg_20260513_153000_task_system",
  "task_id": "task_2",
  "resources": {
    "read_paths": ["src", "package.json"],
    "write_paths": []
  },
  "timeout_ms": 120000,
  "max_rounds": 8
}
```

字段规则：

- `title` 可选，单行短文本，用于展示和 child session title。
- `executor` 必填，第一版支持 `"command"` 和 `"subagent"`。
- `command` 在 `executor === "command"` 时必填。
- `prompt` 在 `executor === "subagent"` 时必填。
- `group_id` 可选，表示关联的 PDD12 Task Group。
- `task_id` 可选，表示关联的 PDD12 Task。
- `resources.read_paths` 必填，可为空数组；路径必须在 `projectRoot` 内。
- `resources.write_paths` 必填，第一版必须为空数组；非空时拒绝启动。
- `timeout_ms` 可选，默认 120000，最大 300000；超过最大值必须返回 error，不允许 silent clamp。
- `max_rounds` 只对 `executor === "subagent"` 有效，默认 8，最大 20；超过最大值必须返回 error。

返回示例：

```json
{
  "type": "async_run_started",
  "run_id": "ar_20260519_153000_a1b2",
  "status": "running",
  "executor": "command",
  "title": "Run typecheck",
  "group_id": "tg_20260513_153000_task_system",
  "persistent_task_id": "task_2",
  "started_at": "2026-05-19T15:30:00.000Z",
  "timeout_at": "2026-05-19T15:32:00.000Z",
  "resource_claim": {
    "read_paths": ["src", "package.json"],
    "write_paths": []
  }
}
```

`run_id` 格式：

```text
^ar_[0-9]{8}_[0-9]{6}_[a-z0-9]{4,12}$
```

不要使用 `task_id` 作为 async run 的主身份，避免和 PDD12 Task 混淆。

### `run_async_check`

查询单个 async run 状态。

参数：

```json
{
  "run_id": "ar_20260519_153000_a1b2"
}
```

返回示例：

```json
{
  "type": "async_run_status",
  "run_id": "ar_20260519_153000_a1b2",
  "status": "completed",
  "executor": "command",
  "title": "Run typecheck",
  "started_at": "2026-05-19T15:30:00.000Z",
  "finished_at": "2026-05-19T15:30:21.000Z",
  "duration_ms": 21000,
  "preview": "Typecheck passed.",
  "output_ref": {
    "run_id": "ar_20260519_153000_a1b2",
    "path": ".task_outputs/async-runs/ar_20260519_153000_a1b2/output.txt"
  },
  "error": null
}
```

### `run_async_list`

列出当前 session 内的 async runs。

参数：

```json
{
  "status": "running",
  "include_terminal": true
}
```

字段规则：

- `status` 可选，支持 `running/completed/failed/timeout/abandoned`。
- `include_terminal` 可选，默认 `true`。
- 输出必须包含 `run_id/title/status/executor/started_at/timeout_at/preview`。
- 列表结果不包含完整输出。

返回示例：

```json
{
  "type": "async_run_list",
  "count": 2,
  "runs": [
    {
      "run_id": "ar_20260519_153000_a1b2",
      "title": "Run typecheck",
      "status": "running",
      "executor": "command",
      "started_at": "2026-05-19T15:30:00.000Z",
      "timeout_at": "2026-05-19T15:32:00.000Z",
      "finished_at": null,
      "duration_ms": null,
      "preview": "Run is still running..."
    }
  ]
}
```

### `run_async_output_read`

按 `run_id` 读取完整输出。

参数：

```json
{
  "run_id": "ar_20260519_153000_a1b2",
  "max_bytes": 20000
}
```

规则：

- 只接受 `run_id`，不接受 path。
- 实际路径来自 record 的 `outputPath`，且必须位于 `<taskOutputsDir>/async-runs/`。
- `max_bytes` 默认 20000，最大 100000。
- 如果输出还不存在，返回 error。
- 截断时按字节或明确命名为 `max_chars`。第一版建议真正按 UTF-8 byte 截断，避免字段名和行为不一致。

返回示例：

```json
{
  "type": "async_run_output",
  "run_id": "ar_20260519_153000_a1b2",
  "content": "..."
}
```

## 数据结构

### AsyncRunRecord

```ts
export type AsyncRunExecutor = "command" | "subagent";

export type AsyncRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "abandoned";

export interface ResourceClaim {
  readPaths: string[];
  writePaths: string[];
}

export interface AsyncRunRecord {
  id: string;
  executor: AsyncRunExecutor;
  title: string;
  status: AsyncRunStatus;

  groupId?: string;
  persistentTaskId?: string;

  command?: string;
  prompt?: string;
  resourceClaim: ResourceClaim;

  startedAt: string;
  timeoutAt: string;
  finishedAt?: string;
  durationMs?: number;

  preview: string;
  outputPath?: string;
  error?: string;

  childSessionId?: string;
  maxRounds?: number;

  trigger: AsyncRunTrigger;
}
```

### AsyncRunNotification

```ts
export interface AsyncRunNotification {
  id: string;
  runId: string;
  type: "async_run_finished";
  status: "completed" | "failed" | "timeout" | "abandoned";
  executor: AsyncRunExecutor;
  title: string;
  groupId?: string;
  persistentTaskId?: string;
  preview: string;
  outputRef?: { runId: string; path: string };
  timestamp: string;
}
```

### AsyncRunManager

```ts
export interface AsyncRunManager {
  start(input: StartAsyncRunInput): AsyncRunRecord;
  check(runId: string): AsyncRunRecord | null;
  list(query?: AsyncRunListQuery): AsyncRunRecord[];
  readOutput(input: ReadAsyncRunOutputInput): string;
  drainNotifications(): AsyncRunNotification[];
  checkForegroundToolConflict(input: {
    toolName: string;
    args: Record<string, unknown>;
  }): { blocked: boolean; reason?: string };
}
```

所有 public read 必须返回深拷贝，尤其是 `resourceClaim.readPaths/writePaths`，避免外部修改闭包内部状态。

## 存储位置

Async run 输出放在 Agent 全局 task outputs 目录下：

```text
<agentHome>/
└── .task_outputs/
    └── async-runs/
        └── ar_20260519_153000_a1b2/
            ├── output.txt
            └── record.json
```

规则：

- `taskOutputsDir` 来自 `ProjectContext.taskOutputsDir`。
- 不写入 `projectRoot`。
- `record.json` 是运行记录快照，便于调试；第一版不靠它恢复进程内状态。
- `output.txt` 保存完整 stdout/stderr 或 subagent 最终报告。
- tool result 和 notification 只返回 preview + output reference。

## Notification Drain

async run 完成、失败或超时后，`AsyncRunManager` 写入 notification queue。

Agent 每次 LLM 调用前 drain：

```text
user real input / tool result 已进入 history
  -> TODO tick reminder
  -> async run notification drain
  -> prepareMessages()
  -> llm.chat()
```

注入格式：

```text
<system-reminder source="async-run">
Async run updates:
- run_id: ar_20260519_153000_a1b2
  title: Run typecheck
  executor: command
  status: completed
  preview: Typecheck passed.
  full_output: use run_async_output_read with run_id ar_20260519_153000_a1b2
</system-reminder>
```

要求：

1. notification 是一次性投递，drain 后从 queue 移除。
2. record 仍保留，可通过 check/list/output_read 查询。
3. 不把完整输出注入 prompt。
4. drain 产生的是动态 user message，不修改 stable system prompt。
5. transcript 如果已接入，应记录为 `system_reminder` 事件。

## Executor: command

`executor: "command"` 用于明确、机械、可白名单控制的诊断命令。

### 允许命令

第一版建议允许：

```text
git diff
git status
git log
git show
npm run typecheck
npm run lint
npm run format:check
npm test
npx vitest run ...
npx eslint ...
npx tsc ...
rg ...
sed -n ...
cat ...
head ...
tail ...
ls ...
pwd
```

### 必须拒绝的命令形态

在匹配白名单前，必须先拒绝 shell 组合和写入形态：

```text
;
&&
||
`
$(
>
>>
<
|
tee
git add
git commit
git push
git reset
git checkout
npm run format
find -delete
find -exec
```

建议第一版不要允许裸 `find`，因为 `find` 的 `-delete/-exec/-ok` 等参数很容易产生副作用。

如果复用 `child_process.exec()`，必须先做严格字符串检查，因为 exec 会交给 shell 解释。不要只做前缀匹配，否则这些命令会绕过：

```text
git status; touch src/pwned
npm run typecheck && npm run format
```

### command policy 接口

```ts
export interface AsyncCommandPolicy {
  maxTimeoutMs: number;
  validate(command: string): { allowed: boolean; reason?: string };
}
```

实现要求：

1. 复用 `isDangerousCommand()`，危险命令永远拒绝。
2. 先拒绝 shell control operators 和写入重定向，再检查白名单。
3. `run_async_start` 对 command policy violation 直接返回 `ToolResult.error: true`，不要创建一个马上失败的 run。
4. command runner 的 timeout 使用 `min(task timeout 剩余时间, policy.maxTimeoutMs)`。
5. 如果复用现有 `executeBash()`，需要扩展它支持可选 timeout；默认前台 `run_bash` 仍保持现有行为。
6. command output 应合并 stdout/stderr，非零 exit code 记为 `failed`。

## Executor: subagent

`executor: "subagent"` 用于需要多步阅读、分析和总结的非阻塞探索任务。

### 与 `run_subagent` 的区别

| 维度 | `run_subagent` | `run_async_start({ executor: "subagent" })` |
| --- | --- | --- |
| 父 Agent 是否等待 | 等待 | 不等待 |
| 返回值 | 子 Agent 最终文本 | `run_id` |
| 结果回流 | 当前 tool_result | 后续 notification + output_read |
| 适合 | 下一步立即依赖结果 | 可并行、可稍后读结果 |

### child Agent 隔离

每个 async subagent 使用独立：

- `History`
- `ContextCompressor`
- child session
- filtered `ToolRegistry`
- transcript child session 记录

不共享父 Agent 的 history，也不把中间消息写回父 history。

### 工具集

第一版 async subagent 只允许：

- `run_read`
- `run_skill`
- 受限 `run_bash`，只允许 command policy 认可的诊断命令

禁止：

- `run_write`
- `run_edit`
- `run_subagent`
- `run_async_start`
- `run_async_check`
- `run_async_list`
- `run_async_output_read`
- `run_todo_*`
- `run_task_*`
- `run_memory_*`

注意：同步 `run_subagent` 当前可以保留原有能力；PDD13 只要求 async subagent 是只读、安全、非交互式的。

### read path 限制

async subagent 的 `run_read` 不能只靠 prompt 约束。

必须在 tool executor 或 registry wrapper 层校验：

1. 读取路径必须在 `projectRoot` 内。
2. 读取路径必须落在 `resourceClaim.readPaths` 中声明的范围内。
3. 如果 `read_paths` 为空数组，表示不允许读取项目文件，只能使用 skill 或允许命令。
4. 如果需要读取全项目，LLM 必须显式声明 `"."`。

这能保证资源声明和前台冲突检测一致。

### timeout

async subagent 必须有 deadline。

推荐实现：

```ts
export interface RunControl {
  signal: AbortSignal;
  deadlineAt: number;
  isExpired(): boolean;
  throwIfExpired(): void;
}
```

`createAgent()` 可新增可选依赖：

```ts
runControl?: RunControl;
```

Agent loop 要在这些位置检查：

1. 每轮循环开始前。
2. 每次 LLM 调用前。
3. 每次 tool 执行前。
4. 每个 tool result 回写后准备进入下一轮前。

如果 timeout 已到：

- async run record 进入 `timeout`。
- child Agent 不再执行新的 LLM call 或 tool call。
- 如果某个外部 LLM request 已经在飞行中且底层 SDK 不能立即取消，late result 必须被丢弃，不能覆盖 `timeout`。

第一版至少必须保证 record 终态正确、不会继续进入下一轮 Agent loop、不会重复 notification。

### 约束提示

async subagent prompt 前追加动态约束：

```text
<async-run-constraints>
You are running as an isolated async subagent.
Do not modify source files.
Use only the declared read_paths.
Use only read-only diagnostic commands.
Return a concise final report with findings, evidence, and recommended next action.
If a needed command or file access is denied, explain what was blocked and continue with available evidence.
</async-run-constraints>
```

如果关联 PDD12 task：

```text
<persistent-task-context>
group_id: tg_...
task_id: task_2
This async run does not update the persistent Task Group.
The parent agent will decide whether to update task status after reading your result.
</persistent-task-context>
```

## 权限设计

### Tool category

`permission.ts` 新增分类：

```ts
type ToolCategory = ... | "async-run";

if (toolName.startsWith("run_async_")) {
  return "async-run";
}
```

### 权限表

| 工具 | plan | auto | default |
| --- | --- | --- | --- |
| `run_async_check` | allow | allow | allow |
| `run_async_list` | allow | allow | allow |
| `run_async_output_read` | allow | allow | allow |
| `run_async_start` with `executor=command` | deny | allow | ask |
| `run_async_start` with `executor=subagent` | allow | allow | ask |

理由：

- plan 模式不允许直接执行 command。
- plan 模式允许只读 async subagent，但实际工具集必须只读。
- output_read 只接受 `run_id`，不接受 path，因此所有模式可 allow。
- default 模式 ask 的是“启动 async run”这个动作；async run 内部不再 ask，避免后台执行卡住。

确认文案示例：

```text
Allow async run: Run typecheck
executor: command
timeout: 120000ms
read paths: src, package.json
write paths: none
command: npm run typecheck
```

## 前台冲突检查

Async run 第一版只读，但它声明的 read paths 仍然会和前台写入冲突。

`AsyncRunManager` 提供：

```ts
checkForegroundToolConflict({
  toolName,
  args
}): { blocked: boolean; reason?: string }
```

Agent 调用顺序：

```text
LLM tool call
  -> permission check
  -> async foreground conflict check
  -> PreToolUse hook
  -> execute tool
  -> PostToolUse hook
```

规则：

1. 如果没有 running async runs，直接 allow。
2. `run_write` / `run_edit` 的目标路径若与任一 running run 的 `readPaths` 重叠，阻止。
3. `run_bash` 如果存在 running async runs，只允许 strict read-only command policy 通过的命令。
4. 其它工具第一版不做冲突检查。

阻止消息示例：

```text
Blocked: path "src/agent.ts" is currently claimed by running async run ar_...
```

## Agent 集成

`createAgent()` 新增可选依赖，建议使用窄接口：

```ts
asyncRunManager?: Pick<
  AsyncRunManager,
  "drainNotifications" | "checkForegroundToolConflict"
>;
```

主循环新增 notification drain：

```ts
const notifications = asyncRunManager?.drainNotifications() ?? [];
if (notifications.length > 0) {
  appendMessage({
    role: "user",
    content: formatAsyncRunReminder(notifications),
  });
}
```

要求：

1. 每次 LLM call 前 drain。
2. 不修改 stable system prompt。
3. 不改 tool definitions。
4. 不把完整输出注入 prompt。
5. transcript 记录 reminder。
6. 子 Agent 不注入父 Agent 的 asyncRunManager，避免 async run 嵌套。

## Tool Registry 集成

新增 `src/tools/async-runs.ts`，提供 `AsyncRunToolProvider`。

`createToolRegistry()` 增加可选 provider：

```ts
createToolRegistry(
  todoProvider?,
  subagentProvider?,
  skillProvider?,
  memoryProvider?,
  taskProvider?,
  asyncRunProvider?,
  options?
)
```

主 Agent 注册顺序建议：

```text
bash -> files -> todo -> subagent -> skill -> memory -> task -> async-run
```

新增 registry options，用于创建 async subagent 的只读工具集：

```ts
interface ToolRegistryOptions {
  projectRoot?: string;
  includeFileWrite?: boolean;
  includeFileEdit?: boolean;
  commandPolicy?: AsyncCommandPolicy;
  readPolicy?: {
    validate(path: string): { allowed: boolean; reason?: string };
  };
}
```

要求：

1. 主 Agent tool definitions 在进程内稳定。
2. 子 Agent / async subagent 可使用过滤后的 registry。
3. 过滤 registry 不包含 `run_async_*`，避免嵌套。
4. `commandPolicy` 和 `readPolicy` 必须在 tool executor 层生效，不能只靠 prompt。

## 组装根 `index.ts`

组装顺序建议：

1. 创建 `ProjectContext`。
2. 创建 `Logger`、`LLMClient`、`SessionManager`、`TranscriptStore`。
3. 创建 `TodoManager`、`TaskManager`、`SkillManager`、`MemoryManager`、`PermissionManager`、`HookRunner`。
4. 创建 `AsyncRunManager`。
5. 创建 `AsyncRunToolProvider`。
6. 创建 `SubagentToolProvider`。
7. 创建主 `ToolRegistry`。
8. 创建主 `Agent`，注入 `asyncRunManager`。

`AsyncRunManager` 需要的依赖：

```ts
createAsyncRunManager({
  projectRoot,
  taskOutputsDir,
  llm,
  logger,
  createAgentFn,
  createCompressorFn,
  createReadonlyRegistryFn,
  getStableSystemPrompt,
  sessionManager,
  transcriptStore,
  parentSessionId,
  hookRunner,
  permissionManager,
});
```

注意：

- `createReadonlyRegistryFn` 必须真的使用 `commandPolicy/readPolicy`。
- async subagent 不要拿到 todo/task/memory/async/subagent tools。
- command executor 不需要创建 child Agent。

## 文件变更计划

从 PDD12 baseline 开始，新增或修改：

```text
src/async-runs.ts
src/async-runs.test.ts
src/tools/async-runs.ts
src/tools/async-runs.test.ts
src/tools/registry.ts
src/tools/registry.test.ts
src/tools/subagent.ts
src/tools/subagent.test.ts
src/tools/bash.ts
src/tools/bash.test.ts
src/permission.ts
src/permission.test.ts
src/agent.ts
src/agent.test.ts
src/index.ts
doc/summary.md
```

不要新增：

```text
src/background-tasks.ts
src/tools/background-tasks.ts
```

不要注册：

```text
run_background_task_start
run_background_task_check
run_background_task_list
run_background_task_output_read
```

## 错误处理

### `run_async_start` 参数错误

返回 `ToolResult.error: true`：

- `executor` 缺失或非法。
- `executor === "command"` 但缺少 `command`。
- `executor === "subagent"` 但缺少 `prompt`。
- `resources` 缺失。
- `resources.read_paths` 或 `resources.write_paths` 不是数组。
- `write_paths` 非空。
- `read_paths` 越界。
- command policy 拒绝。
- timeout 超过最大值。
- max_rounds 超过最大值。
- running run 已达到 3 个。

### runner 失败

record 变为 `failed`，写 output 和 notification：

- command 非零退出码。
- command 执行异常。
- child Agent LLM 调用失败。
- tool executor 抛错。
- 输出落盘失败。

### timeout

record 变为 `timeout`，写 notification。

要求：

- late result 不覆盖 timeout。
- timeout 后不再进入新的 child Agent loop。
- timeout 后不再执行新的 child Agent tool call。
- output 文件至少包含 timeout 信息；如果已有部分输出，可一起保存。

## 测试计划

### `src/async-runs.test.ts`

覆盖：

1. start command 后立即返回 running record。
2. start subagent 后立即返回 running record。
3. 非法 executor 拒绝。
4. 缺 command/prompt 拒绝。
5. write_paths 非空拒绝。
6. 越界 read_paths 拒绝。
7. command policy 拒绝 shell operators，例如 `git status; touch x`。
8. timeout 超过 300000 拒绝，而不是 clamp。
9. max_rounds 超过 20 拒绝。
10. running 上限 3 生效。
11. command 完成后状态 completed，输出落盘。
12. command 非零退出后状态 failed。
13. subagent 完成后状态 completed，childSessionId 记录。
14. timeout 后状态 timeout。
15. late result 不覆盖 timeout。
16. notification drain 只返回一次。
17. check/list 返回深拷贝，外部修改不影响内部 record。
18. output_read 只能读取 async-runs 输出目录。
19. foreground write 与 running read claim 冲突时阻止。
20. foreground bash 遇到 running runs 时只允许 strict read-only command。
21. async subagent 的 run_read 不能越过 declared read_paths。

### `src/tools/async-runs.test.ts`

覆盖：

1. 4 个工具定义名称正确。
2. `run_async_start` 参数缺失返回 error。
3. start 输出包含 `run_id/status/executor/timeout_at/resource_claim`。
4. check unknown run 返回 error。
5. list 支持 status filter。
6. output_read 不接受 path，只接受 run_id。
7. JSON 输出字段使用 `run_id`，不出现 `task_id` 作为 async run 主身份。

### `src/permission.test.ts`

覆盖：

1. `run_async_*` 被归类为 async-run。
2. check/list/output_read 所有模式 allow。
3. plan 模式拒绝 `executor=command`。
4. plan 模式允许 `executor=subagent`。
5. auto 模式允许 start。
6. default 模式 start ask，确认文案包含 executor、timeout、read/write paths。

### `src/agent.test.ts`

覆盖：

1. 每次 LLM call 前 drain async notifications。
2. notification 以 `<system-reminder source="async-run">` 注入。
3. reminder 包含 `run_async_output_read` 指引。
4. 没有通知时不注入。
5. 前台冲突检查发生在 permission 之后、PreToolUse 之前。
6. 冲突时写入 blocked tool_result，不执行工具。

### `src/tools/registry.test.ts`

覆盖：

1. async run provider 被注册。
2. 工具定义顺序稳定。
3. filtered registry 可以关闭 write/edit。
4. commandPolicy 在 run_bash executor 层生效。
5. readPolicy 在 run_read executor 层生效。
6. 子/async registry 不包含 `run_async_*`。

### `src/tools/subagent.test.ts`

覆盖：

1. `run_subagent` 描述提示同步语义。
2. `run_subagent` 描述提示非阻塞任务使用 `run_async_start executor=subagent`。
3. 现有同步行为不变。

## 实现步骤

建议 coding agent 按这个顺序实现：

1. 确认工作树已回滚到 PDD12 后状态；如果存在旧 `background-tasks` 文件，删除旧实现。
2. 新增 `src/async-runs.ts`，先实现 record table、start/check/list、finishRun、notification queue、output 落盘。
3. 补 `src/async-runs.test.ts` 的生命周期、timeout、clone、output、command policy 测试。
4. 新增 `src/tools/async-runs.ts` 和工具测试。
5. 修改 `tools/registry.ts`，接入 async run provider，并支持 `commandPolicy/readPolicy/includeFileWrite/includeFileEdit`。
6. 修改 `tools/bash.ts`，让 `executeBash()` 支持可选 timeout，保持默认前台行为不变。
7. 修改 `permission.ts`，加入 async-run 分类和权限规则。
8. 修改 `agent.ts`，加入 notification drain 和 foreground conflict check。
9. 修改 `tools/subagent.ts` 描述，强调同步 vs async 的选择规则。
10. 修改 `index.ts` 组装 `AsyncRunManager`、`AsyncRunToolProvider` 和主 Agent 注入。
11. 补 agent/registry/permission/subagent 相关测试。
12. 运行 `npm run typecheck` 和相关 vitest。
13. 更新 `doc/summary.md`，记录 Async Run 已实现状态。

## 验收标准

完成后应满足：

1. LLM 可以调用 `run_async_start` 启动 command async run，并立刻收到 `run_id`。
2. LLM 可以调用 `run_async_start` 启动 subagent async run，并立刻收到 `run_id`。
3. `run_subagent` 仍然同步返回最终文本。
4. Async run 完成/失败/超时后，会在后续 LLM call 前注入 notification。
5. LLM 可以通过 `run_async_check/list/output_read` 查询状态和读取完整输出。
6. Async run 输出写入 Agent 全局 `.task_outputs/async-runs/`。
7. Async run 不写源码，不注册 write/edit/task/todo/memory/subagent/async 工具给 async subagent。
8. Command executor 拒绝 shell operators 和写入命令，不能只靠前缀匹配。
9. Async subagent 的 read access 被 `read_paths` 实际限制。
10. Timeout 是终态；late result 不覆盖，不重复 notification，不重复递减 running count。
11. 前台写入与 running async run 的 read claim 冲突时被阻止。
12. `run_async_start` 不自动更新 PDD12 Task Group。
13. 工具定义在主 Agent 中保持稳定，不因 async run 状态变化而改变。
14. PDD14 scheduler 未来可以调用 `AsyncRunManager.start()` 创建 scheduled async run，无需重做运行实例生命周期。

