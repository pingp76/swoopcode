# PDD-01: 最小 Agent Loop

## 对应教程

第 01 章：最小 Agent Loop。

## 设计目的

最小 Agent Loop 解决的不是“如何调用一次 LLM”，而是如何把一次普通模型请求组织成可持续扩展的 coding agent harness。

当前最小闭环是：

```text
REPL 接收用户输入
  -> Agent 写入 user message
  -> History 生成 messages
  -> LLMClient 调用模型
  -> Agent 写入 assistant message
  -> REPL 打印最终回答
```

后续工具调用、权限、压缩、记忆、任务、异步运行和 Eval 都插在这个 loop 的固定位置上。

## 当前实现

核心源码：

| 文件              | 职责                                                           |
| ----------------- | -------------------------------------------------------------- |
| `src/index.ts`    | 组装根，创建共享实例并通过依赖注入接线                         |
| `src/repl.ts`     | 命令行交互层，把用户输入交给 `agent.run()`                     |
| `src/agent.ts`    | 主循环，负责 think -> act -> observe                           |
| `src/history.ts`  | 保存 system/user/assistant/tool 消息和 timing metadata         |
| `src/llm.ts`      | LLM 客户端，调用 provider 并收敛 streaming/tool/reasoning 响应 |
| `src/terminal.ts` | 终端输入输出封装，REPL 与权限确认复用                          |

当前 Agent 已经超过最小形态，包含工具、权限、压缩、恢复、Transcript、Runtime Policy 等能力。但第 01 章阅读时只需要关注：

1. 用户 query 如何进入 History。
2. 每轮 LLM 请求如何由当前 History 构建。
3. assistant response 如何回写 History。
4. 没有 tool call 时如何返回最终文本。

## 模块边界

- `index.ts` 负责创建依赖，不承载业务流程。
- `repl.ts` 负责交互，不维护 agent 内部状态。
- `agent.ts` 拥有主循环，但通过接口接收 LLM、History、ToolRegistry、PermissionManager 等依赖。
- `history.ts` 是 session-local 工作上下文，不是长期记忆，也不是审计日志。
- `transcript.ts` 是 append-only 原始事件流，用于审计和回放；它与 History 分离。

## 状态语义

当前实现使用 `src/timeline.ts` 收口时间语义：

- `turnIndex`：用户 turn。
- `loopRound`：当前用户 turn 内的 LLM 循环轮次。
- `loopIndex`：跨 turn 的全局 LLM 调用序号。
- `messageSequence`：History entry 的稳定顺序。

这些字段用于压缩、Transcript、调试和测试，避免把“第几轮用户输入”和“第几次 LLM 调用”混用。

## 测试入口

- `src/agent.test.ts`：Agent 主循环、Hook、错误恢复、Transcript、reasoning 集成。
- `src/history.test.ts`：History 消息顺序、metadata、替换与清理。
- `src/transcript.test.ts`：事件 sequence 与 historySequence。
- `src/session.test.ts`：sessionId、parentSessionId 与项目元信息。

## 常见错误

1. 在 `agent.ts` 内部直接创建 LLM 或 Terminal，导致测试和子智能体无法替换依赖。
2. 只保存 user message，不保存 assistant message，导致多轮上下文断裂。
3. 把 Transcript 当作 History 使用，导致审计日志和工作上下文边界混乱。
4. 把 system prompt 当普通对话消息随意压缩或改写，破坏 cache-friendly 设计。

## 非目标

第 01 章不设计工具调用、权限、压缩、长期记忆、异步运行或定时运行。这些能力在后续 PDD 中分别定义。
