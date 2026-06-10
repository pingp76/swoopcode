# PDD23: Full-tools Live E2E 与当前复杂功能回归设计

## 审阅结论

PDD22 已经把 Eval Core、当前项目 in-process driver、deterministic suite、replay、live smoke、judge/report 以及第一轮 core-tools live regression 打通。

接下来如果要形成“当前单 Agent 的完整端到端集成测试能力”，不应该直接把 SubAgent、Task、Memory、Skill、Async Run、Schedule 等复杂 case 塞进现有 core-tools live suite。

本阶段应该分三轮继续推进：

```text
第 0 轮：修正当前 live regression 的开关、文档和 summary 小问题
第 1 轮：实现 full-tools live driver，保证复杂系统能在临时 agentHome 中安全运行
第 2 轮：实现当前单 Agent 的 full-system live regression cases
```

其中第 1 轮是关键地基。没有临时 `agentHome` 和完整工具组装能力，就不应该实现 Memory、Task、Schedule、Skill 等 live case，否则会污染用户真实运行数据，也会让测试结果依赖本机状态。

本 PDD 是 PDD22 的后续设计，不替代 PDD22。PDD22 仍是 Eval Core 与 case schema 的来源；PDD23 只负责把当前项目的复杂系统能力接入 live E2E。

## 当前状态

当前 eval 能力大致是：

1. `src/eval/core/` 已有 `EvalCase`、`CodingAgentDriver`、workspace、trace、assertions、runner、report。
2. `learn-claude-code-in-process` driver 已能组装当前项目 `createAgent()`。
3. `tools.kind = "core"` 已支持真实核心工具：`run_read`、`run_write`、`run_edit`、`run_edit_exact`、`run_bash`。
4. live smoke 默认 skip，显式启用后调用真实 LLM。
5. live regression 第一轮已有 core-tools cases。
6. 复杂工具系统仍未进入 live eval driver：TODO、Task、Memory、Skill、SubAgent、Async Run、Schedule、OutputStore。

已知需要先修的小问题：

1. `EVAL_LIVE=1` 和 `EVAL_LIVE_REGRESSION=1` 的开关语义需要收口。
2. README 中 live regression 命令说明需要与实际 npm script 一致。
3. `doc/summary.md` 的源码树需要列出新增 live regression 文件。

## 设计目标

1. 修正当前 live regression 的启用语义，避免普通 live smoke 意外跑昂贵 regression。
2. 为当前项目 in-process driver 增加 full-tools 模式。
3. full-tools 模式必须使用临时 `agentHome`，隔离 skills、memory、logs、task outputs、tasks、schedules。
4. full-tools 模式复用当前项目真实工具 provider，不写一套 eval-only 假实现。
5. 增加少量断言能力，让复杂 case 可以用结构化 hard assertions 判断结果。
6. 新增 full-system live regression suite，覆盖当前单 Agent 的复杂功能。
7. 保持普通 CI 稳定：默认不跑真实 LLM、不需要 API key、不写真实 agentHome。
8. 保持 Eval Core 中立：不要让 runner 直接 import 当前项目的 Task/Memory/Schedule 模块。

## 非目标

1. 不实现 MCP。
2. 不实现 Agent Team。
3. 不实现真实 GitHub Actions workflow。
4. 不要求 full-system live cases 在普通 PR 默认运行。
5. 不把真实 LLM 输出做完整 golden snapshot。
6. 不为了测试改写主 Agent system prompt 或工具定义。
7. 不在本阶段重构 `index.ts` 的组装逻辑。
8. 不读取用户真实 `~/.learn-claude-code-ts` 数据。

## 核心原则

### 1. 隔离先于覆盖率

复杂工具的最大风险不是 case 不够多，而是测试污染真实状态。

必须做到：

1. project workspace 使用 `createEvalWorkspace()` 创建。
2. agentHome 使用临时目录创建。
3. case 结束后清理 agentHome。
4. case 失败且 `keepOnFailure` 开启时，可以保留 workspace 和 agentHome 供排查。

### 2. Driver 层负责当前项目细节

Eval Core 只认识：

```text
EvalCase
CodingAgentDriver
AgentRuntimeEvent
EvalAssertion
```

当前项目 full-tools 的创建细节应该留在：

```text
src/eval/drivers/learn-claude-code/
```

不要让 `runner.ts`、`assertions.ts` 或 `case-schema.ts` 直接依赖 `tasks.ts`、`memory.ts`、`schedules.ts`。

### 3. Live case 做结构断言，Judge 做语义补充

Hard assertions 判断事实：

1. 某工具是否调用。
2. 文件是否存在。
3. 文件是否包含 sentinel。
4. 输出是否包含稳定 token。
5. 临时 store 是否出现目标对象。

Judge 判断质量：

1. TODO 是否真实反映执行步骤。
2. 子智能体结果是否被父 Agent 正确整合。
3. Agent 是否没有夸大成功。
4. 多步骤工作是否合理收束。

### 4. 分层启用

建议保留三个级别：

```text
npm test                         # 默认：unit + deterministic/replay，live suite skip
EVAL_LIVE=1 npm run test:eval:live
EVAL_LIVE_REGRESSION=1 npm run test:eval:live:regression
EVAL_LIVE_FULL=1 npm run test:eval:live:full
```

其中 `EVAL_LIVE=1` 只代表 smoke，不自动打开 regression/full。

## 第 0 轮：修正当前 Live Regression 基础问题

### 目标

把已经实现的 core-tools live regression 调整到可交付状态，为后续 full-tools suite 提供干净基线。

### 代码修改范围

预计修改：

```text
src/eval/core/runner.ts
src/eval/live/live-regression-suite.test.ts
src/eval/README.md
doc/summary.md
```

### 具体要求

#### 1. 收口开关语义

推荐语义：

```text
EVAL_LIVE=1                  -> 只启用 live smoke
EVAL_LIVE_REGRESSION=1       -> 启用 live regression
EVAL_LIVE_FULL=1             -> 启用 full-system live regression
```

如果用户想一次跑 smoke + regression，可以显式执行两个命令，或者后续新增组合脚本。

`runEvalCase()` 对 live mode 的通用校验可以保持宽松，但不应把所有 live suite 的开关耦合到一个全局环境变量上。更稳的方式是：

1. suite 自己用 `describe.skip` 控制是否运行。
2. runner 只在直接调用 live case 且没有任何 live opt-in 时拒绝。
3. 不要让 `EVAL_LIVE=1` 成为 regression suite 的隐式开关。

可接受实现：

```ts
const anyLiveEvalEnabled =
  process.env["EVAL_LIVE"] === "1" ||
  process.env["EVAL_LIVE_REGRESSION"] === "1" ||
  process.env["EVAL_LIVE_FULL"] === "1";
```

但 `live-regression-suite.test.ts` 的 `suite` 开关必须只看 `EVAL_LIVE_REGRESSION=1`。

#### 2. 修正 README

README 应明确：

```bash
# live smoke
EVAL_LIVE=1 npm run test:eval:live

# live regression
EVAL_LIVE_REGRESSION=1 npm run test:eval:live:regression

# smoke + regression
EVAL_LIVE=1 npm run test:eval:live
EVAL_LIVE_REGRESSION=1 npm run test:eval:live:regression
```

不要写“`EVAL_LIVE=1 npm run test:eval:live:regression` 同时跑 smoke + regression”，除非 npm script 真的同时包含两个 suite。

#### 3. 修正 Judge 数量说明

如果 6 个 case 中只有 5 个配置 judge rubric，README 应写：

```text
5 个 case 内置 judge rubric，会额外产生 5 次 judge 调用。
```

或者给 bash case 也补 judge rubric，再写 6 次。

#### 4. 修正 summary 源码树

`doc/summary.md` 的 `src/eval/live/` 应包含：

```text
├── _driver-factory.ts             # live suite 共享 driver/judge LLM 工厂
├── live-llm.ts                    # Live LLM wrapper
├── live-suite.test.ts             # Live smoke suite
└── live-regression-suite.test.ts  # Live regression suite（core tools）
```

### 验收命令

```bash
npm run typecheck
npx vitest run src/eval/live/live-suite.test.ts src/eval/live/live-regression-suite.test.ts
npm test
npx eslint src/eval/core/runner.ts src/eval/live/live-suite.test.ts src/eval/live/live-regression-suite.test.ts
```

不设置环境变量时，live smoke 和 regression 都应 skip。

## 第 1 轮：Full-tools Live Driver

### 目标

为当前项目 in-process driver 增加 full-tools 模式，使 live eval 可以在临时 workspace + 临时 agentHome 中安全使用完整工具系统。

### 推荐文件改动

新增：

```text
src/eval/drivers/learn-claude-code/full-tool-runtime.ts
src/eval/drivers/learn-claude-code/full-tool-runtime.test.ts
```

修改：

```text
src/eval/core/case-schema.ts
src/eval/drivers/learn-claude-code/in-process-driver.ts
src/eval/drivers/learn-claude-code/tool-trace.ts
src/eval/core/assertions.ts
src/eval/README.md
doc/summary.md
```

### Schema 设计

在 `EvalToolPlan` 中增加 full 模式：

```ts
export type EvalToolPlan =
  | { kind: "fake"; fakeTools?: EvalFakeTool[] }
  | { kind: "core"; core?: EvalCoreToolOptions }
  | { kind: "full"; full?: EvalFullToolOptions };

export interface EvalFullToolOptions {
  enabledTools?: EvalFullToolGroup[];
  agentHome?: "temp";
  seedSkills?: Record<string, string>;
  seedMemories?: Record<string, EvalSeedMemory>;
  permissionMode?: "auto" | "default" | "plan";
  startScheduleManager?: boolean;
}

export type EvalFullToolGroup =
  | "core"
  | "todo"
  | "task"
  | "memory"
  | "skill"
  | "subagent"
  | "async"
  | "schedule"
  | "output";
```

第一版只支持 `agentHome: "temp"`。不要支持任意 path，避免 coding agent 不小心把测试指向用户真实 agentHome。

### Full runtime 组装

`full-tool-runtime.ts` 应提供类似：

```ts
export interface FullEvalRuntime {
  tools: ToolRegistry;
  permissionManager: PermissionManager;
  systemPromptProvider: SystemPromptProvider;
  sessionEventBuffer: SessionEventBuffer;
  transcriptStore: TranscriptStore;
  sessionManager: SessionManager;
  compressor: ContextCompressor;
  cleanup(): Promise<void> | void;
}

export async function createFullEvalRuntime(options: {
  workspaceRoot: string;
  agentHome: string;
  llm: LLMClient;
  logger: Logger;
  emitEvent: (event: AgentRuntimeEvent) => void;
  enabledTools?: EvalFullToolGroup[];
  seedSkills?: Record<string, string>;
  seedMemories?: Record<string, EvalSeedMemory>;
  permissionMode?: PermissionMode;
}): Promise<FullEvalRuntime>;
```

组装顺序应尽量贴近 `index.ts`：

```text
ProjectContext(workspaceRoot, tempAgentHome)
logger
permissionManager
todoManager
skillManager
memoryManager
sessionEventBuffer
taskStore/taskManager
outputStore
executionPolicy / readonly command policy
asyncRunManager
scheduleStore/scheduleManager
systemPromptProvider
tool providers
tool registry
subagent provider
trace wrapper
```

注意事项：

1. `ProjectContext.projectRoot = workspaceRoot`。
2. `ProjectContext.agentHome = tempAgentHome`。
3. `skillsDir`、`memoryDir`、`tasksDir`、`schedulesDir`、`taskOutputsDir` 都来自 tempAgentHome。
4. `seedSkills` 写入 temp skills 目录后再 `skillManager.scan()`。
5. `seedMemories` 写入 temp memory 目录后再 `memoryManager.scan()`。
6. `scheduleManager` 第一版不要自动 tick，除非 case 明确需要；创建/读取/取消 schedule 不需要真实触发。
7. `asyncRunManager` 需要在 driver close 时 cleanup 或等待 running runs 终止。
8. `subagent` 使用同一个 LLM client，但必须拿过滤后的 readonly registry。

### in-process driver 接入

当前 `in-process-driver.ts` 已按 `tools.kind` 分 fake/core。

第 1 轮需要改成：

```text
if tools.kind === "full":
  create temp agentHome
  create full runtime
  use fullRuntime.tools
  use fullRuntime.permissionManager
  use fullRuntime.systemPromptProvider
  use fullRuntime.sessionEventBuffer
  use fullRuntime.transcriptStore
  use fullRuntime.sessionManager
  close() 时 fullRuntime.cleanup()
else:
  保持 fake/core 逻辑不变
```

不要为了 full mode 修改 `agent.ts`。

### 断言增强

复杂 case 需要少量新断言。建议第 1 轮先实现这些：

#### `fileNotExists`

```ts
{ kind: "fileNotExists", path: "blocked.txt" }
```

用于权限拒绝、越界路径、防误写。

#### `toolCalledOneOf`

```ts
{
  kind: "toolCalledOneOf",
  toolNames: ["run_memory_list", "run_memory_read"]
}
```

用于模型可能用不同查询工具达到同一目的的场景。

#### `toolResultContains`

```ts
{
  kind: "toolResultContains",
  toolName: "run_task_group_read",
  text: "Live regression plan"
}
```

用于确认工具结果本身包含目标内容，而不是只看最终回复。

#### `stepToolCalled` / `stepToolNotCalled`

```ts
{
  kind: "stepToolNotCalled",
  stepId: "observe",
  toolName: "run_write"
}
```

用于多 turn case，确认第一步只观察、不写入。

实现前提：`ToolRuntimeEvent.stepId` 必须能被正确填充。若当前 trace wrapper 无法知道 stepId，driver 可以在 `send()` 前设置 currentStepId，让 wrapper emit 事件时带上。

### Trace 增强

建议增加以下 runtime event：

```ts
export interface EvalRuntimePathEvent extends BaseRuntimeEvent {
  kind: "runtime_path";
  source: "driver";
  label: "workspaceRoot" | "agentHome";
  path: string;
}
```

该事件用于失败 trace 中定位临时目录。默认 trace 可写入 path，因为这是临时路径，不含 secret。

### 第 1 轮测试

新增确定性测试，不调用真实 LLM：

```text
src/eval/drivers/learn-claude-code/full-tool-runtime.test.ts
```

覆盖：

1. full runtime 创建临时 agentHome 下的 skills/memory/tasks/schedules/logs 目录。
2. `enabledTools: ["core", "todo"]` 只注册 core + todo。
3. `enabledTools` 全开时包含 run_task_group_create、run_memory_create、run_skill、run_subagent、run_async_start、run_schedule_create、run_output_read。
4. seed skill 可被 `run_skill` 读取。
5. seed memory 不写入真实 agentHome。
6. close/cleanup 后无 running async run。

### 第 1 轮验收命令

```bash
npm run typecheck
npx vitest run src/eval/drivers/learn-claude-code/full-tool-runtime.test.ts
npx vitest run src/eval/runner.test.ts
npm test
npx eslint src/eval/core/case-schema.ts src/eval/core/assertions.ts src/eval/drivers/learn-claude-code/full-tool-runtime.ts src/eval/drivers/learn-claude-code/in-process-driver.ts
```

## 第 2 轮：当前单 Agent Full-system Live Regression

### 目标

在第 1 轮 full-tools driver 基础上，实现当前单 Agent 的复杂功能 live regression cases。

新增文件：

```text
src/eval/live/live-full-suite.test.ts
```

新增脚本：

```json
{
  "test:eval:live:full": "vitest run src/eval/live/live-full-suite.test.ts"
}
```

启用条件：

```text
EVAL_LIVE_FULL=1
```

Judge 启用仍使用：

```text
EVAL_JUDGE=1
```

### Suite 结构

推荐分两组：

```text
Live Full Suite - Release
  稳定、成本低、发布前可跑

Live Full Suite - Nightly
  时间较长、模型策略差异大、适合夜间或人工触发
```

第一版可以只实现 Release 组，Nightly 先作为 skipped describe 或 TODO 注释。

### Release cases

#### `live-full-todo-guided-file-change`

目标：Agent 使用 TODO 管理短任务，并完成文件修改。

配置：

```ts
tools: {
  kind: "full",
  full: {
    agentHome: "temp",
    enabledTools: ["core", "todo"],
  },
}
```

Fixture：

```text
docs/todo-target.md
status: draft
```

Query：

```text
Use a TODO list to track this work:
1. Read docs/todo-target.md.
2. Update it so status becomes complete and add marker TODO_LIVE_DONE.
Complete the TODO items as you finish them.
```

Hard assertions：

1. `allStepsCompleted`
2. `toolCalled(run_todo_create)`
3. `toolCalled(run_todo_update, minCount: 2)`
4. `fileContains("docs/todo-target.md", "status: complete")`
5. `fileContains("docs/todo-target.md", "TODO_LIVE_DONE")`
6. `allToolsSucceeded`

Judge：

1. TODO 反映真实执行步骤。
2. 不应只创建 TODO 而不完成文件修改。

#### `live-full-memory-confirmed-create-and-read`

目标：明确用户要求记忆时，Agent 创建 memory，并在后续 turn 读回。

配置：

```ts
enabledTools: ["memory"]
```

Steps：

```text
1. Please remember this for the eval project: release keyword is LIVE-MEM-42.
2. List or read your memories and tell me the release keyword.
```

Hard assertions：

1. `allStepsCompleted`
2. `toolCalled(run_memory_create)`
3. `toolCalledOneOf(["run_memory_list", "run_memory_read"])`
4. step 2: `finalOutputContains("LIVE-MEM-42")`
5. `allToolsSucceeded`

补充断言：

1. `fileContains` 可以检查 temp agentHome 的 memory 文件，但不要把绝对路径写死在 case 中。
2. 更好的方式是 `toolResultContains(run_memory_read, "LIVE-MEM-42")`。

#### `live-full-skill-guided-output`

目标：Agent 发现并加载临时 skill，再按 skill 指示完成输出。

配置：

```ts
enabledTools: ["core", "skill"],
seedSkills: {
  "eval-format/SKILL.md": "..."
}
```

Seed skill：

```text
# eval-format

When asked to create an eval status file, first write the marker SKILL_USED_22,
then include the user's requested status.
```

Query：

```text
Use the eval-format skill to create skill-output.md with status: passed.
```

Hard assertions：

1. `allStepsCompleted`
2. `toolCalled(run_skill)`
3. `fileContains("skill-output.md", "SKILL_USED_22")`
4. `fileContains("skill-output.md", "status: passed")`
5. `allToolsSucceeded`

#### `live-full-subagent-readonly-analysis`

目标：父 Agent 委托子智能体做只读分析，并整合结果。

配置：

```ts
enabledTools: ["core", "subagent", "skill"]
```

Fixture：

```ts
// src/a.ts
export const liveToken = "SUBAGENT_LIVE_01";
```

Query：

```text
Ask a subagent to inspect src/a.ts and report the liveToken value.
Do not modify any files.
```

Hard assertions：

1. `allStepsCompleted`
2. `toolCalled(run_subagent)`
3. `finalOutputContains("SUBAGENT_LIVE_01")`
4. `toolNotCalled(run_write)`
5. `toolNotCalled(run_edit)`
6. `toolNotCalled(run_edit_exact)`

Judge：

1. 父 Agent 应基于子智能体结果回答。
2. 不应修改文件。

### Nightly cases

#### `live-full-task-group-durable-plan`

目标：验证持久化 Task Group 创建、更新、读取。

配置：

```ts
enabledTools: ["task"]
```

Hard assertions：

1. `toolCalled(run_task_group_create)`
2. `toolCalled(run_task_update)`
3. `toolCalled(run_task_group_read)`
4. `finalOutputContains("Live regression plan")`
5. `allToolsSucceeded`

风险：

1. 模型可能需要从 create 输出中提取 group_id 再 update。
2. 如果模型不稳定，可先放 nightly。

#### `live-full-async-output-handle`

目标：验证 Async Run 启动、检查、读取输出。

配置：

```ts
enabledTools: ["async", "output"]
```

Query：

```text
Start an async run for:
node -e "setTimeout(() => console.log('ASYNC_LIVE_OK'), 100)"
Then check it and read the output until you can report ASYNC_LIVE_OK.
```

Hard assertions：

1. `toolCalled(run_async_start)`
2. `toolCalledOneOf(["run_async_check", "run_async_output_read", "run_output_read"])`
3. `finalOutputContains("ASYNC_LIVE_OK")`
4. `allToolsSucceeded`

要求：

1. timeout 设为 60 秒。
2. driver close 时收敛 running async runs。
3. 命令不访问网络，不写文件。

#### `live-full-schedule-create-read-cancel`

目标：验证 Schedule 创建、读取、取消，不触发真实任务。

配置：

```ts
enabledTools: ["schedule"]
startScheduleManager: false
```

Query：

```text
Create a schedule far in the future named "live regression schedule"
that would run: echo SCHEDULE_LIVE_OK.
Then read or list the schedule and cancel it.
```

Hard assertions：

1. `toolCalled(run_schedule_create)`
2. `toolCalledOneOf(["run_schedule_read", "run_schedule_list"])`
3. `toolCalled(run_schedule_cancel)`
4. `finalOutputContains("live regression schedule")`
5. `allToolsSucceeded`

要求：

1. schedule 时间必须足够远。
2. 不启动 tick loop，或者注入 fake clock。
3. 使用 temp schedulesDir。

### Full suite report

建议 full suite 结束后输出 release 视角摘要：

```text
Live full regression:
- release cases passed: 4 / 4
- nightly cases passed: 0 / 0 skipped
- judge enabled: false
- provider/model: ...
```

第一版可以只靠 Vitest 输出，report aggregation 作为后续增强。

### 第 2 轮验收命令

不调用真实 LLM：

```bash
npm run typecheck
npx vitest run src/eval/live/live-full-suite.test.ts
npm test
npx eslint src/eval/live/live-full-suite.test.ts
```

调用真实 LLM：

```bash
EVAL_LIVE_FULL=1 npm run test:eval:live:full
EVAL_LIVE_FULL=1 EVAL_JUDGE=1 npm run test:eval:live:full
```

在没有 API key 或网络时，真实 LLM 命令可以失败，但必须在报告中说明是环境问题，而不是代码问题。

## 完成标准

PDD23 完成后，项目应具备：

1. core-tools live regression：覆盖基本读写改查 bash 权限多轮。
2. full-tools live driver：能安全组装当前项目完整工具系统。
3. full-system live regression：覆盖当前单 Agent 的 TODO、Memory、Skill、SubAgent，并预留 Task/Async/Schedule nightly。
4. 所有 live suite 默认 skip。
5. 所有 live suite 都只使用临时 workspace 和临时 agentHome。
6. `doc/summary.md` 与 `src/eval/README.md` 反映当前实现。
