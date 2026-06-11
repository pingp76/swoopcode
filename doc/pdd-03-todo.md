# PDD-03: Session TODO 管理器

## 对应教程

第 03 章：让 Agent 规划当前任务。

## 设计目的

TODO 管理器用于当前 session 内的短期执行计划。它帮助模型把一个复杂请求拆成可观察步骤，但不承担长期项目管理、跨会话持久化或多人协作。

## 当前实现

核心源码：

| 文件               | 职责                                             |
| ------------------ | ------------------------------------------------ |
| `src/todo.ts`      | session-local TODO 状态与工具 provider           |
| `src/todo.test.ts` | TODO 状态机与工具行为测试                        |
| `src/agent.ts`     | 在主循环中暴露 TODO 工具并让 TODO 状态参与上下文 |

当前 TODO 工具由 `src/todo.ts` 提供，包含创建、更新、追加、删除、列出、取消等能力。工具名保持 `run_` 前缀和小写命名。

## 状态模型

TODO item 是当前执行计划中的一个步骤，常见状态包括：

- `pending`
- `in_progress`
- `completed`
- `cancelled`

实现重点不是状态枚举多复杂，而是保证同一时刻只有合理数量的 active work，并让模型显式更新计划，不要在最终回答里假装已经做过未执行的步骤。

## 与 Task 的区别

| 能力     | TODO             | Persistent Task      |
| -------- | ---------------- | -------------------- |
| 生命周期 | 当前 session     | 跨 session           |
| 存储     | 内存             | agentHome/task store |
| 用途     | 当前请求执行清单 | 长期工作计划         |
| 工具     | `run_todo_*`     | `run_task_*`         |

如果用户要求“接下来几天逐步完成”，应该使用 Task Group，而不是 TODO。

## 测试入口

- `src/todo.test.ts`
- `src/agent.test.ts`

## 常见错误

1. 把 TODO 当成持久化任务系统。
2. TODO 更新只写自然语言，不更新结构化状态。
3. 每次工具调用都自动改 TODO，导致模型失去显式规划责任。
4. 在子智能体中复用父 TODO，导致旁路探索污染父任务计划。

## 非目标

TODO 不做跨 session 持久化，不做依赖图，不做任务归档，不做通知系统。
