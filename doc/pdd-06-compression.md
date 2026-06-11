# PDD-06: 上下文压缩

## 对应教程

第 06 章：当 History 太长时如何保持上下文可用。

## 设计目的

Agent Loop 会持续追加 user、assistant、tool result。上下文压缩的目标是控制 token 增长，同时不破坏 tool_call/tool_result 配对和关键任务证据。

## 当前实现

核心源码：

| 文件                   | 职责                                    |
| ---------------------- | --------------------------------------- |
| `src/message-block.ts` | 把连续消息分组为压缩原子单位            |
| `src/compressor.ts`    | 衰减压缩、即时压缩、全量压缩            |
| `src/normalize.ts`     | LLM 消息合法化和 tool result 修复       |
| `src/output-store.ts`  | 大输出登记与 `output_id` 读取           |
| `src/timeline.ts`      | 压缩年龄使用 `loopIndex` 等统一时间语义 |

## 三层压缩

| 层级        | 触发点          | 当前语义                                                 |
| ----------- | --------------- | -------------------------------------------------------- |
| P0 衰减压缩 | 每轮 LLM 调用前 | 根据全局 `loopIndex` 衰减旧工具结果                      |
| P1 即时压缩 | 工具执行后      | 大工具输出登记到 OutputStore，并在 History 中保留 handle |
| P2 全量压缩 | 上下文超过阈值  | 对旧块进行摘要或裁剪，保留近期和关键证据                 |

P1 当前优先使用 OutputStore；未注入 OutputStore 的单独压缩器实例仍保留旧文件 fallback，便于早期 lesson 和单元测试独立运行。

## Message Block 不变量

压缩不能随意截断单条消息。`MessageBlock` 是压缩的最小原子单位，用于保证：

1. assistant tool call 与对应 tool result 不被拆散。
2. system prompt 不被混入普通 user/assistant 压缩块。
3. 压缩后仍能还原为 provider 可接受的 messages。
4. timing metadata 不被错误覆盖。

## 与 OutputStore 的关系

大输出不直接塞进 History。当前实现会登记到 OutputStore，并把 `output_id` 暴露给 LLM。LLM 需要完整内容时调用 `run_output_read`。

## 测试入口

- `src/message-block.test.ts`
- `src/compressor.test.ts`
- `src/normalize.test.ts`
- `src/output-store.test.ts`
- `src/agent.test.ts`

## 常见错误

1. 按字符数直接截断消息，破坏 JSON 或 tool result 配对。
2. 用局部 roundCount 判断消息年龄，跨 turn 后语义漂移。
3. 把大输出绝对路径暴露给 LLM。
4. 压缩时丢掉 provider 特殊字段，例如 reasoning 或 tool_calls。

## 非目标

当前项目不实现语义向量压缩，不实现外部数据库检索，也不保证压缩摘要可作为法律/审计证据。
