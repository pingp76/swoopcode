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

| 字段 | 说明 |
|------|------|
| `id` | 唯一标识，只允许 `[a-z0-9._-]` |
| `driver` | Driver 计划：in-process 或 CLI |
| `steps` | 用户输入序列，每个 step 可独立断言 |
| `workspace` | 可选的临时 workspace 配置（`initialFiles`、`keepOnFailure`） |
| `assertions` | case 级断言，所有 step 完成后执行 |
| `trace` | 可选的 trace 配置（`enabled`、`outputDir`） |

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
- `tools.kind = "fake"`：使用自定义 fake 工具，无副作用，适合测试 runner 本身

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

| Assertion | 说明 |
|-----------|------|
| `finalOutputContains` | 最终输出包含指定文本 |
| `finalOutputMatches` | 最终输出匹配正则表达式 |
| `exitCodeIs` | 退出码等于指定值（CLI driver 用） |
| `allStepsCompleted` | 所有步骤都执行完毕 |
| `fileExists` | 文件存在 |
| `fileContains` | 文件包含指定文本 |
| `noWritesOutsideWorkspace` | 没有向 workspace 外写入 |

#### Instrumented Assertions（需要 driver 提供 runtime events）

| Assertion | 说明 |
|-----------|------|
| `toolCalled` | 指定工具被调用过（可设 `minCount`） |
| `toolNotCalled` | 指定工具未被调用 |
| `toolCallCount` | 指定工具调用次数等于指定值 |
| `toolArgsContain` | 指定工具的参数包含指定文本 |
| `noToolErrors` | 没有工具错误（tool_call/tool_result 中 error） |
| `allToolsSucceeded` | 所有 tool_result 的 error 不为 true |
| `transcriptEventTypes` | transcript 事件类型序列匹配 |
| `permissionPromptShown` | 权限确认弹窗已展示 |
| `custom` | 自定义断言函数 |

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

## 当前限制

以下功能计划在后续批次实现：

- **真实 LLM 测试**：当前所有 case 使用 scripted LLM；live 模式需要 `EVAL_LIVE=1`
- **Replay 模式**：从已有对话记录回放
- **Judge 评估**：自动评分系统（第三批）
- **`workspaceDiffContains`**：workspace diff 断言
- **复杂 CLI 交互**：REPL 类 CLI 的 readyPattern / prompt 匹配

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
│   │   ├── in-process-driver.ts  # 当前项目 driver
│   │   ├── core-tool-runtime.ts  # 真实核心工具注册表
│   │   ├── scripted-llm.ts       # Scripted LLM
│   │   ├── scripted-terminal.ts  # Scripted Terminal
│   │   └── tool-trace.ts         # 工具追踪包装器
│   └── cli/
│       └── cli-driver.ts         # CLI 黑盒 driver
├── cases/
│   └── deterministic.test.ts     # Deterministic suite
├── runner.test.ts        # Runner 集成测试
└── README.md             # 本文档
```
