# 上下文压缩

对上下文信息中次要内容进行压缩，避免上下文长度超限，节约 token 消耗。

压缩之后的内容务必保留如下信息，以便任务正常推进：
- 当前任务目标
- 已完成的关键动作
- 已修改或重点查看过的文件
- 关键决定与约束
- 下一步应该做什么

# Token 估算方案

使用字符数估算，不引入 tiktoken 等重依赖：
- 中文：1 字符 ≈ 1.5 token
- 英文：1 字符 ≈ 0.25 token
- 取 `max(中文字符数 × 1.5, 总字符数 × 0.25)` 作为估算值
- 教学项目不需要精确计数，此估算足以判断是否需要压缩

# 消息块（Message Block）—— 压缩的最小原子单位

## 为什么需要消息块？

在 Agent 对话中，`tool_use`（assistant 消息中的 tool_calls）与 `tool_result`（role=tool 的消息）是**逻辑配对**的：
- 一个 assistant 消息可能包含多个 tool_call（并行调用）
- 每个 tool_call 必须有且仅有一条对应的 tool 消息
- 如果压缩只删除了其中一个，就会导致上下文逻辑断裂，模型无法理解之前做了什么

**核心原则：压缩操作以完整的消息块为最小单位，永远不切断 tool_use 与 tool_result 的配对关系。**

## 消息块的定义

将消息列表按逻辑含义分组，每组是一个不可分割的"消息块"：

```
消息块类型 A — 纯文本对话：
  [user]          → 用户提问或回复
  [assistant]     → 模型的文本回复（无 tool_calls）

消息块类型 B — 工具调用轮次（最关键，不可拆分）：
  [assistant]     → 模型请求工具调用（含 tool_calls）
  [tool]          → 第 1 个工具的结果（tool_call_id 关联）
  [tool]          → 第 2 个工具的结果（tool_call_id 关联）
  ...
  [tool]          → 第 N 个工具的结果（tool_call_id 关联）

消息块类型 C — 全量压缩摘要：
  [user]          → "[Context Summary] ..."（由全量压缩产生）
```

一个 assistant 消息中的所有 tool_call 及其对应的 tool 消息属于**同一个消息块**，不可拆分。

## 消息块的结构化表示

```typescript
/** 消息块 — 压缩操作的最小原子单位 */
type MessageBlock =
  | { type: "text"; user?: Message; assistant: Message }
  | { type: "tool_use"; assistant: Message; toolResults: Message[] }
  | { type: "summary"; user: Message };
```

## 压缩操作的消息块约束

所有压缩机制（即时压缩、衰减压缩、全量压缩）都必须遵守：

1. **不拆分**：一个消息块中的所有消息要么全部保留，要么全部压缩，要么全部替换
2. **不孤立**：assistant 的 tool_calls 与对应的 tool 消息始终同进退
3. **不破坏 ID 关联**：tool_call_id 与 tool 消息的对应关系在压缩后必须保持正确
4. **衰减压缩可以缩短块内内容**：允许截断 tool 消息的 content，但必须保留 tool_call_id
5. **全量压缩以块为单位**：决定保留或压缩时，以消息块为粒度判断，不以单条消息判断

# 压缩管道位置

压缩在消息标准化（normalize）之后、发送给 LLM 之前执行：

```
history.getMessages() → normalizeMessages() → groupToBlocks() → compress() → flattenToMessages() → llm.chat()
```

新增步骤说明：
- `groupToBlocks()`：将扁平消息列表按上述规则分组为消息块数组
- 压缩操作在消息块数组上进行，天然保证原子性
- `flattenToMessages()`：将压缩后的消息块数组还原为扁平消息列表

理由：normalize 保证 API 格式合规（补全 tool_result、合并同角色消息等），消息块分组在 normalize 之后，保证输入的消息已经是 API 合规的。压缩操作在消息块粒度上进行，天然保证 tool_use/tool_result 不被拆分。

# 三种压缩机制

按优先级排列：

## 1. 即时压缩（工具执行后触发）

对单次工具输出过大的情况进行即时压缩。

- **触发时机**：工具执行完成后立即触发
- **触发条件**：输出超过 `THRESHOLD_TOOL_OUTPUT`（默认 2000）token **且** 工具名在 `compressibleTools` 列表中
- **适用范围**：由 `compressibleTools` 配置决定（默认 `["run_bash"]`）
  - 压缩器内部根据工具名决策，调用方（agent.ts）无需硬编码 `if (fnName === "run_bash")`
  - `run_read` 等工具不在列表中，输出直接透传
  - 未来加入 `run_grep` 等大输出工具时，只需修改配置
- **存储路径**：`.task_outputs/{toolCallId}.txt`（项目内路径）
- **文件清理**：会话结束时统一清理 `.task_outputs/` 目录
- **返回给 LLM 的内容**：
```
<persisted-output>
Full output saved to: .task_outputs/{toolCallId}.txt
Preview (first {N} chars):
{截断后的预览内容}
</persisted-output>
```

实现备注（2026-05 第四轮重构）：

- 当前实现已经把 P1 即时压缩输出接入 `OutputStore`。
- 新路径不再只把裸 `.task_outputs/<toolCallId>.txt` 暴露给 LLM，而是返回稳定 `output_id`。
- LLM 看到 `<persisted-output ... output-id="out_...">` 后，应使用 `run_output_read({"output_id":"out_..."})` 读回完整输出。
- 未注入 OutputStore 的单独压缩器实例仍保留旧文件 fallback，保证早期 lesson 和单元测试可以独立运行。
- 注入 OutputStore 后，`cleanup()` 不会删除已登记输出；这些输出属于 Agent 运行 artifact，而不是压缩器私有临时文件。

实现备注（2026-05 第五轮重构）：

- 当前实现已经把压缩年龄从局部 `roundCount` 收口到全局 `loopIndex`。
- `loopRound` 仍表示当前 user turn 内第几次 LLM 调用，并保留为旧 `round` 字段的兼容语义。
- P0 衰减压缩现在使用 `currentLoopIndex - block.loopIndex > DECAY_THRESHOLD` 判断旧工具结果；如果读取到旧 block 只有 `round` 字段，仍按旧逻辑 fallback。
- `messageSequence` 只用于 History 排序、debug 和 compact round-trip，不作为压缩年龄。

## 2. 衰减压缩（每轮 agent loop 调用 LLM 之前触发）

随着对话推进，逐步缩短旧的工具调用结果，保留近期上下文的完整度。以**消息块**为操作单位。

- **触发时机**：每轮 agent loop 调用 LLM 之前
- **触发条件**：`当前全局 loopIndex - 消息块所在 loopIndex > DECAY_THRESHOLD`（默认 3）
  - `loopIndex` 以同一个 Agent 实例内每次 LLM 调用为一轮，跨多次用户输入单调递增
  - 旧 `round` 只作为兼容 fallback，不再作为跨 turn 年龄判断的首选字段
- **按消息块类型的压缩规则**：
  - **text 块**（纯文本对话）：不修改，完整保留
  - **tool_use 块**（工具调用轮次）：
    - assistant 消息（含 tool_calls）：不修改，完整保留（tool_calls 参数是 LLM 后续推理的上下文）
    - 该块内所有 tool 消息：`content` 截断为前 `DECAY_PREVIEW_TOKENS`（默认 100）token
    - 必须保留每条 tool 消息的 `tool_call_id` 不变（OpenAI API 要求）
    - 如果某条 tool 消息已存文件（即时压缩时），在截断内容末尾追加文件路径引用
  - **summary 块**（之前的全量压缩摘要）：不修改，完整保留

## 3. 全量压缩（上下文超过阈值时触发）

当衰减压缩不足以控制上下文长度时，进行全量压缩。

- **触发时机**：
  - 每轮 agent loop 调用 LLM 之前自动检测
  - 用户输入 `/compact` 命令显式触发
- **触发条件**：估算 token 数 > `MAX_CONTEXT_TOKENS`（可配置，建议为模型上下文窗口的 80%）
- **执行方式**：纯规则压缩，不调用 LLM（避免"发送已超限的上下文去压缩"的悖论）
- **压缩策略**（以消息块为操作单位）：
  1. 将消息列表分组为消息块数组
  2. 保留 `system prompt` 不变
  3. 最近 `K` 个消息块保持原样（`K` 可配置，默认 4）
  4. 其余消息块按类型压缩：
     - **text 块** → `user` 消息保留全文（用户意图不可丢失），`assistant` 回复保留最后一条
     - **tool_use 块** → 整个块压缩为 `"{工具名}({参数概要}) → [结果摘要]"` 一行文本
       - 一个块中的多个 tool_call 压缩为多行，保持在一起
     - **summary 块** → 保留上一次摘要文本，参与新一轮压缩（避免信息退化）
  5. 将压缩部分包装为一条 `user` 消息：
     `[Context Summary] {结构化摘要文本}`
  6. 最终拼接：`[摘要消息块] + [最近 K 个原样消息块]`
- **连续压缩**：后续全量压缩时，将上一次 `lastSummary` 作为输入参与新一轮压缩，避免摘要信息在多次压缩中退化

### 压缩状态

全量压缩的状态由 `ContextCompressor` 内部闭包管理（不修改 `History` 接口）：

```typescript
interface CompressorState {
  hasCompacted: boolean;   // 是否已做过全量压缩
  lastSummary?: string;    // 最近一次摘要文本（连续压缩时复用）
  recentFiles: string[];   // 最近操作过的文件路径
}
```

# 模块接口设计

```typescript
/**
 * 消息块 — 压缩操作的最小原子单位
 *
 * 三种类型：
 * - text: 纯文本对话（user + assistant 无工具调用）
 * - tool_use: 工具调用轮次（assistant 含 tool_calls + 所有对应的 tool 消息）
 * - summary: 全量压缩产生的摘要消息
 */
type MessageBlock =
  | { type: "text"; user?: Message; assistant: Message }
  | { type: "tool_use"; assistant: Message; toolResults: Message[] }
  | { type: "summary"; user: Message };

/** 将扁平消息列表分组为消息块数组 */
function groupToBlocks(messages: Message[]): MessageBlock[];

/** 将消息块数组还原为扁平消息列表 */
function flattenToMessages(blocks: MessageBlock[]): Message[];

/** 压缩配置项 */
interface CompressionConfig {
  thresholdToolOutput: number;    // 即时压缩的 token 阈值
  decayThreshold: number;         // 衰减压缩的轮次阈值
  decayPreviewTokens: number;     // 衰减后保留的 token 数
  maxContextTokens: number;       // 触发全量压缩的 token 阈值
  compactKeepRecent: number;      // 全量压缩时保留的最近消息块数
  compressibleTools: string[];    // 需要 P1 即时压缩的工具名列表
}

/** 压缩后的工具结果 */
interface CompressedToolResult {
  content: string;           // 返回给 LLM 的内容（preview 或原文）
  persistedPath?: string;    // 如果存了文件，记录路径
}

/** 全量压缩结果 */
interface CompactResult {
  blocks: MessageBlock[];    // 压缩后的消息块列表
  summary: string;           // 摘要文本
}

/** 压缩器状态 */
interface CompressorState {
  hasCompacted: boolean;
  lastSummary?: string;
  recentFiles: string[];
}

/** 上下文压缩器接口 */
interface ContextCompressor {
  // 即时压缩：工具执行后调用
  // 内部根据 toolName 和 compressibleTools 配置自动决策是否压缩
  compressToolResult(toolName: string, toolCallId: string, output: string): CompressedToolResult;

  // 衰减压缩：每轮 agent loop 开始时调用，缩短旧的工具结果
  // 输入输出都是消息块数组，保证原子性
  decayOldBlocks(blocks: MessageBlock[], currentRound: number): MessageBlock[];

  // 全量压缩：上下文超过阈值时调用，将历史压缩为摘要
  // 输入输出都是消息块数组，保证原子性
  compactHistory(blocks: MessageBlock[]): CompactResult;

  // 获取当前压缩状态
  getState(): CompressorState;

  // 清理临时文件
  cleanup(): void;
}
```

# 与现有模块的集成点

- **agent.ts**（重构后由 `prepareMessages()` 和 `handleToolCalls()` 调用）：
  - `handleToolCalls()` 中对**所有**工具统一调用 `compressor.compressToolResult(fnName, toolCallId, output)`
  - 压缩器内部根据 `compressibleTools` 配置决策是否压缩，调用方无需硬编码工具名
  - `prepareMessages()` 中依次执行衰减压缩 + 全量压缩检测
- **history.ts**：压缩操作在 `history.getEntries()` 返回的带 timing 元信息条目上进行
- **normalize.ts**：压缩在其后执行，不改变现有处理顺序
- **tools/bash.ts**：工具本身不知道压缩的存在，由 agent 负责压缩
- **子智能体**：
  - 子智能体使用独立的 `ContextCompressor` 实例（通过 `createCompressorFn` 工厂创建）
  - 子智能体返回结果给父智能体时，结果就是天然压缩的（一条文本）
  - 父智能体不需要关心子智能体内部的压缩状态

# 配置项

| 配置项 | 说明 | 默认值 |
|--------|------|--------|
| `thresholdToolOutput` | 即时压缩的 token 阈值 | 2000 |
| `decayThreshold` | 衰减压缩的轮次阈值 | 3 |
| `decayPreviewTokens` | 衰减后保留的 token 数 | 100 |
| `maxContextTokens` | 触发全量压缩的 token 阈值 | 80000 |
| `compactKeepRecent` | 全量压缩时保留的最近消息块数 | 4 |
| `compressibleTools` | 需要即时压缩的工具名列表 | `["run_bash"]` |

# 错误处理与降级

- **文件写入失败** → 跳过即时压缩，返回原始输出
- **全量压缩后仍超限** → 只保留 `system prompt` + 最后一条 `user` + 最后一条 `assistant`
- **压缩导致 API 报错** → 回退到未压缩的消息重试

# 实现优先级

```
P0（核心，先实现）：
  └── ContextCompressor 接口 + 衰减压缩
      → 投入最小，效果最明显，解决大多数超限问题

P1（增强，其次实现）：
  └── 即时压缩（工具结果存文件）
      → 解决单次工具输出过大的问题

P2（兜底，最后实现）：
  └── 全量压缩
      → 最复杂，只在极端情况下触发
```
