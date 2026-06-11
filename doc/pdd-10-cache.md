# PDD-10: Prompt Cache 友好的请求布局

## 背景

Anthropic 在 2026-04-30 发布的文章 [Lessons from building Claude Code: Prompt caching is everything](https://claude.com/blog/lessons-from-building-claude-code-prompt-caching-is-everything) 提到一个核心原则：prompt caching 本质上是从请求开头开始做前缀匹配。只要前缀中的 system prompt、工具定义、模型、项目上下文或历史消息发生变化，变化点之后的缓存都无法复用。

当前项目已经实现了 Skill、Memory、权限模式、Hook、上下文压缩、子智能体等能力。这些能力让 Agent 更接近真实 coding agent，但也引入了新的缓存风险：

- `system-prompt.ts` 每轮根据用户输入动态组合 Skill hint 和 Memory hint。
- Memory 在运行时 create/delete/reload 后，下一轮 system prompt 会变化。
- 子智能体目前使用自己的 system prompt 和过滤后的工具注册表。
- 工具定义虽然按注册顺序输出，但没有显式稳定性约束和测试。
- LLM 日志记录了完整请求，但没有记录 system prompt、tools、稳定前缀是否发生变化。

本 PDD 的目标是把项目改造成 cache-ready 的请求布局。即使当前接入的是 OpenAI-compatible 的 MiniMax API，未必能拿到真实 prompt cache 命中率，项目也应该先在架构上满足 prompt caching 的基本约束。

## 核心结论

缓存优化的第一优先级不是继续压缩更多文本，而是让请求开头尽可能稳定。

推荐请求布局：

```text
1. 静态 system prompt
2. 稳定工具定义
3. 项目级固定说明
4. 会话启动时的 Skill/Memory 快照
5. 对话历史
6. 本轮用户输入和 system-reminder
```

关键规则：

- 静态内容放前面，动态内容放后面。
- 不要为了状态变化修改 system prompt。
- 不要在会话中途添加、删除或重排工具定义。
- 不要在会话中途切换模型。
- Memory、mode、reload 等变化通过消息提醒模型，而不是重写 system prompt。
- fork 类操作，例如子智能体和未来的 LLM compaction，应尽量复用父会话的 system prompt、工具定义和历史前缀。

## 目标

本阶段实现或设计以下能力：

- System prompt 动静分离，避免每轮重建稳定前缀。
- Memory 变更后不立即修改 system prompt，通过 `<system-reminder>` 提醒模型。
- `/mode` 变化不改变工具列表，不改变 system prompt，只通过提醒消息表达当前状态。
- 工具定义顺序稳定，重复注册报错，提供稳定性测试。
- LLM 日志增加 cache debug 信息，帮助观察 system prompt/tools/prefix 是否变化。
- 子智能体设计为 cache-safe fork 的方向：复用父级稳定前缀，使用相同工具定义，通过执行层限制能力。
- 更新后续设计约束：未来新增功能时优先考虑 prompt cache 前缀稳定性。

## 非目标

本阶段不做这些事情：

- 不实现 Anthropic 原生 `cache_control` 参数。
- 不承诺显示真实 prompt cache hit rate，除非底层 API response 明确返回相关 usage 字段。
- 不引入新的外部依赖。
- 不把全部工具改成 deferred tool loading。本项目工具数量少，先保持教学清晰。
- 不把当前规则压缩改成 LLM 摘要压缩。
- 不实现跨模型 cache 复用。prompt cache 通常是模型隔离的。

## 术语

| 术语            | 含义                                                                       |
| --------------- | -------------------------------------------------------------------------- |
| 稳定前缀        | 多次请求开头完全相同的一段内容，包含 system prompt、工具定义、固定上下文等 |
| 动态消息        | 随当前轮变化的 user/tool/assistant 消息                                    |
| 会话快照        | 会话启动时固定下来的 Skill/Memory 摘要                                     |
| system-reminder | 用 user message 或 tool result 携带的系统提醒，不修改 system prompt        |
| fork 请求       | 基于父会话前缀派生的旁路请求，例如子智能体、未来 LLM compaction            |
| cache debug     | 本项目教学版缓存观测信息，例如 prompt hash、tools hash、prefix hash        |

## 当前实现问题

### 问题 1: System prompt 每轮动态重建

当前 `src/agent.ts` 在每次 `run(query)` 开头调用：

```typescript
const prompt = systemPromptProvider.build(query);
history.setSystemPrompt(prompt ?? "");
```

`systemPromptProvider.build(query)` 会根据当前用户输入判断是否忽略 memory，并动态读取最新 Memory hint。这会导致：

- 普通对话中 memory 文件变化会改变 system prompt。
- “本轮不要使用 memory”会通过删除 memory hint 改变 system prompt。
- Skill/Memory 顺序或内容变化会导致请求前缀变化。

### 问题 2: Memory 变更直接影响下一轮 prompt

当前 `MemoryManager.buildPromptSection()` 读取缓存中的最新 memory。由于 system prompt 每轮重新构建，memory create/delete/reload 会在下一轮改变 system prompt。

这符合“最新状态优先”的直觉，但不符合 prompt cache 的前缀稳定原则。

### 问题 3: 工具定义缺少稳定性契约

当前 `ToolRegistry` 使用 `Map` 保存工具，注册顺序在正常情况下是稳定的。但文档和测试没有明确要求：

- 相同启动条件下工具顺序必须完全一致。
- `/mode` 不能改变工具定义。
- `/skill load` 和 `/memory reload` 不能改变已传给模型的工具 schema。
- 重复注册同名工具应该报错。

### 问题 4: 子智能体不是 cache-safe fork

当前 `run_subagent` 创建独立 history 和过滤后的工具注册表。这保证隔离简单，但缓存上有两个问题：

- 子智能体 system prompt 不是父会话同一个稳定前缀。
- 子智能体工具定义少于父智能体，工具前缀不同。

如果未来使用支持 prompt caching 的模型，这会让子智能体调用无法复用父会话缓存。

### 问题 5: 日志无法观察缓存稳定性

当前 `llm-logger.ts` 完整记录 messages 和 tools，但没有摘要指标。实现者需要人工对比大段日志，才能知道是 system prompt、工具定义还是消息前缀发生了变化。

## 总体设计

### 请求布局

Agent 给 LLM 的请求必须遵循以下顺序：

```text
system:
  Static agent instructions
  Skill session snapshot
  Memory session snapshot

tools:
  Stable tool definitions in fixed order

messages:
  Historical user/assistant/tool messages
  Current user query
  <system-reminder>...</system-reminder> messages for this turn
```

重要说明：

- `system` 在一个会话内默认不变。
- `tools` 在一个会话内不变。
- `messages` 可以持续增长和压缩。
- 动态状态变化通过 messages 进入模型。

### System prompt 分层

把 prompt 分为三类：

| 层级             | 内容                                         | 生命周期                      | 是否允许本轮动态修改 |
| ---------------- | -------------------------------------------- | ----------------------------- | -------------------- |
| Static           | Agent 基础行为、教学项目规则、Skill 使用规则 | 进程启动后固定                | 否                   |
| Session Snapshot | 启动时的 Skill 列表、Memory 摘要             | 会话内固定，显式 refresh 才变 | 否                   |
| Turn Reminder    | 本轮忽略 memory、mode 切换、memory reload    | 单轮或少数轮                  | 是，通过 message     |

本阶段不需要把 Static 和 Session Snapshot 存成两个 system message，因为 OpenAI-compatible Chat Completion 通常只需要一个 system message。实现上可以组合成一个稳定 system prompt 字符串，但必须保证组合发生在会话启动或显式 refresh 时，而不是每轮发生。

## 详细模块设计

## 1. 新增 `src/session-events.ts`

新增一个轻量的会话事件缓冲区，用来收集 out-of-band 状态变化，并在下一次用户请求时注入为 `<system-reminder>`。

### 接口

```typescript
export interface SessionReminder {
  source: "memory" | "mode" | "skill" | "cache" | "system";
  message: string;
}

export interface SessionEventBuffer {
  push(reminder: SessionReminder): void;
  drain(): SessionReminder[];
  peek(): SessionReminder[];
}

export function createSessionEventBuffer(): SessionEventBuffer;
```

### 行为

- `push()` 只保存短消息，不保存大型内容。
- `drain()` 返回当前所有提醒并清空缓冲区。
- `peek()` 用于测试和调试，不清空。
- 多个提醒在下一轮合并为一条 user message，避免插入太多消息。
- 每条提醒格式由 agent 统一包装，不让各模块自己拼 XML。

### reminder 格式

Agent 注入时使用以下格式：

```text
<system-reminder source="memory">
Memory was updated during this session. The stable system prompt snapshot was not changed. Use run_memory_list or run_memory_read if the latest memory matters.
</system-reminder>
```

如果一轮有多个提醒：

```text
<system-reminder source="mode">
Mode changed to plan. Follow plan-mode constraints. Local permission checks still enforce the mode.
</system-reminder>

<system-reminder source="memory">
Memory was reloaded. Use memory tools if the latest entries matter.
</system-reminder>
```

### 测试

新增 `src/session-events.test.ts`：

- `drain()` 返回后清空。
- `peek()` 不清空。
- 多条提醒保持插入顺序。

## 2. 重构 `src/system-prompt.ts`

当前 `SystemPromptProvider.build(query)` 同时承担“生成 system prompt”和“根据本轮 query 忽略 memory”的职责。需要拆分为稳定 prompt 和本轮提醒。

### 新接口

```typescript
export interface SystemPromptSnapshot {
  systemPrompt: string | null;
  skillHint: string | null;
  memoryHint: string | null;
}

export interface TurnPromptContext {
  query: string;
}

export interface SystemPromptProvider {
  getSnapshot(): SystemPromptSnapshot;
  refreshSnapshot(): SystemPromptSnapshot;
  buildTurnReminders(ctx: TurnPromptContext): SessionReminder[];
}
```

### 创建逻辑

```typescript
export function createSystemPromptProvider(deps: {
  getSkillHint: () => string | null;
  getMemoryHint: () => string | null;
}): SystemPromptProvider;
```

内部行为：

- provider 创建时立即生成一次 snapshot。
- `getSnapshot()` 返回当前稳定快照。
- `refreshSnapshot()` 重新读取 Skill/Memory 并生成新快照，但普通对话不调用。
- `buildTurnReminders({ query })` 只处理本轮动态要求，例如“本轮不要使用 memory”。

### 忽略 memory 的新语义

以前用户说“本轮不要使用 memory”时，系统通过不注入 memory hint 实现。新设计中，稳定 system prompt 不变，本轮追加提醒：

```text
<system-reminder source="memory">
For this turn, do not use long-term memory. Ignore the memory snapshot unless the user explicitly asks to inspect it.
</system-reminder>
```

这样前缀仍然稳定。

### 注意事项

- 不要把当前时间、随机数、hash、计数器写入 system prompt。
- `refreshSnapshot()` 只在用户显式要求“刷新 prompt 快照”或未来新命令中调用。
- `/memory reload` 默认只刷新 `MemoryManager` 本地缓存，不刷新 system prompt snapshot。

### 测试

更新 `src/system-prompt.test.ts`：

- 创建 provider 后，多次 `getSnapshot()` 内容相同。
- memory 源变化后，未调用 `refreshSnapshot()` 时 snapshot 不变。
- 调用 `refreshSnapshot()` 后 snapshot 更新。
- “忽略 memory”“不要使用 memory”“本轮不要使用 memory”“ignore memory”“do not use memory”都会生成 turn reminder，而不是删除 system prompt 中的 memory snapshot。

## 3. 修改 `src/agent.ts`

### 当前流程

当前每轮 `run(query)`：

```text
build system prompt from query
history.setSystemPrompt(...)
append user query
loop:
  prepare messages
  llm.chat(messages, tools)
```

### 新流程

Agent 创建时或 `index.ts` 组装时设置一次稳定 system prompt：

```text
history.setSystemPrompt(systemPromptProvider.getSnapshot().systemPrompt ?? "")
```

每轮 `run(query)`：

```text
append user query
append system-reminder messages from:
  systemPromptProvider.buildTurnReminders({ query })
  sessionEventBuffer.drain()
loop:
  prepare messages
  use stable tools
  llm.chat(messages, tools)
```

### 新依赖

`createAgent()` 增加可选依赖：

```typescript
sessionEventBuffer?: SessionEventBuffer;
```

`systemPromptProvider` 不再用于每轮设置 system prompt，只用于本轮 reminder。

### 注入顺序

推荐顺序：

```text
1. 用户原始 query
2. systemPromptProvider 根据 query 生成的本轮提醒
3. sessionEventBuffer 中积累的 out-of-band 提醒
4. SessionStart hook 注入消息
5. TODO 中断消息
```

如果为了减少改动，也可以保留当前 SessionStart hook 位置，但必须保证所有提醒以 user message 形式进入历史，而不是修改 system prompt。

### 兼容压缩管道

提醒消息使用普通 user message。这样：

- `normalizeMessages()` 可以正常处理。
- `groupToBlocks()` 可以正常分组。
- P0/P1/P2 压缩无需知道 reminder 的特殊语义。

实现备注（2026-05 第五轮重构）：

- reminder 仍然以普通 user message 进入 history，不修改 system prompt。
- history 会给 reminder 附带当前 `turnIndex`、`loopRound`、`loopIndex` 和 `messageSequence`。
- 这些 timing metadata 只在 prepare/group/compact 管线内部流转，`flattenToMessages()` 会在发送给 LLM 前清除内部字段。
- 因此 prompt cache 友好的 stable prefix 设计不变：动态状态仍走 user reminder，而不是 system prompt rewrite。

### 测试

更新 `src/agent.test.ts`：

- `history.setSystemPrompt()` 不会在每次 `run()` 被调用。
- 用户输入“本轮不要使用 memory”时，LLM 请求中包含 `<system-reminder>`。
- sessionEventBuffer 的提醒会在下一轮注入一次，之后不重复。
- reminder 不破坏 tool_call/tool_result 配对。

## 4. 修改 `src/index.ts`

组装根负责创建共享实例。

### 新接线顺序

```text
config
logger
terminal
llm/logger
history
todoManager
skillManager
permissionManager
memoryManager
sessionEventBuffer
systemPromptProvider
tool providers
tool registry
subagent provider
agent
cli commands
repl
```

### 稳定 prompt 设置

在创建 agent 之前：

```typescript
const systemPromptProvider = createSystemPromptProvider({
  getSkillHint: () =>
    skillManager.listMeta().length > 0 ? SKILL_SYSTEM_PROMPT_HINT : null,
  getMemoryHint: () => memoryManager.buildPromptSection(),
});

const snapshot = systemPromptProvider.getSnapshot();
if (snapshot.systemPrompt) {
  history.setSystemPrompt(snapshot.systemPrompt);
}
```

不要在 `agent.run()` 中每轮重新设置。

### 事件缓冲区共享

同一个 `sessionEventBuffer` 传给：

- `createAgent()`
- `createModeCliCommand()`
- `createMemoryCliCommand()`
- `createMemoryToolProvider()`，可选
- 未来的 `/skill reload` 或 `/prompt refresh` 命令

## 5. 修改 `src/cli-commands.ts`

### `/mode`

`/mode plan|auto|default` 仍然只修改 `PermissionManager`，不要改变工具定义和 system prompt。

新增可选依赖：

```typescript
createModeCliCommand(
  permissionManager: PermissionManager,
  logger: Logger,
  sessionEventBuffer?: SessionEventBuffer,
)
```

切换成功后 push reminder：

```text
Mode changed to plan. Keep all tool definitions stable; local permission checks enforce read-only behavior.
```

### `/memory reload`

现有行为：

```text
manager.scan()
manager.rebuildIndex()
```

保持不变，但增加 reminder：

```text
Memory was reloaded. The stable system prompt memory snapshot was not automatically changed. Use run_memory_list/read if latest memory matters.
```

### `/memory remove`

删除 memory 后增加 reminder：

```text
Memory entry "<name>" was removed. The stable system prompt memory snapshot may still mention it until snapshot refresh.
```

### `/skill load`

当前文档已经说明 `/skill load` 只刷新本地缓存，不更新 LLM 可见工具定义。新增 reminder：

```text
Skills were re-scanned. Tool definitions remain the startup snapshot. Restart or explicitly refresh the prompt snapshot if the model must see new skill metadata.
```

### 可选新增 `/prompt refresh`

本 PDD 不强制实现，但建议后续增加：

```text
/prompt refresh
```

作用：

- 调用 `systemPromptProvider.refreshSnapshot()`。
- 更新 `history.setSystemPrompt()`。
- 打印警告：这会破坏当前会话后续 prompt cache 前缀。

教学意义：让用户明确看到“刷新 prompt 快照”和“保持 cache 前缀”之间的取舍。

## 6. 修改 `src/tools/memory.ts`

Memory 工具由 LLM 调用，tool result 本身会进入历史，所以 create/delete 成功后模型已经能看到变化。不过为了缓存语义清楚，建议工具结果明确说明 system prompt snapshot 不会自动更新。

### 新依赖

```typescript
export function createMemoryToolProvider(
  manager: MemoryManager,
  options?: {
    sessionEventBuffer?: SessionEventBuffer;
  },
): MemoryToolProvider;
```

### create 成功输出

当前：

```text
Memory saved: [user] prefer_xxx: ...
```

建议：

```text
Memory saved: [user] prefer_xxx: ...
Note: the stable system prompt memory snapshot is unchanged for cache stability. Use run_memory_list/read for the latest memory if needed.
```

并 push reminder：

```text
Memory was created or updated by tool call. Use memory tools if the latest entry matters in later turns.
```

### delete 成功输出

当前：

```text
Memory "xxx" deleted.
```

建议：

```text
Memory "xxx" deleted.
Note: the stable system prompt memory snapshot may still mention it until prompt snapshot refresh.
```

并 push reminder。

### 权限不变

- `run_memory_list/read` 继续无需确认。
- `run_memory_create/delete` 继续所有模式都需要确认。
- 子智能体默认不应写 memory，即使未来暴露相同工具定义，也要在执行层或权限层拒绝写入。

## 7. 修改 `src/tools/registry.ts`

### 稳定性要求

工具定义必须满足：

- 同一个进程内，多次 `getToolDefinitions()` 返回相同顺序。
- 同样启动条件下，工具定义序列化结果相同。
- 注册同名工具抛错。
- CLI 命令不得在会话中途修改已注册工具定义。

### 建议实现

在 `createToolRegistry()` 内部维护缓存：

```typescript
const orderedEntries: ToolEntry[] = [];
```

`register(entry)`：

- 校验 name 存在。
- 如果 name 已存在，抛错。
- `tools.set(name, entry)`。
- `orderedEntries.push(entry)`。

`getToolDefinitions()`：

- 返回 `orderedEntries.map((entry) => entry.definition)`。
- 不重新排序。
- 不根据 mode、memory、skill runtime state 过滤。

### 是否 deep freeze

教学版可以先不 deep freeze，因为 TypeScript 类型和本地约定已经足够清晰。若实现者愿意增加保护，可以在测试环境中对 definitions 做 `Object.freeze`，但不要为了 freeze 引入复杂递归工具。

### 测试

更新或新增 `src/tools/registry.test.ts`：

- 重复注册同名工具会抛错。
- 多次 `getToolDefinitions()` 工具名顺序一致。
- 创建包含 todo/subagent/skill/memory provider 的完整 registry，顺序稳定。
- `/mode` 切换不会改变工具定义 hash。

## 8. 新增 `src/cache-debug.ts`

当前无法保证底层 API 返回真实 cache hit rate，因此先实现教学版 cache debug。

### 接口

```typescript
export interface CacheDebugSnapshot {
  systemPromptHash: string;
  toolsHash: string;
  stablePrefixHash: string;
  messageCount: number;
  toolCount: number;
}

export interface CacheDebugState {
  current: CacheDebugSnapshot;
  changed: {
    systemPrompt: boolean;
    tools: boolean;
    stablePrefix: boolean;
  };
}

export function createCacheDebugTracker(): {
  inspect(input: {
    messages: ChatCompletionMessageParam[];
    tools: ChatCompletionTool[];
  }): CacheDebugState;
};
```

### hash 规则

使用 Node 内置 `crypto.createHash("sha256")`，不新增依赖。

需要稳定序列化：

- 对普通对象按 key 排序。
- 数组保持顺序。
- string 原样进入 hash。

### stablePrefixHash 的定义

教学版先定义为：

```text
system message content + tools JSON
```

不要把所有历史消息都算入 stable prefix，因为对话历史本来会增长。后续如果要观察更细的前缀变化，可以增加：

- `firstUserContextHash`
- `sessionSnapshotHash`
- `recentHistoryHash`

### 输出语义

不要叫“真实 cache hit rate”。推荐日志：

```text
[cache] systemPrompt=stable tools=stable prefix=stable systemHash=abc123 toolsHash=def456
```

如果变化：

```text
[cache] systemPrompt=changed tools=stable prefix=changed
```

### 真实 usage 的未来兼容

如果未来底层 API 返回类似字段，可以在 `llm.ts` 或 `llm-logger.ts` 中解析：

- `usage.prompt_tokens_details.cached_tokens`
- `usage.cache_read_input_tokens`
- `usage.cache_creation_input_tokens`

但本阶段只作为 optional unknown field 处理，不把它写成必然存在的功能。

## 9. 修改 `src/llm-logger.ts`

### 新增日志内容

`logRequest(messages, tools)` 中增加：

```text
Cache Debug:
  systemPromptHash: ...
  toolsHash: ...
  stablePrefixHash: ...
  systemPromptChanged: yes/no
  toolsChanged: yes/no
```

### 注意

- Hash 只用于调试，不参与业务逻辑。
- 不要把时间戳加入 system prompt 或工具定义。
- LLM 日志里可以有时间戳，因为日志不是请求前缀。

## 10. 修改 `src/llm.ts`

本阶段 `llm.ts` 不需要改变请求参数。不要为了 Anthropic `cache_control` 修改 OpenAI-compatible 请求结构。

可以做一个小的类型扩展：

```typescript
export interface LLMResponse {
  content: string | null;
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  usage?: unknown;
}
```

如果加入 `usage`：

- `llmLogger.logResponse()` 可以记录原始 usage。
- 不要假设某个 provider 一定返回 cache 字段。

如果实现者希望保持最小改动，可以暂时不改 `llm.ts`，只在 request 侧记录 cache debug hash。

## 11. 修改 `src/tools/subagent.ts`

子智能体是本 PDD 中最复杂的部分，建议分两阶段实现。

### 阶段 A: 保持隔离，但复用稳定 prompt snapshot

低风险改动：

- 子智能体不再自己拼 `SKILL_SYSTEM_PROMPT_HINT + memoryHint`。
- `createSubagentToolProvider()` 接收 `getStableSystemPrompt()`。
- 子智能体 history 设置与父级相同的稳定 system prompt snapshot。

这样至少 system prompt 前缀一致。

### 阶段 B: cache-safe fork

更完整的设计：

1. 父 Agent 在每次调用 LLM 前保存最新 fork context。

```typescript
export interface AgentForkContext {
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
}
```

2. `createAgent()` 增加可选依赖：

```typescript
forkContextStore?: {
  set(context: AgentForkContext): void;
  get(): AgentForkContext | null;
};
```

3. 在 `prepareMessages()` 和 `tools.getToolDefinitions()` 后，调用：

```typescript
forkContextStore.set({ messages: finalMsgs, tools: toolDefs });
```

4. `run_subagent` 执行时读取父级 fork context，以父级 messages 为基础追加子任务：

```text
parent cached messages
user: <system-reminder source="subagent">You are running as a subagent...</system-reminder>
user: 子任务 task
```

5. 子智能体使用与父级相同顺序的工具定义。

### 工具能力限制

为了 cache 命中，子智能体最好看到相同工具定义；为了安全，限制放在执行层，而不是通过删除工具定义实现。

建议增加 `ToolExecutionPolicy`：

```typescript
export interface ToolExecutionPolicy {
  canExecute(
    toolName: string,
    args: Record<string, unknown>,
  ): {
    allowed: boolean;
    reason?: string;
  };
}
```

子智能体策略：

- 禁止 `run_subagent`，避免递归。
- 禁止 `run_memory_create` 和 `run_memory_delete`，长期记忆写入必须由父级确认。
- 允许 `run_memory_list/read`。
- 其他工具继续经过 `PermissionManager`。

这样工具定义可以稳定，但执行仍然安全。

### 测试

更新 `src/tools/subagent.test.ts`：

- 子智能体 system prompt 与父级 stable prompt 相同。
- 子智能体工具定义顺序与父级相同，或阶段 A 文档明确还未实现。
- 子智能体调用 `run_subagent` 会被拒绝。
- 子智能体调用 `run_memory_create/delete` 会被拒绝。
- 子智能体可读取 memory 摘要或通过 `run_memory_read` 读取指定 memory。

## 12. 压缩器设计约束

当前 `src/compressor.ts` 的 P2 compaction 是本地规则摘要，不会额外调用 LLM，因此不会产生“摘要调用破坏缓存”的问题。

如果未来把 P2 改成 LLM 摘要，必须遵守 cache-safe fork：

```text
same system prompt
same tool definitions
same parent messages
append user compaction instruction at the end
```

禁止实现成：

```text
system: summarize this conversation
tools: none
messages: full old conversation
```

因为这会从第一个 token 开始破坏缓存前缀。

未来 LLM compaction 还需要保留 compaction buffer：

- 请求中要有空间容纳 compaction instruction。
- 响应中要有空间容纳 summary。
- 触发阈值不能等到上下文完全满了才做。

## 13. 配置设计

新增可选环境变量：

| 变量                | 默认值  | 含义                                |
| ------------------- | ------- | ----------------------------------- |
| `CACHE_DEBUG`       | `true`  | 是否在日志中记录 cache debug hash   |
| `CACHE_DEBUG_PRINT` | `false` | 是否在终端每轮显示 cache debug 简报 |

为什么默认 `CACHE_DEBUG_PRINT=false`：

- 终端每轮打印会干扰普通教学体验。
- `logs/llm.log` 已经足够排查。
- 用户明确调试缓存时再打开终端显示。

如果开启终端显示，输出示例：

```text
[cache] prefix stable, tools stable, system stable
```

或：

```text
[cache] prefix changed: system prompt changed
```

再次强调：这不是底层 API 的真实命中率，只是本项目计算的缓存稳定性信号。

## 14. 文档更新

实现本 PDD 后，需要更新 `doc/summary.md`：

- 当前阶段增加 “Prompt Cache 友好的请求布局”。
- `system-prompt.ts` 描述改为稳定 snapshot + turn reminder。
- 新增 `session-events.ts`。
- 新增 `cache-debug.ts`。
- Memory 说明改为“会话内 system prompt 使用启动快照；变更通过 reminder 注入”。
- 工具系统说明增加“工具定义顺序稳定，不按 mode 动态删减”。
- 子智能体说明根据实际实现阶段更新。

同时建议更新 `AGENTS.md` 的设计约束：

```text
新增功能时优先保持 prompt cache 前缀稳定：
- 不在会话中途修改 system prompt。
- 不在会话中途改变工具定义。
- 动态状态变化通过消息提醒。
- fork 类请求复用父级 stable prefix。
```

## 实施顺序

推荐分阶段开发，避免一次改动过大。

### Phase 1: 稳定 system prompt 和 reminder

1. 新增 `src/session-events.ts`。
2. 重构 `src/system-prompt.ts` 为 snapshot + turn reminder。
3. 修改 `src/index.ts`，启动时设置一次 stable system prompt。
4. 修改 `src/agent.ts`，停止每轮 `history.setSystemPrompt()`，改为追加 reminder。
5. 更新 `src/system-prompt.test.ts`、`src/agent.test.ts`。

验收：

- 普通连续两轮对话中 system prompt hash 不变。
- “本轮不要使用 memory”不会改变 system prompt，只会增加 reminder message。

### Phase 2: CLI/Memory 状态变化走 reminder

1. `createModeCliCommand()` 接入 `SessionEventBuffer`。
2. `createMemoryCliCommand()` 接入 `SessionEventBuffer`。
3. `createMemoryToolProvider()` 成功 create/delete 后输出 cache 语义，并可选 push reminder。
4. 更新相关测试。

验收：

- `/mode plan` 后工具定义 hash 不变。
- `/memory reload` 后 system prompt hash 不变。
- 下一轮 LLM 请求包含 memory reload reminder。

### Phase 3: 工具定义稳定性和 cache debug

1. 修改 `ToolRegistry`，重复注册同名工具抛错，显式维护 ordered entries。
2. 新增 `src/cache-debug.ts`。
3. 修改 `llm-logger.ts` 记录 hash。
4. 可选修改 `config.ts` 支持 `CACHE_DEBUG`。
5. 新增或更新测试。

验收：

- 多次 `getToolDefinitions()` 顺序一致。
- mode 切换、memory reload 不改变 tools hash。
- LLM 日志能清楚显示 system/tools/prefix 是否 changed。

### Phase 4: 子智能体 cache-safe fork

1. 阶段 A：子智能体复用父级 stable system prompt。
2. 阶段 B：新增 fork context，子智能体基于父级 messages 追加任务。
3. 阶段 B：保持工具定义一致，通过执行策略限制递归和 memory 写入。
4. 更新子智能体测试。

验收：

- 子智能体请求的 system prompt 与父级一致。
- 子智能体工具定义不因过滤而改变顺序或数量，或文档明确阶段 A 尚未实现。
- 子智能体不能递归调用 `run_subagent`。
- 子智能体不能创建或删除 memory。

## 代码改动清单

| 文件                         | 操作       | 说明                                                    |
| ---------------------------- | ---------- | ------------------------------------------------------- |
| `src/session-events.ts`      | 新增       | 会话 reminder 缓冲区                                    |
| `src/session-events.test.ts` | 新增       | reminder buffer 测试                                    |
| `src/system-prompt.ts`       | 修改       | 从每轮动态 build 改为 stable snapshot + turn reminders  |
| `src/system-prompt.test.ts`  | 修改       | 覆盖 snapshot 稳定性和 ignore memory reminder           |
| `src/agent.ts`               | 修改       | 不再每轮改 system prompt，注入 reminder messages        |
| `src/agent.test.ts`          | 修改       | 覆盖 reminder 注入和 tool 配对不破坏                    |
| `src/index.ts`               | 修改       | 创建 sessionEventBuffer，启动时设置 stable prompt       |
| `src/cli-commands.ts`        | 修改       | mode/memory/skill reload 推送 reminder                  |
| `src/tools/memory.ts`        | 修改       | memory create/delete 输出 cache 语义，可选推送 reminder |
| `src/tools/registry.ts`      | 修改       | 工具顺序稳定、重复注册报错                              |
| `src/tools/registry.test.ts` | 新增       | 工具定义稳定性测试                                      |
| `src/cache-debug.ts`         | 新增       | hash 和稳定性追踪                                       |
| `src/cache-debug.test.ts`    | 新增       | hash 稳定序列化测试                                     |
| `src/llm-logger.ts`          | 修改       | request 日志增加 cache debug                            |
| `src/config.ts`              | 可选修改   | 增加 `CACHE_DEBUG` 配置                                 |
| `src/tools/subagent.ts`      | 分阶段修改 | 复用 stable prompt，未来实现 cache-safe fork            |
| `src/tools/subagent.test.ts` | 修改       | 子智能体 cache 和能力限制测试                           |
| `doc/summary.md`             | 实现后修改 | 更新当前项目状态                                        |
| `AGENTS.md`                  | 可选修改   | 增加 cache-friendly 设计约束                            |

实现备注（2026-05 Runtime Hardening Round A）：

- `llm.log` 不再在每次 Agent 启动时清空，也不再在超过大小上限时清空重写。
- 当前实现改为追加 BOOT 标记，并在单文件超过默认 5MB 时轮转为 `llm.log.1`、`llm.log.2` 等历史文件，默认保留 5 份。
- 这不会改变 prompt cache 的请求布局；它只改变本地审计日志的保留策略。

## 测试计划

最小验证：

```bash
npm run typecheck
npx vitest run src/system-prompt.test.ts src/agent.test.ts src/session-events.test.ts
```

涉及工具注册和日志后：

```bash
npx vitest run src/tools/registry.test.ts src/cache-debug.test.ts
npx vitest run src/tools/memory.test.ts src/permission.test.ts
```

涉及子智能体后：

```bash
npx vitest run src/tools/subagent.test.ts src/agent.test.ts
```

最终验证：

```bash
npm test
npx eslint src/system-prompt.ts src/agent.ts src/index.ts src/session-events.ts src/cache-debug.ts src/tools/registry.ts src/tools/memory.ts src/cli-commands.ts
```

如果分阶段提交，每个阶段只需要跑相关测试加 `npm run typecheck`。最终合并前跑完整测试。

## 验收清单

- [ ] 普通多轮对话不会每轮重写 system prompt。
- [ ] Memory create/delete/reload 不会自动改变 stable system prompt。
- [ ] “本轮不要使用 memory”通过 reminder 生效。
- [ ] `/mode` 不改变工具定义。
- [ ] 工具定义顺序稳定，重复注册报错。
- [ ] LLM 日志能看到 system/tools/prefix hash。
- [ ] cache debug 不声称真实 hit rate，除非 API usage 明确提供。
- [ ] 子智能体至少复用父级 stable system prompt。
- [ ] 如果实现完整 cache-safe fork，子智能体工具定义与父级一致，执行层限制递归和 memory 写入。
- [ ] `doc/summary.md` 在实现后更新。

## 设计取舍

### 为什么不直接每次刷新 system prompt

刷新 system prompt 能让模型立刻看到最新 Memory/Skill 状态，但会破坏缓存前缀。长期来看，频繁刷新会让 latency 和成本不可控。更好的方式是把“状态变化”作为消息追加，让稳定前缀继续命中。

### 为什么不隐藏不可用工具

隐藏工具看起来更省 token，但会在会话中途改变 tools 前缀。对于 plan mode、subagent mode 这种状态，应该保持工具定义稳定，把限制放在权限层或执行策略层。

### 为什么 cache debug 不是 hit rate

真实 hit rate 必须来自模型服务端 usage。当前项目使用 OpenAI-compatible 客户端，不能假设 provider 一定返回缓存字段。教学版先显示 hash 稳定性，可以帮助定位“为什么缓存可能断了”，但不能伪造服务端命中率。

### 为什么子智能体分阶段做

子智能体 cache-safe fork 会触及 agent、history、tool registry、permission 多个边界。一次实现容易引入递归工具调用、memory 写入权限、tool_call 配对等问题。先复用 stable prompt，再实现完整 fork，是更稳妥的教学路线。
