# PDD22: Agent 集成测试与 Eval Runner 框架设计

## 审阅结论

本阶段应该为项目新增一套 **中立的 Coding Agent Eval Core + 当前项目 Driver** 的集成测试框架。

当前项目已经有大量单元测试，也已经具备几块天然适合自动化验收的基础：

- `createAgent()` 通过依赖注入接收 LLM、工具注册表、权限管理器、Transcript、Terminal 等组件。
- `TranscriptStore` 已经能记录 append-only 原始事件。
- `ToolRegistry` 已经把工具定义和执行函数统一在一处。
- `Terminal` 已经抽象了 REPL 输入和权限确认。
- `LLMClient` 已经是窄接口，适合替换为 scripted LLM 或 replay LLM。

但 Eval 框架不应该强绑定这些内部类型。它要尽量评估“一个 coding agent 在 workspace 中完成任务的行为”，而不是评估“当前 `agent.ts` 的实现细节”。当前项目的 `createAgent()`、`ToolRegistry`、`TranscriptStore` 等能力应该放在 adapter/driver 层，作为第一种被测 agent 接入方式。

因此 PDD22 不应该先做真实 LLM judge，也不应该先把 runner 写死到当前 Agent，而应该先做一个稳定的中立 harness：

```text
EvalCase
  -> temporary workspace
  -> CodingAgentDriver
       -> current in-process agent driver
       -> future CLI driver
       -> future external agent driver
  -> standardized runtime events
  -> portable assertions
  -> optional instrumented assertions
  -> optional judge/report
```

核心判断：

1. **完整框架建议压缩为三批实现**。两批能做，但会把基础框架、真实工具、replay/live、judge/report 挤在一起，后续 agent 很容易边界失控。
2. Eval Core 必须先抽象 `CodingAgentDriver`，runner 只依赖 driver 接口，不直接依赖 `createAgent()`。
3. 当前项目提供 `learn-claude-code in-process driver`，复用 `createAgent()`、scripted LLM、scripted terminal、ToolRegistry tracing 和 Transcript。
4. 第一版 case 使用 TypeScript 对象，不引入 YAML/JSON schema 解析依赖，避免早期复杂度扩散。
5. 普通 CI 只跑 deterministic eval，不依赖 API key，不访问真实模型。
6. Live model smoke 与 LLM judge 必须显式 opt-in，适合 nightly 或人工触发，不应默认阻塞每个 PR。
7. Judge 不是唯一裁判；硬规则断言先执行，judge 只处理开放式语义质量。
8. Trace 必须结构化、可机器读取、可被人和 AI 复盘，而不是只写自然语言日志。

## 背景

现在的集成验证主要是人工流程：

1. 让 AI 生成一些 case query。
2. 人手动在 REPL 中执行到某个阶段。
3. 人或 AI 再分析执行日志和 LLM 通信日志。
4. 判断 Agent 行为是否正确。

这个流程可以发现问题，但难以进入 CI：

- 手动 query 不稳定。
- REPL 交互和权限确认需要人工输入。
- 多轮工具调用的中间行为不容易机器判断。
- 不同 LLM 的输出文本和策略可能不同。
- 只看最终回复会漏掉越权、错误工具调用、错误恢复、上下文污染等问题。
- 让 LLM 评价 Agent 行为有价值，但本身也有不确定性。

PDD22 的目标是把这条人工流程拆成可自动执行的层级：

```text
P0 deterministic eval
  neutral runner + current-agent driver + scripted model + hard assertions

P1 replay eval
  recorded model response fixtures + same driver boundary + hard assertions

P2 live smoke
  live agent/model + small stable cases + cost/time budget + soft gating

P3 judge eval
  hard assertions first + LLM judge rubric + report + human review marker
```

## 设计目标

1. 新增 `src/eval/`，提供可复用的 eval runner，而不是把 case 写死在某个测试文件里。
2. Eval Core 只依赖中立接口：case、workspace、driver、runtime events、assertions、trace、report。
3. 支持一个 case 内多个 user query，复用同一个 driver 实例，覆盖多 turn 行为。
4. 支持 scripted driver 输入，以确定性响应序列驱动当前项目 agent loop。
5. 支持 scripted terminal，以自动回答权限确认和未来 REPL 输入；但 terminal 只属于当前项目 driver，不进入 core。
6. 支持标准化 runtime events，记录 agent output、tool call、tool result、LLM call、permission prompt、log、error 等事件。
7. 支持 per-case structured trace，便于 CI artifact、失败分析和未来 judge 输入。
8. 支持临时 workspace 和真实核心工具，验证当前项目 `run_bash`、`run_read`、`run_write`、`run_edit`、`run_edit_exact` 的集成路径。
9. 支持 replay fixture，把真实 LLM 通信录制成可重复的 response 序列。
10. 支持 opt-in live model smoke，验证真实模型与当前 runtime 的兼容性。
11. 支持可选 LLM judge，对开放式行为给出结构化评分与证据。
12. 保持主 Agent 代码干净：`agent.ts` 不出现 eval 专用分支。
13. 保持普通 CI 稳定：无 API key 时 eval 仍可运行并通过 deterministic suite。

## 非目标

1. 第一批不接真实 LLM。
2. 第一批不跑真实 REPL/PTY。
3. 前两批不实现 LLM-as-judge。
4. 前两批不实现 live model smoke。
5. 不引入 YAML、JSON schema validator、snapshot test 框架或外部 eval 平台。
6. 不为了 eval 修改 stable system prompt 或工具定义。
7. 不大改 `index.ts` 组装根。
8. 不把 eval trace 默认写入仓库目录，避免产生脏文件。
9. 不用最终回复的完整文本做 golden snapshot；默认只做结构化断言和关键片段断言。
10. 不把 judge 结果作为普通 CI 的唯一通过条件。
11. 不把当前项目的 `ToolRegistry`、`TranscriptStore`、`Terminal` 设计成 Eval Core 的必需依赖。
12. 不在本 PDD 实现 GitHub Actions 配置；可以在后续按 `npm run test:eval` 接入。

## 核心原则

### 1. Deterministic first

先让测试对同一输入产生同一输出，再谈真实模型。

Agent 的集成风险分两类：

- Runtime 是否正确：消息顺序、工具调用、权限、Transcript、文件边界、错误恢复。
- 模型是否表现好：是否理解任务、是否策略合理、是否回复质量高。

第一类必须用确定性测试守住。第二类才需要 live eval 和 judge。

### 2. Driver boundary first

Eval Core 的核心接口是 `CodingAgentDriver`。

Runner 不知道被测对象是：

- 当前项目的 in-process Agent。
- 一个 CLI 进程。
- 另一个 coding agent。
- 未来改写后的 runtime。

Runner 只知道：

```text
start case
send user input
receive final output
read standardized runtime events
close driver
```

当前项目内部的 LLM、Terminal、ToolRegistry、Transcript 都属于 driver 实现细节。

### 3. Trace 是事实来源

测试失败时，不能只看到一句 `expected true to be false`。

每个 eval case 都应该产生结构化事实：

- 收到哪些 user query。
- Driver 收到哪些 user query。
- Driver 返回哪些 final output。
- 产生了哪些标准化 runtime events。
- 如果 driver 支持内部观测，LLM 调用、工具调用、权限提示、Transcript 事件分别是什么。
- 每个 assertion 为什么通过或失败。

未来 judge 也必须基于这些事实，而不是只看最终回复。

### 4. Case 描述行为，不描述实现细节

Eval case 应描述用户任务和期望行为，例如：

```ts
{
  id: "write-readme",
  steps: [{ query: "Create a README with project name." }],
  assertions: [
    { kind: "toolCalled", toolName: "run_write" },
    { kind: "fileContains", path: "README.md", text: "Project" },
  ],
}
```

它不应该要求 Agent 内部某个私有函数被调用。`toolCalled` 这类断言可以存在，但必须被标记为 instrumented assertion：只有支持工具事件的 driver 才能执行。

### 5. Portable assertions before instrumented assertions

断言分两类：

```text
Portable assertions
  finalOutputContains / fileExists / fileContains / workspaceDiffContains /
  noWritesOutsideWorkspace / exitCodeIs / allStepsCompleted

Instrumented assertions
  toolCalled / toolArgsContain / transcriptEventTypes /
  llmCallCount / permissionPromptShown
```

Portable assertions 应尽量成为 case 的主干。Instrumented assertions 用来调试当前 agent runtime，但不要让整个 eval 框架依赖它们。

### 6. Hard assertions before judge

Judge 只看硬规则之后的剩余语义问题。

顺序必须是：

```text
run case
  -> collect trace
  -> run deterministic assertions
  -> if hard assertions fail, mark failed
  -> if judge enabled, run judge on trace
  -> combine report
```

不要让 judge 去判断文件是否存在、工具是否越权、tool result 是否配对。这些都应该由代码断言。

### 7. Live eval 是观测，不是默认门禁

真实模型可能因为服务状态、模型更新、采样、速率限制、成本控制而产生波动。Live eval 应该：

- 显式开启。
- 有 timeout。
- 有 cost/token budget。
- case 数量很少。
- 失败时产出报告，但不默认阻塞普通 CI。

## 总体架构

```text
EvalCase[]
  |
  v
EvalSuiteRunner
  |
  +-- createEvalWorkspace()
  +-- createTraceRecorder()
  +-- createCodingAgentDriver(case.driver)
  |
  v
for each step:
  driver.send({ query })
    -> final output
    -> standardized runtime events
  |
  v
run assertions
  |
  v
EvalRunResult
  |
  +-- in-memory result for Vitest
  +-- optional JSON trace writer
  +-- optional judge report
```

`agent.ts` 不需要知道自己处于 eval 中。当前项目 driver 通过依赖注入完成替换：

- LLM 换成 scripted/replay/live wrapper。
- Terminal 换成 scripted terminal。
- ToolRegistry 包一层 tracing registry。
- TranscriptStore 使用现有 `createTranscriptStore()`，但只作为 driver 内部事件来源。
- Workspace 使用临时目录。

未来如果实现 CLI driver，Eval Core 不需要改变：

```text
CliCodingAgentDriver
  -> spawn command
  -> feed stdin
  -> collect stdout/stderr
  -> inspect workspace
  -> emit standardized runtime events
```

## 建议文件布局

三批完成后的建议结构：

```text
src/eval/
├── core/
│   ├── case-schema.ts      # EvalCase、EvalStep、EvalAssertion、EvalRunResult 类型
│   ├── driver.ts           # CodingAgentDriver 中立接口
│   ├── workspace.ts        # 临时 workspace 与路径边界
│   ├── trace.ts            # TraceRecorder、RuntimeEvent
│   ├── assertions.ts       # portable + instrumented assertion 执行器
│   ├── runner.ts           # runEvalCase/runEvalSuite 核心 runner
│   ├── trace-writer.ts     # JSON trace 输出
│   └── report.ts           # suite report 聚合
├── drivers/
│   ├── learn-claude-code/
│   │   ├── in-process-driver.ts # 当前项目 createAgent() driver
│   │   ├── scripted-llm.ts      # ScriptedLLMClient
│   │   ├── scripted-terminal.ts # ScriptedTerminal
│   │   ├── tool-trace.ts        # ToolRegistry tracing wrapper
│   │   └── core-tool-runtime.ts # 当前项目真实核心工具 registry
│   └── cli/
│       └── cli-driver.ts        # CLI/black-box driver，第二批实现
├── replay/
│   └── replay-llm.ts            # recorded response replay
├── live/
│   ├── live-llm.ts              # opt-in live smoke wrapper
│   └── live-suite.test.ts       # 默认 skip / env opt-in
├── judge/
│   ├── judge.ts                 # judge rubric and parser
│   └── judge-suite.test.ts      # scripted judge deterministic tests
├── cases/
│   ├── deterministic.test.ts    # 当前项目 deterministic eval suite
│   └── fixtures/
├── runner.test.ts               # core + fake driver tests
└── README.md                    # case 写法、driver、trace、live/judge 说明
```

## 类型设计

### `EvalCase`

```ts
export interface EvalCase {
  id: string;
  title: string;
  description?: string;
  tags?: string[];
  mode?: EvalCaseMode;
  driver: EvalDriverPlan;
  steps: EvalStep[];
  workspace?: EvalWorkspacePlan;
  assertions: EvalAssertion[];
  judge?: EvalJudgePlan;
  trace?: EvalTracePlan;
}

export type EvalCaseMode =
  | "scripted"
  | "replay"
  | "live";
```

设计说明：

- `scripted` 是默认模式，用预设 response 序列跑确定性 eval。
- `replay` 使用录制过的 LLM response fixture。
- `live` 调真实模型，必须显式 opt-in。
- `judge` 是可选附加评估，不改变 runner 基本流程。
- `driver` 是被测 Agent 的唯一入口。Eval Core 不直接知道 LLM、Terminal、ToolRegistry 或具体 Agent 类。

### `EvalDriverPlan`

```ts
export type EvalDriverPlan =
  | LearnClaudeCodeInProcessDriverPlan
  | CliDriverPlan
  | CustomDriverPlan;

export interface LearnClaudeCodeInProcessDriverPlan {
  kind: "learn-claude-code-in-process";
  llm: EvalLLMPlan;
  terminal?: EvalTerminalPlan;
  tools?: EvalToolPlan;
  maxRounds?: number;
}

export interface CliDriverPlan {
  kind: "cli";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  readyPattern?: string;
}

export interface CustomDriverPlan {
  kind: string;
  options?: Record<string, unknown>;
}
```

设计说明：

- `learn-claude-code-in-process` 是当前项目的第一种 driver，实现时可以复用 `createAgent()`。
- `cli` 是黑盒 driver，为未来架构大改或测试其他 coding agent 留出口。
- Eval Core 可以只识别 `kind` 并把具体 plan 交给 driver factory；不要在 core 中 import 当前项目内部模块。

### `CodingAgentDriver`

```ts
export interface CodingAgentDriver {
  startCase(context: AgentCaseContext): Promise<void>;
  send(input: AgentInput): Promise<AgentTurnResult>;
  readEvents?(): Promise<AgentRuntimeEvent[]>;
  close(): Promise<void>;
}

export interface AgentCaseContext {
  caseId: string;
  workspaceRoot: string;
  metadata?: Record<string, unknown>;
}

export interface AgentInput {
  stepId: string;
  query: string;
}

export interface AgentTurnResult {
  stepId: string;
  finalOutput: string;
  exitCode?: number;
  events?: AgentRuntimeEvent[];
}
```

设计说明：

- `send()` 是唯一必须由 runner 调用的交互入口。
- `events` 是标准化 runtime events。支持内部观测的 driver 可以返回丰富事件；黑盒 driver 可以只返回 stdout/stderr/log。
- 同一个 case 内多个 step 复用同一个 driver 实例；不同 case 必须创建新 driver。

### `EvalStep`

```ts
export interface EvalStep {
  id?: string;
  query: string;
  assertions?: EvalAssertion[];
}
```

一个 case 可以有多个 step：

```ts
steps: [
  { query: "Create notes.md with one TODO." },
  { query: "Now add a second TODO." },
]
```

这些 step 复用同一个 driver 实例，从而覆盖多 user turn 的 history、transcript、permission、context 或 CLI session 行为。

### `EvalLLMPlan`

```ts
export interface EvalLLMPlan {
  kind: "scripted" | "replay" | "live";
  scriptedResponses?: ScriptedLLMResponse[];
  replayFile?: string;
  live?: LiveLLMOptions;
}

export interface ScriptedLLMResponse {
  id?: string;
  content?: string | null;
  toolCalls?: ScriptedToolCall[];
  finishReason?: string;
  assistantMessage?: ChatCompletionMessageParam;
}

export interface ScriptedToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  rawArguments?: string;
}
```

`rawArguments` 用于测试非法 JSON 或 provider 兼容边界。普通 case 应使用 `args`，由 helper 转成 JSON 字符串。

### `EvalTerminalPlan`

```ts
export interface EvalTerminalPlan {
  questions?: string[];
  permissionAnswers?: boolean[];
  defaultPermissionAnswer?: boolean;
}
```

第一阶段主要用于当前项目 driver 的 `askUser()` 权限确认。未来如果要测试 REPL，可以让 `question()` 消耗 `questions`。Eval Core 不直接依赖这个类型。

### `EvalToolPlan`

```ts
export interface EvalToolPlan {
  kind: "fake" | "core";
  fakeTools?: EvalFakeTool[];
  core?: EvalCoreToolOptions;
}

export interface EvalFakeTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  result: ToolResult | ((args: Record<string, unknown>) => Promise<ToolResult>);
}

export interface EvalCoreToolOptions {
  includeBash?: boolean;
  includeRead?: boolean;
  includeWrite?: boolean;
  includeEdit?: boolean;
  includeEditExact?: boolean;
  permissionMode?: "auto" | "default" | "plan";
}
```

第一阶段只需要 `fake`。第二阶段实现 `core`，接当前项目真实核心工具。Eval Core 不直接依赖这个类型。

### `EvalWorkspacePlan`

```ts
export interface EvalWorkspacePlan {
  initialFiles?: Record<string, string>;
  keepOnFailure?: boolean;
}
```

workspace 默认在 OS tmp 目录创建，每个 case 独立目录。所有真实文件工具都以该目录为 `projectRoot`。

### `EvalAssertion`

```ts
export type EvalAssertion =
  | FinalOutputContainsAssertion
  | FinalOutputMatchesAssertion
  | ExitCodeIsAssertion
  | AllStepsCompletedAssertion
  | FileExistsAssertion
  | FileContainsAssertion
  | WorkspaceDiffContainsAssertion
  | NoWritesOutsideWorkspaceAssertion
  | FinalResponseMatchesAssertion
  | ToolCalledAssertion
  | ToolNotCalledAssertion
  | ToolCallCountAssertion
  | ToolArgsContainAssertion
  | NoToolErrorsAssertion
  | TranscriptEventTypesAssertion
  | AllToolsSucceededAssertion
  | CustomAssertion;
```

Portable assertions 优先实现：

```ts
export interface FinalOutputContainsAssertion {
  kind: "finalOutputContains";
  text: string;
  stepId?: string;
}

export interface FinalOutputMatchesAssertion {
  kind: "finalOutputMatches";
  pattern: string;
  stepId?: string;
}

export interface ExitCodeIsAssertion {
  kind: "exitCodeIs";
  code: number;
  stepId?: string;
}

export interface AllStepsCompletedAssertion {
  kind: "allStepsCompleted";
}

export interface FileExistsAssertion {
  kind: "fileExists";
  path: string;
}

export interface FileContainsAssertion {
  kind: "fileContains";
  path: string;
  text: string;
}

export interface WorkspaceDiffContainsAssertion {
  kind: "workspaceDiffContains";
  path: string;
  text: string;
}

export interface NoWritesOutsideWorkspaceAssertion {
  kind: "noWritesOutsideWorkspace";
}
```

Instrumented assertions 也可以实现，但必须在 assertion metadata 中标记它们依赖 driver event：

```ts
export interface ToolCalledAssertion {
  kind: "toolCalled";
  toolName: string;
  minCount?: number;
}

export interface ToolCallCountAssertion {
  kind: "toolCallCount";
  toolName: string;
  count: number;
}

export interface TranscriptEventTypesAssertion {
  kind: "transcriptEventTypes";
  expected: string[];
}

export interface NoToolErrorsAssertion {
  kind: "noToolErrors";
}
```

第二阶段补齐：

```ts
export interface ToolNotCalledAssertion {
  kind: "toolNotCalled";
  toolName: string;
}

export interface ToolArgsContainAssertion {
  kind: "toolArgsContain";
  toolName: string;
  text: string;
}

export interface FinalResponseMatchesAssertion {
  kind: "finalResponseMatches"; // 兼容别名，推荐新 case 使用 finalOutputMatches
  pattern: string;
}

export interface AllToolsSucceededAssertion {
  kind: "allToolsSucceeded";
}
```

后续可以继续扩展，但不要修改已存在 assertion 的语义。

### `AgentRuntimeEvent`

```ts
export type AgentRuntimeEvent =
  | AgentOutputEvent
  | ToolRuntimeEvent
  | LLMRuntimeEvent
  | PermissionRuntimeEvent
  | LogRuntimeEvent
  | RawRuntimeEvent
  | DriverErrorEvent;

export interface BaseRuntimeEvent {
  id: string;
  timestamp: string;
  stepId?: string;
  kind: string;
  source: "core" | "driver" | "agent" | "tool" | "llm" | "terminal";
}

export interface AgentOutputEvent extends BaseRuntimeEvent {
  kind: "agent_output";
  text: string;
}

export interface ToolRuntimeEvent extends BaseRuntimeEvent {
  kind: "tool_call" | "tool_result";
  toolName: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: boolean;
}

export interface LLMRuntimeEvent extends BaseRuntimeEvent {
  kind: "llm_call" | "llm_response";
  mode?: "scripted" | "replay" | "live";
  messageCount?: number;
  toolDefinitionCount?: number;
  contentPreview?: string;
}

export interface PermissionRuntimeEvent extends BaseRuntimeEvent {
  kind: "permission_prompt" | "permission_response";
  message?: string;
  allowed?: boolean;
}

export interface LogRuntimeEvent extends BaseRuntimeEvent {
  kind: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

export interface RawRuntimeEvent extends BaseRuntimeEvent {
  kind: "raw";
  label: string;
  payload: unknown;
}

export interface DriverErrorEvent extends BaseRuntimeEvent {
  kind: "driver_error";
  message: string;
  stack?: string;
}
```

设计说明：

- Portable assertions 只依赖 step result、workspace 和标准 runtime events。
- 当前项目 driver 可以把 `TranscriptEvent`、tool call、LLM call 映射为 `AgentRuntimeEvent`，也可以额外保留 raw event。
- 黑盒 CLI driver 即使没有 tool/LLM 内部事件，也可以通过 stdout/stderr/log 生成 `agent_output`、`log`、`driver_error`。

### `EvalTrace`

```ts
export interface EvalTrace {
  caseId: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  mode: EvalCaseMode;
  workspaceRoot?: string;
  steps: EvalStepTrace[];
  runtimeEvents: AgentRuntimeEvent[];
  rawDriverEvents?: unknown[];
  assertions: EvalAssertionResult[];
  judge?: EvalJudgeResult;
  error?: EvalRunError;
}

export interface EvalStepTrace {
  stepId: string;
  query: string;
  startedAt: string;
  endedAt?: string;
  finalOutput?: string;
  exitCode?: number;
  error?: EvalRunError;
}

export interface EvalAssertionResult {
  kind: string;
  passed: boolean;
  message: string;
  evidence?: Record<string, unknown>;
}
```

Trace 不追求和 `llm.log` 一样完整。它是测试证据，不是完整原始通信日志。

## Runner 生命周期

`runEvalCase()` 的推荐流程：

```text
1. validateEvalCase(case)
2. createTraceRecorder(case)
3. create workspace
4. write initialFiles
5. create driver from case.driver
6. driver.startCase({ caseId, workspaceRoot })
7. for each step:
      append step trace
      await driver.send({ stepId, query })
      record final output and runtime events
8. collect driver.readEvents()
9. run step assertions and case assertions
10. optionally run judge
11. optionally write trace
12. driver.close()
13. cleanup workspace unless keepOnFailure
14. return EvalRunResult
```

`runEvalCase()` 不应该直接使用 Vitest 的 `expect()`。它返回结构化结果，由测试文件决定如何断言：

```ts
const result = await runEvalCase(myCase);
expect(result.passed).toBe(true);
```

这样 runner 可以被 CLI、nightly 脚本或未来 dashboard 复用。

## 当前项目 Driver 支撑设计

以下能力属于 `learn-claude-code-in-process` driver。Eval Core 只消费 driver 返回的 `AgentTurnResult` 和 `AgentRuntimeEvent`，不直接依赖这些实现。

### Scripted LLM

`createScriptedLLMClient()` 实现 `LLMClient`：

```ts
export function createScriptedLLMClient(options: {
  caseId: string;
  responses: ScriptedLLMResponse[];
  emitEvent: (event: AgentRuntimeEvent) => void;
}): LLMClient;
```

行为要求：

1. 每次 `chat()` 消耗一个 response。
2. response 用完时抛错：`Eval case <id> has no scripted LLM response for call <n>`。
3. response 中的 `args` 自动序列化为 `function.arguments`。
4. 如果传入 `assistantMessage`，优先使用它，以便测试 reasoning replay 或 provider 特殊字段。
5. 每次 `chat()` 都写标准化 `llm_call` / `llm_response` runtime event。
6. 不模拟真实网络耗时，除非后续显式加入 `delayMs`。

### Scripted Terminal

`createScriptedTerminal()` 实现 `Terminal`：

```ts
export function createScriptedTerminal(plan?: EvalTerminalPlan): Terminal;
```

行为要求：

1. `question()` 从 `questions` 队列取值。
2. `askUser()` 从 `permissionAnswers` 队列取值。
3. 如果 permission 队列为空，使用 `defaultPermissionAnswer`，默认 `true`。
4. 如果 question 队列为空，抛出清晰错误，避免测试静默通过。
5. `close()` 只标记 closed，不操作真实 stdin。

### Tool tracing

不要修改真实工具实现来记录 trace。用 wrapper 包住 registry：

```ts
export function wrapToolRegistryForTrace(
  registry: ToolRegistry,
  emitEvent: (event: AgentRuntimeEvent) => void,
): ToolRegistry;
```

行为要求：

1. `getToolDefinitions()` 原样返回底层 registry 的定义。
2. `getExecutor(name)` 返回 wrapped executor。
3. wrapped executor 记录开始时间、参数、结果、错误和耗时。
4. 如果底层 executor throw，要记录 error 后重新 throw，让 Agent 保持原行为。
5. ToolResult 中的 `error: true` 应记录为工具失败，但不等同于 JS throw。

## Workspace fixture 设计

第一阶段在 Eval Core 中实现 `workspace.ts`：

```ts
export interface EvalWorkspace {
  root: string;
  readFile(path: string): Promise<string>;
  exists(path: string): Promise<boolean>;
  cleanup(): Promise<void>;
}

export async function createEvalWorkspace(plan?: EvalWorkspacePlan): Promise<EvalWorkspace>;
```

行为要求：

1. 使用 `mkdtemp` 在 OS tmp 目录创建 case 独立目录。
2. `initialFiles` 中的路径必须是相对路径，拒绝绝对路径和 `..` 逃逸。
3. 写入 initial files 时自动创建父目录。
4. `readFile` 和 `exists` 也必须做路径边界检查。
5. 默认 case 结束后 cleanup。
6. 如果 case 失败且 `keepOnFailure` 为 true，则保留目录，并在 trace 中写入 `workspaceRoot`。

## Core tool runtime 设计

第二阶段在当前项目 driver 中实现 `core-tool-runtime.ts`，用于创建真实核心工具 registry。

建议：

```ts
export function createCoreEvalToolRegistry(options: {
  projectRoot: string;
  includeBash?: boolean;
  includeRead?: boolean;
  includeWrite?: boolean;
  includeEdit?: boolean;
  includeEditExact?: boolean;
}): ToolRegistry;
```

实现可以复用现有 `createToolRegistry()`，但要注意：

- 不接 todo、subagent、skill、memory、task、async、schedule、output provider。
- `projectRoot` 必须传入临时 workspace。
- 默认打开核心工具，除非 case 显式关闭。
- 真实 bash 仍受 `command-safety.ts` 硬黑名单约束。
- eval case 中的 bash 命令应该保持只读或低风险，例如 `pwd`、`ls`、`cat package.json`。

## Trace writer 设计

第一阶段在 Eval Core 中实现 `trace-writer.ts`：

```ts
export interface EvalTraceWriterOptions {
  outputDir?: string;
  enabled?: boolean;
}

export async function writeEvalTrace(
  trace: EvalTrace,
  options: EvalTraceWriterOptions,
): Promise<string | null>;
```

行为要求：

1. 默认不写入仓库目录。
2. 如果 `EVAL_TRACE_DIR` 存在，则写入该目录。
3. 文件名使用安全 case id，例如 `<case-id>.trace.json`。
4. 写入 JSON 使用两空格缩进。
5. 失败 trace 也要写。
6. 返回写入路径，供测试失败消息打印。

## Replay 设计

第三批实现 replay 能力，仍然通过 driver 边界接入。

### Replay fixture

建议格式：

```json
{
  "version": 1,
  "caseId": "edit-readme",
  "provider": "openai_compatible",
  "model": "example-model",
  "recordedAt": "2026-06-03T00:00:00.000Z",
  "responses": [
    {
      "content": null,
      "toolCalls": [
        {
          "id": "call_1",
          "name": "run_read",
          "args": { "path": "README.md" }
        }
      ],
      "finishReason": "tool_calls"
    },
    {
      "content": "Done.",
      "toolCalls": [],
      "finishReason": "stop"
    }
  ]
}
```

第一版 replay 只读取 fixture，不负责自动录制。自动录制可以作为后续增强。

### Replay 行为

`createReplayLLMClient()` 可以内部复用 `createScriptedLLMClient()`：

```text
read fixture
  -> validate version and caseId
  -> convert responses to ScriptedLLMResponse[]
  -> createScriptedLLMClient()
```

这样 replay 与 scripted 在 runner 层保持一致。

## Live smoke 设计

第三批加入 live smoke，但默认 skip。

### 启用条件

建议需要同时满足：

```text
EVAL_LIVE=1
OPENAI_API_KEY or provider-specific API key exists
```

没有启用时，live suite 输出 skipped，不失败。

### Live case 限制

Live smoke case 应满足：

1. 数量少，建议 3 到 5 个。
2. 每个 case 有 timeout。
3. 每个 case 有 max LLM calls。
4. 只使用临时 workspace。
5. 断言以结构性结果为主，不断言完整回复。
6. 不执行高风险 bash 命令。
7. 失败时写 trace，但普通 CI 不跑。

### Live LLM wrapper

不要在 `runner.ts` 直接 import provider 细节。第三批可以在当前项目 driver 内提供：

```ts
export function createLiveEvalLLMClient(options: {
  config: Config;
  trace: TraceRecorder;
}): LLMClient;
```

内部可复用现有 `createLLMClient()`，并用 trace wrapper 记录每次 response 的摘要。

## Judge 设计

第三批实现 LLM judge。

### Judge 输入

Judge 不应读取整份 `llm.log`，而应读取结构化 trace 摘要：

```ts
export interface EvalJudgeInput {
  caseId: string;
  title: string;
  description?: string;
  userQueries: string[];
  finalOutputs: string[];
  runtimeEvents: AgentRuntimeEvent[];
  hardAssertionResults: EvalAssertionResult[];
  rubric: EvalJudgeRubric;
}
```

### Judge rubric

```ts
export interface EvalJudgeRubric {
  goal: string;
  passCriteria: string[];
  failCriteria: string[];
  scoring?: {
    minPassingScore: number;
    maxScore: number;
  };
}
```

### Judge 输出

Judge 必须输出 JSON，并由代码解析：

```ts
export interface EvalJudgeResult {
  enabled: boolean;
  passed: boolean;
  score: number;
  summary: string;
  strengths: string[];
  problems: string[];
  evidence: Array<{
    kind: "runtime_event" | "final_output" | "assertion" | "workspace";
    ref: string;
    note: string;
  }>;
  needsHumanReview: boolean;
}
```

### Judge 规则

1. Hard assertions 失败时，不调用 judge，或调用 judge 但标记 `hardFailed: true`，不能让 judge 覆盖硬失败。
2. Judge JSON 解析失败时，case 标记为 `judge_failed`，但 deterministic result 不受影响。
3. Judge 默认不在普通 CI 跑。
4. Judge prompt 不进入 Agent system prompt；它是 eval runner 的单独 LLM 调用。
5. Judge 的模型可以与被测 Agent 模型不同。

## 报告设计

第三批实现 report aggregation。

建议输出两种报告：

1. JSON report：机器读取。
2. Markdown summary：人读。

JSON:

```ts
export interface EvalSuiteReport {
  version: 1;
  startedAt: string;
  endedAt: string;
  mode: "scripted" | "replay" | "live" | "mixed";
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  judgeEnabled: boolean;
  cases: Array<{
    id: string;
    title: string;
    passed: boolean;
    hardPassed: boolean;
    judgePassed?: boolean;
    tracePath?: string;
    failureSummary?: string;
  }>;
}
```

Markdown:

```text
# Eval Report

- total: 8
- passed: 7
- failed: 1

## Failed

### edit-readme

- hard assertion failed: fileContains README.md "Usage"
- trace: /tmp/eval-traces/edit-readme.trace.json
```

## 三批实现计划

建议压缩为三批。两批不是不可能，但不推荐：第二批会同时承担真实工具、CLI driver、replay/live、judge/report，风险过于集中。三批能让每次交付都有独立验收点，也能让其他 coding agent 更容易接手。

### 第一批: Neutral Eval Core + 当前项目 In-process Driver

目标：先搭出中立 runner 和 driver 边界，同时提供一个能驱动当前项目 `createAgent()` 的 deterministic driver。

新增文件：

```text
src/eval/core/case-schema.ts
src/eval/core/driver.ts
src/eval/core/workspace.ts
src/eval/core/trace.ts
src/eval/core/assertions.ts
src/eval/core/runner.ts
src/eval/core/trace-writer.ts
src/eval/drivers/learn-claude-code/in-process-driver.ts
src/eval/drivers/learn-claude-code/scripted-llm.ts
src/eval/drivers/learn-claude-code/scripted-terminal.ts
src/eval/drivers/learn-claude-code/tool-trace.ts
src/eval/runner.test.ts
```

具体需求：

1. 定义 `CodingAgentDriver`、`AgentInput`、`AgentTurnResult`、`AgentRuntimeEvent`。
2. 定义 `EvalCase`、`EvalStep`、`EvalAssertion`、`EvalTrace`、`EvalRunResult`。
3. 实现临时 workspace，支持 `initialFiles`、路径边界检查和 cleanup。
4. 实现 `TraceRecorder` 和 `writeEvalTrace()`。
5. 实现 portable assertions：
   - `finalOutputContains`
   - `finalOutputMatches`
   - `allStepsCompleted`
   - `fileExists`
   - `fileContains`
   - `noWritesOutsideWorkspace`
6. 实现当前项目 in-process driver：
   - 内部使用 `createAgent()`。
   - 内部使用 scripted LLM。
   - 内部使用 scripted terminal。
   - 内部可以使用 fake tools。
   - 把 LLM/tool/permission/transcript 映射成 `AgentRuntimeEvent`。
7. 实现 instrumented assertions 的第一批：
   - `toolCalled`
   - `toolCallCount`
   - `noToolErrors`
   - `transcriptEventTypes`
8. 实现 `runEvalCase()`。
9. 写至少 4 个测试：
   - core runner 能用 fake driver 跑无工具 final output。
   - 当前项目 driver 能跑无工具 final output。
   - 当前项目 driver 能跑一次 fake tool call 后 final output。
   - 多 query 复用同一个 driver。
10. 更新 `doc/summary.md`，说明 Eval Core 和当前项目 driver 已新增。

第一批不做：

1. 不接真实核心工具。
2. 不实现 CLI driver。
3. 不接真实 LLM。
4. 不接 replay/live/judge。
5. 不加 `npm run test:eval`。

验收命令：

```bash
npm run typecheck
npx vitest run src/eval/runner.test.ts
npx eslint src/eval
```

### 第二批: Deterministic Suite + 真实核心工具 + CLI Driver

目标：把 Eval Core 变成 CI 可用的 deterministic integration suite，并用 CLI driver 验证框架没有绑定当前 Agent 内部结构。

新增/修改文件：

```text
src/eval/drivers/learn-claude-code/core-tool-runtime.ts
src/eval/drivers/cli/cli-driver.ts
src/eval/cases/deterministic.test.ts
src/eval/README.md
package.json
doc/summary.md
```

具体需求：

1. 实现 `createCoreEvalToolRegistry()`，接真实 `run_bash/run_read/run_write/run_edit/run_edit_exact`。
2. 当前项目 in-process driver 支持 `tools.kind = "core"`。
3. 补齐 instrumented assertions：
   - `toolNotCalled`
   - `toolArgsContain`
   - `allToolsSucceeded`
   - `permissionPromptShown`
4. 实现 CLI driver：
   - spawn 指定 command。
   - 向 stdin 输入 step query。
   - 收集 stdout/stderr/exitCode。
   - 生成 `agent_output`、`log`、`driver_error` runtime events。
   - 支持 timeout。
5. 新增 deterministic suite，至少包含 5 个 case：
   - `run_write` 创建文件。
   - `run_read` 读取 fixture 文件。
   - `run_edit_exact` 精确修改文件。
   - `run_bash` 执行只读命令。
   - CLI driver 最小 smoke case。
6. `package.json` 新增：

```json
{
  "scripts": {
    "test:eval": "vitest run src/eval/cases/deterministic.test.ts"
  }
}
```

7. 新增 `src/eval/README.md`，说明 case 写法、driver、trace、命令和限制。
8. 更新 `doc/summary.md`。

第二批不做：

1. 不接真实 LLM。
2. 不实现 replay。
3. 不实现 judge。
4. 不改 GitHub Actions。
5. 不默认把 trace 写到仓库。

验收命令：

```bash
npm run typecheck
npx vitest run src/eval/runner.test.ts
npm run test:eval
npx eslint src/eval
npm test
```

### 第三批: Replay + Live Smoke + Judge/Report

目标：加入质量观测层：replay、opt-in live smoke、可选 judge 和 suite report。它们不进入普通 CI 默认门禁。

新增/修改文件：

```text
src/eval/replay/replay-llm.ts
src/eval/live/live-llm.ts
src/eval/live/live-suite.test.ts
src/eval/judge/judge.ts
src/eval/judge/judge-suite.test.ts
src/eval/core/report.ts
src/eval/cases/fixtures/
src/eval/README.md
package.json
doc/summary.md
```

具体需求：

1. 定义 replay fixture 格式。
2. 实现 `createReplayLLMClient()`，复用当前项目 driver 的 scripted LLM 路径。
3. 添加至少 2 个 replay fixture case。
4. 实现 `createLiveEvalLLMClient()`，复用现有 `createLLMClient()`。
5. live suite 默认 skip，只有 `EVAL_LIVE=1` 时运行。
6. live case 至少 2 个，且只做结构性断言。
7. 定义 `EvalJudgeRubric`、`EvalJudgeInput`、`EvalJudgeResult`。
8. 实现 judge prompt builder 和 JSON parser，必须能处理无效 JSON。
9. `runEvalCase()` 支持 hard assertions 后可选 judge。
10. 实现 suite report 聚合、JSON report writer、Markdown report writer。
11. `judge-suite.test.ts` 使用 scripted judge LLM，不调用真实模型。
12. 增加脚本：

```json
{
  "scripts": {
    "test:eval:live": "vitest run src/eval/live/live-suite.test.ts",
    "test:eval:judge": "vitest run src/eval/judge/judge-suite.test.ts"
  }
}
```

13. README 增加 replay/live/judge/report 使用说明。
14. 更新 `doc/summary.md`。

第三批不做：

1. 不实现自动录制真实 LLM response。
2. 不让 live smoke 进入普通 CI 默认命令。
3. 不让 judge 覆盖 hard assertion failure。
4. 不让 judge 默认进入普通 CI。
5. 不实现复杂 dashboard。

验收命令：

```bash
npm run typecheck
npm run test:eval
npm run test:eval:judge
npx vitest run src/eval/live/live-suite.test.ts
npx eslint src/eval
npm test
```

如果有 API key，可以额外手动运行：

```bash
EVAL_LIVE=1 npm run test:eval:live
```

## 第一阶段示例 Case

### Case 1: 无工具回复

```ts
const noToolCase: EvalCase = {
  id: "no-tool-final-response",
  title: "Agent returns final response without tools",
  steps: [{ query: "Say hello." }],
  driver: {
    kind: "learn-claude-code-in-process",
    llm: {
      kind: "scripted",
      scriptedResponses: [
        { content: "Hello from eval.", toolCalls: [], finishReason: "stop" },
      ],
    },
    tools: { kind: "fake", fakeTools: [] },
  },
  assertions: [
    { kind: "finalOutputContains", text: "Hello" },
    { kind: "toolCallCount", toolName: "run_bash", count: 0 },
  ],
};
```

### Case 2: 一次 fake tool call

```ts
const fakeToolCase: EvalCase = {
  id: "fake-tool-once",
  title: "Agent executes one fake tool then answers",
  steps: [{ query: "Check status." }],
  driver: {
    kind: "learn-claude-code-in-process",
    llm: {
      kind: "scripted",
      scriptedResponses: [
        {
          content: null,
          toolCalls: [
            { id: "call_1", name: "run_status", args: { target: "demo" } },
          ],
          finishReason: "tool_calls",
        },
        {
          content: "Status is ok.",
          toolCalls: [],
          finishReason: "stop",
        },
      ],
    },
    tools: {
      kind: "fake",
      fakeTools: [
        {
          name: "run_status",
          result: { output: "ok", error: false },
        },
      ],
    },
  },
  assertions: [
    { kind: "toolCalled", toolName: "run_status", minCount: 1 },
    { kind: "noToolErrors" },
    { kind: "finalOutputContains", text: "ok" },
  ],
};
```

### Case 3: 多 query

```ts
const multiQueryCase: EvalCase = {
  id: "multi-query-history",
  title: "Agent keeps history across multiple queries",
  steps: [
    { id: "first", query: "Remember alpha." },
    { id: "second", query: "What did I ask you to remember?" },
  ],
  driver: {
    kind: "learn-claude-code-in-process",
    llm: {
      kind: "scripted",
      scriptedResponses: [
        { content: "I will remember alpha.", toolCalls: [], finishReason: "stop" },
        { content: "You asked me to remember alpha.", toolCalls: [], finishReason: "stop" },
      ],
    },
    tools: { kind: "fake", fakeTools: [] },
  },
  assertions: [
    { kind: "finalOutputContains", stepId: "second", text: "alpha" },
    {
      kind: "transcriptEventTypes",
      expected: [
        "user_message",
        "assistant_message",
        "user_message",
        "assistant_message",
      ],
    },
  ],
};
```

## 第二阶段示例 Case

### 写文件

```ts
const writeFileCase: EvalCase = {
  id: "core-write-file",
  title: "Agent writes a file through real run_write",
  steps: [{ query: "Create hello.txt." }],
  workspace: {},
  driver: {
    kind: "learn-claude-code-in-process",
    tools: { kind: "core" },
    llm: {
      kind: "scripted",
      scriptedResponses: [
        {
          content: null,
          toolCalls: [
            {
              id: "call_1",
              name: "run_write",
              args: { path: "hello.txt", content: "hello eval" },
            },
          ],
          finishReason: "tool_calls",
        },
        { content: "Created hello.txt.", toolCalls: [], finishReason: "stop" },
      ],
    },
  },
  assertions: [
    { kind: "toolCalled", toolName: "run_write" },
    { kind: "fileContains", path: "hello.txt", text: "hello eval" },
    { kind: "allToolsSucceeded" },
  ],
};
```

### 读文件

```ts
const readFileCase: EvalCase = {
  id: "core-read-file",
  title: "Agent reads a fixture file through real run_read",
  workspace: {
    initialFiles: {
      "notes.md": "Project note: eval runner",
    },
  },
  steps: [{ query: "Read notes.md and summarize it." }],
  driver: {
    kind: "learn-claude-code-in-process",
    tools: { kind: "core" },
    llm: {
      kind: "scripted",
      scriptedResponses: [
        {
          content: null,
          toolCalls: [
            { id: "call_1", name: "run_read", args: { path: "notes.md" } },
          ],
          finishReason: "tool_calls",
        },
        { content: "The note is about eval runner.", toolCalls: [], finishReason: "stop" },
      ],
    },
  },
  assertions: [
    { kind: "toolCalled", toolName: "run_read" },
    { kind: "finalOutputContains", text: "eval runner" },
  ],
};
```

## Case 校验规则

`validateEvalCase()` 应覆盖：

1. `id` 非空，只允许 `[a-z0-9._-]`。
2. `steps` 至少一项。
3. `assertions` 至少一项。
4. `driver` 必须存在，并且 `kind` 非空。
5. `learn-claude-code-in-process` driver 的 `scripted` 模式必须提供 `scriptedResponses`。
6. `replay` 模式必须提供 `replayFile`。
7. `live` 模式必须显式 opt-in。
8. `workspace.initialFiles` 的路径必须是相对路径，不能包含 `..` 逃逸。
9. fake tool 名称不能重复。
10. assertion 中引用的 `stepId` 必须存在。
11. `toolCallCount.count` 不能为负数。

## 错误与失败语义

建议区分：

```ts
export type EvalRunStatus =
  | "passed"
  | "failed"
  | "skipped"
  | "error";
```

- `failed`：case 正常运行完，但 assertion 或 judge 不通过。
- `error`：runner 自身出错，例如 scripted response 不足、fixture 无效、workspace 创建失败。
- `skipped`：live/judge 未启用或缺少环境变量。
- `passed`：所有必要检查通过。

Vitest 中可以把 `failed` 和 `error` 都转为测试失败，但报告里要保留区别。

## 与现有模块的关系

### Eval Core

Eval Core 不 import `agent.ts`、`llm.ts`、`terminal.ts`、`transcript.ts`、`tools/registry.ts`。它只认识 `CodingAgentDriver`、workspace、trace、assertions 和 report。

### Agent

只有 `learn-claude-code-in-process` driver 调用 `agent.run(query)`，不修改 Agent 主循环。未来如果 Agent 架构大改，只需要改这个 driver 或新增 driver。

### LLM

当前项目 driver 提供新的 `LLMClient` 实现：

- scripted
- replay
- live wrapper
- judge client wrapper

### Terminal

当前项目 driver 使用 `ScriptedTerminal`，不操作真实 stdin。CLI driver 可以直接通过 stdin/stdout 工作，不需要实现 `Terminal`。

### Transcript

当前项目 driver 使用现有 `createTranscriptStore()`。Case 结束后把 `readSession(sessionId)` 映射为标准化 runtime events，并可额外保留 raw driver events。

### ToolRegistry

当前项目 driver 可以创建 fake registry，也可以创建 core tool registry。无论哪种 registry，都通过 trace wrapper 包一层并输出标准化 tool runtime events。

### Permission

第一阶段可以用 auto mock permission。第二阶段如果接真实 PermissionManager，需要注入 scripted terminal 的 `askUser`。

### ProjectContext

第二阶段真实工具 eval 使用临时 workspace 作为 `projectRoot`。不要写入当前仓库。

## 与 CI 的关系

建议最终命令分层：

```bash
npm run test:eval        # deterministic integration suite
npm run test:eval:live   # opt-in live smoke
npm run test:eval:judge  # deterministic judge parser/reporter tests
```

普通 CI 建议：

```bash
npm run typecheck
npm test
npm run test:eval
npm run lint
```

Nightly 或人工触发：

```bash
EVAL_LIVE=1 npm run test:eval:live
EVAL_JUDGE=1 npm run test:eval:judge
```

## 测试策略

### 第一阶段测试

1. Core runner 能通过 fake driver 跑无工具 case。
2. `CodingAgentDriver` 生命周期按 `startCase -> send -> readEvents -> close` 执行。
3. Workspace initial files 正确写入。
4. Workspace 阻止路径逃逸。
5. Trace writer 写 JSON。
6. Scripted LLM 顺序返回。
7. Scripted LLM response 用完时报错。
8. Scripted Terminal 权限答案按顺序消耗。
9. 当前项目 in-process driver 能跑无工具 case。
10. 当前项目 in-process driver 能跑 fake tool case。
11. Runner 能跑多 query case。
12. Assertion failure 返回结构化结果。

### 第二阶段测试

1. Core tool registry 能写文件。
2. Core tool registry 能读文件。
3. Core tool registry 能精确编辑文件。
4. Core tool registry 能跑安全 bash。
5. CLI driver 能执行最小命令并收集 stdout/stderr/exitCode。
6. CLI driver timeout 能收敛为 `driver_error` 或 `error`。
7. Instrumented assertions 能从 runtime events 中判断工具行为。
8. `npm run test:eval` 无 API key 可通过。

### 第三阶段测试

1. Replay fixture 解析成功。
2. Replay fixture caseId 不匹配时报错。
3. Replay client 行为等同 scripted client。
4. Live suite 在未设置 `EVAL_LIVE=1` 时 skip。
5. Live suite 在启用但缺少 key 时给出清晰 skip 或 error。
6. Judge prompt builder 包含 case、trace、rubric。
7. Judge JSON parser 能解析合法 JSON。
8. Judge JSON parser 能处理非法 JSON。
9. Hard assertion 失败时 judge 不能覆盖失败。
10. Report aggregation 统计 passed/failed/skipped。
11. Markdown report 包含失败摘要和 trace path。

## 完成后的能力边界

三阶段完成后，项目会拥有四层自动化验收：

```text
Unit tests
  验证单个模块纯逻辑。

Deterministic eval
  验证 driver + agent behavior + tools/workspace + trace。

Replay eval
  验证真实模型历史 response 在当前 runtime 下仍能跑通。

Live/Judge eval
  观察真实模型行为和开放式质量，服务 nightly 与人工复核。
```

其中普通 CI 的核心门禁应是：

```text
Unit tests + deterministic eval
```

Replay、live、judge 是质量观测层，不应在初期默认阻塞所有提交。

## 风险与对策

### 风险 1: 框架过早接入真实模型导致不稳定

对策：前两阶段只做 deterministic eval。Live smoke 第三阶段再做，并默认 skip。

### 风险 2: Case schema 过度设计

对策：第一版只用 TypeScript interface 和对象，不引入外部 schema validator。必要校验手写。

### 风险 3: Trace 太像日志，无法机器判断

对策：Trace 使用结构化对象，assertions 只读取结构化字段。

### 风险 4: Judge 被当成唯一真相

对策：hard assertions 优先，judge 不可覆盖硬失败。

### 风险 5: 真实工具污染仓库

对策：第二批所有真实工具 eval 都使用临时 workspace。

### 风险 6: 多 query case 的状态泄漏

对策：同一 case 内复用 driver；不同 case 必须创建新 driver、新 workspace。当前项目 driver 内部再创建新 Agent、新 History、新 Transcript。

### 风险 7: 实现者读 PDD 后只实现部分路径

对策：每批都有 checklist 和验收命令。实现时必须逐条核对。

## 最终验收清单

三阶段全部完成后，应满足：

1. `src/eval/core/` 与 `src/eval/drivers/` 边界清晰。
2. `npm run test:eval` 无 API key 可稳定通过。
3. Eval case 支持多 query。
4. Eval Core 只依赖 `CodingAgentDriver`，不直接依赖当前项目内部 Agent 类型。
5. 当前项目 driver 支持 fake LLM、replay LLM、live LLM。
6. Eval runner 支持临时 workspace。
7. 当前项目 driver 支持 scripted terminal。
8. 当前项目 driver 支持真实核心工具。
9. CLI driver 至少支持最小 smoke case。
10. 每个 case 可产生 structured trace。
11. Trace 可写入 JSON artifact。
12. Hard assertions 覆盖 final output、workspace files、tool events、transcript events、tool errors。
13. Replay fixture 可复现历史真实 LLM response。
14. Live smoke 默认 skip，显式启用。
15. Judge 默认不进入普通 CI。
16. Judge 输出结构化 JSON，并能处理解析失败。
17. Suite report 能输出 JSON 和 Markdown。
18. `doc/summary.md` 反映已实现的 eval 模块。
19. 全量 `npm test`、`npm run typecheck`、`npm run lint` 通过，或报告 pre-existing lint 问题。
