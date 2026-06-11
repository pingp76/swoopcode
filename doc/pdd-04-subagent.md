# PDD-04: SubAgent 工具

## 对应教程

第 04 章：把旁路探索交给子智能体。

## 设计目的

父 Agent 在主任务中经常需要做旁路探索，例如“只读分析某个目录”“查找可能相关的测试”。如果把这些中间过程全部写入父 History，会迅速污染上下文。

SubAgent 通过工具形式提供一个隔离的短生命周期 Agent：

```text
父 Agent 调用 run_subagent
  -> 创建 child session/history
  -> 复用父级稳定 prompt snapshot 和共享依赖
  -> 运行受限工具集
  -> 返回摘要给父 Agent
```

## 当前实现

核心源码：

| 文件                         | 职责                                       |
| ---------------------------- | ------------------------------------------ |
| `src/tools/subagent.ts`      | `run_subagent` 工具 provider               |
| `src/tools/subagent.test.ts` | 子智能体工具测试                           |
| `src/session.ts`             | main/subagent sessionId 和 parentSessionId |
| `src/agent.ts`               | 支持被子智能体复用的主循环                 |
| `src/index.ts`               | 注入共享依赖与只读 registry factory        |

## 共享与隔离

共享：

- LLM client 或同一 runtime policy 下的 LLM client。
- PermissionManager 的模式和边界。
- Stable system prompt snapshot。
- OutputStore、ProjectContext、Logger 等应共享的基础设施。

隔离：

- child History。
- child Transcript/session。
- child TODO。
- child 工具集通常更受限，默认不再允许无限递归创建 subagent。

## 权限边界

子智能体继承父级权限语义。没有交互式确认能力时，`ask` 应降级为 `deny`，避免子智能体在后台代表用户确认敏感操作。

## Prompt Cache 边界

当前实现保留 cache-friendly fork 的关键原则：子智能体复用父级稳定 prompt snapshot，而不是启动时重新扫描并构造一个漂移的 system prompt。

## 测试入口

- `src/tools/subagent.test.ts`
- `src/agent.test.ts`
- `src/session.test.ts`
- `src/permission.test.ts`

## 常见错误

1. 子智能体重新创建 PermissionManager，导致权限模式与父级不一致。
2. 子智能体继承完整工具集并允许无限递归。
3. 把 child 的全部中间消息写回父 History。
4. 子智能体运行中刷新 system prompt，破坏稳定前缀。

## 非目标

SubAgent 不是多 Agent Team。它只是一个工具调用内的隔离运行实例，不实现真实分布式调度、handoff 协议或多成员协作状态机。
