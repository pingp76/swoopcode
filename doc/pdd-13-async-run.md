# PDD-13: Async Run 非阻塞运行实例

## 对应教程

第 13 章：后台运行但不丢边界。

## 设计目的

Async Run 表示一次非阻塞运行实例。它解决的是“前台 Agent 不想被慢命令或旁路子任务阻塞”的问题，不是新的长期任务计划，也不是定时系统。

## 当前实现

核心源码：

| 文件                      | 职责                                                  |
| ------------------------- | ----------------------------------------------------- |
| `src/async-runs.ts`       | AsyncRunManager，start/check/list/output/notification |
| `src/tools/async-runs.ts` | `run_async_start/check/list/output_read`              |
| `src/execution-policy.ts` | command executor 的 readonly/ci/workspace_write 边界  |
| `src/output-store.ts`     | 登记 async 输出并提供 `output_id`                     |
| `src/tools/subagent.ts`   | subagent executor 的相邻能力                          |

## 生命周期

Async Run 当前是 session-local 运行实例：

- 可以在当前进程内 start、check、list、read output。
- 完成后产生 notification，前台 Agent 可 drain 并提醒模型。
- 输出优先通过 OutputStore 暴露为 `output_id`。
- 不跨进程恢复，不承诺重启后继续执行。

## Executor

当前支持：

- `command`：受 `ExecutionPolicy` 校验的非交互命令。
- `subagent`：隔离 child Agent 做后台分析。

Schedule 到点后会创建 Async Run，但 Schedule 不重新实现后台状态机。

## 重构合并后的当前边界

- Async Run 不跨重启。Schedule 只能把持久化 occurrence 从 running 收敛为 orphaned，不能恢复已经丢失的 async run。
- command policy 已统一到 `ExecutionPolicy`。
- 旧字段 `outputPath` 保留兼容历史测试；新代码优先使用 `outputId`。
- Async Run 完成回调由 ScheduleManager 单点注册，不通过私有字段二次接线。

## 测试入口

- `src/async-runs.test.ts`
- `src/tools/async-runs.test.ts`
- `src/execution-policy.test.ts`
- `src/tools/subagent.test.ts`
- `src/agent.test.ts`

## 常见错误

1. 把 Async Run 当成持久化任务系统。
2. 重启后假装可以恢复后台进程。
3. command executor 自己维护白名单，不复用 ExecutionPolicy。
4. 把输出绝对路径直接暴露给模型。
5. 未处理前台冲突，例如同一资源同时被前台和后台写入。

## 非目标

当前项目不实现人工 cancel、跨进程恢复、任务队列数据库、云端执行器、并行依赖图或 `run_async_wait`。
