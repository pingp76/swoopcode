# 2026-05 第五轮重构方案：时间语义收口与最终优化

本文是当前 review 重构线的最后一轮方案。它面向后续真正编码的 coding agent，目标是用一次小而精确的收口，解决 `round` / `turn` / `sequence` 的命名和语义漂移问题，同时避免把教学项目推向过度框架化。

第五轮之后，除非新增功能章节或发现新的高风险漏洞，不建议继续做横向大重构。

实施状态（2026-05）：已完成。

- 新增 `src/timeline.ts`，统一 `turnIndex` / `loopRound` / `loopIndex` / `messageSequence` 类型语义。
- `History` 现在为每条普通对话消息分配 `messageSequence`，并保存 timing metadata；旧 `{ round }` 调用仍兼容。
- `MessageBlock` 管线会携带并清理 `_turnIndex`、`_loopRound`、`_loopIndex`、`_messageSequence`、`_round`。
- `Compressor.decayOldBlocks()` 优先使用 `loopIndex` 判断跨 turn 年龄，旧 `round` 仅作为 fallback。
- `TranscriptEvent.sequence` 与 `historySequence` 已明确区分。
- `Agent` 在同一实例内维护递增 `turnIndex` 和 `loopIndex`，`maxRounds` 仍使用 turn 内 `loopRound`。

## 一、前置状态

前四轮已经完成：

1. Schedule / Async Run / Permission 的 P0 交叉边界修复。
2. 消息 normalize 与 tool_call / tool_result 邻接不变量修复。
3. 非交互执行边界 `ExecutionPolicy` 收敛。
4. `OutputStore` / `run_output_read` 与 `run_edit_exact`。

当前剩余的最高价值问题是 P1-3：时间语义统一。它不应该扩大为 `index.ts` 拆分、统一错误类型、通用 JSON store、统一 ID generator 或完整 MessagePipeline 抽象。

## 二、本轮目标

### 目标

1. 明确区分用户 turn、Agent loop round、全 session loop index、History message sequence、Transcript event sequence。
2. 让上下文衰减压缩不再依赖每次 `agent.run()` 都从 0 重新开始的局部 `roundCount`。
3. 保持现有教学递进：不删除早期 `round` 相关讲解，但在当前实现和 summary 中说明新版语义。
4. 保留 prompt cache 友好设计：不因为时间元信息重构而改 system prompt 或工具定义。
5. 补齐测试，证明多次用户输入、多轮工具调用、compact 写回、transcript 记录之间的时间元信息不会漂移。

### 非目标

1. 不拆分 `index.ts`。它仍然是 Composition Root，后续如果要拆，应单独开新章节。
2. 不新增通用 `JsonEntityStore<T>`。
3. 不统一所有错误类型。
4. 不新增 `run_patch`。
5. 不实现 `workspace_write`、Async Run cancel、Schedule linked Task 更新或主动汇报。
6. 不持久化 Session / Transcript。
7. 不把 MessagePipeline 抽象成插件系统。第五轮只整理时间元信息，不重构整条消息管线。

## 三、当前问题

目前代码中的 `round` 至少承担了三种不同含义：

1. `agent.ts` 的 `roundCount`：一次 `agent.run()` 内第几次调用 LLM。
2. `HistoryEntry.round` / `_round`：消息块进入 compressor 后用于判断新旧。
3. `TranscriptEvent.round`：事件记录中的轮次线索。

问题在于：`roundCount` 每次 `agent.run()` 都从 0 开始。如果同一个 Agent 实例经历多次用户输入，后一轮用户输入中的第 1 次 LLM 调用仍然是 `round=1`。这会让“消息年龄”判断依赖局部 loop，而不是依赖整个 session 内真实经过了多少次 LLM 调用。

这在单轮测试中不明显，但当一个工作 agent 持续运行、积累多次用户输入、穿插 reminder / hook / async notification / schedule notification 时，旧工具结果的衰减时机可能变得不可解释。

## 四、统一术语

第五轮引入下列术语。实现中应尽量使用这些名字；旧字段 `round` 可作为兼容别名短期保留，但不再作为新语义的首选名字。

| 名称 | 含义 | 生命周期 | 主要用途 |
| --- | --- | --- | --- |
| `turnIndex` | 第几次外部用户输入触发的 `agent.run()` | 单个 Agent 实例内单调递增 | 区分用户 turn，解释 reminder 属于哪个用户请求 |
| `loopRound` | 当前 turn 内第几次 think-act-observe / LLM 调用 | 每次 `agent.run()` 内从 1 开始 | `maxRounds`、用户可理解的“本轮第几次循环” |
| `loopIndex` | 当前 Agent 实例内第几次 LLM 调用 | 单个 Agent 实例内单调递增 | 上下文衰减压缩的年龄基准 |
| `messageSequence` | History 中第几条普通对话消息 | 单个 History 内单调递增 | 稳定排序、debug、compact round-trip |
| `transcriptSequence` | Transcript 中第几个 append-only 事件 | 单个 session 内单调递增 | 事件回放、审计、搜索 |
| `timestamp` | 真实墙钟时间 | 来自 clock | 人类审计，不参与压缩年龄判断 |

关键决策：**P0 衰减压缩使用 `loopIndex`，不使用 `messageSequence`。**

原因是“旧工具结果”本质上应该表示“经过了多少次 LLM 思考循环”，而不是“后面追加了多少条消息”。一次工具调用可能产生多条 tool result / hook message / reminder，如果用 message sequence 做年龄，压缩时机将和消息数量耦合。

## 五、目标数据模型

建议新增一个很小的 `src/timeline.ts`，只放类型和少量注释，不放复杂状态机：

```ts
export interface MessageTimingInput {
  turnIndex?: number;
  loopRound?: number;
  loopIndex?: number;
  /** 兼容旧调用点：等价于 loopRound，不再用于跨 turn 衰减判断。 */
  round?: number;
}

export interface MessageTiming {
  turnIndex?: number;
  loopRound?: number;
  loopIndex?: number;
  messageSequence: number;
  /** 兼容字段：短期保留，后续新代码不要主动依赖。 */
  round?: number;
}
```

如果实施者认为单独文件过重，也可以先放在 `history.ts`；但无论放在哪里，`HistoryEntry`、`MessageBlock`、`TranscriptEvent` 的字段命名必须保持一致。

## 六、精确改动计划

### A. History 时间元信息

文件：

- `src/history.ts`
- `src/history.test.ts`

改动：

1. 将 `HistoryEntry` 从 `{ message, round? }` 扩展为：
   - `message`
   - `messageSequence`
   - `turnIndex?`
   - `loopRound?`
   - `loopIndex?`
   - `round?` 兼容字段
2. `History.add()` 继续接受旧参数 `{ round?: number }`，同时接受新参数：
   - `{ turnIndex?: number; loopRound?: number; loopIndex?: number; round?: number }`
3. `History.add()` 返回刚写入的 `HistoryEntry`，方便 `agent.ts` 把 `messageSequence` 写入 transcript。
   - 这是向后兼容的扩展：旧调用方忽略返回值即可。
4. `round` 的兼容规则：
   - 如果调用方传 `loopRound`，`entry.round = loopRound`。
   - 如果只传旧 `round`，`entry.loopRound = round` 且 `entry.round = round`。
   - `loopIndex` 不从 `round` 推断，避免把局部 round 误当成全局年龄。
5. `replaceEntries()` 保留传入 entry 上已有的 `messageSequence`；如果某条 entry 没有 `messageSequence`，由 History 分配新序号。
6. `replaceEntries()` 完成后，内部 next sequence 必须大于所有现存 `messageSequence`，避免下一次 `add()` 撞号。

测试：

- `add()` 自动分配递增 `messageSequence`。
- 旧 `{ round: 2 }` 调用仍能通过 `entry.round` 和 `entry.loopRound` 读到 2。
- 新 `{ turnIndex, loopRound, loopIndex }` 会被完整保存。
- `replaceEntries()` 保留已有 sequence，并为缺失 sequence 的 summary 分配新 sequence。
- `getMessages()` 仍不暴露任何 timing 元信息。

### B. Agent 时间来源

文件：

- `src/agent.ts`
- `src/agent.test.ts`

改动：

1. 在 `createAgent()` 闭包中新增两个计数器：

```ts
let nextTurnIndex = 0;
let nextLoopIndex = 0;
```

2. 每次 `run(query)` 开始时：
   - `const turnIndex = ++nextTurnIndex`
   - `const initialLoopIndex = nextLoopIndex + 1`
   - 用户 query、turn reminders、sessionEventBuffer reminders 使用：
     - `turnIndex`
     - `loopRound: 0`
     - `loopIndex: initialLoopIndex`
3. Agent 主循环中：
   - 将局部变量 `roundCount` 重命名为 `loopRound`
   - 每次进入一次 LLM 调用前：
     - `loopRound++`
     - `const loopIndex = ++nextLoopIndex`
4. TODO tick、async notification、schedule notification、recovery reminder、continuation reminder 等运行中注入的 user message 使用当前：
   - `turnIndex`
   - `loopRound`
   - `loopIndex`
5. `buildRoundLimitResponse()` 可重命名为 `buildLoopRoundLimitResponse()`，语义明确为 turn 内 loop 限制。
6. `appendMessage()` 改为接受 timing 对象，而不是单个 `round` 数字。
7. `appendMessage()` 调用 `history.add()` 后，将返回 entry 的 `messageSequence` 传给 transcript。
8. 所有注释中“round 表示消息年龄”的说法改成：
   - `loopRound` 表示当前 turn 内循环次数。
   - `loopIndex` 表示 compressor 的年龄基准。

测试：

- 同一个 Agent 实例连续调用两次 `run()`，第二次的 `turnIndex` 应递增。
- 第二次 `run()` 的 `loopRound` 从 1 重新开始，但 `loopIndex` 继续递增。
- `maxRounds` 仍按 `loopRound` 截断子智能体。
- 初始用户 query 和第一轮 LLM 调用共享同一个即将执行的 `loopIndex`，避免刚写入的 query 被视为“过旧”。
- async / schedule notification 注入时带当前 timing，并能进入 transcript。

### C. 消息管线元信息

文件：

- `src/agent.ts`
- `src/normalize.ts`
- `src/message-block.ts`
- `src/message-block.test.ts`

改动：

1. `annotateEntries()` 不再只写 `_round`，而是写入：
   - `_turnIndex`
   - `_loopRound`
   - `_loopIndex`
   - `_messageSequence`
   - `_round` 兼容字段
2. `normalizeMessages()` 必须保留这些顶层内部字段。
   - 它仍然只清理 content 数组内部 `_` 开头字段。
3. `MessageBlock` 类型扩展：
   - `turnIndex?`
   - `loopRound?`
   - `loopIndex?`
   - `messageSequence?`
   - `round?` 兼容字段
4. `groupToBlocks()` 聚合时：
   - `messageSequence` 取块内最小值，用于稳定排序和 debug。
   - `loopIndex` 取块内最小值，用于代表该 block 的产生年龄。
   - `turnIndex` / `loopRound` 也取块内最小值，保留解释性。
5. `flattenToMessages()` 必须清除所有内部字段：
   - `_turnIndex`
   - `_loopRound`
   - `_loopIndex`
   - `_messageSequence`
   - `_round`
6. `blocksToEntries()` 或等价恢复函数在 compact 写回时，优先读取每条消息自己的内部 timing；只有缺失时才 fallback 到 block 聚合 timing。

测试：

- group / flatten 后不会把 `_turnIndex` 等内部字段发送给 LLM。
- tool_use block 能保留 `loopIndex`，并且 flatten 后原始消息顺序不变。
- compact 写回时，块内每条消息自己的 timing 不会被 block 聚合 timing 覆盖。
- 缺失新字段但存在旧 `_round` 的消息仍能按旧测试通过。

### D. Compressor 衰减语义

文件：

- `src/compressor.ts`
- `src/compressor.test.ts`

改动：

1. `decayOldBlocks(blocks, currentRound)` 的参数名和注释改为 `currentLoopIndex`。
2. 计算 block age 时优先使用：
   - `block.loopIndex`
   - fallback：`block.round`
3. `decayAfterRounds` 配置名可以暂时不改，以免牵连 `.env` 和早期文档；但 summary 中要说明它现在表示“经过多少次全 session LLM loop 后衰减”。
4. 如果 block 没有 `loopIndex` 也没有 `round`，不做衰减，保持当前保守行为。
5. P1 即时压缩、P2 全量压缩、OutputStore 逻辑不变。

测试：

- 两个不同 user turn 的 tool block：即使第二个 turn 的 `loopRound` 又从 1 开始，旧 block 也会因 `loopIndex` 差距被衰减。
- 只有旧 `round` 字段的 block 仍按旧逻辑衰减，避免早期测试断裂。
- 大输出 OutputStore 行为不受影响。

### E. Transcript 关系说明

文件：

- `src/transcript.ts`
- `src/transcript.test.ts`

改动：

1. `TranscriptEvent` 增加可选字段：
   - `turnIndex?`
   - `loopRound?`
   - `loopIndex?`
   - `historySequence?`
2. 保留现有 `sequence` 字段，它仍然是 transcript event sequence，不等同于 history message sequence。
3. `appendMessage()` 接收 timing 和 historySequence。
4. `append()` 对非 message 事件也可以接收 timing，但不强制。
5. 文档注释明确：
   - `sequence`：事件流顺序。
   - `historySequence`：如果该事件对应一条 History message，记录它在 prompt working context 中的顺序。

测试：

- 同一个 session 内 transcript `sequence` 递增。
- message 事件能保存 `historySequence`。
- recovery / history_replaced 事件可以带 timing，但没有 historySequence 也合法。

### F. 文档与注释审计

文件：

- `doc/summary.md`
- `doc/pdd6.md`
- `doc/pdd10.md`
- `doc/pdd11.md`
- `doc/refactor-2026-05-project-review.md`
- 本文档

改动：

1. `doc/summary.md` 新增或更新“时间语义”小节。
2. `Agent 核心循环` 小节改写：
   - `roundCount` -> `loopRound`
   - 说明 `turnIndex / loopRound / loopIndex / messageSequence / transcriptSequence`
3. `上下文压缩` 小节说明 P0 衰减使用 `loopIndex`。
4. `History` 小节从 “messages + rounds” 更新为 “messages + timing metadata”。
5. `Transcript` 小节说明 `sequence` 和 `historySequence` 的差异。
6. PDD 正文不大面积重写，避免破坏教学递进；只在相关文档追加“当前实现备注”：
   - PDD6：压缩年龄从局部 round 收口到全 session `loopIndex`。
   - PDD10：turn reminder 仍走 user message，带 timing metadata，不改 system prompt。
   - PDD11：错误恢复 compact 写回保留 timing metadata。
7. `doc/refactor-2026-05-project-review.md` 将 P1-3 标记为第五轮处理完成，并说明这是当前重构线最后一轮。

## 七、实施顺序

建议按以下顺序实施，不要跳到 `agent.ts` 直接全局改名。

1. 新增/定义 timing 类型。
2. 修改 `history.ts`，让 timing metadata 和 sequence 能独立测试通过。
3. 修改 `message-block.ts`，让管线能携带并清除新内部字段。
4. 修改 `compressor.ts`，将衰减年龄切到 `loopIndex`，保留旧 `round` fallback。
5. 修改 `transcript.ts`，明确 event sequence 和 history sequence。
6. 最后修改 `agent.ts`，把真实 timing 串起来。
7. 跑聚焦测试。
8. 更新 summary 和 PDD 备注。
9. 跑全量测试。

不要先做全局搜索替换 `round`。代码中仍有一些合理的 `round`：

- `max_rounds` tool 参数是面向用户的旧名称，可以保留。
- TODO manager 里的 `roundCount` 表示 TODO 中断计数，暂不纳入本轮。
- 旧测试和兼容字段中的 `round` 可以保留，但注释要说明它是 legacy 或局部语义。

## 八、Checklist

### A. 类型与 History

- [ ] 定义 timing metadata 的字段含义。
- [ ] `HistoryEntry` 增加 `messageSequence`。
- [ ] `HistoryEntry` 增加 `turnIndex`、`loopRound`、`loopIndex`。
- [ ] `History.add()` 返回写入后的 entry。
- [ ] `History.add()` 兼容旧 `{ round }`。
- [ ] `History.replaceEntries()` 保留或分配 sequence，并维护 next sequence。
- [ ] `getMessages()` 不泄漏 timing metadata。

### B. Agent loop

- [ ] `createAgent()` 闭包维护 `nextTurnIndex`。
- [ ] `createAgent()` 闭包维护 `nextLoopIndex`。
- [ ] 每次 `run()` 分配新的 `turnIndex`。
- [ ] 每次 LLM 调用分配新的全局 `loopIndex`。
- [ ] 局部 `roundCount` 重命名或注释为 `loopRound`。
- [ ] 初始 user query / turn reminder 绑定即将执行的 first loop index。
- [ ] async / schedule / hook / recovery / continuation reminders 都带 timing。
- [ ] `maxRounds` 仍按 `loopRound` 工作。

### C. Message block

- [ ] `annotateEntries()` 写入新内部字段。
- [ ] `normalizeMessages()` 保留新顶层内部字段。
- [ ] `groupToBlocks()` 聚合新 timing 字段。
- [ ] `flattenToMessages()` 清理新内部字段。
- [ ] compact 写回保留每条消息自己的 timing。

### D. Compressor

- [ ] `decayOldBlocks()` 使用 `loopIndex` 判断年龄。
- [ ] 无 `loopIndex` 时 fallback 到旧 `round`。
- [ ] `decayAfterRounds` 文档说明当前含义。
- [ ] OutputStore 与即时压缩行为不变。

### E. Transcript

- [ ] `TranscriptEvent` 增加 timing 字段。
- [ ] `TranscriptEvent.sequence` 保持事件序列语义。
- [ ] message 事件记录 `historySequence`。
- [ ] 文档说明 `historySequence` 与 `sequence` 的差异。

### F. 文档

- [ ] `doc/summary.md` 增加时间语义小节。
- [ ] `doc/summary.md` 更新 Agent / History / Transcript / Compressor 描述。
- [ ] `doc/pdd6.md` 增加当前实现备注。
- [ ] `doc/pdd10.md` 增加当前实现备注。
- [ ] `doc/pdd11.md` 增加当前实现备注。
- [ ] `doc/refactor-2026-05-project-review.md` 标记第五轮为最后一轮优化。

## 九、测试计划

聚焦测试：

```bash
npx vitest run \
  src/history.test.ts \
  src/message-block.test.ts \
  src/compressor.test.ts \
  src/transcript.test.ts \
  src/agent.test.ts
```

共享行为测试：

```bash
npx vitest run \
  src/normalize.test.ts \
  src/recovery.test.ts \
  src/tools/subagent.test.ts \
  src/async-runs.test.ts \
  src/schedules.test.ts
```

最终验证：

```bash
npm run typecheck
npm test
npx eslint src/history.ts src/message-block.ts src/compressor.ts src/transcript.ts src/agent.ts
git diff --check
```

如果普通 shell 找不到 `npm` 或 `npx`，按本仓库既有经验使用：

```bash
zsh -lic 'npm test'
```

## 十、验收标准

第五轮完成后，必须满足：

1. 连续两次 `agent.run()` 不会让压缩年龄回退。
2. `loopRound` 仍能表达单个 user turn 内第几次 LLM 调用。
3. `maxRounds` 不受全局 `loopIndex` 影响。
4. `History` 中每条消息都有稳定 `messageSequence`。
5. `Transcript` 事件 sequence 与 History message sequence 的关系被代码和文档明确区分。
6. `_turnIndex` / `_loopRound` / `_loopIndex` / `_messageSequence` / `_round` 不会出现在最终发送给 LLM 的消息中。
7. 早期教学章节仍可理解：旧 `round` 不被突然删除，而是作为兼容字段逐步淡出。
8. 全量测试通过。

## 十一、风险提示

1. 不要把 `loopRound` 用作跨 turn 年龄。它每次用户输入都会重置。
2. 不要把 `messageSequence` 用作压缩年龄。消息数量不是模型思考轮数。
3. 不要把 `transcript.sequence` 当成 `history.messageSequence`。Transcript 是 append-only 审计流，History 是可 compact / replace 的 prompt working context。
4. 不要把 timing metadata 放进 message content。它应该是内部顶层字段，最终 flatten 时清除。
5. 不要为了“命名彻底”删除所有 `round`。`max_rounds`、旧测试、旧 PDD 都需要兼容。
6. 不要在这轮顺手拆 `index.ts`。Composition Root 拆分不是时间语义收口的必要条件。

## 十二、完成后的项目状态

第五轮完成后，当前 review 重构线可以收束：

1. P0 设计漏洞已经处理。
2. P1 中影响边界正确性的项目已经处理。
3. 剩余事项主要是后续功能章节，而不是当前架构债。

后续如果继续推进，建议按“新功能 PDD”而不是“继续 refactor round”组织，例如：

- workspace_write profile
- Async Run cancel
- Schedule linked Task update
- run_patch
- index.ts Composition Root 拆分

这些都不是第五轮的一部分。
