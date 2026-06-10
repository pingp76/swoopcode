# Eval 系统

教学用途的确定性回归测试框架，用于验证 Coding Agent 的核心行为。

## 快速开始

```bash
# 运行 deterministic suite（≥5 个 core tool + CLI smoke case）
npm run test:eval

# 运行所有 eval 相关测试（含 runner 集成测试）
npx vitest run src/eval/
```

## 设计原则

- **确定性**：所有 case 使用 scripted LLM，不依赖真实模型，确保任何环境都能稳定通过
- **可移植**：Eval Core 不直接依赖当前项目内部模块（agent.ts、llm.ts 等），只认识 `CodingAgentDriver` 接口
- **可观测**：通过 instrumented assertions 验证工具调用、权限确认等内部行为
- **隔离性**：每个 case 在独立临时 workspace 中运行，自动清理

## Case 结构

一个最小 eval case：

```ts
import type { EvalCase } from "./core/case-schema.js";

const myCase: EvalCase = {
  id: "my-case",
  title: "My first eval case",
  driver: {
    kind: "learn-claude-code-in-process",
    llm: {
      kind: "scripted",
      scriptedResponses: [
        { content: "Hello!", toolCalls: [], finishReason: "stop" },
      ],
    },
    tools: { kind: "core" }, // 使用真实核心工具
  },
  steps: [{ query: "Say hello." }],
  assertions: [
    { kind: "finalOutputContains", text: "Hello" },
    { kind: "allStepsCompleted" },
  ],
};
```

### 关键字段

| 字段         | 说明                                                         |
| ------------ | ------------------------------------------------------------ |
| `id`         | 唯一标识，只允许 `[a-z0-9._-]`                               |
| `driver`     | Driver 计划：in-process 或 CLI                               |
| `steps`      | 用户输入序列，每个 step 可独立断言                           |
| `workspace`  | 可选的临时 workspace 配置（`initialFiles`、`keepOnFailure`） |
| `assertions` | case 级断言，所有 step 完成后执行                            |
| `trace`      | 可选的 trace 配置（`enabled`、`outputDir`）                  |

### Driver 类型

#### In-process Driver

直接组装当前项目的 `createAgent()`，使用 scripted LLM 和 scripted terminal。

```ts
driver: {
  kind: "learn-claude-code-in-process",
  llm: { kind: "scripted", scriptedResponses: [...] },
  tools: { kind: "core" }, // 或 { kind: "fake", fakeTools: [...] }
}
```

- `tools.kind = "core"`：使用真实的 bash/read/write/edit/editExact 工具，限制在临时 workspace 内
- `tools.kind = "full"`：使用当前项目完整工具系统（TODO/Task/Memory/Skill/SubAgent/Async/Schedule/Output），并强制使用临时 `agentHome`
- `tools.kind = "fake"`：使用自定义 fake 工具，无副作用，适合测试 runner 本身

Full-tools 示例：

```ts
driver: {
  kind: "learn-claude-code-in-process",
  llm: { kind: "live", live: { maxCalls: 12 } },
  tools: {
    kind: "full",
    full: {
      agentHome: "temp",
      enabledTools: ["core", "todo", "skill"],
      seedSkills: {
        "eval-format/SKILL.md": "When asked for status, write SKILL_USED_22.",
      },
    },
  },
  maxRounds: 12,
}
```

#### CLI Driver

通过 `child_process.spawn` 启动外部命令，适用于测试独立 CLI 工具。

```ts
driver: {
  kind: "cli",
  command: "cat",
  args: [],
  timeoutMs: 5000,
}
```

- `command` / `args`：要执行的命令和参数
- `env`：可选的环境变量覆盖
- `timeoutMs`：可选的超时时间（**per-case 语义**，从 `startCase()` 开始计时）
- `readyPattern`：预留字段，用于复杂交互式 CLI 的 prompt 匹配

> **CLI Driver 限制**：当前 `send()` 的 100ms 等待是固定值，适用于简单 echo 命令（如 `cat`）。复杂交互式 CLI 或慢机器/CI 环境可能需要更长的等待时间，这属于后续增强。

### Workspace 配置

```ts
workspace: {
  initialFiles: {
    "data.txt": "apple banana cherry",
  },
  keepOnFailure: true, // case 失败时保留临时目录，便于调试
}
```

`initialFiles` 的键必须是相对路径，不能包含 `..` 或绝对路径。

### Assertion 类型

#### Portable Assertions（不依赖 driver 内部事件）

| Assertion                  | 说明                              |
| -------------------------- | --------------------------------- |
| `finalOutputContains`      | 最终输出包含指定文本              |
| `finalOutputMatches`       | 最终输出匹配正则表达式            |
| `exitCodeIs`               | 退出码等于指定值（CLI driver 用） |
| `allStepsCompleted`        | 所有步骤都执行完毕                |
| `fileExists`               | 文件存在                          |
| `fileNotExists`            | 文件不存在                        |
| `fileContains`             | 文件包含指定文本                  |
| `noWritesOutsideWorkspace` | 没有向 workspace 外写入           |

#### Instrumented Assertions（需要 driver 提供 runtime events）

| Assertion               | 说明                                           |
| ----------------------- | ---------------------------------------------- |
| `toolCalled`            | 指定工具被调用过（可设 `minCount`）            |
| `toolNotCalled`         | 指定工具未被调用                               |
| `toolCalledOneOf`       | 一组工具中至少一个被调用过                     |
| `toolCallCount`         | 指定工具调用次数等于指定值                     |
| `toolArgsContain`       | 指定工具的参数包含指定文本                     |
| `toolResultContains`    | 指定工具结果包含指定文本                       |
| `stepToolCalled`        | 指定 step 中工具被调用过                       |
| `stepToolNotCalled`     | 指定 step 中工具未被调用                       |
| `noToolErrors`          | 没有工具错误（tool_call/tool_result 中 error） |
| `allToolsSucceeded`     | 所有 tool_result 的 error 不为 true            |
| `transcriptEventTypes`  | transcript 事件类型序列匹配                    |
| `permissionPromptShown` | 权限确认弹窗已展示                             |
| `custom`                | 自定义断言函数                                 |

> **注意**：instrumented assertions 依赖 driver 发射 `tool_call` / `tool_result` / `permission_prompt` 等事件。in-process driver 通过 `wrapToolRegistryForTrace` 和 `scripted-terminal` 自动发射这些事件；CLI 黑盒 driver 可能不支持全部 instrumented assertions。

### Step 级断言

断言可以写在 case 级别（所有 step 完成后执行），也可以写在 step 级别：

```ts
steps: [
  {
    query: "Step 1",
    assertions: [
      { kind: "finalOutputContains", text: "step1 result" },
    ],
  },
],
```

Step 级断言与 case 级断言合并后统一执行。

## Trace 配置

Eval 运行结束后可以输出结构化 trace JSON：

```ts
trace: {
  enabled: true,
  outputDir: "./eval-traces",
}
```

也可以通过环境变量启用：

```bash
EVAL_TRACE_DIR=./eval-traces npm run test:eval
```

Trace 文件包含：case 信息、步骤痕迹、runtime events、断言结果。

## 编写 Core Tool Case 的注意事项

1. **Scripted LLM Responses**：每个 tool call 需要至少 2 个 responses
   - 第 1 个：assistant message 包含 `toolCalls`（`finishReason: "tool_calls"`）
   - 第 2 个：assistant message 不包含 tool calls（`finishReason: "stop"`）

2. **Bash 安全**：eval case 中的 bash 命令应使用安全命令（如 `echo`、`pwd`、`ls`、`cat`），避免危险命令被 `command-safety.ts` 黑名单拦截

3. **路径边界**：所有文件操作自动限制在临时 workspace 内，尝试写入 workspace 外会返回错误

4. **工具延迟创建**：core tool registry 在 `startCase()` 时才创建，因为需要 `workspaceRoot`

## Replay 模式

Replay 从 JSON fixture 读取录制好的 LLM 响应序列，复用 scripted LLM 路径驱动 Agent。

```ts
driver: {
  kind: "learn-claude-code-in-process",
  llm: {
    kind: "replay",
    replayFile: "fixtures/my-case.json",
  },
}
```

Fixture 格式：

```json
{
  "version": 1,
  "caseId": "my-case",
  "provider": "openai_compatible",
  "model": "gpt-4",
  "recordedAt": "2026-06-03T00:00:00.000Z",
  "responses": [
    { "content": "Hello!", "toolCalls": [], "finishReason": "stop" }
  ]
}
```

- `version` 必须为 `1`
- `caseId` 必须与 `EvalCase.id` 匹配（防御混用）
- `replayFile` 推荐用绝对路径；相对路径会基于 `process.cwd()` 解析
- 第一版 replay 只读取 fixture，不负责自动录制

## Live Smoke

Live smoke 使用真实 LLM 验证 agent 行为，默认 **不运行**。

### 启用条件

```bash
EVAL_LIVE=1 npm run test:eval:live
```

Live suite 在 `EVAL_LIVE !== "1"` 时自动 skip。

### Live case 限制

- 数量少（2-3 个）
- 断言以结构性为主（`allStepsCompleted`、`toolCalled`、`noToolErrors`），不断言完整回复文本
- 使用 `maxRounds` / `maxCalls` 限制，防止 LLM 无限循环
- 只使用临时 workspace

```ts
driver: {
  kind: "learn-claude-code-in-process",
  llm: { kind: "live", live: { maxCalls: 8 } },
  tools: { kind: "core" },
  maxRounds: 8,
}
```

## Live Regression

Live regression 是比 smoke 更全面的真实 LLM 验证，覆盖核心工具的端到端能力。默认 **不运行**。

### 启用条件

```bash
# 跑 live regression
EVAL_LIVE_REGRESSION=1 npm run test:eval:live:regression
```

> **注意**：`test:eval:live`（smoke，2 个 case）和 `test:eval:live:regression`（regression，6 个 case）是两个**独立 suite**，互不依赖。`EVAL_LIVE=1` 只影响 smoke suite 的开关；`EVAL_LIVE_REGRESSION=1` 只影响 regression suite 的开关。跑 regression 时不需要设置 `EVAL_LIVE`。

### 第一轮 case 列表（6 个）

| Case ID                                 | 场景                               |
| --------------------------------------- | ---------------------------------- |
| `live-core-read-structured-summary`     | 读取结构化文件并基于内容回答       |
| `live-core-write-report-with-sentinels` | 创建新文件并写入精确 sentinel 内容 |
| `live-core-edit-existing-config`        | 编辑已有文件并保留不相关内容       |
| `live-core-bash-readonly-command`       | 执行只读 bash 命令并报告输出       |
| `live-core-permission-denied-write`     | 权限被拒绝后不继续写入             |
| `live-core-multi-turn-stateful-edit`    | 多轮上下文共享：先观察再修改       |

### 设计原则

- 只使用 core tools（read/write/edit/editExact/bash），不依赖 TODO/Task/Memory/Skill/SubAgent/Async/Schedule
- 每个 case 限制 `maxCalls`/`maxRounds`（通常 8-12），Vitest timeout 30-60s（multi-turn case 用 60s）
- 断言以结构性为主，Judge 做开放式质量补充评价
- 只使用临时 workspace，不留副作用

### Judge 开关

5 个 case 已内置 judge rubric，但 judge 默认关闭。额外启用：

```bash
EVAL_LIVE_REGRESSION=1 EVAL_JUDGE=1 npm run test:eval:live:regression
```

这会额外产生 5 次 LLM judge 调用（bash case 无 judge），建议在发布前或主循环大改后开启。

Judge 默认使用和 Agent **相同的模型**。如果想用不同模型（例如轻量模型降低成本），通过 `JUDGE_MODEL` 覆盖：

```bash
EVAL_LIVE_REGRESSION=1 EVAL_JUDGE=1 JUDGE_MODEL=gpt-4o-mini npm run test:eval:live:regression
```

## Live Full Regression

Live full regression 使用 `tools.kind = "full"` 验证当前单 Agent 的复杂工具系统。默认 **不运行**，并且每个 case 都使用临时 workspace 与临时 `agentHome`，不会读取或写入用户真实 `~/.learn-claude-code-ts`。

### 启用条件

```bash
EVAL_LIVE_FULL=1 npm run test:eval:live:full
```

### Release case 列表（4 个）

| Case ID                                      | 场景                                          |
| -------------------------------------------- | --------------------------------------------- |
| `live-full-todo-guided-file-change`          | 使用 TODO 管理短任务并完成文件修改            |
| `live-full-memory-confirmed-create-and-read` | 用户明确要求记忆后创建 memory，并在下一轮读回 |
| `live-full-skill-guided-output`              | 加载临时 seed skill，并按 skill 指示写文件    |
| `live-full-subagent-readonly-analysis`       | 父 Agent 委托只读 subagent 分析文件并整合结果 |

其中 skill release case 使用 `SKILL_USED_22` 作为 seed skill 行为标记，调试 trace 时可以用它快速确认模型确实加载并遵循了临时 skill。

Nightly 组已预留 Task Group、Async Run + Output、Schedule create/read/cancel 三类 case，当前默认 `describe.skip`，用于后续人工或夜间运行策略。

### Judge 开关

```bash
EVAL_LIVE_FULL=1 EVAL_JUDGE=1 npm run test:eval:live:full
```

Release 组 4 个 case 均内置 judge rubric。开启后会额外产生 4 次 judge LLM 调用。

## MCP Harness Prototype

MCP suite 使用 eval 内置 fixture server，覆盖 MCP lifecycle、tool、resource、error、timeout 与 server crash trace。fixture server 遵循 MCP 2025-06-18 的最小 JSON-RPC 子集；当前 transport 由 driver 以 in-process 方式模拟，case schema 保留 `transport: "stdio" | "http"` 字段，便于未来替换为真实 MCP client。in-process driver 支持顶层 `driver.mcpServers`，也兼容 `tools.full.mcpServers`。

> 当前项目尚未实现生产级 MCP runtime / 第三方 MCP server 接入。下面这些 MCP suite 现在全部 `describe.skip`，只作为 harness 草案保留，不作为真实 MCP 功能验收。

### 确定性 MCP

```bash
npx vitest run src/eval/mcp/fixture-server.test.ts
npx vitest run src/eval/mcp/mcp-suite.test.ts
```

### Live MCP（当前无条件 skip）

```bash
EVAL_LIVE_MCP=1 npm run test:eval:live:mcp
EVAL_LIVE_MCP=1 EVAL_JUDGE=1 npm run test:eval:live:mcp
```

Live MCP case 目前也无条件 skip。等真实 MCP runtime 落地后，再恢复 `EVAL_LIVE_MCP=1` 的 opt-in 运行。

## Agent Team Harness Prototype

Team suite 使用 `learn-claude-code-team` driver。第一版是顺序 supervisor 拓扑：planner、implementer、reviewer、researcher 等成员依次运行，每个成员都是一个真实 Agent 实例，有独立 history 和受限工具集，共享临时 workspace 与同一个 LLM client。

当前 Team member 工具组支持 `core`、`read`、`bash`、`todo`、`mcp`。写入/编辑工具成功后 driver 会发射 `artifact_produced` 事件，`teamArtifactContains` 会同时检查该事件和 workspace 文件内容。

> 当前项目尚未实现生产级 Agent Team runtime。下面这些 Team suite 现在全部 `describe.skip`，只作为 harness 草案保留，不作为真实 Team 功能验收。

### 确定性 Team

```bash
npx vitest run src/eval/team/team-assertions.test.ts
npx vitest run src/eval/team/team-suite.test.ts
```

### Live Team（当前无条件 skip）

```bash
EVAL_LIVE_TEAM=1 npm run test:eval:live:team
EVAL_LIVE_TEAM=1 EVAL_JUDGE=1 npm run test:eval:live:team
```

### Live Team + MCP（当前无条件 skip）

```bash
EVAL_LIVE_TEAM=1 EVAL_LIVE_MCP=1 npm run test:eval:live:team:mcp
```

Team+MCP mixed case 目前也无条件 skip。等真实 Team/MCP runtime 落地后，再恢复显式 opt-in 运行。

## Judge 评估

Judge 在 hard assertions 执行后，用另一个 LLM 对 case 做开放式质量评价。

### Judge 不覆盖 hard assertions

Hard assertions 失败时，judge 仍可运行，但 `result.status` 不受影响。Judge 只是补充评分。

### 定义 rubric

```ts
{
  judge: {
    rubric: {
      goal: "Agent should write a greeting file.",
      passCriteria: ["File is created", "Content is friendly"],
      failCriteria: ["File is missing", "Content is empty"],
      scoring: { minPassingScore: 7, maxScore: 10 },
    },
  },
}
```

### 运行 judge

```ts
import { loadConfig } from "../../config.js";
import { createLLMClient } from "../../llm.js";

const config = loadConfig();
const judgeLLM = createLLMClient(
  {
    /* ResolvedLLMConfig */
  },
  undefined,
  config.runtimePolicy,
);
const result = await runEvalCase(evalCase, createDriver, judgeLLM);
console.log(result.judge?.summary);
```

Judge 输出 `EvalJudgeResult`：

- `passed` / `score` / `summary`
- `strengths` / `problems`
- `evidence` — 带引用的事件/输出/断言证据
- `needsHumanReview` — 是否需要人工复核

### Judge JSON 解析鲁棒性

Judge LLM 可能返回 markdown code block、额外文本或无效 JSON。解析器采用四层降级：

1. 直接 `JSON.parse()`
2. 正则提取 ` ```json ... ``` ` 代码块
3. 括号深度计数器 + 字符串引号跟踪提取嵌套 JSON
4. 返回 `judge_failed` 结果（不影响 hard result）

## Suite Report

运行多个 case 并聚合报告：

```ts
import {
  runEvalSuite,
  writeJsonReport,
  writeMarkdownReport,
} from "./core/report.js";

const report = await runEvalSuite(cases, createDriver, judgeLLM);
await writeJsonReport(report, "./report.json");
await writeMarkdownReport(report, "./report.md");
```

Report 输出两种格式：

- **JSON**：机器读取，含每个 case 的 `hardPassed`、`judgePassed`、`tracePath`、`failureSummary`
- **Markdown**：人读，分 Passed / Failed 章节

## 脚本速查表

```bash
# 确定性 suite（默认 CI）
npm run test:eval

# Replay suite
npx vitest run src/eval/cases/replay-suite.test.ts

# Live smoke（需要 EVAL_LIVE=1 和 API key）
npm run test:eval:live

# Live regression（需要 EVAL_LIVE_REGRESSION=1）
EVAL_LIVE_REGRESSION=1 npm run test:eval:live:regression

# Live regression + Judge（额外启用 LLM judge 评价，增加 5 次 LLM 调用）
EVAL_LIVE_REGRESSION=1 EVAL_JUDGE=1 npm run test:eval:live:regression

# Live full regression（需要 EVAL_LIVE_FULL=1）
EVAL_LIVE_FULL=1 npm run test:eval:live:full

# Live full regression + Judge（额外启用 LLM judge 评价，增加 4 次 LLM 调用）
EVAL_LIVE_FULL=1 EVAL_JUDGE=1 npm run test:eval:live:full

# Live MCP（当前无条件 skip，待真实 MCP runtime 后恢复）
EVAL_LIVE_MCP=1 npm run test:eval:live:mcp

# Live Team（当前无条件 skip，待真实 Agent Team runtime 后恢复）
EVAL_LIVE_TEAM=1 npm run test:eval:live:team

# Live Team + MCP mixed（当前无条件 skip）
EVAL_LIVE_TEAM=1 EVAL_LIVE_MCP=1 npm run test:eval:live:team:mcp

# 用不同模型做 judge（默认和 Agent 同模型）
EVAL_LIVE_REGRESSION=1 EVAL_JUDGE=1 JUDGE_MODEL=gpt-4o-mini npm run test:eval:live:regression

# Judge suite（scripted judge，不依赖真实模型）
npm run test:eval:judge

# 所有 eval 测试
npx vitest run src/eval/
```

## 当前限制

- **自动录制**：replay fixture 需手动创建，不支持自动录制真实 LLM 对话
- **`workspaceDiffContains`**：workspace diff 断言暂未实现
- **复杂 CLI 交互**：REPL 类 CLI 的 readyPattern / prompt 匹配属于后续增强
- **并行 suite**：`runEvalSuite` 当前顺序执行，未来可并行化
- **MCP transport**：当前 MCP fixture 以 in-process client/server 模拟 transport，尚未接真实第三方 MCP server
- **Team 并发**：Team driver 第一版按成员顺序执行，不做并行调度或分布式 team
- **MCP/Team 测试状态**：MCP 与 Agent Team 相关 suite 当前全部 `describe.skip`，避免误读为真实功能已实现

## 目录结构

```
src/eval/
├── core/
│   ├── case-schema.ts    # 所有 Eval 类型定义
│   ├── driver.ts         # CodingAgentDriver 接口
│   ├── workspace.ts      # 临时 workspace
│   ├── trace.ts          # TraceRecorder
│   ├── assertions.ts     # 断言执行器
│   ├── runner.ts         # 核心 runner
│   └── trace-writer.ts   # JSON 输出
├── drivers/
│   ├── learn-claude-code/
│   │   ├── in-process-driver.ts       # 当前项目 driver
│   │   ├── core-tool-runtime.ts       # 真实核心工具注册表
│   │   ├── full-tool-runtime.ts       # 临时 agentHome 下的完整工具运行时
│   │   ├── full-tool-runtime.test.ts  # full runtime 确定性测试
│   │   ├── mcp-runtime.ts             # MCP fixture adapter
│   │   ├── team-driver.ts             # 顺序 supervisor Team driver
│   │   ├── scripted-llm.ts            # Scripted LLM
│   │   ├── scripted-terminal.ts       # Scripted Terminal
│   │   └── tool-trace.ts              # 工具追踪包装器
│   └── cli/
│       └── cli-driver.ts         # CLI 黑盒 driver
├── cases/
│   ├── fixtures/
│   │   ├── replay-read.json      # Replay fixture: read file
│   │   └── replay-write.json     # Replay fixture: write file
│   ├── deterministic.test.ts     # Deterministic suite
│   └── replay-suite.test.ts      # Replay suite
├── live/
│   ├── _driver-factory.ts             # Live suite 共享 driver + judge LLM 工厂
│   ├── live-llm.ts                     # Live LLM wrapper
│   ├── live-suite.test.ts              # Live smoke suite
│   ├── live-regression-suite.test.ts   # Live regression suite（core tools）
│   ├── live-full-suite.test.ts         # Live full-system regression suite
│   ├── live-mcp-suite.test.ts          # Live MCP suite
│   └── live-team-suite.test.ts         # Live Team / Team+MCP suite
├── mcp/
│   ├── fixture-server.ts          # MCP JSON-RPC fixture server
│   ├── fixture-server.test.ts     # MCP fixture protocol tests
│   ├── mcp-trace.ts               # MCP trace helper
│   └── mcp-suite.test.ts          # MCP deterministic harness tests
├── team/
│   ├── team-schema.ts             # Team judge input type entry
│   ├── team-trace.ts              # Team trace summary helper
│   ├── team-assertions.ts         # Team event helper utilities
│   ├── team-assertions.test.ts    # Team helper tests
│   └── team-suite.test.ts         # Team deterministic harness tests
├── judge/
│   ├── judge.ts                  # LLM judge 实现
│   └── judge-suite.test.ts       # Judge 集成测试
├── replay/
│   └── replay-llm.ts             # Replay LLM client
├── runner.test.ts        # Runner 集成测试
└── README.md             # 本文档
```
