/**
 * case-schema.ts — Eval 框架的类型定义模块
 *
 * 职责：定义 EvalCase、EvalStep、EvalAssertion、EvalTrace、EvalRunResult 等核心类型。
 *
 * 设计原则：
 * - 所有类型使用 interface / type 声明，不引入运行时依赖
 * - Eval Core 不直接依赖当前项目内部模块（如 agent.ts、llm.ts）
 * - 类型尽量扁平，避免深层嵌套，便于测试和序列化
 */

// ============================================================================
// Driver 计划与模式
// ============================================================================

/** EvalCase 的运行模式 */
export type EvalCaseMode = "scripted" | "replay" | "live";

/** Driver 计划：被测 Agent 的唯一入口 */
export type EvalDriverPlan =
  | LearnClaudeCodeInProcessDriverPlan
  | LearnClaudeCodeTeamDriverPlan
  | CliDriverPlan
  | CustomDriverPlan;

/** 当前项目 in-process driver 计划 */
export interface LearnClaudeCodeInProcessDriverPlan {
  kind: "learn-claude-code-in-process";
  llm: EvalLLMPlan;
  terminal?: EvalTerminalPlan;
  tools?: EvalToolPlan;
  mcpServers?: EvalMcpServerPlan[];
  mcpClientTimeoutMs?: number;
  maxRounds?: number;
}

/** 当前项目 Agent Team driver 计划 */
export interface LearnClaudeCodeTeamDriverPlan {
  kind: "learn-claude-code-team";
  llm: EvalLLMPlan;
  terminal?: EvalTerminalPlan;
  workspace: "eval";
  agentHome: "temp";
  topology: "supervisor";
  members: EvalTeamMemberPlan[];
  maxAgents?: number;
  maxTeamSteps?: number;
  tools?: EvalToolPlan;
  mcpServers?: EvalMcpServerPlan[];
}

/** Team 成员计划：eval harness 按角色顺序启动真实 Agent。 */
export interface EvalTeamMemberPlan {
  id: string;
  role: string;
  tools: EvalTeamToolGroup[];
  maxRounds?: number;
  failAfterFirstToolCall?: boolean;
}

/** Team 成员允许使用的工具能力组。 */
export type EvalTeamToolGroup = "core" | "read" | "bash" | "todo" | "mcp";

/** CLI 黑盒 driver 计划（第二批实现） */
export interface CliDriverPlan {
  kind: "cli";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  timeoutMs?: number;
  readyPattern?: string;
}

/** 自定义 driver 计划（扩展预留） */
export interface CustomDriverPlan {
  kind: string;
  options?: Record<string, unknown>;
}

// ============================================================================
// LLM 计划
// ============================================================================

/** LLM 执行计划 */
export interface EvalLLMPlan {
  kind: "scripted" | "replay" | "live";
  scriptedResponses?: ScriptedLLMResponse[];
  replayFile?: string;
  live?: LiveLLMOptions;
}

/** Scripted LLM 的预设响应 */
export interface ScriptedLLMResponse {
  id?: string;
  content?: string | null;
  toolCalls?: ScriptedToolCall[];
  finishReason?: string;
  assistantMessage?: unknown;
}

/** Scripted 工具调用 */
export interface ScriptedToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  rawArguments?: string;
}

/** Live LLM 选项（第三批实现） */
export interface LiveLLMOptions {
  timeoutMs?: number;
  maxCalls?: number;
}

// ============================================================================
// Terminal 计划
// ============================================================================

/** Terminal 自动应答计划 */
export interface EvalTerminalPlan {
  questions?: string[];
  permissionAnswers?: boolean[];
  defaultPermissionAnswer?: boolean;
}

// ============================================================================
// Tool 计划
// ============================================================================

/** Tool 执行计划 */
export type EvalToolPlan =
  | EvalFakeToolPlan
  | EvalCoreToolPlan
  | EvalFullToolPlan;

/** Fake 工具执行计划 */
export interface EvalFakeToolPlan {
  kind: "fake";
  fakeTools?: EvalFakeTool[];
}

/** 真实核心工具执行计划 */
export interface EvalCoreToolPlan {
  kind: "core";
  core?: EvalCoreToolOptions;
}

/** 当前项目完整工具执行计划 */
export interface EvalFullToolPlan {
  kind: "full";
  full?: EvalFullToolOptions;
}

/** Fake 工具定义 */
export interface EvalFakeTool {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  result:
    | EvalToolResult
    | ((args: Record<string, unknown>) => Promise<EvalToolResult>);
}

/** Fake 工具返回结果（与当前项目 ToolResult 同构，避免直接依赖） */
export interface EvalToolResult {
  output: string;
  error: boolean;
}

/** 真实核心工具选项（第二批实现） */
export interface EvalCoreToolOptions {
  includeBash?: boolean;
  includeRead?: boolean;
  includeWrite?: boolean;
  includeEdit?: boolean;
  includeEditExact?: boolean;
  permissionMode?: "auto" | "default" | "plan";
}

/** 当前项目 full-tools eval 支持的工具组 */
export type EvalFullToolGroup =
  | "core"
  | "todo"
  | "task"
  | "memory"
  | "skill"
  | "subagent"
  | "async"
  | "schedule"
  | "output"
  | "mcp";

/** full-tools eval 的预置 memory 内容 */
export interface EvalSeedMemory {
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  body: string;
}

/** 当前项目完整工具选项 */
export interface EvalFullToolOptions {
  enabledTools?: EvalFullToolGroup[];
  agentHome?: "temp";
  seedSkills?: Record<string, string>;
  seedMemories?: Record<string, EvalSeedMemory>;
  mcpServers?: EvalMcpServerPlan[];
  mcpClientTimeoutMs?: number;
  permissionMode?: "auto" | "default" | "plan";
  startScheduleManager?: boolean;
}

// ============================================================================
// MCP Fixture 计划
// ============================================================================

/** Eval 内置 MCP fixture server 计划。 */
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

/** MCP fixture tool 定义与固定返回。 */
export interface EvalMcpFixtureTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  result:
    | { contentText: string }
    | { errorCode: number; errorMessage: string; data?: unknown };
}

/** MCP fixture resource 定义。 */
export interface EvalMcpFixtureResource {
  uri: string;
  name: string;
  mimeType?: string;
  text: string;
}

// ============================================================================
// Workspace 计划
// ============================================================================

/** Workspace 初始化计划 */
export interface EvalWorkspacePlan {
  initialFiles?: Record<string, string>;
  keepOnFailure?: boolean;
}

// ============================================================================
// EvalCase 与 EvalStep
// ============================================================================

/** 单个 Eval 用例 */
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

/** Eval 步骤 */
export interface EvalStep {
  id?: string;
  query: string;
  assertions?: EvalAssertion[];
}

/** Judge 评分标准 */
export interface EvalJudgeRubric {
  goal: string;
  passCriteria: string[];
  failCriteria: string[];
  scoring?: {
    minPassingScore: number;
    maxScore: number;
  };
}

/** Judge 计划（第三批实现） */
export interface EvalJudgePlan {
  rubric: EvalJudgeRubric;
  /**
   * 预留字段：指定 judge 使用的模型。
   * 当前实现由 runner 调用方传入 judgeLLM 参数决定模型，此字段未被读取。
   */
  model?: string;
}

/** Judge 输入 */
export interface EvalJudgeInput {
  caseId: string;
  title: string;
  description: string | undefined;
  userQueries: string[];
  finalOutputs: string[];
  runtimeEvents: AgentRuntimeEvent[];
  hardAssertionResults: EvalAssertionResult[];
  rubric: EvalJudgeRubric;
}

/** Judge 输出 */
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

/** Suite 报告 */
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

/** Trace 计划 */
export interface EvalTracePlan {
  outputDir?: string;
  enabled?: boolean;
}

// ============================================================================
// Assertions
// ============================================================================

/** 所有断言类型的联合 */
export type EvalAssertion =
  | FinalOutputContainsAssertion
  | FinalOutputMatchesAssertion
  | ExitCodeIsAssertion
  | AllStepsCompletedAssertion
  | FileExistsAssertion
  | FileNotExistsAssertion
  | FileContainsAssertion
  | WorkspaceDiffContainsAssertion
  | NoWritesOutsideWorkspaceAssertion
  | ToolCalledAssertion
  | ToolNotCalledAssertion
  | ToolCalledOneOfAssertion
  | ToolCallCountAssertion
  | ToolArgsContainAssertion
  | ToolResultContainsAssertion
  | StepToolCalledAssertion
  | StepToolNotCalledAssertion
  | NoToolErrorsAssertion
  | AllToolsSucceededAssertion
  | TranscriptEventTypesAssertion
  | PermissionPromptShownAssertion
  | McpServerStartedAssertion
  | McpServerStoppedAssertion
  | McpToolListedAssertion
  | McpToolCalledAssertion
  | McpToolResultContainsAssertion
  | McpResourceReadAssertion
  | McpErrorCodeAssertion
  | TeamAgentSpawnedAssertion
  | TeamRoleUsedAssertion
  | TeamHandoffOccurredAssertion
  | TeamAgentToolCalledAssertion
  | TeamAgentToolNotCalledAssertion
  | TeamAgentFailedAssertion
  | TeamArtifactContainsAssertion
  | TeamAllAgentsCompletedAssertion
  | TeamNoUnauthorizedWritesAssertion
  | CustomAssertion;

/** 最终输出包含指定文本 */
export interface FinalOutputContainsAssertion {
  kind: "finalOutputContains";
  text: string;
  stepId?: string;
}

/** 最终输出匹配正则表达式 */
export interface FinalOutputMatchesAssertion {
  kind: "finalOutputMatches";
  pattern: string;
  stepId?: string;
}

/** 退出码等于指定值 */
export interface ExitCodeIsAssertion {
  kind: "exitCodeIs";
  code: number;
  stepId?: string;
}

/** 所有步骤都执行完毕 */
export interface AllStepsCompletedAssertion {
  kind: "allStepsCompleted";
}

/** 文件存在 */
export interface FileExistsAssertion {
  kind: "fileExists";
  path: string;
}

/** 文件不存在 */
export interface FileNotExistsAssertion {
  kind: "fileNotExists";
  path: string;
}

/** 文件包含指定文本 */
export interface FileContainsAssertion {
  kind: "fileContains";
  path: string;
  text: string;
}

/** Workspace diff 包含指定文本（第二批实现，此处占位） */
export interface WorkspaceDiffContainsAssertion {
  kind: "workspaceDiffContains";
  path: string;
  text: string;
}

/** 没有向 workspace 外写入 */
export interface NoWritesOutsideWorkspaceAssertion {
  kind: "noWritesOutsideWorkspace";
}

/** 工具被调用过 */
export interface ToolCalledAssertion {
  kind: "toolCalled";
  toolName: string;
  minCount?: number;
}

/** 工具未被调用 */
export interface ToolNotCalledAssertion {
  kind: "toolNotCalled";
  toolName: string;
}

/** 一组工具中至少一个被调用过 */
export interface ToolCalledOneOfAssertion {
  kind: "toolCalledOneOf";
  toolNames: string[];
}

/** 工具调用次数等于指定值 */
export interface ToolCallCountAssertion {
  kind: "toolCallCount";
  toolName: string;
  count: number;
}

/** 工具调用的参数包含指定文本 */
export interface ToolArgsContainAssertion {
  kind: "toolArgsContain";
  toolName: string;
  text: string;
}

/** 工具结果包含指定文本 */
export interface ToolResultContainsAssertion {
  kind: "toolResultContains";
  toolName: string;
  text: string;
}

/** 指定 step 中工具被调用过 */
export interface StepToolCalledAssertion {
  kind: "stepToolCalled";
  stepId: string;
  toolName: string;
  minCount?: number;
}

/** 指定 step 中工具未被调用 */
export interface StepToolNotCalledAssertion {
  kind: "stepToolNotCalled";
  stepId: string;
  toolName: string;
}

/** 没有工具错误 */
export interface NoToolErrorsAssertion {
  kind: "noToolErrors";
}

/** 所有工具调用都成功 */
export interface AllToolsSucceededAssertion {
  kind: "allToolsSucceeded";
}

/** Transcript 事件类型序列匹配 */
export interface TranscriptEventTypesAssertion {
  kind: "transcriptEventTypes";
  expected: string[];
}

/** 权限确认弹窗已展示 */
export interface PermissionPromptShownAssertion {
  kind: "permissionPromptShown";
}

/** MCP server 已启动 */
export interface McpServerStartedAssertion {
  kind: "mcpServerStarted";
  serverId: string;
}

/** MCP server 已停止 */
export interface McpServerStoppedAssertion {
  kind: "mcpServerStopped";
  serverId: string;
}

/** MCP tool 已通过 tools/list 暴露 */
export interface McpToolListedAssertion {
  kind: "mcpToolListed";
  serverId: string;
  toolName: string;
}

/** MCP tool 已被调用 */
export interface McpToolCalledAssertion {
  kind: "mcpToolCalled";
  serverId: string;
  toolName: string;
}

/** MCP tool 返回内容包含指定文本 */
export interface McpToolResultContainsAssertion {
  kind: "mcpToolResultContains";
  serverId: string;
  toolName: string;
  text: string;
}

/** MCP resource 已被读取 */
export interface McpResourceReadAssertion {
  kind: "mcpResourceRead";
  serverId: string;
  uri: string;
}

/** MCP error code 已出现 */
export interface McpErrorCodeAssertion {
  kind: "mcpErrorCode";
  serverId: string;
  code: number;
}

/** Team 成员已启动 */
export interface TeamAgentSpawnedAssertion {
  kind: "teamAgentSpawned";
  agentId: string;
}

/** Team 某个角色已被使用 */
export interface TeamRoleUsedAssertion {
  kind: "teamRoleUsed";
  role: string;
}

/** Team 发生指定 handoff */
export interface TeamHandoffOccurredAssertion {
  kind: "teamHandoffOccurred";
  from: string;
  to: string;
}

/** Team 指定成员调用过某个工具 */
export interface TeamAgentToolCalledAssertion {
  kind: "teamAgentToolCalled";
  agentId: string;
  toolName: string;
}

/** Team 指定成员未调用某个工具 */
export interface TeamAgentToolNotCalledAssertion {
  kind: "teamAgentToolNotCalled";
  agentId: string;
  toolName: string;
}

/** Team 指定成员失败 */
export interface TeamAgentFailedAssertion {
  kind: "teamAgentFailed";
  agentId: string;
}

/** Team 产物包含指定文本 */
export interface TeamArtifactContainsAssertion {
  kind: "teamArtifactContains";
  path: string;
  text: string;
}

/** Team 所有成员都完成 */
export interface TeamAllAgentsCompletedAssertion {
  kind: "teamAllAgentsCompleted";
}

/** Team 未出现未授权写入 */
export interface TeamNoUnauthorizedWritesAssertion {
  kind: "teamNoUnauthorizedWrites";
  allowedRoles?: string[];
}

/** 自定义断言（通过函数实现） */
export interface CustomAssertion {
  kind: "custom";
  fn: (ctx: EvalAssertionContext) => boolean | Promise<boolean>;
  message: string;
}

/** 断言执行上下文 */
export interface EvalAssertionContext {
  caseId: string;
  stepTraces: EvalStepTrace[];
  runtimeEvents: AgentRuntimeEvent[];
  workspaceRoot: string;
}

// ============================================================================
// Runtime Events
// ============================================================================

/** 标准化运行时事件的联合类型 */
export type AgentRuntimeEvent =
  | AgentOutputEvent
  | ToolRuntimeEvent
  | LLMRuntimeEvent
  | PermissionRuntimeEvent
  | LogRuntimeEvent
  | RuntimePathEvent
  | McpRuntimeEvent
  | TeamRuntimeEvent
  | RawRuntimeEvent
  | DriverErrorEvent;

/** 事件基础字段 */
export interface BaseRuntimeEvent {
  id: string;
  timestamp: string;
  stepId?: string;
  kind: string;
  /**
   * 事件来源。
   * - "agent": 当前专用于 transcript 映射事件（in-process driver 把 TranscriptStore 事件映射为 runtime event 时使用）。
   *   CLI driver 不应将普通 agent_output 标为 "agent"，以免污染 instrumented assertions。
   * - "llm" / "tool" / "terminal": driver 内部观测事件。
   * - "driver": runner 或通用 driver 事件。
   * - "core": 预留，当前代码库中无使用。保留以兼容未来 runner 注入事件的扩展。
   */
  source: "core" | "driver" | "agent" | "tool" | "llm" | "terminal";
}

/** Agent 输出事件 */
export interface AgentOutputEvent extends BaseRuntimeEvent {
  kind: "agent_output";
  text: string;
}

/** 工具运行时事件 */
export interface ToolRuntimeEvent extends BaseRuntimeEvent {
  kind: "tool_call" | "tool_result";
  toolName: string;
  /**
   * 预留字段：OpenAI 格式的 tool_call ID，用于 tool_call/tool_result 配对。
   * 当前实现中 eval 层的事件未填充此字段（agent.ts 内部有 tool_call_id，但未透传到 eval runtime events）。
   */
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  error?: boolean;
}

/** LLM 运行时事件 */
export interface LLMRuntimeEvent extends BaseRuntimeEvent {
  kind: "llm_call" | "llm_response";
  mode?: "scripted" | "replay" | "live";
  messageCount?: number;
  toolDefinitionCount?: number;
  contentPreview?: string;
}

/** 权限运行时事件 */
export interface PermissionRuntimeEvent extends BaseRuntimeEvent {
  kind: "permission_prompt" | "permission_response";
  message?: string;
  allowed?: boolean;
}

/** 日志运行时事件 */
export interface LogRuntimeEvent extends BaseRuntimeEvent {
  kind: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/** Eval runtime 路径事件，用于 trace 中定位临时 workspace/agentHome */
export interface RuntimePathEvent extends BaseRuntimeEvent {
  kind: "runtime_path";
  source: "driver";
  label: "workspaceRoot" | "agentHome";
  path: string;
}

/** MCP fixture/client 运行时事件 */
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

/** Agent Team 运行时事件 */
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

/** 原始运行时事件（扩展预留） */
export interface RawRuntimeEvent extends BaseRuntimeEvent {
  kind: "raw";
  label: string;
  payload: unknown;
}

/** Driver 错误事件 */
export interface DriverErrorEvent extends BaseRuntimeEvent {
  kind: "driver_error";
  message: string;
  stack?: string;
}

// ============================================================================
// Trace 与 Result
// ============================================================================

/** Eval 运行状态 */
export type EvalRunStatus = "passed" | "failed" | "skipped" | "error";

/** Eval 运行结果 */
export interface EvalRunResult {
  caseId: string;
  title: string;
  status: EvalRunStatus;
  passed: boolean;
  steps: EvalStepTrace[];
  runtimeEvents: AgentRuntimeEvent[];
  assertions: EvalAssertionResult[];
  tracePath?: string;
  error?: EvalRunError;
  judge?: EvalJudgeResult;
}

/** Eval 运行错误 */
export interface EvalRunError {
  message: string;
  stack?: string;
  stepId?: string;
}

/** 步骤执行痕迹 */
export interface EvalStepTrace {
  stepId: string;
  query: string;
  startedAt: string;
  endedAt?: string;
  finalOutput?: string;
  exitCode?: number;
  error?: EvalRunError;
}

/** 断言执行结果 */
export interface EvalAssertionResult {
  kind: string;
  passed: boolean;
  message: string;
  evidence?: Record<string, unknown>;
}

/** 完整 Eval Trace（可序列化为 JSON） */
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
