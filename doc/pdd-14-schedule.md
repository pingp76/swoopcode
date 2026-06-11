# PDD-14: Schedule 定时运行系统

## 对应教程

第 14 章：让 Agent 在未来自动发动。

## 设计目的

Schedule 是持久化定时规则，保存用户希望在未来某个时间或周期触发的 intention。它不直接执行任务，而是在到点时创建 Async Run。

```text
Schedule = 长期定时意图
Occurrence = 某一次应触发实例
Async Run = 真实运行实例
```

## 当前实现

核心源码：

| 文件                      | 职责                                     |
| ------------------------- | ---------------------------------------- |
| `src/schedule-store.ts`   | Schedule/Occurrence 存储、索引、原子写入 |
| `src/schedules.ts`        | ScheduleManager，tick、触发、通知、收敛  |
| `src/tools/schedules.ts`  | `run_schedule_*` 工具 provider           |
| `src/async-runs.ts`       | 被 Schedule 触发的运行实例               |
| `src/execution-policy.ts` | Schedule command/resources 校验          |
| `src/output-store.ts`     | occurrence 输出句柄                      |

## 当前实现边界

已实现：

- Schedule 物理存储在 `<agentHome>/schedules`。
- Tool/CLI/Manager 默认只操作当前 `projectRoot` 的 schedule。
- tick 发现 due occurrence 后创建 Async Run。
- 进程重启后 running occurrence 收敛为 orphaned。
- Schedule trigger command preflight 复用共享 ExecutionPolicy。
- occurrence 保存 `outputId`，让模型通过 `run_output_read` 读取完整输出。
- REPL 退出时可以 stop scheduler，测试中不遗留 timer。

明确未实现：

- 不实现完整 cron parser。
- 不实现 pause/resume。
- 不实现 `queue` 重叠策略。
- 不实现分布式 scheduler、多进程锁、云执行器。
- `saveRawOutput=false`、`linkedTaskUpdate`、`workspace_write` 不暴露给 LLM。
- 不自动修改 Task 状态。

## 工具

- `run_schedule_create`
- `run_schedule_list`
- `run_schedule_read`
- `run_schedule_cancel`
- `run_schedule_delete`
- `run_schedule_occurrence_list`

当前 `run_schedule_create` 只暴露已实现字段，例如 `notify_llm` 和 `summary_prompt`。设计预留字段不能在工具描述中承诺已经可用。

## 权限

Schedule 风险高于普通一次性工具，因为它会在未来自动执行。创建时必须固定 permission profile 和 resource envelope；触发时不再交互式 ask，而是按创建时的边界执行。

## Runtime Hardening 合并结论

ScheduleStore 的 schedule、occurrence 和 index 写入已接入共享原子写入。当前没有实现 occurrence retention；历史 occurrence 裁剪属于未来清理功能，不能在当前工具中承诺。

## 测试入口

- `src/schedule-store.test.ts`
- `src/schedules.test.ts`
- `src/tools/schedules.test.ts`
- `src/execution-policy.test.ts`
- `src/agent.test.ts`

## 常见错误

1. Schedule 直接执行命令，不通过 Async Run。
2. 全局 agentHome 下的 schedule 跨项目误触发。
3. 重启后 running occurrence 永久悬挂。
4. tool schema 暴露未实现字段。
5. 触发时重新询问用户或扩大权限边界。
