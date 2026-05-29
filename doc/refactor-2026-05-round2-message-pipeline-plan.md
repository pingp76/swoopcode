# 2026-05 第二轮重构方案：消息管线不变量修复

本文是 `doc/refactor-2026-05-project-review.md` 中“第二轮：消息管线修复”的精确执行计划。它面向后续真正编码的 coding agent，要求先按本文输出本轮 checklist，再实施。

第一轮已经处理 Schedule / Async Run / Permission 交叉边界。第二轮回到更早章节的核心消息管线，但只修不变量和测试，不重写 agent loop，不改变 PDD1-PDD14 的教学递进。

实施状态（2026-05-28）：

- 本轮 checklist 已落地：`normalizeMessages()` 现在是 clone-based 纯函数，缺失或错位的 tool result 会回到对应 assistant tool block，孤立 tool result 不进入最终 LLM 输入，带 `tool_calls` 的 assistant 不再参与普通 assistant 合并。
- `message-block.ts` 保持压缩原子层职责，只做重复赋值清理并补 normalized tool block 测试。
- Agent 主循环没有重写，只补了真实 LLM 输入顺序测试，确认 Hook exitCode 2 的 user message 位于所有 tool_result 之后。
- 本文下方 checklist 保留为后续 review/audit 的逐项核对模板，当前实现状态以 `doc/summary.md` 与测试结果为准。

## 一、本轮目标

本轮只处理 `normalize.ts`、`message-block.ts`、`agent.ts` 之间的消息顺序和引用安全问题：

1. `normalizeMessages()` 必须是纯函数：不修改输入数组，也不修改输入 message 对象。
2. 缺失的 `tool_result` 必须插入到对应 assistant `tool_calls` 后面，而不是追加到全局末尾。
3. assistant `tool_calls` 与对应 tool messages 必须形成连续 block，中间不能被 user reminder、Hook message 或后续 user query 打断。
4. 连续同角色合并不能合并带 `tool_calls` 的 assistant 消息。
5. `message-block.ts` 继续作为压缩原子层，测试要证明 normalize 后的 tool block 可以被正确 group / flatten。
6. `agent.test.ts` 需要覆盖真实 agent loop 中 Hook 延迟注入后的 LLM 输入顺序。

## 二、本轮不做

以下事项明确不纳入第二轮：

1. 不实现 `ExecutionPolicy`。那是第三轮。
2. 不重构 round / turn / sequence 时间语义。那是后续 P1-3。
3. 不新增 OutputStore 或 `run_output_read`。
4. 不修改 LLM provider、streaming 聚合、tool schema 或权限模式。
5. 不改变 History / Transcript 的持久化策略。
6. 不把 `message-block.ts` 改成复杂 parser；本轮只加固它接收 normalized messages 时的边界。

## 三、当前问题定位

### 1. 缺失 tool result 的插入位置错误

当前 `ensureToolResults()` 会先收集所有已有 tool message，然后遍历 assistant `tool_calls`。如果发现缺失，就把占位 tool message `push()` 到数组末尾。

这会把下面这种历史：

```text
user
assistant(tool_calls: call_1)
user(next question)
```

修成：

```text
user
assistant(tool_calls: call_1)
user(next question)
tool(call_1: cancelled)
```

这仍然违反 OpenAI tool_call / tool_result 邻接规则。正确顺序应该是：

```text
user
assistant(tool_calls: call_1)
tool(call_1: cancelled)
user(next question)
```

### 2. normalize 会复用并修改输入对象

`cleanMetadata()` 在 content 不是数组时直接返回原消息对象。`mergeConsecutiveRoles()` 初始化 `merged = [messages[0]!]`，随后直接修改 `last.content`。

这意味着 prepareMessages 阶段可能污染 History 中的原始 message 引用，后续压缩、transcript 对照和测试都会变得不稳定。

### 3. assistant 合并规则过宽

当前连续 assistant 消息都会合并。若第一条 assistant 带 `tool_calls`，合并第二条 assistant 会让带工具调用的 message 同时携带拼接后的文本内容，并可能掩盖缺失 tool result 的结构问题。

本轮规则：只合并不带 `tool_calls` 的普通 assistant 文本消息。

## 四、目标设计

### 1. 职责分层

```text
normalize.ts
  -> 生成 provider-safe messages
  -> 修复 tool_call / tool_result 邻接
  -> 保留顶层 _round 元数据，供 message-block 读取
  -> 不修改输入

message-block.ts
  -> 假设输入已经 normalized
  -> 按 text / tool_use / summary 分 block
  -> flatten 时清除 _round

agent.ts
  -> 负责在真实 loop 中把 Hook / reminder 延迟到 tool_result block 后
  -> 不把消息顺序修复逻辑散落到 agent loop
```

### 2. tool result 修复策略

`ensureToolResults()` 改为 block-aware 的一遍构造：

1. 先扫描所有 `role="tool"` message，建立 `tool_call_id -> first tool message` 映射。
2. 遍历消息列表，遇到普通消息则 clone 后输出。
3. 遇到带 `tool_calls` 的 assistant：
   - 先输出 assistant clone。
   - 按 `tool_calls` 原始顺序输出对应 tool message。
   - 如果已有 tool message，使用它的 clone。
   - 如果缺失，插入 `{ role: "tool", tool_call_id, content: "(cancelled)" }`。
   - 标记这些 tool id 已消费。
4. 后续遍历到已经消费过的 tool message 时跳过，避免重复。
5. 遍历到没有任何 assistant 引用的 orphan tool message 时跳过。本轮选择“丢弃无归属 tool message”，因为 provider 不能接受孤立 tool message；正常 agent 路径不应生成它，测试要覆盖不把它发送给 LLM。

注意：本轮不在 normalize 里引入 logger，避免把纯函数变成依赖注入模块。

### 3. clone 策略

新增内部 helper：

- `cloneMessage(msg)`：浅 clone message，并 clone content array / tool_calls。
- `cloneContent(content)`：字符串和 null 原样返回；数组内容逐 block clone，并过滤 block 内 `_` 开头字段。
- `cloneToolCalls(toolCalls)`：clone tool call 和内部 `function` 对象。

顶层 `_round` 必须保留到 normalize 输出中，因为 `groupToBlocks()` 依赖它计算 block.round。`flattenToMessages()` 仍负责最终清除 `_round`。

### 4. 合并策略

`mergeConsecutiveRoles()` 只允许：

- `user + user`
- 普通 `assistant + assistant`，且两条 assistant 都没有有效 `tool_calls`

不允许：

- `tool + tool`
- `assistant(tool_calls) + assistant`
- `assistant + assistant(tool_calls)`

合并时必须创建新对象，不得修改 `last` 原对象。

## 五、改动清单

### A. 先补失败测试：normalize 顺序和纯函数

文件：

- `src/normalize.test.ts`

Checklist：

- [ ] 更新“缺失 tool result”测试：断言 placeholder 位于对应 assistant 后、后续 user 前。
- [ ] 新增多 tool_call 测试：两个 tool call 中缺一个结果时，输出顺序为 assistant -> tool(call_1) -> tool(call_2)。
- [ ] 新增 out-of-place tool result 测试：如果 tool result 出现在后续 user 之后，normalize 会把它移动回对应 assistant 后，并在原位置跳过。
- [ ] 新增 orphan tool result 测试：没有任何 assistant 引用的 role=tool message 不出现在 normalize 输出中。
- [ ] 新增纯函数测试：调用 normalize 后，原 messages 深度等于调用前快照。
- [ ] 新增引用隔离测试：合并连续 user 后，修改 result content 不影响原 messages。
- [ ] 新增 assistant 合并边界测试：带 tool_calls 的 assistant 不与相邻 assistant 合并。
- [ ] 保留顶层 `_round` 测试：normalize 输出仍包含 `_round`，后续 flatten 再清除。

建议测试命名：

- `inserts missing tool result immediately after its assistant tool call`
- `moves existing out-of-place tool result back into the assistant tool block`
- `does not mutate input messages`
- `does not merge assistant messages when either side has tool calls`

### B. 修改 normalize 实现

文件：

- `src/normalize.ts`

Checklist：

- [ ] 将 `cleanMetadata()` 改为始终返回 clone 后的新 message。
- [ ] content 数组 block 仍过滤 `_` 开头字段。
- [ ] 顶层 `_round` 不在 normalize 阶段删除。
- [ ] 重写 `ensureToolResults()`，按第四节的 block-aware 策略插入或移动 tool result。
- [ ] 对缺失 id 的 tool_call 保持现有策略：只在 `toolCall.id` 存在时插入 placeholder。
- [ ] orphan role=tool message 不进入 normalize 输出。
- [ ] 重写 `mergeConsecutiveRoles()`，合并时创建新对象。
- [ ] `mergeConsecutiveRoles()` 不合并任何带 `tool_calls` 的 assistant。
- [ ] 保持输出 content 合并格式不变：连续 string content 仍合并为 text block 数组，避免破坏现有测试。

### C. 加固 message-block 测试和小清理

文件：

- `src/message-block.ts`
- `src/message-block.test.ts`

Checklist：

- [ ] 删除 `pendingUser = undefined;` 重复赋值。
- [ ] 新增测试：`normalizeMessages()` 后的“缺失 tool_result”序列可以 group 成一个 `tool_use` block，随后 user query 保持为独立 text block。
- [ ] 新增 round-trip 测试：normalized tool block 经 `groupToBlocks()` + `flattenToMessages()` 后，assistant 与 tool result 仍连续。
- [ ] 不把复杂修复逻辑下沉到 `message-block.ts`，避免压缩层承担 provider-normalization 职责。

### D. 增加 Agent 集成测试

文件：

- `src/agent.test.ts`

Checklist：

- [ ] 扩展或新增 fake LLM，记录每次 `chat(messages, tools)` 收到的 messages。
- [ ] 在“多 tool call + PreToolUse exitCode 2”场景中，断言第二次 LLM 调用的输入顺序为：

```text
user(original query)
assistant(tool_calls call_1, call_2)
tool(call_1)
tool(call_2)
user([Hook: PreToolUse]...)
```

- [ ] 断言 Hook user message 不在两个 tool result 中间。
- [ ] 断言没有 role=tool message 出现在没有前置 assistant tool_calls 的位置。
- [ ] 保留现有 history 顺序测试，不用重写 agent loop。

### E. 文档同步

文件：

- `doc/summary.md`
- `doc/refactor-2026-05-project-review.md`，如实施过程中改变本方案边界

Checklist：

- [ ] `doc/summary.md` 的“消息标准化”段落补充：normalize 是纯函数；缺失 tool_result 会插入到对应 assistant tool block 内；顶层 `_round` 由 flatten 清除。
- [ ] `doc/summary.md` 测试覆盖表更新 `src/normalize.test.ts`、`src/message-block.test.ts`、`src/agent.test.ts` 数量和覆盖描述。
- [ ] 如果实施 agent 选择不丢弃 orphan tool message，而是转换为 user message，必须更新本文档说明原因。

## 六、建议 PR / Commit 切分

### PR 1：normalize 纯函数与 tool block 修复

目标：

- 完成 A、B。
- 不改 agent loop。

建议文件：

- `src/normalize.ts`
- `src/normalize.test.ts`

验证：

```bash
npm run typecheck
npx vitest run src/normalize.test.ts
```

### PR 2：message-block 与 agent 集成测试

目标：

- 完成 C、D。
- 只做小清理，不改 agent 主流程。

建议文件：

- `src/message-block.ts`
- `src/message-block.test.ts`
- `src/agent.test.ts`

验证：

```bash
npm run typecheck
npx vitest run src/message-block.test.ts src/agent.test.ts
```

### PR 3：文档收尾

目标：

- 完成 E。
- 确认 summary 与当前实现一致。

建议文件：

- `doc/summary.md`
- `doc/refactor-2026-05-round2-message-pipeline-plan.md`

验证：

```bash
npm run typecheck
npx vitest run src/normalize.test.ts src/message-block.test.ts src/agent.test.ts
```

## 七、实施顺序

1. 先运行当前相关测试，记录基线。如果 Vitest 因 Rollup native optional dependency 或 macOS code signature 问题无法启动，先在执行回复里说明环境阻塞。
2. 先写 normalize 失败测试，再改实现。
3. normalize 测试通过后，再补 message-block 测试。
4. 最后补 agent 集成测试，确认真实 loop 输入顺序。
5. 更新 `doc/summary.md`。
6. 运行 typecheck、相关 vitest、eslint changed files。

## 八、验收标准

本轮完成后必须满足：

1. `normalizeMessages()` 不修改输入数组和输入对象。
2. 任意 assistant `tool_calls` 的 tool results 在 normalize 输出中紧跟该 assistant。
3. 缺失 tool result 的 placeholder 不会被追加到全局尾部。
4. out-of-place tool result 会被移动回对应 assistant block。
5. orphan tool message 不会进入最终 LLM 输入。
6. 带 `tool_calls` 的 assistant 不会和相邻 assistant 合并。
7. `groupToBlocks()` 能把 normalized tool sequence 作为完整 `tool_use` block。
8. 真实 agent loop 中，Hook exitCode 2 注入的 user message 只出现在所有 tool_result 之后。
9. `doc/summary.md` 与实现、测试数量保持一致。

## 九、风险提示

1. 不要删除顶层 `_round`。它不是 OpenAI API 字段，但在 normalize 后、flatten 前是内部协议字段。
2. 不要把 system prompt 放进 `groupToBlocks()` 管线。当前 agent 已经单独处理 system message。
3. 不要为了“严格交替”合并 tool messages。tool messages 必须保留一条对应一个 `tool_call_id`。
4. 不要在 normalize 中引入 logger 或依赖注入；保持它是可单测的纯数据转换函数。
5. 如果修改 `mergeConsecutiveRoles()` 的输出 content 格式，必须同步更新所有依赖 array content 的旧测试。
