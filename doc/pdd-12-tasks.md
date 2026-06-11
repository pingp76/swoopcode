# PDD-12: 持久化 Task 任务系统

## 对应教程

第 12 章：跨会话长期任务。

## 设计目的

Task 系统保存跨 session 的长期工作计划。它与 Session TODO 不同：TODO 是当前请求的短期执行清单，Task Group 是可持久化、可恢复、可审计的长期计划。

## 当前实现

核心源码：

| 文件                     | 职责                                        |
| ------------------------ | ------------------------------------------- |
| `src/task-store.ts`      | Task Group 文件存储、索引、读写校验         |
| `src/tasks.ts`           | TaskManager，状态机、依赖校验、active group |
| `src/tools/tasks.ts`     | `run_task_*` 工具 provider                  |
| `src/project-context.ts` | agentHome/task 路径派生                     |
| `src/cli-commands.ts`    | `/task` 相关命令                            |
| `src/atomic-write.ts`    | 原子写入基础设施                            |

## 存储边界

Task 是 agent 运行数据，默认存放在 agentHome 下，而不是项目源码目录。

当前存储布局包含：

- group 文件。
- project 关联索引。
- 临时写入目录。

Runtime Hardening Round A 已将 TaskStore 写入接入共享原子写入工具。启动清理只处理过期临时文件，不删除 completed group。

## 当前工具

- `run_task_group_create`
- `run_task_group_list`
- `run_task_group_read`
- `run_task_add`
- `run_task_update`
- `run_task_delete`

`activeTaskGroupId` 只能作为上下文提醒和默认建议，不能让工具在缺少 `group_id` 时隐式更新某个 group。

## 状态边界

Task Group 和 Task Item 都有明确状态机。状态更新必须显式记录事件，不能只改最终字段。

子智能体可被分配 owner，但第一版不支持多个 agent 并发写同一个 Task Group。

## 测试入口

- `src/task-store.test.ts`
- `src/tasks.test.ts`
- `src/tools/tasks.test.ts`
- `src/cli-commands.test.ts`

## 常见错误

1. 把当前 TODO 自动持久化为 Task。
2. 允许缺少 `group_id` 的 update 隐式修改 active group。
3. 启动清理删除 completed group。
4. 写入时不校验目录名和文件内 id 是否一致。

## 非目标

当前项目不实现看板、甘特图、云同步、多用户 ACL、复杂搜索或数据库索引。
