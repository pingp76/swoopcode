# PDD-15: Runtime Hardening 与长期运行鲁棒性

本文是一份分阶段实施的重构设计文档，目标是补上教学 Agent 在长期运行场景下最基础的运行态护栏。它不是前五轮 review 重构的追加修修补补，而是一个新的、可独立实施的 Runtime Hardening 章节。

实施状态（2026-05）：

- Round A 已完成：新增共享原子写入工具；TaskStore、ScheduleStore、OutputStore 的关键 JSON/文本写入已接入原子写；`agent.log` 与 `llm.log` 已支持大小上限轮转。
- Round B-E 尚未实施：Runtime Health Check、Startup Recovery、Retention dry-run/apply、Runtime Lock 仍按本文后续方案推进。

当前项目已经具备 Task、Async Run、Schedule、OutputStore、日志、权限和时间语义等能力。随着这些能力叠加，Agent 会在 `<agentHome>` 下持续产生运行态数据。如果没有清理、恢复、完整性检查和执行上限，长期运行后可能出现日志无限增长、半写入 JSON、悬挂 output 引用、永远 running 的后台记录、重复触发 schedule、多个进程同时写同一份运行数据等问题。

本设计的目标不是把教学项目做成生产级平台，而是用最小但清晰的一组机制，让读者理解“Agent 自身运行数据也需要生命周期管理”。

## 一、当前运行态数据边界

根据当前 `ProjectContext`，Agent 自身的运行数据集中在 `<agentHome>`：

| 路径                        | 当前用途                               | 清理风险                                                |
| --------------------------- | -------------------------------------- | ------------------------------------------------------- |
| `<agentHome>/logs`          | `agent.log`、`llm.log`                 | 日志无限增长或被清空后丢失审计线索                      |
| `<agentHome>/.task_outputs` | OutputStore 大输出、Async Run 兼容输出 | 大文件无限堆积、index 与文件不一致                      |
| `<agentHome>/tasks`         | 持久化 Task Group                      | 不能随便删；需要完整性检查和归档边界                    |
| `<agentHome>/schedules`     | Schedule 与 occurrence                 | 历史 occurrence 增长、running occurrence 重启后需要收敛 |
| `<agentHome>/memory`        | 长期记忆                               | 用户资产，不应自动清理                                  |
| `<agentHome>/skills`        | 技能文件                               | 用户资产，不应自动清理                                  |

重要边界：

1. Runtime cleanup 只允许扫描和修改 `<agentHome>`。
2. 不得清理 `projectRoot` 里的用户项目文件。
3. `memory`、`skills`、`AGENTS.md` 属于用户意图或用户资产，不参与自动清理。
4. Task 与 Schedule 是 durable intent，不等同于临时运行产物，必须默认保留。

## 二、设计目标

### 目标

1. 防止运行态数据无限增长，尤其是日志和大输出。
2. 防止进程崩溃或强制退出后留下半写入文件，导致下次启动读不起来。
3. 提供启动恢复，把可修复问题自动收敛到一致状态。
4. 提供只读健康检查，让用户和教学读者看到 Agent 当前运行数据是否健康。
5. 提供清理预览，先解释“会删什么、为什么能删”，再允许真正删除。
6. 对 Async Run 与 Schedule 的 running 状态做重启收敛，避免长期残留不可完成状态。
7. 保持现有 PDD 递进结构，不抽象成重型框架。

### 非目标

1. 不实现跨机器迁移。
2. 不持久化当前尚未持久化的 Session / Transcript。
3. 不自动删除 memory、skills、项目文件或活跃任务。
4. 不引入数据库。
5. 不实现后台 daemon。
6. 不把所有 store 重写成通用 `JsonEntityStore<T>`。
7. 不实现复杂的分布式锁；只做本机单写者保护。
8. 不在 system prompt 中动态注入大量运行态统计；运行态变化仍通过 reminder 或显式工具表达。

## 三、核心原则

### 1. 先分类，再清理

运行态数据分为四类：

| 类别     | 示例                                          | 默认策略                             |
| -------- | --------------------------------------------- | ------------------------------------ |
| 用户资产 | memory、skills、AGENTS.md                     | 永不自动清理                         |
| 用户意图 | Task Group、Schedule 规则                     | 默认保留；只允许显式 archive/delete  |
| 审计记录 | occurrence、async run record、未来 transcript | 按数量和年龄裁剪，但保留关键失败线索 |
| 执行产物 | logs、tool output、async output               | 可按 TTL、大小、引用关系清理         |

### 2. 清理不能破坏引用

任何 output 文件只要仍被活跃 Task、Schedule occurrence、Async Run notification 或最近审计记录引用，就不能删除。删除时必须同步更新 index 或把引用标记为 `missing/deleted`，不能留下“看似存在但读不了”的 handle。

### 3. 能 dry-run 的操作必须先 dry-run

清理和修复都应该先能生成 preview：

- 会处理哪些文件。
- 预计释放多少空间。
- 为什么它们安全。
- 哪些对象因为仍被引用而跳过。

### 4. 启动恢复只做低风险收敛

启动时可以自动做：

- 清理过期 `.tmp`。
- 把明显 stale 的 running occurrence 标为 `orphaned`。
- 重建可派生 index。
- 把损坏 JSON 移到 `corrupt/`，并继续启动。

启动时不应该自动做：

- 删除用户 Task Group。
- 删除 active Schedule。
- 删除 memory / skills。
- 大规模删除 OutputStore 内容。

### 5. fail closed

如果 health check 或 cleanup 无法判断某个对象是否安全，默认保留并报告原因。不要为了释放空间而猜测删除。

## 四、建议新增模块

### 1. `src/runtime-health.ts`

职责：只读检查 `<agentHome>` 下的运行态健康情况。

建议接口：

```ts
export interface RuntimeHealthReport {
  checkedAt: string;
  agentHome: string;
  summaries: RuntimeHealthSummary[];
  issues: RuntimeHealthIssue[];
}

export interface RuntimeHealthIssue {
  severity: "info" | "warning" | "error";
  area: "logs" | "outputs" | "tasks" | "schedules" | "lock";
  code: string;
  message: string;
  path?: string;
  suggestedAction?: string;
}
```

第一版检查项：

1. `<agentHome>` 是否存在、是否可读写。
2. `logs` 总大小、单个日志是否超过阈值。
3. OutputStore index 是否可读，record 指向的文件是否存在。
4. output 文件是否存在但没有 index record。
5. Task index 是否能从 group 文件重建。
6. Schedule index 是否能从 schedule 文件重建。
7. occurrence 是否存在 stale running。
8. 是否存在旧 `.tmp` 文件。
9. 是否存在 runtime lock 冲突。

### 2. `src/runtime-retention.ts`

职责：生成清理候选与执行清理。

建议接口：

```ts
export interface RetentionPolicy {
  logsMaxBytes: number;
  logsKeepFiles: number;
  outputMaxAgeDays: number;
  outputMaxTotalBytes: number;
  asyncOutputMaxAgeDays: number;
  occurrenceMaxPerSchedule: number;
  occurrenceMaxAgeDays: number;
}

export interface CleanupPlan {
  createdAt: string;
  dryRun: boolean;
  items: CleanupItem[];
  skipped: CleanupSkippedItem[];
  totalReclaimableBytes: number;
}

export interface CleanupItem {
  area: "logs" | "outputs" | "async_runs" | "schedule_occurrences" | "tmp";
  action: "delete_file" | "rotate_log" | "prune_index_record" | "mark_orphaned";
  path?: string;
  id?: string;
  bytes?: number;
  reason: string;
}
```

第一版只处理低风险对象：

1. 过期 `.tmp`。
2. 过大的普通日志轮转。
3. 旧 async legacy output 文件。
4. OutputStore 中“无引用、超过 TTL”的输出。
5. Schedule occurrence 中“终态、超过保留数量、没有活跃引用”的历史记录。

### 3. `src/runtime-lock.ts`

职责：保护同一个 `<agentHome>` 不被两个进程同时写。

建议行为：

1. 启动时创建 `<agentHome>/agent.lock`。
2. lock 内容包含：
   - `pid`
   - `hostname`
   - `startedAt`
   - `projectRoot`
3. 如果 lock 存在：
   - pid 仍存活：拒绝启动或进入只读诊断模式。
   - pid 不存在：标记为 stale lock，允许覆盖，并在 health report 中记录。
4. 进程正常退出时删除 lock。

教学裁剪：

- 不处理 NFS 或跨机器锁。
- 不做复杂 lease 续约。
- 不把 lock 做成权限系统的一部分。

### 4. `src/atomic-write.ts`

职责：收敛 store 里重复的安全写文件模式。

建议只提供两个小函数：

```ts
export function atomicWriteTextFile(path: string, content: string): void;
export function atomicWriteJsonFile(path: string, value: unknown): void;
```

原则：

1. 写入同目录 `.tmp` 文件。
2. 写完后立刻读取并校验 JSON。
3. `rename` 覆盖正式文件。
4. 失败时清理临时文件。

不建议第一版做泛型 store。教学上保留 TaskStore、ScheduleStore、OutputStore 各自业务校验更清楚，只把“原子写文件”抽出来。

### 5. `src/runtime-recovery.ts`

职责：启动时执行低风险恢复。

第一版恢复动作：

1. 清理过期 `.tmp`。
2. 将损坏 JSON 移动到同级 `corrupt/<timestamp>-<filename>`。
3. 重建 Task / Schedule 派生 index。
4. 把重启后遗留的 `running` schedule occurrence 收敛为 `orphaned`。
5. 生成 recovery report，注入一次 session reminder，告知本次启动修复了什么。

如果担心模块过多，也可以先把 `runtime-recovery.ts` 与 `runtime-health.ts` 合并，等教学推进到第二轮再拆。

## 五、现有模块改动计划

### A. OutputStore

文件：

- `src/output-store.ts`
- `src/output-store.test.ts`

改动：

1. 增加 `listRecords()`，返回只读 record 列表。
2. 增加 `findDanglingRecords()`，检查 index record 指向的文件是否存在。
3. 增加 `findUnindexedFiles()`，找出 `outputs/*.txt` 中没有 index record 的文件。
4. 增加 `deleteRecord(outputId, reason)`，删除文件并更新 index。
5. `deleteRecord()` 必须：
   - 校验 output id。
   - 校验 relativePath 不逃逸 output root。
   - 先删除文件或确认文件不存在。
   - 再原子写 index。
6. 保留 `run_output_read` 的只读边界，不让 LLM 通过普通工具随意删 output。

测试：

- record 文件缺失时 health 能报告，不崩溃。
- 未登记文件能被识别为 orphan file。
- 删除 record 后 index 和文件同步变化。
- 删除不存在文件时能收敛 index，而不是抛出不可恢复错误。
- 路径逃逸记录不能被删除逻辑利用。

### B. ScheduleStore / ScheduleManager

文件：

- `src/schedule-store.ts`
- `src/schedules.ts`
- `src/schedules.test.ts`

改动：

1. 增加 occurrence 枚举接口，支持按 scheduleId、状态、时间排序读取。
2. health check 检查：
   - active schedule 是否有非法 nextRunAt。
   - occurrence 文件名与内容 id 是否一致。
   - running occurrence 是否已经 stale。
3. recovery 将重启残留的 running occurrence 标记为 `orphaned`。
4. retention 对终态 occurrence 做裁剪：
   - 每个 schedule 至少保留最近 N 条。
   - 失败、timeout、orphaned 可以额外保留最近 N 条，方便排查。
   - active schedule 的最近一次 occurrence 永远保留。
5. 清理 occurrence 时必须同时维护 schedule 的展示统计，不能让 `run_schedule_occurrence_list` 出现断裂错误。

测试：

- stale running occurrence 启动后变为 orphaned。
- 每个 schedule 保留最近 N 条。
- 最近失败 occurrence 不会被过早清理。
- 跨项目 schedule 不会被当前项目 cleanup 误删。

### C. TaskStore / TaskManager

文件：

- `src/task-store.ts`
- `src/tasks.ts`
- `src/task-store.test.ts`
- `src/tasks.test.ts`

改动：

1. 使用共享 `atomicWriteJsonFile()` 替代局部写入逻辑。
2. health check 验证：
   - `group_id` 与目录名一致。
   - task id 唯一。
   - 依赖引用存在。
   - 依赖图无环。
   - index 能从 group 文件重建。
3. cleanup 只处理 `.tmp` 和明确 archived/deleted 且用户显式选择的 group。
4. 不默认删除 completed group，因为 completed 仍是用户的长期计划记录。

测试：

- 损坏 group 文件不会导致整个 store 无法启动。
- index 损坏时可重建。
- active group 不会出现在清理候选中。
- completed group 默认不清理。

### D. Async Run

文件：

- `src/async-runs.ts`
- `src/async-runs.test.ts`

改动：

1. 保持 Async Run record session-local，不新增完整持久化。
2. 明确 legacy output 路径 `<taskOutputsDir>/async-runs/<run_id>/output.txt` 是可清理执行产物。
3. retention 可删除已经有 OutputStore record 且超过 TTL 的 legacy output。
4. retention 不删除当前进程内 running run 的 outputPath。
5. health report 展示当前 runningCount、terminal run 数量、output 总大小。

测试：

- running run 的 output 不进入清理候选。
- terminal run 的 legacy output 超过 TTL 后进入清理候选。
- 同一个输出已登记到 OutputStore 时，legacy 文件可被清理但 OutputStore 文件保留。

### E. Logger / LLMLogger

文件：

- `src/logger.ts`
- `src/llm-logger.ts`
- `src/logger.test.ts`

改动：

1. `agent.log` 增加简单轮转：
   - 当前文件超过阈值时改名为 `.1`。
   - 旧 `.1` 改名为 `.2`，最多保留 N 个。
2. `llm.log` 改为同样的轮转策略，避免通过清空文件控制大小而丢失最近历史。
3. 日志轮转失败不影响主流程，但要输出 console warn。
4. 日志路径仍来自 `ProjectContext.logsDir`。

测试：

- 超过阈值时生成轮转文件。
- 保留数量超过上限时删除最旧日志。
- 日志目录不可写时不影响 console 输出。

### F. Index 组装根

文件：

- `src/index.ts`
- `src/index.test.ts`

改动：

1. 创建 `RuntimeLock`，启动时获取 `<agentHome>` 写锁。
2. 创建 `RuntimeHealthChecker` 和 `RuntimeRecovery`。
3. 启动时先执行 recovery，再创建 Task/Schedule/OutputStore 管理器。
4. recovery report 通过 `SessionEventBuffer` 注入一次 `<system-reminder source="runtime-recovery">`。
5. 保持 `index.ts` 仍是 Composition Root，不在本轮拆分 wiring。

注意：

当前 `index.ts` 已经承担很多组装职责，但本轮不借 Runtime Hardening 顺手拆它。否则读者会同时面对“运行态恢复”和“组装根拆分”两件事，教学负担过大。

### G. 工具与 CLI

建议先做 CLI，再决定是否暴露 LLM 工具。

新增 CLI：

- `/runtime health`
- `/runtime cleanup --dry-run`
- `/runtime cleanup --apply`

可选 LLM 工具：

- `run_runtime_health_check`
- 暂不提供 `run_runtime_cleanup_apply`

原因：

1. health 是只读的，适合让 LLM 使用。
2. cleanup apply 是破坏性操作，即使只删 runtime artifact，也应先由用户确认。
3. 如果未来要给 LLM 暴露 cleanup apply，必须走 PermissionManager，且 default 模式 ask、plan 模式 deny、auto 模式也建议 ask。

## 六、默认 Retention Policy

第一版建议默认值保守一些：

| 对象                        | 默认策略                                              |
| --------------------------- | ----------------------------------------------------- |
| `agent.log`                 | 单文件 5MB，保留 5 份                                 |
| `llm.log`                   | 单文件 5MB，保留 5 份                                 |
| OutputStore 输出            | 超过 30 天且无引用才可清理                            |
| OutputStore 总量            | 超过 1GB 时，从最旧且无引用输出开始清理               |
| Async legacy output         | terminal 后超过 7 天可清理                            |
| Schedule occurrence         | 每个 schedule 保留最近 200 条                         |
| Schedule failure occurrence | 每个 schedule 额外保留最近 20 条失败/timeout/orphaned |
| `.tmp` 文件                 | 超过 24 小时清理                                      |
| corrupt 文件                | 默认不清理，只报告                                    |

教学环境可以通过环境变量调整，但不要一开始做复杂配置系统。

可选环境变量：

- `AGENT_RETENTION_OUTPUT_MAX_AGE_DAYS`
- `AGENT_RETENTION_OUTPUT_MAX_BYTES`
- `AGENT_RETENTION_LOG_MAX_BYTES`
- `AGENT_RETENTION_DRY_RUN_ONLY`

## 七、引用完整性模型

第一版需要建立“谁引用了 output”的简单规则。

OutputStore record 可被以下对象引用：

1. Async Run record 的 `outputId`。
2. Schedule occurrence 的 `outputId`。
3. 未来 Task attachment 或 transcript event 的 `outputId`。

当前实现中，Async Run record 是 session-local，重启后不再是长期引用。因此重启后的 OutputStore 引用主要来自 Schedule occurrence。Task 目前没有正式 attachment 字段，不能假设 Task 引用了 output。

清理判断：

1. 如果 output record 有 `scheduleId` / `occurrenceId`，并且对应 occurrence 仍存在，则保留。
2. 如果 output record 的 sourceKind 是 `async_run`，且没有 durable 引用，超过 TTL 后可清理。
3. 如果 output record 的 sourceKind 是 `tool_result`，第一版建议只在超过 TTL 且不在最近 N 个 record 内时清理。
4. 如果无法判断引用关系，保留并在 cleanup skipped 中报告。

## 八、启动恢复流程

建议启动顺序：

```text
createProjectContext()
  -> acquireRuntimeLock()
  -> runRuntimeRecovery()
  -> create stores/managers
  -> runRuntimeHealthCheck()
  -> inject recovery/health reminder if needed
  -> start REPL
```

启动恢复报告示例：

```text
<system-reminder source="runtime-recovery">
Runtime recovery completed.
- removed 3 stale tmp files
- rebuilt schedule index
- marked 1 stale running occurrence as orphaned
- found 2 output records with missing files
Use /runtime health for details.
</system-reminder>
```

注意：

1. reminder 只在有 warning/error 或实际恢复动作时注入。
2. 不修改 stable system prompt。
3. 不修改工具定义。

## 九、实施分轮建议

### Round A：原子写与日志轮转

范围：

- 新增 `atomic-write.ts`
- TaskStore / ScheduleStore / OutputStore index 写入改用共享原子写
- Logger / LLMLogger 增加轮转

为什么先做：

这是最低风险、收益最高的一层。它不改变业务语义，却能减少半写入和日志膨胀。

### Round B：Runtime Health Check

范围：

- 新增 `runtime-health.ts`
- 新增 `/runtime health`
- 只读检查 logs / outputs / tasks / schedules / lock

为什么第二步：

先看见问题，再做清理。教学上也更自然。

### Round C：Startup Recovery

范围：

- 新增 `runtime-recovery.ts`
- 启动时清理 `.tmp`
- 重建派生 index
- 收敛 stale running occurrence
- recovery reminder

为什么第三步：

这一步开始改变磁盘状态，因此必须建立在 health check 已经能解释问题的基础上。

### Round D：Retention Preview

范围：

- 新增 `runtime-retention.ts`
- 新增 `/runtime cleanup --dry-run`
- 只生成 cleanup plan，不删除

为什么第四步：

让用户确认清理候选是否符合预期，避免误删。

### Round E：Retention Apply

范围：

- 新增 `/runtime cleanup --apply`
- 只处理低风险对象：tmp、轮转日志、无引用过期 output、旧 async legacy output、过老 terminal occurrence

为什么最后：

真正删除文件的逻辑必须等引用完整性和 dry-run 输出稳定后再做。

## 十、测试矩阵

必须覆盖：

1. 原子写失败不会留下正式文件半写入。
2. index 损坏时 health 能报告。
3. index 可派生时 recovery 能重建。
4. OutputStore record 指向缺失文件时 health 报 warning。
5. 未登记 output 文件不会被 `run_output_read` 读取。
6. cleanup dry-run 不修改任何文件。
7. cleanup apply 删除 output 时同步更新 index。
8. active schedule 不被清理。
9. active task group 不被清理。
10. stale running occurrence 启动恢复为 orphaned。
11. runtime lock 存在且 pid 活跃时拒绝第二个写进程。
12. stale lock 可被覆盖并记录 warning。
13. 日志轮转保留数量正确。
14. 权限模式下 LLM 不能直接执行 cleanup apply。

建议命令：

```bash
npm run typecheck
npx vitest run src/runtime-health.test.ts src/runtime-retention.test.ts src/runtime-recovery.test.ts
npx vitest run src/output-store.test.ts src/schedule-store.test.ts src/task-store.test.ts src/logger.test.ts
npm test
npx eslint src/runtime-health.ts src/runtime-retention.ts src/runtime-recovery.ts src/atomic-write.ts
```

## 十一、文档更新计划

实施时需要同步更新：

1. `doc/summary.md`
   - 增加 Runtime Hardening 当前状态。
   - 更新日志策略、OutputStore 清理策略、Schedule occurrence 保留策略。
2. `doc/pdd-12-tasks.md`
   - 补充 Task cleanup 的真实边界：默认不删 completed group，只做 archive 或显式删除。
3. `doc/pdd-13-async-run.md`
   - 补充 Async Run legacy output 的 retention 策略。
4. `doc/pdd-14-schedule.md`
   - 补充 Schedule occurrence retention 与 stale running recovery。
5. 后续如正式作为教学章节，可新增：
   - `doc/pdd-15-runtime-hardening.md`

## 十二、实施检查清单

实施前：

- [ ] 确认不读取 `doc/todo.md`。
- [ ] 从 `doc/summary.md` 提取当前真实路径和模块状态。
- [ ] 明确本轮只处理 Runtime Hardening，不顺手拆 `index.ts`。

Round A：

- [x] 新增 `atomic-write.ts`。
- [x] TaskStore index/group 写入使用原子写。
- [x] ScheduleStore index/schedule/occurrence 写入使用原子写。
- [x] OutputStore index/output 写入使用原子写。
- [x] Logger / LLMLogger 增加轮转。
- [x] 测试覆盖写入失败和日志轮转。

Round B：

- [ ] 新增 RuntimeHealthReport 类型。
- [ ] 检查 logs 大小。
- [ ] 检查 OutputStore dangling/unindexed。
- [ ] 检查 Task index/group 一致性。
- [ ] 检查 Schedule index/occurrence 一致性。
- [ ] 新增 `/runtime health`。

Round C：

- [ ] 新增 RuntimeRecoveryReport。
- [ ] 清理 stale `.tmp`。
- [ ] 损坏 JSON 移入 `corrupt/`。
- [ ] 重建可派生 index。
- [ ] stale running occurrence 标记为 `orphaned`。
- [ ] recovery reminder 注入 session event buffer。

Round D：

- [ ] 新增 RetentionPolicy。
- [ ] 生成 cleanup dry-run plan。
- [ ] 解释每个候选的 reason。
- [ ] 对被引用对象生成 skipped item。
- [ ] 确认 dry-run 不修改磁盘。

Round E：

- [ ] cleanup apply 删除 tmp。
- [ ] cleanup apply 轮转日志。
- [ ] cleanup apply 删除无引用过期 output 并更新 index。
- [ ] cleanup apply 删除 async legacy output。
- [ ] cleanup apply 裁剪 terminal occurrence。
- [ ] 破坏性操作走 CLI 显式确认，不默认暴露给 LLM apply 工具。

完成后：

- [ ] 更新 `doc/summary.md`。
- [ ] 更新相关 PDD 的实现备注。
- [ ] 运行 typecheck、focused tests、必要的 full test。
- [ ] 检查 `git diff --check`。

## 十三、最终边界

这轮重构完成后，项目应该具备以下长期运行底线：

1. 日志不会无限增长。
2. 大输出不会永久堆积。
3. 半写入 JSON 不会轻易破坏整个 store。
4. 重启后不会留下不可解释的 running schedule occurrence。
5. 用户可以用一个命令看清 Agent runtime 是否健康。
6. 清理操作可预览、可解释、可拒绝。
7. 用户资产和用户意图不会被自动删除。

这足够作为教学 Agent 的“长期运行鲁棒性”章节，同时不会把项目推向过度工程化。

## 当前已落地范围

本文原本是 Runtime Hardening 的重构设计。当前代码已完成 Round A：`src/atomic-write.ts` 提供同目录临时文件 + rename 覆盖 + JSON 语法校验；TaskStore、ScheduleStore、OutputStore 的关键 JSON 写入已接入原子写；`src/log-rotation.ts` 已接入 `llm-logger.ts`，避免 LLM 通信日志无限增长。

Round B-E 仍是后续方向：Startup Health Check、Startup Recovery、Retention dry-run/apply、Runtime Lock 尚未实现。公开教程和 PDD 只能把它们描述为设计边界，不能描述为已完成能力。
