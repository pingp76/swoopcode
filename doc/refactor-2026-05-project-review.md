# 2026-05 项目整体 Review 后续重构方案

本文面向后续执行重构的 coding agent。目标不是推翻当前教学项目，而是在保留 PDD1-PDD14 递进式章节设计的前提下，修正当前已经暴露的整体性边界问题，让这个项目更适合作为未来工作 agent 的基础。

## 一、重构总原则

1. 保持教学递进，不把后续章节能力提前塞回早期章节。
2. 先修契约和边界，再做结构拆分。
3. 每一轮改动都必须能独立验证，不做跨几十个文件的大爆炸式重构。
4. 不删除已有教学能力。若旧工具过于简单，优先新增更安全的后续工具或收紧描述，而不是直接破坏早期 lesson。
5. `doc/summary.md` 是当前实现状态入口。任何行为变化完成后，都要同步更新 summary 和相关 PDD 的实现备注。
6. 对外暴露的 schema、type、tool description、system prompt、测试必须保持三角一致：接口承诺了什么，实现就要做到什么，测试也要覆盖什么。

## 二、当前整体判断

项目的主骨架是正确的：

- `index.ts` 作为 composition root，集中创建共享依赖。
- `ProjectContext` 明确区分 `projectRoot` 和 `agentHome`。
- `SystemPromptProvider` 已经把稳定 prompt、session snapshot、turn reminder 分层。
- `TaskStore` 的主身份、项目索引、读写校验比早期模块更成熟。
- `Async Run`、`Schedule`、`Task`、`TODO` 已经形成了较好的能力分层。

真正需要优先处理的问题，是 PDD12-PDD14 之后出现的生命周期和边界硬化问题：

- durable 数据和 session-local 执行之间缺少恢复协议。
- agentHome 全局存储和当前 projectRoot 执行边界之间还有泄漏。
- 部分 tool schema 暴露了尚未兑现的能力。
- 权限策略在 permission、bash、async、schedule 多处重复表达。
- message normalize、output persistence、round 语义等核心管线还有隐性不变量风险。

## 三、P0：必须优先修复的设计漏洞

### P0-1. 修正 Schedule 跨项目执行边界

#### 问题

Schedule 数据存放在全局 `agentHome/schedules` 下，但 `ScheduleManager.reloadActiveSchedules()` 当前会加载所有 active schedule。由于 `AsyncRunManager` 用当前启动项目的 `projectRoot` 创建，一个项目中的 agent 进程可能触发另一个项目的 schedule，并在错误的 projectRoot 下执行。

#### 涉及文件

- `src/project-context.ts`
- `src/schedule-store.ts`
- `src/schedules.ts`
- `src/index.ts`
- `src/cli-commands.ts`
- `src/schedules.test.ts`
- `src/schedule-store.test.ts`
- `src/tools/schedules.test.ts`，如果还不存在则新增
- `doc/summary.md`
- `doc/pdd14.md`

#### 建议方案

1. `ScheduleManager` 启动扫描时只加载当前 `projectRoot` 的 schedule。
2. `ScheduleStore.list()` 仿照 `TaskStore.list()`，默认 current-project only，跨项目列表必须显式传参。
3. CLI `/schedule list` 默认只列当前项目，新增或保留 `--all-projects` 作为显式跨项目查询入口。
4. `run_schedule_list` 的 tool description 必须说明默认只看当前项目。
5. 如果未来要允许跨项目 schedule，必须在 schedule 文件中保存并在触发时恢复原始 `projectRoot`，不能用当前进程 projectRoot 代替。

#### 验收标准

- 在同一个 `agentHome` 下保存项目 A 和项目 B 的 schedule，从项目 B 启动时不能触发项目 A 的 schedule。
- `/schedule list` 和 `run_schedule_list` 默认不显示其他项目 schedule。
- 显式 all-projects 查询只能读，不改变触发范围。
- 相关测试覆盖 store、manager、CLI、tool 四层。

### P0-2. 补齐 Schedule durable 与 Async Run session-local 的恢复协议

#### 问题

PDD14 定义 Schedule 是跨 session / 跨重启的 durable trigger，而 PDD13 定义 Async Run 是当前进程/session 内的一次性运行。当前 occurrence 进入 `running` 后，如果进程退出，重启后没有机制把它收敛为 `missed`、`orphaned`、`timeout` 或其他终态。

#### 涉及文件

- `src/schedules.ts`
- `src/schedule-store.ts`
- `src/async-runs.ts`
- `src/schedules.test.ts`
- `doc/pdd13.md`
- `doc/pdd14.md`
- `doc/summary.md`

#### 建议方案

1. 在 Schedule 启动扫描时读取最近 running occurrences。
2. 对没有对应内存 async run 的 running occurrence 执行收敛策略。
3. 第一版推荐新增 occurrence status：`orphaned`。语义是：上次进程退出时 async run 失联，不能恢复输出。
4. 如果 occurrence 已超过 `timeoutSeconds`，也可以收敛为 `timeout`，但要在文档里说明这是按 wall-clock 推断，不是 async run 真正回调。
5. `runningOccurrences` 内存 map 只能作为当前进程 overlap 优化，不能作为唯一事实源。

#### 验收标准

- 重启时不会留下永久 running occurrence。
- overlapPolicy=skip 在重启后不会因为内存 map 清空而误判。
- orphaned 或 timeout 会进入 schedule notification，LLM 下一轮能看到。
- 文档清楚说明：Schedule durable，Async Run 不 durable，恢复只恢复 occurrence 状态，不恢复执行进程。

### P0-3. 收敛 Schedule 对外契约，删除或实现未兑现字段

#### 问题

`run_schedule_create` schema 暴露了 `save_raw_output`、`linked_task_update`、部分 permission profile 语义，但当前实现没有完整兑现：

- Async Run 完成时总是写输出文件，没有按 schedule output policy 控制。
- `linked_task_update` 没有 TaskManager 依赖和实现。
- `permissionProfile` 目前更像记录字段，不是完整执行边界。

#### 涉及文件

- `src/tools/schedules.ts`
- `src/schedules.ts`
- `src/schedule-store.ts`
- `src/async-runs.ts`
- `src/tasks.ts`
- `src/tools/tasks.ts`
- `src/permission.ts`
- `doc/pdd14.md`
- `doc/summary.md`

#### 建议方案

短期建议选择路线 A：

1. 第一版只保留真正实现的字段。
2. 把未实现字段从 tool schema 移除，或标记为内部预留且不让 LLM 设置。
3. 在 PDD14 中新增“当前实现裁剪”小节，明确哪些字段是设计预留。

中期再选择路线 B：

1. `ScheduleManager` 注入 `TaskManager`。
2. `linkedTaskUpdate=append_note` 时，把 occurrence summary 追加到指定 Task。
3. `mark_failed_on_failure` 只在 occurrence 失败、超时、orphaned 时更新 task。
4. `saveRawOutput=false` 时，Async Run 不保存 raw output，或者只保存 summary output。

#### 验收标准

- 任一 tool schema 字段都能在实现里找到消费点。
- 每个非默认字段至少有一个测试。
- 文档不再把“未来设计”描述成“当前已实现”。

### P0-4. 修正消息 normalize 的 tool_call / tool_result 不变量

#### 问题

`normalize.ensureToolResults()` 当前把缺失 tool result 追加到消息末尾，这可能破坏 assistant tool_call 与 tool result 的邻接关系。`mergeConsecutiveRoles()` 还会原地修改 message 对象，存在污染 History 引用的风险。

#### 涉及文件

- `src/normalize.ts`
- `src/normalize.test.ts`
- `src/message-block.ts`
- `src/message-block.test.ts`
- `src/agent.test.ts`

#### 建议方案

1. normalize pipeline 必须纯函数化，所有输出 message 都是 clone 或新对象。
2. 缺失 tool result 必须插入到对应 assistant tool_call block 后，而不是追加到全局尾部。
3. 更推荐把补全逻辑下沉到 message block 层：先 group，再按 block 修复或拒绝。
4. 增加测试覆盖多轮 tool_call、缺失中间 tool_result、连续 user reminder、Hook inject 后的消息顺序。

#### 验收标准

- normalize 不修改输入数组及其内部 message 对象。
- tool result 永远跟随对应 assistant tool_call 所在 block。
- message-block round-trip 测试仍通过。

## 四、P1：边界加固后继续推进

### P1-1. 统一 ExecutionPolicy，收敛权限和命令策略

#### 问题

权限判断分散在 `permission.ts`、`tools/bash.ts`、`async-runs.ts`、`schedules.ts` 和 registry 过滤选项里。Async command policy 还是 prefix 字符串匹配，容易允许带 `--fix` 或隐式写产物的命令。

#### 建议方案

1. 新增 `src/execution-policy.ts`。
2. 统一表达 `executor`、`permissionProfile`、`resources`、`projectRoot`、`command` 的验证。
3. command policy 不再只看 prefix，应至少解析为 argv，再检查子命令、flag、shell operator。
4. `permission.ts` 继续负责用户交互模式，`ExecutionPolicy` 负责非交互能力边界。
5. Schedule 和 Async Run 共用同一套 policy。

#### 验收标准

- `readonly`、`ci`、未来 `workspace_write` 的语义只在一个地方定义。
- `npx eslint --fix`、`npm run lint -- --fix`、`npx tsc` emit 场景有明确 allow/deny 测试。
- permission 中重复的 mode 分支被删除。

### P1-2. 建立统一 Output Handle 与读取工具

#### 问题

Async Run 有 `run_async_output_read`，但普通大工具输出由 compressor 写到 `<agentHome>/.task_outputs`，LLM 只看到 `.task_outputs/<toolCallId>.txt`，这个路径不一定能通过项目文件工具读取。

#### 建议方案

1. 新增 `OutputStore` 或 `output-handle.ts`。
2. 所有大输出都返回稳定 handle，例如 `out_<timestamp>_<slug>`。
3. 新增 `run_output_read`，只能读取 agentHome 下由 OutputStore 登记的输出。
4. Async Run output 可以继续保留专用读取工具，但内部也可复用 OutputStore。

#### 验收标准

- LLM 看到的每个 persisted output 都有可调用工具读回。
- output 读取不突破 projectRoot，也不暴露任意 agentHome 文件。
- compressor、async-run、schedule occurrence outputRef 的命名语义一致。

### P1-3. 梳理 round、turn、sequence 的时间语义

实施状态（2026-05 第五轮重构）：已作为当前 review 重构线最后一轮处理。

当前实现区分：

- `turnIndex`：第几次外部用户输入触发 `agent.run()`。
- `loopRound`：当前 turn 内第几次 LLM 调用，`maxRounds` 继续使用这个局部语义。
- `loopIndex`：同一个 Agent 实例内全局 LLM 调用序号，P0 衰减压缩使用它判断消息年龄。
- `messageSequence`：History working context 中的消息顺序。
- `TranscriptEvent.sequence`：Transcript append-only 事件流顺序，和 `messageSequence` 不混用。

#### 问题

当前每次 `agent.run()` 内部 roundCount 从 0 重新开始，用户消息和 reminder 也常写入 round 0。P0/P2 压缩依赖 round 判断旧消息，这在多用户 turn 场景里语义不够清楚。

#### 建议方案

1. 在 HistoryEntry 中区分 `turnIndex`、`loopRound`、`sequence`。
2. `turnIndex` 表示第几次外部用户输入。
3. `loopRound` 表示该 turn 内第几次 think-act-observe。
4. `sequence` 表示全 session 单调递增顺序。
5. 压缩策略优先使用 `sequence` 或 `turnIndex`，不要只依赖局部 round。

#### 验收标准

- 多次 `agent.run()` 后，旧消息年龄可以被稳定判断。
- Transcript sequence 与 History sequence 的关系在文档中说明。
- 现有单 turn 测试不退化。

### P1-4. 增加更安全的文件编辑能力

#### 问题

`run_write` 会覆盖整文件，`run_edit` 是 replaceAll。教学早期可以接受，但作为工作 agent 基座风险偏高。

#### 建议方案

1. 保留 `run_write` 和 `run_edit`，因为它们属于早期 lesson。
2. 新增后续章节工具，例如 `run_patch` 或 `run_edit_exact`。
3. 新工具要求 `expected_occurrences`、上下文片段或 unified patch。
4. tool description 中引导模型优先使用更安全的新工具。

#### 验收标准

- 旧章节代码和测试不被破坏。
- 新工具能拒绝多处匹配、零匹配、上下文漂移。
- 权限层把新工具归入 file-write。

### P1-5. 给 LLM 日志增加隐私和体积边界

#### 问题

`llm-logger.ts` 当前完整记录 system prompt、messages、tool args、response。教学调试很有价值，但未来工作 agent 会涉及密钥、路径、私有代码和用户输入。

#### 建议方案

1. 增加 `LLM_LOG_MODE=off|metadata|redacted|full`。
2. 默认建议为 `redacted` 或保留教学默认但在 summary 中明确风险。
3. 对 API key、常见 secret、超长 tool output 做截断或脱敏。
4. 保留 full 模式供教学调试显式开启。

#### 验收标准

- 默认日志不会保存明显 secret。
- full 模式行为有测试或快照覆盖。
- 文档说明日志路径和隐私边界。

## 五、P2：结构和教学质量整理

### P2-1. 文档同步和注释去漂移

优先修正：

- `doc/summary.md` 增加完整 Schedule 已实现功能段落。
- `doc/summary.md` 测试覆盖表加入 Schedule 工具、Schedule permission、Schedule agent integration。
- `src/tools/files.ts` 的 tool description 从 current working directory 改为 project root。
- `src/tools/subagent.ts` 删除“包含 write/edit、共享同一个 permissionManager”这类过期注释。
- `src/message-block.ts` 清理重复语句和注释。

验收标准：

- 每个实现能力在 summary 中都有准确入口。
- 注释讲边界和原因，不重复翻译代码。

### P2-2. 拆分过大的 wiring，但不引入框架化抽象

`index.ts` 已经完成早期 CLI/REPL 拆分，但 Async Run 和 Schedule 接线让 composition root 再次变厚。建议只做轻量拆分：

- `createAsyncRunWiring(...)`
- `createScheduleWiring(...)`
- `createToolProviders(...)`

这些函数可以先放在 `index.ts` 同文件内，等稳定后再移动。目标是让共享依赖的创建顺序更清楚，不是做一个复杂 container。

### P2-3. frontmatter 解析统一

Skill 和 Memory 都有 frontmatter 解析需求。当前解析器偏 ad hoc，错误时常静默跳过。

建议：

- 新增 `src/frontmatter.ts`。
- reader 和 writer 对称。
- 对 invalid skill/memory 返回 warning，至少 logger 可见。
- 保持格式简单，不引入 YAML 复杂依赖，符合教学项目定位。

## 六、建议执行顺序

### 第一轮：Schedule 边界修复

目标：

- P0-1 项目过滤。
- P0-2 running occurrence 重启收敛。
- P0-3 schema 契约裁剪，先不实现 linked task。

建议提交粒度：

1. 先改 store/manager 过滤和测试。
2. 再改 occurrence reconcile 和测试。
3. 最后改 tool schema、summary、PDD14。

验证：

```bash
npm run typecheck
npx vitest run src/schedule-store.test.ts src/schedules.test.ts
npx vitest run src/tools/schedules.test.ts src/cli-commands.test.ts src/permission.test.ts
```

### 第二轮：消息管线修复

目标：

- P0-4 normalize 纯函数化。
- tool_call/tool_result 按 block 修复。
- 增加顺序不变量测试。

验证：

```bash
npm run typecheck
npx vitest run src/normalize.test.ts src/message-block.test.ts src/agent.test.ts
```

### 第三轮：权限策略统一

目标：

- P1-1 新增 ExecutionPolicy。
- Async Run 和 Schedule 共用 command/profile/resource 验证。
- 清理 permission 重复分支。

验证：

```bash
npm run typecheck
npx vitest run src/permission.test.ts src/tools/bash.test.ts src/async-runs.test.ts src/schedules.test.ts
```

### 第四轮：输出读取与安全编辑

目标：

- P1-2 OutputStore 和 `run_output_read`。
- P1-4 新增安全 edit/patch 工具。

验证：

```bash
npm run typecheck
npx vitest run src/compressor.test.ts src/tools/files.test.ts src/tools/registry.test.ts src/agent.test.ts
```

### 第五轮：时间语义收口与最终优化

目标：

- P1-3 `turnIndex` / `loopRound` / `loopIndex` / `messageSequence` / `transcriptSequence` 时间语义收口。
- summary/PDD 只同步与时间语义直接相关的注释和实现备注。
- 明确本轮之后当前 review 重构线收束。

验证：

```bash
npm run typecheck
npm test
npm run lint
```

## 七、交给 coding agent 的执行要求

每个执行 agent 在开始编码前必须：

1. 读取 `AGENTS.md`。
2. 读取 `doc/summary.md`。
3. 读取本文档中对应阶段。
4. 如果修改 Schedule，必须读取 `doc/pdd14.md`。
5. 如果修改 Async Run，必须读取 `doc/pdd13.md`。
6. 如果修改 Task，必须读取 `doc/pdd12.md`。
7. 如果修改 prompt cache、memory、skill 动态状态，必须读取 `doc/pdd10.md`。

每个执行 agent 在编码前必须先输出 checklist：

- 需求点。
- 涉及文件。
- 测试文件。
- 文档同步点。
- 不改动范围。

每个执行 agent 完成后必须：

1. 逐条对照 checklist。
2. 运行最小相关测试。
3. 如果触及共享行为，再运行更宽测试。
4. 更新 `doc/summary.md`。
5. 在最终回复里明确说明未运行的验证和原因。

## 八、不要做的事情

1. 不要把 Schedule 改成一个完整 cron/workflow 平台。
2. 不要让 Async Run 变成 durable job system，除非另写新的 PDD。
3. 不要为了修权限问题直接把 mode 设成 auto。
4. 不要把 projectRoot 和 agentHome 混成一个目录。
5. 不要让动态状态修改 system prompt 或 tool definitions，除非明确新章节要讨论 prompt cache 取舍。
6. 不要一次性把 `agent.ts`、`index.ts`、tools、permission、schedule 全部重写。
7. 不要因为新增更安全工具就删除旧工具，旧工具仍承担教学递进价值。

## 九、完成后的理想状态

完成以上重构后，这个项目应该具备以下性质：

- 初学者仍能沿 PDD1-PDD14 理解一个 coding agent 如何逐步长出来。
- 每个 durable 能力都有清楚的物理存储身份。
- 每个 session-local 能力都不会伪装成跨重启能力。
- 每个 tool schema 字段都有真实实现和测试。
- 权限边界不依赖模型“听话”，而是由执行层强制。
- prompt cache 稳定前缀不被动态状态污染。
- 后续新增 streaming、web fetch、workspace write、durable run queue 时，有明确插入点。
