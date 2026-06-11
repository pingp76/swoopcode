# PDD-11: LLM 错误恢复

## 对应教程

第 11 章：LLM 出错时不要崩。

## 设计目的

真实 LLM 调用会遇到限流、网络失败、上下文超限、输出截断和 provider 格式异常。Recovery 机制让 Agent 对错误做出明确、有限、可测试的恢复决策，而不是无限 retry 或静默失败。

## 当前实现

核心源码：

| 文件                | 职责                                            |
| ------------------- | ----------------------------------------------- |
| `src/recovery.ts`   | 错误分类、恢复决策、backoff 策略                |
| `src/agent.ts`      | 包装 LLM 调用，执行 compact/continue/fail       |
| `src/history.ts`    | `replaceEntries()` 支持恢复性压缩后替换 History |
| `src/compressor.ts` | 上下文过长时配合全量压缩                        |
| `src/transcript.ts` | 记录恢复相关事件                                |

## 恢复动作

| 动作       | 语义                                          |
| ---------- | --------------------------------------------- |
| `backoff`  | 限流或临时网络错误，等待后重试                |
| `compact`  | 上下文超限，压缩当前 History 后重试           |
| `continue` | 输出被截断，追加 continuation reminder 后继续 |
| `fail`     | 不可恢复或预算耗尽，返回清晰失败              |

恢复状态只属于当前 `agent.run()`，不能跨用户 turn 复用。

## 与工具调用的关系

工具一旦执行，不应因为 LLM retry 而重复执行同一个副作用工具。Recovery 包装的是 LLM 调用阶段，工具执行阶段的错误通过 tool result 或工具错误返回给模型观察。

## 时间语义

当前实现使用 `turnIndex`、`loopRound`、`loopIndex` 和 `messageSequence` 维护恢复前后的消息顺序。`blocksToEntries()` 优先读取消息内部 timing 字段，避免 compact 后把一个 block 内所有消息时间语义覆盖成同一个值。

## 测试入口

- `src/recovery.test.ts`
- `src/history.test.ts`
- `src/agent.test.ts`
- `src/compressor.test.ts`

## 常见错误

1. 所有错误都无限 retry。
2. 上下文超限后继续追加消息而不压缩。
3. provider 错误格式泄漏到 Agent 主循环。
4. LLM retry 导致工具副作用重复执行。

## 非目标

当前项目不实现复杂熔断、并发请求池、跨进程恢复队列或 provider 级健康检查。
