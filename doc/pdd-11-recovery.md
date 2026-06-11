# PDD-11: Agent Loop 错误处理与恢复

本设计用于给现有 Agent 主循环增加可解释、可限制、可测试的错误恢复机制。

目标不是让所有错误都“自动修好”，而是在 LLM 调用失败、上下文过长、输出被截断等常见情况下，Agent 能做出明确恢复决策，并且避免无限重试、重复执行工具或静默失败。

本次实现只更新代码与测试。不要因为实现本 PDD 自动更新 `doc/summary.md`；除非后续任务明确要求更新 summary。

## 背景

当前 Agent 主循环在 `agent.ts` 中直接调用 `llm.chat(...)`。如果 LLM 请求抛错，错误会直接向外冒泡，REPL 只能看到失败，Agent 没有机会判断：

- 是否应该等待后重试。
- 是否应该压缩上下文后重试。
- 是否是配置错误，应该直接提示用户修改 `.env`。
- 是否是模型输出被截断，应该要求模型从断点继续。

`llm.ts` 里已有一个很轻的内部重试逻辑，但它不理解 Agent 状态，也无法执行 compact、追加 continuation reminder、或生成面向用户的失败提示。因此恢复策略应当上移到 `agent.ts`，`llm.ts` 只负责发送请求和暴露足够的响应/错误信息。

## 设计目标

1. 处理 Agent loop 中的 LLM 相关错误。
2. 根据错误类型做出 `continue`、`compact`、`backoff`、`fail` 四类恢复决策。
3. 记录本次用户请求内的恢复状态，避免死循环和不必要的重复执行。
4. 在恢复过程中提示用户，例如正在重试、正在 compact、正在请求继续输出。
5. 当 LLM 输出中断时，下一次请求要提示 LLM 从上次断点继续，不要完全重新执行。
6. 保持 prompt cache 友好：动态恢复提示通过临时 user reminder 注入，不修改稳定 system prompt。
7. 保持教学项目风格：代码结构清晰，关键逻辑配中文注释，测试覆盖决策分支。

## 非目标

1. 不实现 provider 级别的复杂熔断、队列、并发请求池。
2. 不引入新的外部依赖。
3. 不修改工具定义，不因为错误恢复改变工具列表。
4. 不在错误恢复时重新执行已经完成的工具调用。
5. 不把恢复状态持久化到磁盘；恢复状态只属于当前 `agent.run(query)`。
6. 本 PDD 实现阶段不要更新 `doc/summary.md`。

## 错误类型

新增统一错误分类 `LLMErrorKind`：

```ts
export type LLMErrorKind =
  | "network"
  | "rate_limit"
  | "credential"
  | "quota"
  | "context_length"
  | "output_interrupted"
  | "unknown";
```

分类含义：

- `network`：网络超时、连接重置、DNS 错误、临时 5xx。
- `rate_limit`：请求过快或服务端限流，可等待后重试。
- `credential`：API key、baseURL、认证配置错误，不应重试。
- `quota`：token 额度、账户余额、配额耗尽，不应立即重试。
- `context_length`：上下文窗口超限，应 compact 后重试。
- `output_interrupted`：LLM 成功返回但 `finish_reason` 表示长度截断，应追加 continuation reminder 后继续。
- `unknown`：无法识别的错误，最多按普通失败处理，避免无限循环。

错误分类规则建议：

- HTTP `401`、`403`，或错误信息包含 `api key`、`unauthorized`、`forbidden`、`credential`：归类为 `credential`。
- HTTP `429` 且错误信息包含 `quota`、`insufficient_quota`、`balance`、`billing`：归类为 `quota`。
- HTTP `429` 其他情况：归类为 `rate_limit`。
- HTTP `400`、`413`，或错误信息包含 `context length`、`maximum context`、`token limit`、`too many tokens`：归类为 `context_length`。
- HTTP `500`、`502`、`503`、`504`，或错误信息包含 `timeout`、`ECONNRESET`、`ETIMEDOUT`、`ENOTFOUND`、`AbortError`：归类为 `network`。
- LLM 成功响应但 `finishReason === "length"`：归类为 `output_interrupted`。
- 其他错误：归类为 `unknown`。

## 恢复决策

新增恢复动作：

```ts
export type RecoveryAction = "continue" | "compact" | "backoff" | "fail";
```

决策含义：

- `continue`：不重新执行工具，只向历史追加一条 continuation reminder，再次调用 LLM。
- `compact`：强制压缩当前历史，然后再次调用 LLM。
- `backoff`：等待固定时间后重试同一次 LLM 调用。
- `fail`：停止本次 `run()`，返回用户可理解的失败提示。

推荐决策表：

| 错误类型             | 默认动作   | 超过上限后                     |
| -------------------- | ---------- | ------------------------------ |
| `network`            | `backoff`  | `fail`                         |
| `rate_limit`         | `backoff`  | `fail`                         |
| `credential`         | `fail`     | `fail`                         |
| `quota`              | `fail`     | `fail`                         |
| `context_length`     | `compact`  | `fail`                         |
| `output_interrupted` | `continue` | 返回已得到的部分内容或中断提示 |
| `unknown`            | `fail`     | `fail`                         |

默认限制：

- API 调用重试次数：最多 5 次。
- 每次 backoff 间隔：3 秒。
- compact 重试次数：最多 1 次。
- continue 重试次数：最多 2 次。

这些默认值先写成代码内常量即可，不需要引入环境变量。教学项目优先保持实现直观。

## 恢复状态

新增恢复状态：

```ts
export interface RecoveryState {
  apiRetryCount: number;
  compactRetryCount: number;
  continueRetryCount: number;
}
```

状态生命周期：

- 每次 `agent.run(query)` 创建一个新的 `RecoveryState`。
- 状态只在本次用户请求内有效。
- 不写入 `history`，不持久化到磁盘。
- 子智能体也使用自己的独立恢复状态。

状态计数规则：

- `apiRetryCount`：只统计 `network` 和 `rate_limit` 的 backoff 重试。
- `compactRetryCount`：只统计 `context_length` 触发的强制 compact。
- `continueRetryCount`：只统计 `output_interrupted` 触发的 continuation。

## 模块设计

### 新增 `src/recovery.ts`

职责：封装错误分类、恢复决策、提示文案、等待函数。

导出内容：

```ts
export type LLMErrorKind = ...;
export type RecoveryAction = ...;

export interface RecoveryState { ... }
export interface RecoveryConfig { ... }

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig;

export function createRecoveryState(): RecoveryState;
export function classifyLLMError(error: unknown): LLMErrorKind;
export function decideRecovery(
  kind: LLMErrorKind,
  state: RecoveryState,
  config?: RecoveryConfig,
): RecoveryAction;
export function formatRecoveryNotice(
  action: RecoveryAction,
  kind: LLMErrorKind,
  state: RecoveryState,
  config?: RecoveryConfig,
): string;
export function formatFailureMessage(kind: LLMErrorKind, error?: unknown): string;
export function sleep(ms: number): Promise<void>;
```

设计原则：

- `classifyLLMError()` 不依赖 OpenAI SDK 的具体类型，只通过宽松结构读取 `status`、`code`、`message`。
- `decideRecovery()` 是纯函数，便于单元测试。
- `formatFailureMessage()` 返回面向用户的中文提示。
- `sleep()` 单独导出，测试时可 mock 或用 fake timer。

### 修改 `src/llm.ts`

`LLMResponse` 增加 `finishReason`：

```ts
export interface LLMResponse {
  content: string | null;
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  finishReason: string | null;
}
```

响应解析：

- 从 `response.choices?.[0]?.finish_reason ?? null` 获取 `finishReason`。
- `choice.message.content` 仍映射为 `content`。
- `choice.message.tool_calls ?? []` 仍映射为 `toolCalls`。

重试逻辑调整：

- 移除 `llm.ts` 当前内部的多次 API 重试，避免 agent 层看不到每次失败。
- `llm.ts` 可以保留日志记录，但不要在这里决定 `backoff`、`compact`、`continue`。
- 如果 API 抛错，原样抛出，交给 `agent.ts` 分类。
- 如果响应没有 `choice`，抛出 `No response from LLM` 错误。

### 修改 `src/history.ts`

为强制 compact 增加安全回写能力：

```ts
replaceEntries(entries: HistoryEntry[]): void;
```

语义：

- 替换普通对话消息和对应 timing 元信息。
- 不修改 system prompt。
- `entries` 的顺序必须按时间顺序写入。
- 每个 entry 的 `message` 原样保存，`turnIndex` / `loopRound` / `loopIndex` / `messageSequence` / `round` 按当前实现规则保留或补齐。

为什么需要这个 API：

- 当前 `prepareMessages()` 返回的是临时压缩后的 LLM 输入，不会改写 `history`。
- 当 API 明确报 context window 超限时，需要强制把压缩后的历史写回，下一次请求才会真的变短。
- 不能直接用 `clear()` 后手动恢复 system prompt，因为 system prompt 独立存储，容易误删或重复插入。

### 修改 `src/agent.ts`

Agent 层新增内部函数。

#### `compactCurrentHistoryForRecovery(timing)`

职责：当 API 报 context window 超限时，强制压缩当前 history 并写回。

流程：

1. `history.getEntries()` 读取当前普通消息。
2. `annotateEntries(entries)` 附加内部 timing 元信息。
3. `normalizeMessages(annotated)` 标准化消息。
4. `groupToBlocks(normalized)` 分块。
5. `compressor.decayOldBlocks(blocks, timing.loopIndex)` 先做 P0 衰减。
6. `compressor.compactHistory(decayed)` 做 P2 全量压缩。
7. `flattenToMessages(compacted.blocks)` 得到压缩后的消息。
8. 将压缩后消息转换为 `HistoryEntry[]`。
9. 调用 `history.replaceEntries(...)` 写回。

注意：

- system prompt 不参与这个流程，仍由 `history.getSystemPrompt()` 独立维护。
- 如果 compact 后没有减少消息，仍然消耗一次 `compactRetryCount`，避免死循环。
- compact 失败时记录 warn，并返回 `fail`。

#### `appendContinuationReminder(timing)`

职责：LLM 输出被截断后，追加一条 user reminder。

推荐内容：

```xml
<system-reminder source="recovery">
你的上一次输出因为长度限制中断了。请从断点继续输出，不要从头重写，也不要重复已经完成的工具调用。
</system-reminder>
```

注意：

- 这条 reminder 是普通 user 消息，不修改 system prompt。
- 必须在已经保存 assistant 部分输出之后追加。
- 如果上一轮包含 tool calls，不应把 `finishReason === "length"` 当成普通 continuation；优先按工具调用流程处理，避免破坏 tool_call/tool_result 配对。

#### 包装 LLM 调用

在主循环内创建恢复状态：

```ts
const recoveryState = createRecoveryState();
```

将原来的：

```ts
const response = await llm.chat(finalMsgs, toolDefs, cacheState);
```

替换为可恢复流程：

```ts
let response: LLMResponse;

try {
  response = await llm.chat(finalMsgs, toolDefs, cacheState);
} catch (error) {
  const kind = classifyLLMError(error);
  const action = decideRecovery(kind, recoveryState);

  if (action === "backoff") {
    recoveryState.apiRetryCount++;
    logger.warn(formatRecoveryNotice(action, kind, recoveryState));
    await sleep(DEFAULT_RECOVERY_CONFIG.retryDelayMs);
    continue;
  }

  if (action === "compact") {
    recoveryState.compactRetryCount++;
    logger.info(formatRecoveryNotice(action, kind, recoveryState));
    const compacted = compactCurrentHistoryForRecovery(timing);
    if (compacted) continue;
    return formatFailureMessage(kind, error);
  }

  logger.error(formatRecoveryNotice(action, kind, recoveryState));
  return formatFailureMessage(kind, error);
}
```

成功响应后处理中断：

1. 先把 assistant 的部分输出写入 history。
2. 如果有 tool calls，继续走现有 `handleToolCalls()`。
3. 如果没有 tool calls 且 `response.finishReason === "length"`：
   - 决策为 `continue` 时，递增 `continueRetryCount`。
   - 追加 continuation reminder。
   - `continue` 进入下一轮 LLM 调用。
   - 超过上限时，返回当前已有部分内容，前面加中断说明。

返回示例：

```ts
return `[模型输出被截断，已达到继续次数上限]\n${response.content ?? ""}`;
```

## 用户提示

恢复过程需要通过 logger 提示用户。

建议提示：

- backoff：`LLM 调用失败，正在重试 2/5，3 秒后继续...`
- compact：`LLM 上下文过长，正在压缩历史后重试...`
- continue：`LLM 输出被截断，正在请求从断点继续 1/2...`
- credential fail：`LLM 认证配置错误，请检查 LLM_API_KEY、LLM_BASE_URL、LLM_MODEL。`
- quota fail：`LLM token 额度或账户余额不足，请稍后或补充额度后再试。`
- context fail：`上下文压缩后仍然超过模型窗口，请开启新会话或减少上下文。`

提示只进入终端日志，不需要写入 `history`，除 continuation reminder 外。

## 与工具调用的关系

错误恢复必须避免重复执行工具：

- 如果 `llm.chat(...)` 在返回前失败，此时还没有新的 assistant tool calls 写入 history，也没有工具执行，不存在重复执行问题。
- 如果 LLM 成功返回 tool calls，按现有流程先保存 assistant，再执行工具。
- 工具执行失败不属于本 PDD 范围，仍由工具自身返回 `ToolResult.error` 并写入 tool message。
- `output_interrupted` 只处理无 tool calls 的文本输出中断。带 tool calls 的响应继续按工具调用路径处理。

## 与压缩器的关系

现有压缩器已有三层机制：

- P0 衰减压缩：每轮自动缩短旧工具结果。
- P1 即时压缩：大工具输出存 `.task_outputs/`。
- P2 全量压缩：超过阈值时生成摘要。

本 PDD 增加的是“API 报 context window 超限后的强制 P2 compact 写回”。

关键差异：

- 普通 `prepareMessages()` 里的 compact 只影响本次发给 LLM 的消息。
- 恢复用 compact 必须写回 `history`，否则下一次请求仍可能携带过长历史。

实现备注（2026-05 第五轮重构）：

- 恢复用 compact 写回 history 时，会保留每条消息自己的 timing metadata。
- `turnIndex` 表示用户 turn，`loopRound` 表示当前 turn 内循环，`loopIndex` 表示跨 turn 的全局 LLM 调用序号。
- `blocksToEntries()` 优先读取消息上的内部 timing 字段，只有缺失时才 fallback 到 block 聚合 timing，避免 compact 后把一个 block 内所有消息的时间语义统一覆盖。
- Transcript 会额外记录 `historySequence`，用于把 append-only recovery event 和被压缩的 History 工作上下文关联起来。

## 测试计划

### `src/recovery.test.ts`

覆盖：

1. `401` / `403` 分类为 `credential`。
2. `429 quota` 分类为 `quota`。
3. 普通 `429` 分类为 `rate_limit`。
4. context token 错误分类为 `context_length`。
5. timeout / 5xx 分类为 `network`。
6. `network` 在上限内决策为 `backoff`。
7. `network` 超过上限后决策为 `fail`。
8. `context_length` 在上限内决策为 `compact`。
9. `output_interrupted` 在上限内决策为 `continue`。
10. credential/quota 永远决策为 `fail`。

### `src/llm.ts` 相关测试

如果已有 LLM 客户端测试，则扩展；如果没有，可用 mock OpenAI client 的方式覆盖：

1. 成功响应返回 `finishReason`。
2. 没有 `tool_calls` 时返回空数组。
3. 没有 choice 时抛错，不在 `llm.ts` 内部吞掉。

### `src/history.test.ts`

覆盖 `replaceEntries()`：

1. 替换普通消息。
2. 保留 timing 元信息（含兼容 round 字段）。
3. 不修改 system prompt。
4. 替换后 `getMessages()` 仍会在头部插入 system prompt。

### `src/agent.test.ts`

覆盖：

1. mock LLM 前两次抛 `network` 错误，第三次成功，断言 `chat` 调用 3 次。
2. mock LLM 一直抛 `network` 错误，超过上限后返回失败提示。
3. mock LLM 抛 `credential` 错误，断言不重试。
4. mock LLM 抛 `context_length` 错误，断言触发 compact 后再次调用。
5. mock LLM 返回 `finishReason: "length"` 且有部分 content，断言 history 追加 continuation reminder。
6. continuation 超过上限后返回部分内容和中断说明。
7. 带 tool calls 的响应即使 finishReason 异常，也不破坏现有 tool_call/tool_result 流程。

## 实现顺序

1. 新增 `src/recovery.ts` 与 `src/recovery.test.ts`。
2. 修改 `src/llm.ts` 的 `LLMResponse`，增加 `finishReason`，并移除内部重复重试。
3. 修改所有 mock LLM 测试数据，补充 `finishReason: "stop"` 或 `null`。
4. 给 `src/history.ts` 增加 `replaceEntries()`，补充测试。
5. 在 `src/agent.ts` 接入错误分类、恢复决策、backoff、fail。
6. 在 `src/agent.ts` 增加强制 compact 写回。
7. 在 `src/agent.ts` 处理 `finishReason === "length"` 的 continuation。
8. 运行 `npm run typecheck`。
9. 运行相关测试：`npx vitest run src/recovery.test.ts src/history.test.ts src/agent.test.ts`。
10. 如果改动影响共享行为，再运行 `npm test`。

## 验收标准

实现完成后应满足：

1. LLM 网络类失败会按默认 5 次、3 秒间隔重试。
2. credential 错误不会重试，并返回配置修复提示。
3. quota 错误不会重试，并返回额度不足提示。
4. context window 超限会触发强制 compact，且 compact 后的历史会写回。
5. compact 重试有次数上限，不会无限压缩。
6. LLM 文本输出因长度中断时，会保存已有部分输出，并请求模型从断点继续。
7. continuation 有次数上限，不会无限继续。
8. 恢复提示会通过 logger 输出。
9. 不修改稳定 system prompt。
