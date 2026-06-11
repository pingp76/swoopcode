# PDD-10: Prompt Cache 友好的请求布局

## 对应教程

第 10 章：稳定前缀与动态提醒。

## 设计目的

Agent 越复杂，请求中越容易混入大量稳定内容和动态内容。Prompt Cache 友好布局要求把两者分开：

```text
Stable Prefix:
  system prompt snapshot
  tool definitions
  stable project context / memory index

Dynamic Tail:
  history messages
  session reminders
  tool results
  working evidence
```

这既服务 provider prompt cache，也服务行为稳定和子智能体快照一致性。

## 当前实现

核心源码：

| 文件                    | 职责                                             |
| ----------------------- | ------------------------------------------------ |
| `src/system-prompt.ts`  | 稳定 system prompt snapshot 与动态 reminder 格式 |
| `src/session-events.ts` | 运行中事件缓冲，drain 为 system-reminder         |
| `src/cache-debug.ts`    | system/tools/prefix hash 调试                    |
| `src/tools/registry.ts` | 工具定义稳定顺序与重复注册保护                   |
| `src/stable-context.ts` | 稳定上下文 pack 与 hash                          |
| `src/agent.ts`          | 每轮构建 LLM 请求并合并动态 reminder             |
| `src/llm-logger.ts`     | 记录请求/响应与 cache debug 信息                 |

## 当前实现边界

已实现：

- 会话级 stable system prompt snapshot。
- Skill/Memory/Hook/Schedule 等运行事件通过 session reminder 进入动态尾部。
- 工具定义按稳定顺序导出，重复注册报错。
- `cache-debug.ts` 记录本地 hash，用于发现前缀漂移。
- 子智能体复用父级稳定 prompt snapshot。
- LLM 日志轮转，避免单个日志无限增长。

未实现：

- 不实现 Anthropic 原生 `cache_control`。
- 不实现跨 provider cache 抽象参数。
- 不把本地 hash 当作真实 cache hit rate。
- 不在当前会话中自动刷新 system prompt；未来如需要，应使用显式 refresh/invalidation。

## 设计取舍

动态状态不能写进 system prompt 开头。例如 TODO、hook reminder、memory 创建提示、当前时间戳都属于动态状态。它们应该进入 messages 尾部。

权限模式也不通过动态隐藏工具 schema 表达。权限应该在执行前检查，而不是让 tools 每轮变来变去。

## 测试入口

- `src/system-prompt.test.ts`
- `src/session-events.test.ts`
- `src/cache-debug.test.ts`
- `src/tools/registry.test.ts`
- `src/tools/subagent.test.ts`
- `src/agent.test.ts`

## 常见错误

1. 每轮重新扫描所有状态并生成完整 system prompt。
2. memory/skill 变化后直接刷新稳定前缀。
3. 根据 permission mode 动态隐藏工具定义。
4. 把 cache debug hash 写成 provider 真实命中率。
5. 把 provider-specific cache 参数散落进 `agent.ts`，而不是由 adapter/policy 收口。
