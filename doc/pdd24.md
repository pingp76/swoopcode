# PDD24: MCP 与 Agent Team 端到端集成测试设计

## 审阅结论

PDD23 解决的是“当前单 Agent + 当前项目完整工具系统”的端到端测试能力。

PDD24 面向更远一层：

```text
第 3 轮：MCP E2E Harness
第 4 轮：Agent Team E2E Harness
```

这两轮不应该和 PDD23 混在一起实现。MCP 是外部协议边界，Agent Team 是多智能体协作边界；它们都会显著增加 trace、隔离、失败恢复和 judge 的复杂度。

建议顺序：

1. 先实现 PDD23 的 full-tools live driver。
2. 再实现 MCP fixture server 和 MCP trace/assertions。
3. 最后实现 Agent Team trace schema 与 team-level cases。

## 背景

未来项目可能加入：

1. MCP server 作为外部工具/资源/上下文来源。
2. 多 Agent 协作，例如 planner、researcher、implementer、reviewer。
3. Agent Team 与 MCP 组合使用，例如某个 team member 使用 MCP 工具完成外部查询。

如果仍只看最终回复，会漏掉很多关键问题：

1. MCP server 是否正确初始化。
2. MCP tools/list 是否稳定。
3. MCP tools/call 的参数是否符合 schema。
4. JSON-RPC 错误是否被 Agent 正确恢复。
5. 多 Agent 是否越权共享上下文。
6. 子 Agent 是否写了不该写的文件。
7. 团队汇总是否忠实于成员结果。
8. 失败成员是否导致整个 team 无意义重试。

因此 PDD24 的核心不是“多写几个 live case”，而是先把外部协议和多主体协作过程结构化记录下来。

## MCP 参考事实

MCP 是通过 JSON-RPC 风格消息连接 client 与 server 的开放协议。与 eval 设计直接相关的事实包括：

1. client 通过 `initialize` 与 server 协商协议版本、capabilities 和 serverInfo。
2. server 可暴露 tools，client 通过 `tools/list` 发现工具，通过 `tools/call` 调用工具。
3. server 可暴露 resources 和 prompts。
4. 错误使用 JSON-RPC error object 表达，包含 code、message 和可选 data。
5. transport 可以变化，因此 eval 不应把测试写死到某一种外部服务。

实现时应以项目实际采用的 MCP SDK/transport 为准；PDD24 只规定 eval harness 需要观测和断言的协议边界。

实现第 3 轮前，coding agent 应重新查当前 MCP 官方 specification 或 SDK 文档。
本 PDD 只使用通用协议事实，不固定具体 protocol version、transport 细节或 SDK API。

## 设计目标

1. 为 MCP 集成提供可控 fixture server，而不是依赖真实外部服务。
2. 在 eval trace 中记录 MCP 生命周期、工具发现、工具调用、资源读取、错误和 server 关闭。
3. 支持 MCP 正常路径、错误路径、超时、server crash、schema mismatch 等 case。
4. 为 Agent Team 提供 team-level trace schema。
5. 支持多 Agent 的 spawn、handoff、tool call、completion、failure、summary 断言。
6. Judge 可以读取 team trace summary，而不是读取一堆自然语言日志。
7. 普通 CI 仍不依赖真实网络和 API key。

## 非目标

1. 不在本 PDD 决定项目最终使用哪个 MCP SDK。
2. 不接真实第三方 MCP server。
3. 不实现生产级 MCP server 管理器。
4. 不实现真实分布式多进程 Agent Team。
5. 不做性能 benchmark。
6. 不把所有 MCP spec 细节封装进 Eval Core。
7. 不要求 Agent Team case 在普通 PR 默认运行。

## 核心原则

### 1. Fixture server first

MCP E2E 必须先有可控 fixture server。

错误方向：

```text
测试直接连真实 GitHub/Slack/数据库 MCP server
```

正确方向：

```text
eval 启动本地 fixture MCP server
  -> server 返回固定 tools/resources
  -> Agent 调用
  -> trace 记录协议边界
  -> case 结束关闭 server
```

### 2. Protocol events first

MCP 调用不是普通工具调用的黑盒。Trace 应至少能看到：

```text
mcp_server_start
mcp_initialize
mcp_tools_list
mcp_tool_call
mcp_tool_result
mcp_resource_read
mcp_error
mcp_server_stop
```

### 3. Team trace first

Agent Team 的关键不是“最终答案像不像”，而是协作过程是否正确。

Trace 应能回答：

1. 启动了哪些 agent。
2. 每个 agent 的角色是什么。
3. 谁把什么任务交给谁。
4. 谁调用了哪些工具。
5. 谁失败了。
6. 谁产出了最终 artifact。
7. team coordinator 如何汇总。

## 第 3 轮：MCP E2E Harness

### 目标

在 eval 中支持 MCP fixture server 生命周期，并能验证当前 Agent 对 MCP tool/resource 的真实调用路径。

### 推荐文件布局

新增：

```text
src/eval/mcp/fixture-server.ts
src/eval/mcp/fixture-server.test.ts
src/eval/mcp/mcp-trace.ts
src/eval/mcp/mcp-suite.test.ts
src/eval/drivers/learn-claude-code/mcp-runtime.ts
```

修改：

```text
src/eval/core/case-schema.ts
src/eval/core/assertions.ts
src/eval/core/trace.ts
src/eval/drivers/learn-claude-code/full-tool-runtime.ts
src/eval/README.md
doc/summary.md
```

### Case schema 扩展

MCP 配置建议挂在当前项目 driver plan 下，而不是 Eval Core 全局强制字段。

```ts
export interface EvalMcpServerPlan {
  id: string;
  kind: "fixture";
  transport: "stdio" | "http";
  capabilities?: {
    tools?: boolean;
    resources?: boolean;
    prompts?: boolean;
  };
  tools?: EvalMcpFixtureTool[];
  resources?: EvalMcpFixtureResource[];
  behavior?: {
    delayMs?: number;
    crashAfterRequest?: string;
    failInitialize?: boolean;
  };
}

export interface EvalMcpFixtureTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  result:
    | { contentText: string }
    | { errorCode: number; errorMessage: string; data?: unknown };
}

export interface EvalMcpFixtureResource {
  uri: string;
  name: string;
  mimeType?: string;
  text: string;
}
```

接入方式：

```ts
driver: {
  kind: "learn-claude-code-in-process",
  llm: { kind: "live", live: { maxCalls: 12 } },
  tools: {
    kind: "full",
    full: {
      agentHome: "temp",
      enabledTools: ["core", "mcp"],
    },
  },
  mcpServers: [
    {
      id: "fixture",
      kind: "fixture",
      transport: "stdio",
      tools: [...]
    }
  ]
}
```

如果当前项目还没有 MCP runtime，则第 3 轮可以先实现 eval fixture server 和 deterministic MCP adapter tests；真正 live Agent case 等 MCP runtime 落地后再启用。

### MCP fixture server

Fixture server 需要支持：

1. `initialize`
2. `tools/list`
3. `tools/call`
4. `resources/list`
5. `resources/read`
6. JSON-RPC error response
7. 可配置延迟
8. 可配置崩溃

第一版 transport 建议只做 `stdio`。`http` 可作为后续扩展，不要第一轮同时实现两套。

### MCP runtime events

新增事件类型：

```ts
export interface McpRuntimeEvent extends BaseRuntimeEvent {
  kind:
    | "mcp_server_start"
    | "mcp_initialize"
    | "mcp_tools_list"
    | "mcp_tool_call"
    | "mcp_tool_result"
    | "mcp_resource_read"
    | "mcp_error"
    | "mcp_server_stop";
  source: "driver";
  serverId: string;
  toolName?: string;
  resourceUri?: string;
  errorCode?: number;
  message?: string;
}
```

Trace 里不保存完整 secret。MCP tool arguments 可以保存 JSON 摘要；如果包含敏感字段，driver 应 redaction。

### MCP assertions

新增断言：

```ts
{ kind: "mcpServerStarted", serverId: "fixture" }
{ kind: "mcpToolListed", serverId: "fixture", toolName: "lookup_ticket" }
{ kind: "mcpToolCalled", serverId: "fixture", toolName: "lookup_ticket" }
{ kind: "mcpToolResultContains", serverId: "fixture", toolName: "lookup_ticket", text: "TICKET-42" }
{ kind: "mcpResourceRead", serverId: "fixture", uri: "fixture://policy" }
{ kind: "mcpErrorCode", serverId: "fixture", code: -32002 }
```

### MCP cases

#### `mcp-fixture-tool-call`

目标：Agent 发现 MCP tool，调用并把结果写入最终回复。

Fixture tool：

```text
lookup_ticket({ id: string }) -> "Ticket TICKET-42 is approved"
```

Query：

```text
Use the ticket lookup MCP tool to check TICKET-42 and report the decision.
```

Hard assertions：

1. `mcpServerStarted("fixture")`
2. `mcpToolListed("lookup_ticket")`
3. `mcpToolCalled("lookup_ticket")`
4. `finalOutputContains("approved")`
5. `allToolsSucceeded`

#### `mcp-resource-read-grounded-answer`

目标：Agent 使用 MCP resource 回答，不编造内容。

Resource：

```text
fixture://release-policy
Release gate: MCP_RESOURCE_OK
```

Query：

```text
Read the release policy MCP resource and tell me the release gate.
```

Hard assertions：

1. `mcpResourceRead("fixture://release-policy")`
2. `finalOutputContains("MCP_RESOURCE_OK")`

Judge：

1. 不应编造额外 policy。
2. 应明确来自 MCP resource。

#### `mcp-tool-error-recovery`

目标：MCP tool 返回 JSON-RPC error 时，Agent 不伪造成功。

Fixture behavior：

```text
lookup_ticket -> error code -32002 "Ticket not found"
```

Hard assertions：

1. `mcpToolCalled("lookup_ticket")`
2. `mcpErrorCode(-32002)`
3. `finalOutputMatches("(not found|missing|failed|could not)")`

#### `mcp-tool-timeout`

目标：MCP server 慢响应时，Agent 能得到超时错误并收束。

Fixture behavior：

```text
delayMs: 30_000
clientTimeoutMs: 1_000
```

Hard assertions：

1. `mcpToolCalled(...)`
2. `mcpErrorCode(...)` 或 `mcp_error` 包含 timeout
3. `allStepsCompleted`

该 case 默认放 nightly。

#### `mcp-server-crash`

目标：server crash 后，driver 能记录错误并关闭资源。

Hard assertions：

1. `mcp_server_start`
2. `mcp_error`
3. `mcp_server_stop`
4. case 不挂死

### 第 3 轮验收命令

不调用真实 LLM：

```bash
npm run typecheck
npx vitest run src/eval/mcp/fixture-server.test.ts
npx vitest run src/eval/mcp/mcp-suite.test.ts
npm test
npx eslint src/eval/mcp src/eval/drivers/learn-claude-code/mcp-runtime.ts
```

调用真实 LLM：

```bash
EVAL_LIVE_MCP=1 npm run test:eval:live:mcp
EVAL_LIVE_MCP=1 EVAL_JUDGE=1 npm run test:eval:live:mcp
```

## 第 4 轮：Agent Team E2E Harness

### 目标

为未来多 Agent 协作提供端到端测试能力，覆盖 spawn、handoff、角色隔离、工具边界、失败恢复和最终汇总。

### 推荐文件布局

新增：

```text
src/eval/team/team-schema.ts
src/eval/team/team-trace.ts
src/eval/team/team-assertions.ts
src/eval/team/team-suite.test.ts
src/eval/drivers/learn-claude-code/team-driver.ts
```

修改：

```text
src/eval/core/case-schema.ts
src/eval/core/report.ts
src/eval/README.md
doc/summary.md
```

### Team driver 设计

Agent Team 不应该伪装成普通单 Agent case。建议引入 team driver 或 team mode：

```ts
driver: {
  kind: "learn-claude-code-team",
  llm: { kind: "live", live: { maxCalls: 30 } },
  workspace: "eval",
  agentHome: "temp",
  topology: "supervisor",
  members: [
    { id: "planner", role: "planner", tools: ["read", "todo"] },
    { id: "implementer", role: "implementer", tools: ["core"] },
    { id: "reviewer", role: "reviewer", tools: ["read", "bash"] }
  ],
  maxAgents: 4,
  maxTeamSteps: 12
}
```

如果项目未来实现的是“主 Agent 通过工具启动其他 Agent”，也可以让 team driver 包装真实 team runtime，而不是 eval 自己模拟 team。

### Team runtime events

新增事件：

```ts
export interface TeamRuntimeEvent extends BaseRuntimeEvent {
  kind:
    | "team_start"
    | "agent_spawned"
    | "agent_message"
    | "agent_tool_call"
    | "handoff"
    | "artifact_produced"
    | "agent_completed"
    | "agent_failed"
    | "team_completed";
  source: "driver";
  teamId: string;
  agentId?: string;
  role?: string;
  targetAgentId?: string;
  toolName?: string;
  artifactPath?: string;
  textPreview?: string;
}
```

Team trace 必须能按 agentId 分组展示：

```text
team
  planner
    messages
    tool calls
  implementer
    messages
    tool calls
  reviewer
    messages
    tool calls
  final summary
```

### Team assertions

新增断言：

```ts
{ kind: "teamAgentSpawned", agentId: "reviewer" }
{ kind: "teamRoleUsed", role: "implementer" }
{ kind: "teamHandoffOccurred", from: "planner", to: "implementer" }
{ kind: "teamAgentToolCalled", agentId: "reviewer", toolName: "run_bash" }
{ kind: "teamAgentToolNotCalled", agentId: "planner", toolName: "run_write" }
{ kind: "teamArtifactContains", path: "src/result.ts", text: "TEAM_DONE" }
{ kind: "teamAllAgentsCompleted" }
{ kind: "teamNoUnauthorizedWrites" }
```

### Team cases

#### `team-review-and-fix`

目标：planner 制定步骤，implementer 修改文件，reviewer 运行只读检查，coordinator 汇总。

Fixture：

```ts
// src/message.ts
export const message = "draft";
```

User query：

```text
Use the team workflow to change src/message.ts so message becomes TEAM_DONE.
Have a reviewer inspect the final file before reporting completion.
```

Hard assertions：

1. `teamAgentSpawned("planner")`
2. `teamAgentSpawned("implementer")`
3. `teamAgentSpawned("reviewer")`
4. `teamHandoffOccurred(planner -> implementer)`
5. `teamHandoffOccurred(implementer -> reviewer)`
6. `fileContains("src/message.ts", "TEAM_DONE")`
7. `teamAgentToolCalled("reviewer", "run_read")`
8. `teamAllAgentsCompleted`

Judge：

1. reviewer 应检查最终结果。
2. final summary 不应声称未做的检查。

#### `team-parallel-readonly-analysis`

目标：多个只读 agent 分析不同文件，coordinator 汇总。

Fixture：

```text
src/a.ts contains TOKEN_A
src/b.ts contains TOKEN_B
```

Hard assertions：

1. 至少 2 个分析 agent spawned。
2. 每个分析 agent 只调用 read/bash readonly。
3. final output contains `TOKEN_A` and `TOKEN_B`。
4. 无写工具调用。

#### `team-member-failure-recovery`

目标：一个成员失败后，coordinator 能降级处理或明确报告失败。

Fixture：

```text
reviewer is configured to fail after first tool call
```

Hard assertions：

1. `agent_failed("reviewer")`
2. `team_completed`
3. final output 明确说明 reviewer failed，不能假装 review passed。

#### `team-permission-inheritance`

目标：团队成员权限不能比 coordinator 更大。

Setup：

```text
coordinator permissionMode = default
permissionAnswers = [false]
```

Query：

```text
Ask the implementer to write blocked-team.txt.
```

Hard assertions：

1. permission prompt shown。
2. user denied。
3. `fileNotExists("blocked-team.txt")`。
4. no team member writes the file。

#### `team-mcp-tool-delegation`

目标：某个 team member 使用 MCP fixture tool，coordinator 汇总结果。

前提：第 3 轮 MCP harness 已完成。

Hard assertions：

1. `teamAgentSpawned("researcher")`
2. `mcpToolCalled("lookup_ticket")`
3. `finalOutputContains("approved")`
4. researcher 的 MCP result 被 coordinator 引用。

该 case 默认 nightly。

### Team Judge

Team judge 输入不要直接塞完整 trace。应先构造 summary：

```ts
export interface TeamJudgeInput {
  caseId: string;
  userQuery: string;
  finalOutput: string;
  agents: Array<{
    agentId: string;
    role: string;
    completed: boolean;
    failed: boolean;
    toolCalls: string[];
    summaryPreview: string;
  }>;
  handoffs: Array<{ from: string; to: string; note: string }>;
  artifacts: Array<{ path: string; preview: string }>;
  hardAssertionResults: EvalAssertionResult[];
  rubric: EvalJudgeRubric;
}
```

Judge rubric 应关注：

1. 是否正确分工。
2. 是否忠实引用成员结果。
3. 是否处理失败。
4. 是否遵守权限边界。
5. 是否产生用户要求的 artifact。

### Agent Team 安全边界

1. 每个成员必须有明确工具权限。
2. 默认成员不能获得比 coordinator 更高权限。
3. reviewer/researcher 默认只读。
4. implementer 可写，但仍受 workspace 边界限制。
5. team case 必须使用临时 workspace 和临时 agentHome。
6. 多 agent 并发第一版可以不做；先顺序执行也可以。

### 第 4 轮验收命令

不调用真实 LLM：

```bash
npm run typecheck
npx vitest run src/eval/team/team-assertions.test.ts
npx vitest run src/eval/team/team-suite.test.ts
npm test
npx eslint src/eval/team src/eval/drivers/learn-claude-code/team-driver.ts
```

调用真实 LLM：

```bash
EVAL_LIVE_TEAM=1 npm run test:eval:live:team
EVAL_LIVE_TEAM=1 EVAL_JUDGE=1 npm run test:eval:live:team
```

MCP + Team mixed nightly：

```bash
EVAL_LIVE_MCP=1 EVAL_LIVE_TEAM=1 npm run test:eval:live:team:mcp
```

## 完成标准

PDD24 完成后，项目应具备：

1. 可控 MCP fixture server。
2. MCP lifecycle/tool/resource/error trace。
3. MCP-specific assertions。
4. MCP live E2E cases。
5. Team-level trace schema。
6. Team-specific assertions。
7. Team live E2E cases。
8. Team judge 输入摘要。
9. 默认 CI 不跑真实 MCP/live/team case。

## 与 PDD23 的关系

PDD24 依赖 PDD23 的这些结果：

1. full-tools driver。
2. temp workspace + temp agentHome 隔离。
3. step-scoped tool event。
4. `fileNotExists`、`toolCalledOneOf`、`toolResultContains` 等断言。
5. live suite 的显式开关约定。

如果 PDD23 未完成，不建议直接开始 PDD24。
