# PDD-08: Hook 机制

## 对应教程

第 08 章：在主流程固定位置观察和提醒。

## 设计目的

Hook 允许在 Agent 生命周期的固定时机观察事件或生成提醒，而不把所有扩展逻辑硬塞进 `agent.ts`。

## 当前实现

核心源码：

| 文件                    | 职责                                       |
| ----------------------- | ------------------------------------------ |
| `src/hooks.ts`          | HookRunner、事件类型、执行规则             |
| `src/hooks.test.ts`     | Hook 单元测试                              |
| `src/agent.ts`          | SessionStart、PreToolUse、PostToolUse 集成 |
| `src/session-events.ts` | Hook reminder 进入动态消息尾部             |

## 当前事件

| 事件           | 时机                             | 用途                       |
| -------------- | -------------------------------- | -------------------------- |
| `SessionStart` | 会话开始                         | 输出初始提醒或加载环境提示 |
| `PreToolUse`   | 权限通过后、工具执行前           | 观察即将执行的工具         |
| `PostToolUse`  | 工具执行后、tool result 回写前后 | 生成执行后提醒             |

PreToolUse 放在权限检查之后，是为了避免 Hook 看到本不该执行的敏感动作并产生误导。

## tool_call/tool_result 不变量

Hook 不能插入会破坏 tool_call/tool_result 配对的消息。Hook 输出通过 session reminder 进入动态消息尾部，而不是插到 assistant tool call 和 tool result 中间。

## 测试入口

- `src/hooks.test.ts`
- `src/agent.test.ts`
- `src/session-events.test.ts`

## 常见错误

1. Hook 直接修改 History 中间位置，破坏 provider 消息格式。
2. Hook 内执行工具，绕过 PermissionManager。
3. Hook 抛错导致主任务直接崩溃，而不是被记录并降级。
4. 把 Hook reminder 写进稳定 system prompt。

## 非目标

当前项目只实现轻量进程内 Hook，不实现外部插件进程、远程 webhook、复杂优先级调度或异步队列。
