# PDD-09: 长期记忆 Memory

## 对应教程

第 09 章：跨会话长期事实。

## 设计目的

Memory 保存跨会话仍然有价值的用户偏好或项目事实。它不是聊天日志，也不是 Task，也不是自动总结系统。

## 当前实现

核心源码：

| 文件                     | 职责                                                                |
| ------------------------ | ------------------------------------------------------------------- |
| `src/memory.ts`          | MemoryManager，负责 scan/list/read/create/delete/buildPromptSection |
| `src/tools/memory.ts`    | `run_memory_create/list/read/delete`                                |
| `src/system-prompt.ts`   | 注入轻量 memory index                                               |
| `src/session-events.ts`  | memory 创建/删除后通知当前会话                                      |
| `src/project-context.ts` | agentHome 路径派生                                                  |

## 存储边界

Memory 存在 agentHome 下，而不是用户项目源码目录。这样可以避免个人偏好污染仓库。

应该保存：

- 用户明确要求长期记住的偏好。
- 项目级长期约定。
- 未来任务中可复用的稳定事实。

不应该保存：

- 临时命令输出。
- 未经确认的聊天内容。
- 敏感信息。
- 当前任务进度。

## Prompt 边界

稳定 prompt 只注入轻量 memory index 或摘要。完整 memory 内容应通过工具按需读取。

运行中创建或删除 memory 后，不重写 system prompt，而是通过 session reminder 告知当前会话。

## 测试入口

- `src/memory.test.ts`
- `src/tools/memory.test.ts`
- `src/system-prompt.test.ts`
- `src/session-events.test.ts`

## 常见错误

1. 自动保存所有对话。
2. Memory 删除后当前会话仍不知道删除事实。
3. 把 Memory 全文全部塞进 system prompt。
4. Memory 与当前真实文件冲突时，让 Memory 覆盖真实观察。

## 非目标

当前项目不实现 embedding、向量数据库、云同步、多用户隔离或自动后台总结所有会话。
