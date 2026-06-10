/**
 * assertions.ts — Eval 断言执行器
 *
 * 职责：根据 EvalAssertion 定义，对 case 执行结果做结构化校验。
 *
 * 断言分类：
 * - Portable assertions：只依赖 step result、workspace 和标准事件，不依赖 driver 内部细节
 * - Instrumented assertions：需要 driver 提供 runtime events（如 tool_call 事件）
 *
 * 设计原则：
 * - 每个断言返回 EvalAssertionResult，包含 passed、message、evidence
 * - 断言失败时给出清晰的原因，方便调试
 */

import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type {
  EvalAssertion,
  EvalAssertionResult,
  EvalAssertionContext,
  AgentRuntimeEvent,
  ToolRuntimeEvent,
  McpRuntimeEvent,
  TeamRuntimeEvent,
  EvalStepTrace,
} from "./case-schema.js";

/**
 * runAssertions — 执行一组断言
 *
 * @param assertions - 断言列表
 * @param ctx - 断言执行上下文
 * @returns 每条断言的结果列表
 */
export async function runAssertions(
  assertions: EvalAssertion[],
  ctx: EvalAssertionContext,
): Promise<EvalAssertionResult[]> {
  const results: EvalAssertionResult[] = [];
  for (const assertion of assertions) {
    try {
      const result = await runSingleAssertion(assertion, ctx);
      results.push(result);
    } catch (err) {
      // 断言执行自身抛错时，记录为失败，不中断后续断言
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        kind: assertion.kind,
        passed: false,
        message: `Assertion execution error: ${message}`,
      });
    }
  }
  return results;
}

/**
 * runSingleAssertion — 执行单条断言
 */
async function runSingleAssertion(
  assertion: EvalAssertion,
  ctx: EvalAssertionContext,
): Promise<EvalAssertionResult> {
  switch (assertion.kind) {
    case "finalOutputContains":
      return runFinalOutputContains(assertion, ctx);
    case "finalOutputMatches":
      return runFinalOutputMatches(assertion, ctx);
    case "exitCodeIs":
      return runExitCodeIs(assertion, ctx);
    case "allStepsCompleted":
      return runAllStepsCompleted(assertion, ctx);
    case "fileExists":
      return await runFileExists(assertion, ctx);
    case "fileNotExists":
      return await runFileNotExists(assertion, ctx);
    case "fileContains":
      return await runFileContains(assertion, ctx);
    case "noWritesOutsideWorkspace":
      return runNoWritesOutsideWorkspace(assertion, ctx);
    case "toolCalled":
      return runToolCalled(assertion, ctx);
    case "toolNotCalled":
      return runToolNotCalled(assertion, ctx);
    case "toolCalledOneOf":
      return runToolCalledOneOf(assertion, ctx);
    case "toolCallCount":
      return runToolCallCount(assertion, ctx);
    case "toolArgsContain":
      return runToolArgsContain(assertion, ctx);
    case "toolResultContains":
      return runToolResultContains(assertion, ctx);
    case "stepToolCalled":
      return runStepToolCalled(assertion, ctx);
    case "stepToolNotCalled":
      return runStepToolNotCalled(assertion, ctx);
    case "noToolErrors":
      return runNoToolErrors(assertion, ctx);
    case "allToolsSucceeded":
      return runAllToolsSucceeded(assertion, ctx);
    case "transcriptEventTypes":
      return runTranscriptEventTypes(assertion, ctx);
    case "permissionPromptShown":
      return runPermissionPromptShown(assertion, ctx);
    case "mcpServerStarted":
      return runMcpServerStarted(assertion, ctx);
    case "mcpServerStopped":
      return runMcpServerStopped(assertion, ctx);
    case "mcpToolListed":
      return runMcpToolListed(assertion, ctx);
    case "mcpToolCalled":
      return runMcpToolCalled(assertion, ctx);
    case "mcpToolResultContains":
      return runMcpToolResultContains(assertion, ctx);
    case "mcpResourceRead":
      return runMcpResourceRead(assertion, ctx);
    case "mcpErrorCode":
      return runMcpErrorCode(assertion, ctx);
    case "teamAgentSpawned":
      return runTeamAgentSpawned(assertion, ctx);
    case "teamRoleUsed":
      return runTeamRoleUsed(assertion, ctx);
    case "teamHandoffOccurred":
      return runTeamHandoffOccurred(assertion, ctx);
    case "teamAgentToolCalled":
      return runTeamAgentToolCalled(assertion, ctx);
    case "teamAgentToolNotCalled":
      return runTeamAgentToolNotCalled(assertion, ctx);
    case "teamAgentFailed":
      return runTeamAgentFailed(assertion, ctx);
    case "teamArtifactContains":
      return await runTeamArtifactContains(assertion, ctx);
    case "teamAllAgentsCompleted":
      return runTeamAllAgentsCompleted(assertion, ctx);
    case "teamNoUnauthorizedWrites":
      return runTeamNoUnauthorizedWrites(assertion, ctx);
    case "workspaceDiffContains":
      return runWorkspaceDiffContains(assertion, ctx);
    case "custom":
      return await runCustomAssertion(assertion, ctx);
    default: {
      //  exhaustiveness check: TypeScript 会在漏掉 kind 时报错
      const _exhaustive: never = assertion;
      void _exhaustive;
      return {
        kind: (assertion as unknown as Record<string, unknown>).kind as string,
        passed: false,
        message: `Unknown assertion kind`,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Portable Assertions
// ---------------------------------------------------------------------------

function runFinalOutputContains(
  assertion: { text: string; stepId?: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const stepTrace = findStepTrace(assertion.stepId, ctx);
  const output = stepTrace?.finalOutput ?? "";
  const passed = output.includes(assertion.text);
  return {
    kind: "finalOutputContains",
    passed,
    message: passed
      ? `Final output contains "${assertion.text}"`
      : `Final output does not contain "${assertion.text}"`,
    evidence: { output: output.slice(0, 500) },
  };
}

function runFinalOutputMatches(
  assertion: { pattern: string; stepId?: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const stepTrace = findStepTrace(assertion.stepId, ctx);
  const output = stepTrace?.finalOutput ?? "";
  const regex = new RegExp(assertion.pattern);
  const passed = regex.test(output);
  return {
    kind: "finalOutputMatches",
    passed,
    message: passed
      ? `Final output matches /${assertion.pattern}/`
      : `Final output does not match /${assertion.pattern}/`,
    evidence: { output: output.slice(0, 500) },
  };
}

function runExitCodeIs(
  assertion: { code: number; stepId?: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const stepTrace = findStepTrace(assertion.stepId, ctx);
  const actual = stepTrace?.exitCode ?? 0;
  const passed = actual === assertion.code;
  return {
    kind: "exitCodeIs",
    passed,
    message: passed
      ? `Exit code is ${assertion.code}`
      : `Expected exit code ${assertion.code}, got ${actual}`,
    evidence: { actual },
  };
}

function runAllStepsCompleted(
  _assertion: unknown,
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const completed = ctx.stepTraces.every((s) => s.endedAt !== undefined);
  return {
    kind: "allStepsCompleted",
    passed: completed,
    message: completed ? "All steps completed" : "Some steps did not complete",
    evidence: { total: ctx.stepTraces.length },
  };
}

/**
 * resolveWorkspacePath — 将断言中的相对路径解析为 workspace 内的绝对路径
 *
 * 安全检查：使用 path.resolve 处理 .. 和嵌套逃逸，确保最终路径落在 workspaceRoot 内。
 * 这与 workspace.ts 的 initialFiles 路径边界保持一致。
 */
function resolveWorkspacePath(pathStr: string, workspaceRoot: string): string {
  return resolve(workspaceRoot, pathStr);
}

/**
 * isPathWithinWorkspace — 检查解析后的绝对路径是否落在 workspace 内
 *
 * 采用 startsWith(workspaceRoot + sep) 判断，避免 /workspace 前缀匹配 /workspace-evil。
 */
function isPathWithinWorkspace(
  absolutePath: string,
  workspaceRoot: string,
): boolean {
  return (
    absolutePath === workspaceRoot ||
    absolutePath.startsWith(workspaceRoot + sep)
  );
}

async function runFileExists(
  assertion: { path: string },
  ctx: EvalAssertionContext,
): Promise<EvalAssertionResult> {
  const absolutePath = resolveWorkspacePath(assertion.path, ctx.workspaceRoot);
  if (!isPathWithinWorkspace(absolutePath, ctx.workspaceRoot)) {
    return {
      kind: "fileExists",
      passed: false,
      message: `Path escapes workspace: ${assertion.path}`,
    };
  }
  try {
    await readFile(absolutePath);
    return {
      kind: "fileExists",
      passed: true,
      message: `File exists: ${assertion.path}`,
    };
  } catch {
    return {
      kind: "fileExists",
      passed: false,
      message: `File does not exist: ${assertion.path}`,
    };
  }
}

async function runFileNotExists(
  assertion: { path: string },
  ctx: EvalAssertionContext,
): Promise<EvalAssertionResult> {
  const absolutePath = resolveWorkspacePath(assertion.path, ctx.workspaceRoot);
  if (!isPathWithinWorkspace(absolutePath, ctx.workspaceRoot)) {
    return {
      kind: "fileNotExists",
      passed: false,
      message: `Path escapes workspace: ${assertion.path}`,
    };
  }
  try {
    await readFile(absolutePath);
    return {
      kind: "fileNotExists",
      passed: false,
      message: `File unexpectedly exists: ${assertion.path}`,
    };
  } catch {
    return {
      kind: "fileNotExists",
      passed: true,
      message: `File does not exist: ${assertion.path}`,
    };
  }
}

async function runFileContains(
  assertion: { path: string; text: string },
  ctx: EvalAssertionContext,
): Promise<EvalAssertionResult> {
  const absolutePath = resolveWorkspacePath(assertion.path, ctx.workspaceRoot);
  if (!isPathWithinWorkspace(absolutePath, ctx.workspaceRoot)) {
    return {
      kind: "fileContains",
      passed: false,
      message: `Path escapes workspace: ${assertion.path}`,
    };
  }
  try {
    const content = await readFile(absolutePath, "utf-8");
    const passed = content.includes(assertion.text);
    return {
      kind: "fileContains",
      passed,
      message: passed
        ? `File ${assertion.path} contains "${assertion.text}"`
        : `File ${assertion.path} does not contain "${assertion.text}"`,
      evidence: { content: content.slice(0, 500) },
    };
  } catch {
    return {
      kind: "fileContains",
      passed: false,
      message: `Cannot read file: ${assertion.path}`,
    };
  }
}

function runNoWritesOutsideWorkspace(
  _assertion: unknown,
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  // 重要前提：此断言依赖 driver 已安装 tool trace wrapper，能记录 tool_call 事件。
  // 如果黑盒 driver 不发射 tool_call 事件，此断言会错误通过（无事件 = 无写入）。
  // 使用时应确保 driver 支持 instrumented assertions。
  const toolEvents = ctx.runtimeEvents.filter(
    (e): e is ToolRuntimeEvent =>
      e.kind === "tool_call" || e.kind === "tool_result",
  );
  // 如果没有工具事件，说明没有工具被调用，自然没有外部写入
  if (toolEvents.length === 0) {
    return {
      kind: "noWritesOutsideWorkspace",
      passed: true,
      message: "No tool events observed; assuming no writes outside workspace",
    };
  }

  // 检查 run_write / run_edit / run_edit_exact 的 path 参数是否在 workspace 内
  const writeTools = new Set(["run_write", "run_edit", "run_edit_exact"]);
  const outsideWrites: string[] = [];
  for (const ev of toolEvents) {
    if (ev.kind === "tool_call" && writeTools.has(ev.toolName)) {
      const path = String(ev.args?.path ?? "");
      // 检测路径逃逸：绝对路径（Unix / Windows）、以 .. 开头、包含 /../ 片段
      // 注：此处为轻量启发式检查，完整边界由工具层的 isPathSafe 负责
      if (
        path.startsWith("/") ||
        /^[A-Za-z]:[/\\]/.test(path) ||
        path.startsWith("..") ||
        path.includes("/../")
      ) {
        outsideWrites.push(`${ev.toolName} -> ${path}`);
      }
    }
  }

  const passed = outsideWrites.length === 0;
  return {
    kind: "noWritesOutsideWorkspace",
    passed,
    message: passed
      ? "No writes detected outside workspace"
      : `Writes outside workspace detected: ${outsideWrites.join(", ")}`,
    evidence: { outsideWrites },
  };
}

// ---------------------------------------------------------------------------
// Instrumented Assertions
// ---------------------------------------------------------------------------

function runToolCalled(
  assertion: { toolName: string; minCount?: number },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const minCount = assertion.minCount ?? 1;
  const count = countToolCalls(ctx.runtimeEvents, assertion.toolName);
  const passed = count >= minCount;
  return {
    kind: "toolCalled",
    passed,
    message: passed
      ? `Tool "${assertion.toolName}" called ${count} time(s) (>= ${minCount})`
      : `Tool "${assertion.toolName}" called ${count} time(s), expected >= ${minCount}`,
    evidence: { count },
  };
}

function runToolCallCount(
  assertion: { toolName: string; count: number },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const count = countToolCalls(ctx.runtimeEvents, assertion.toolName);
  const passed = count === assertion.count;
  return {
    kind: "toolCallCount",
    passed,
    message: passed
      ? `Tool "${assertion.toolName}" called exactly ${count} time(s)`
      : `Tool "${assertion.toolName}" called ${count} time(s), expected ${assertion.count}`,
    evidence: { count, expected: assertion.count },
  };
}

function runToolNotCalled(
  assertion: { toolName: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const count = countToolCalls(ctx.runtimeEvents, assertion.toolName);
  const passed = count === 0;
  return {
    kind: "toolNotCalled",
    passed,
    message: passed
      ? `Tool "${assertion.toolName}" was not called`
      : `Tool "${assertion.toolName}" was called ${count} time(s), expected 0`,
    evidence: { count },
  };
}

function runToolCalledOneOf(
  assertion: { toolNames: string[] },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const counts = Object.fromEntries(
    assertion.toolNames.map((name) => [
      name,
      countToolCalls(ctx.runtimeEvents, name),
    ]),
  );
  const called = Object.entries(counts).filter(([, count]) => count > 0);
  const passed = called.length > 0;
  return {
    kind: "toolCalledOneOf",
    passed,
    message: passed
      ? `At least one expected tool was called: ${called.map(([name]) => name).join(", ")}`
      : `None of expected tools were called: ${assertion.toolNames.join(", ")}`,
    evidence: { counts },
  };
}

function runToolArgsContain(
  assertion: { toolName: string; text: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matchingCalls = ctx.runtimeEvents.filter(
    (e): e is ToolRuntimeEvent =>
      e.kind === "tool_call" &&
      e.toolName === assertion.toolName &&
      JSON.stringify(e.args ?? {}).includes(assertion.text),
  );
  const passed = matchingCalls.length > 0;
  return {
    kind: "toolArgsContain",
    passed,
    message: passed
      ? `Tool "${assertion.toolName}" args contain "${assertion.text}"`
      : `Tool "${assertion.toolName}" args do not contain "${assertion.text}"`,
    evidence: { matchingCalls: matchingCalls.length },
  };
}

function runToolResultContains(
  assertion: { toolName: string; text: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matchingResults = ctx.runtimeEvents.filter(
    (e): e is ToolRuntimeEvent =>
      e.kind === "tool_result" &&
      e.toolName === assertion.toolName &&
      stringifyResult(e.result).includes(assertion.text),
  );
  const passed = matchingResults.length > 0;
  return {
    kind: "toolResultContains",
    passed,
    message: passed
      ? `Tool "${assertion.toolName}" result contains "${assertion.text}"`
      : `Tool "${assertion.toolName}" result does not contain "${assertion.text}"`,
    evidence: { matchingResults: matchingResults.length },
  };
}

function runStepToolCalled(
  assertion: { stepId: string; toolName: string; minCount?: number },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const minCount = assertion.minCount ?? 1;
  const count = countStepToolCalls(
    ctx.runtimeEvents,
    assertion.stepId,
    assertion.toolName,
  );
  const passed = count >= minCount;
  return {
    kind: "stepToolCalled",
    passed,
    message: passed
      ? `Tool "${assertion.toolName}" called ${count} time(s) in step "${assertion.stepId}" (>= ${minCount})`
      : `Tool "${assertion.toolName}" called ${count} time(s) in step "${assertion.stepId}", expected >= ${minCount}`,
    evidence: { count, stepId: assertion.stepId },
  };
}

function runStepToolNotCalled(
  assertion: { stepId: string; toolName: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const count = countStepToolCalls(
    ctx.runtimeEvents,
    assertion.stepId,
    assertion.toolName,
  );
  const passed = count === 0;
  return {
    kind: "stepToolNotCalled",
    passed,
    message: passed
      ? `Tool "${assertion.toolName}" was not called in step "${assertion.stepId}"`
      : `Tool "${assertion.toolName}" was called ${count} time(s) in step "${assertion.stepId}", expected 0`,
    evidence: { count, stepId: assertion.stepId },
  };
}

function runAllToolsSucceeded(
  _assertion: unknown,
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const toolResults = ctx.runtimeEvents.filter(
    (e): e is ToolRuntimeEvent => e.kind === "tool_result",
  );
  const failed = toolResults.filter((e) => e.error === true);
  const passed = failed.length === 0;
  return {
    kind: "allToolsSucceeded",
    passed,
    message: passed
      ? "All tool calls succeeded"
      : `${failed.length} tool call(s) failed`,
    evidence: {
      totalToolResults: toolResults.length,
      failedCount: failed.length,
    },
  };
}

function runPermissionPromptShown(
  _assertion: unknown,
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const prompts = ctx.runtimeEvents.filter(
    (e) => e.kind === "permission_prompt",
  );
  const passed = prompts.length > 0;
  return {
    kind: "permissionPromptShown",
    passed,
    message: passed
      ? `Permission prompt was shown ${prompts.length} time(s)`
      : "Permission prompt was not shown",
    evidence: { promptCount: prompts.length },
  };
}

function runMcpServerStarted(
  assertion: { serverId: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findMcpEvents(ctx.runtimeEvents, "mcp_server_start").filter(
    (event) => event.serverId === assertion.serverId,
  );
  const passed = matches.length > 0;
  return {
    kind: "mcpServerStarted",
    passed,
    message: passed
      ? `MCP server "${assertion.serverId}" started`
      : `MCP server "${assertion.serverId}" did not start`,
    evidence: { count: matches.length },
  };
}

function runMcpServerStopped(
  assertion: { serverId: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findMcpEvents(ctx.runtimeEvents, "mcp_server_stop").filter(
    (event) => event.serverId === assertion.serverId,
  );
  const passed = matches.length > 0;
  return {
    kind: "mcpServerStopped",
    passed,
    message: passed
      ? `MCP server "${assertion.serverId}" stopped`
      : `MCP server "${assertion.serverId}" did not stop`,
    evidence: { count: matches.length },
  };
}

function runMcpToolListed(
  assertion: { serverId: string; toolName: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findMcpEvents(ctx.runtimeEvents, "mcp_tools_list").filter(
    (event) =>
      event.serverId === assertion.serverId &&
      event.toolName === assertion.toolName,
  );
  const passed = matches.length > 0;
  return {
    kind: "mcpToolListed",
    passed,
    message: passed
      ? `MCP tool "${assertion.toolName}" was listed by "${assertion.serverId}"`
      : `MCP tool "${assertion.toolName}" was not listed by "${assertion.serverId}"`,
    evidence: { count: matches.length },
  };
}

function runMcpToolCalled(
  assertion: { serverId: string; toolName: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findMcpEvents(ctx.runtimeEvents, "mcp_tool_call").filter(
    (event) =>
      event.serverId === assertion.serverId &&
      event.toolName === assertion.toolName,
  );
  const passed = matches.length > 0;
  return {
    kind: "mcpToolCalled",
    passed,
    message: passed
      ? `MCP tool "${assertion.toolName}" was called on "${assertion.serverId}"`
      : `MCP tool "${assertion.toolName}" was not called on "${assertion.serverId}"`,
    evidence: { count: matches.length },
  };
}

function runMcpToolResultContains(
  assertion: { serverId: string; toolName: string; text: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findMcpEvents(ctx.runtimeEvents, "mcp_tool_result").filter(
    (event) =>
      event.serverId === assertion.serverId &&
      event.toolName === assertion.toolName &&
      (event.message ?? "").includes(assertion.text),
  );
  const passed = matches.length > 0;
  return {
    kind: "mcpToolResultContains",
    passed,
    message: passed
      ? `MCP tool "${assertion.toolName}" result contains "${assertion.text}"`
      : `MCP tool "${assertion.toolName}" result does not contain "${assertion.text}"`,
    evidence: { count: matches.length },
  };
}

function runMcpResourceRead(
  assertion: { serverId: string; uri: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findMcpEvents(ctx.runtimeEvents, "mcp_resource_read").filter(
    (event) =>
      event.serverId === assertion.serverId &&
      event.resourceUri === assertion.uri,
  );
  const passed = matches.length > 0;
  return {
    kind: "mcpResourceRead",
    passed,
    message: passed
      ? `MCP resource "${assertion.uri}" was read from "${assertion.serverId}"`
      : `MCP resource "${assertion.uri}" was not read from "${assertion.serverId}"`,
    evidence: { count: matches.length },
  };
}

function runMcpErrorCode(
  assertion: { serverId: string; code: number },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findMcpEvents(ctx.runtimeEvents, "mcp_error").filter(
    (event) =>
      event.serverId === assertion.serverId &&
      event.errorCode === assertion.code,
  );
  const passed = matches.length > 0;
  return {
    kind: "mcpErrorCode",
    passed,
    message: passed
      ? `MCP error code ${assertion.code} observed on "${assertion.serverId}"`
      : `MCP error code ${assertion.code} was not observed on "${assertion.serverId}"`,
    evidence: { count: matches.length },
  };
}

function runTeamAgentSpawned(
  assertion: { agentId: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findTeamEvents(ctx.runtimeEvents, "agent_spawned").filter(
    (event) => event.agentId === assertion.agentId,
  );
  const passed = matches.length > 0;
  return {
    kind: "teamAgentSpawned",
    passed,
    message: passed
      ? `Team agent "${assertion.agentId}" spawned`
      : `Team agent "${assertion.agentId}" did not spawn`,
    evidence: { count: matches.length },
  };
}

function runTeamRoleUsed(
  assertion: { role: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findTeamEvents(ctx.runtimeEvents).filter(
    (event) => event.role === assertion.role,
  );
  const passed = matches.length > 0;
  return {
    kind: "teamRoleUsed",
    passed,
    message: passed
      ? `Team role "${assertion.role}" was used`
      : `Team role "${assertion.role}" was not used`,
    evidence: { count: matches.length },
  };
}

function runTeamHandoffOccurred(
  assertion: { from: string; to: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findTeamEvents(ctx.runtimeEvents, "handoff").filter(
    (event) =>
      event.agentId === assertion.from && event.targetAgentId === assertion.to,
  );
  const passed = matches.length > 0;
  return {
    kind: "teamHandoffOccurred",
    passed,
    message: passed
      ? `Team handoff occurred from "${assertion.from}" to "${assertion.to}"`
      : `Team handoff did not occur from "${assertion.from}" to "${assertion.to}"`,
    evidence: { count: matches.length },
  };
}

function runTeamAgentToolCalled(
  assertion: { agentId: string; toolName: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findTeamEvents(ctx.runtimeEvents, "agent_tool_call").filter(
    (event) =>
      event.agentId === assertion.agentId &&
      event.toolName === assertion.toolName,
  );
  const passed = matches.length > 0;
  return {
    kind: "teamAgentToolCalled",
    passed,
    message: passed
      ? `Team agent "${assertion.agentId}" called "${assertion.toolName}"`
      : `Team agent "${assertion.agentId}" did not call "${assertion.toolName}"`,
    evidence: { count: matches.length },
  };
}

function runTeamAgentToolNotCalled(
  assertion: { agentId: string; toolName: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findTeamEvents(ctx.runtimeEvents, "agent_tool_call").filter(
    (event) =>
      event.agentId === assertion.agentId &&
      event.toolName === assertion.toolName,
  );
  const passed = matches.length === 0;
  return {
    kind: "teamAgentToolNotCalled",
    passed,
    message: passed
      ? `Team agent "${assertion.agentId}" did not call "${assertion.toolName}"`
      : `Team agent "${assertion.agentId}" called "${assertion.toolName}" ${matches.length} time(s)`,
    evidence: { count: matches.length },
  };
}

function runTeamAgentFailed(
  assertion: { agentId: string },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const matches = findTeamEvents(ctx.runtimeEvents, "agent_failed").filter(
    (event) => event.agentId === assertion.agentId,
  );
  const passed = matches.length > 0;
  return {
    kind: "teamAgentFailed",
    passed,
    message: passed
      ? `Team agent "${assertion.agentId}" failed`
      : `Team agent "${assertion.agentId}" did not fail`,
    evidence: { count: matches.length },
  };
}

async function runTeamArtifactContains(
  assertion: { path: string; text: string },
  ctx: EvalAssertionContext,
): Promise<EvalAssertionResult> {
  const artifactEvents = findTeamEvents(
    ctx.runtimeEvents,
    "artifact_produced",
  ).filter((event) => event.artifactPath === assertion.path);
  const fileResult = await runFileContains(assertion, ctx);
  const passed = artifactEvents.length > 0 && fileResult.passed;
  return {
    ...fileResult,
    kind: "teamArtifactContains",
    passed,
    message: passed
      ? `Team artifact ${assertion.path} was produced and contains "${assertion.text}"`
      : `Team artifact ${assertion.path} missing artifact event or does not contain "${assertion.text}"`,
    evidence: {
      artifactEvents: artifactEvents.length,
      fileEvidence: fileResult.evidence,
    },
  };
}

function runTeamAllAgentsCompleted(
  _assertion: unknown,
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const spawned = findTeamEvents(ctx.runtimeEvents, "agent_spawned")
    .map((event) => event.agentId)
    .filter((agentId): agentId is string => agentId !== undefined);
  const completed = new Set(
    findTeamEvents(ctx.runtimeEvents, "agent_completed")
      .map((event) => event.agentId)
      .filter((agentId): agentId is string => agentId !== undefined),
  );
  const failed = findTeamEvents(ctx.runtimeEvents, "agent_failed")
    .map((event) => event.agentId)
    .filter((agentId): agentId is string => agentId !== undefined);
  const missing = spawned.filter((agentId) => !completed.has(agentId));
  const passed =
    spawned.length > 0 && missing.length === 0 && failed.length === 0;
  return {
    kind: "teamAllAgentsCompleted",
    passed,
    message: passed
      ? "All team agents completed"
      : `Team completion mismatch. Missing: ${missing.join(", ") || "none"}; failed: ${failed.join(", ") || "none"}`,
    evidence: { spawned, missing, failed },
  };
}

function runTeamNoUnauthorizedWrites(
  assertion: { allowedRoles?: string[] },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const writeTools = new Set(["run_write", "run_edit", "run_edit_exact"]);
  const allowedRoles = new Set(assertion.allowedRoles ?? ["implementer"]);
  const unauthorized = findTeamEvents(ctx.runtimeEvents, "agent_tool_call")
    .filter((event) => writeTools.has(event.toolName ?? ""))
    .filter((event) => !allowedRoles.has(event.role ?? ""))
    .map((event) => ({
      agentId: event.agentId,
      role: event.role,
      toolName: event.toolName,
    }));
  const passed = unauthorized.length === 0;
  return {
    kind: "teamNoUnauthorizedWrites",
    passed,
    message: passed
      ? "No unauthorized team writes detected"
      : `Unauthorized team writes detected: ${unauthorized
          .map((event) => `${event.agentId ?? "unknown"}:${event.toolName}`)
          .join(", ")}`,
    evidence: { unauthorized },
  };
}

function runNoToolErrors(
  _assertion: unknown,
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const errorEvents = ctx.runtimeEvents.filter(
    (e): e is ToolRuntimeEvent =>
      (e.kind === "tool_call" || e.kind === "tool_result") && e.error === true,
  );
  const passed = errorEvents.length === 0;
  return {
    kind: "noToolErrors",
    passed,
    message: passed
      ? "No tool errors detected"
      : `${errorEvents.length} tool error(s) detected`,
    evidence: { errorCount: errorEvents.length },
  };
}

function runTranscriptEventTypes(
  assertion: { expected: string[] },
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  // transcriptEventTypes 断言：比较 source="agent" 的事件 kind 序列。
  // 约定：in-process driver 的 readEvents() 把 TranscriptStore 事件映射为 AgentRuntimeEvent 时，
  // 统一设置 source="agent"，从而与 source="llm"/"tool" 等 driver 内部事件区分。
  // 该约定已在 case-schema.ts 的 BaseRuntimeEvent.source JSDoc 中显式声明。
  const actual = ctx.runtimeEvents
    .filter((e) => e.source === "agent")
    .map((e) => e.kind);
  const expected = assertion.expected;
  const passed =
    actual.length === expected.length &&
    actual.every((v, i) => v === expected[i]);
  return {
    kind: "transcriptEventTypes",
    passed,
    message: passed
      ? `Event types match expected sequence`
      : `Event types mismatch. Expected [${expected.join(", ")}], got [${actual.join(", ")}]`,
    evidence: { actual, expected },
  };
}

function runWorkspaceDiffContains(
  assertion: { path: string; text: string },
  _ctx: EvalAssertionContext,
): EvalAssertionResult {
  // validateEvalCase 已在 batch 1 拒绝此 kind，此处 throw 作为最后一道防线
  throw new Error(
    `workspaceDiffContains not implemented in batch 1 (path: ${assertion.path})`,
  );
}

async function runCustomAssertion(
  assertion: {
    fn: (ctx: EvalAssertionContext) => boolean | Promise<boolean>;
    message: string;
  },
  ctx: EvalAssertionContext,
): Promise<EvalAssertionResult> {
  const passed = await assertion.fn(ctx);
  return {
    kind: "custom",
    passed,
    message: assertion.message,
  };
}

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/**
 * findStepTrace — 根据 stepId 查找对应的步骤痕迹
 *
 * 如果 stepId 未指定，返回最后一步；否则按 stepId 精确匹配。
 */
function findStepTrace(
  stepId: string | undefined,
  ctx: EvalAssertionContext,
): EvalStepTrace | undefined {
  if (stepId === undefined) {
    return ctx.stepTraces.at(-1);
  }
  return ctx.stepTraces.find((s) => s.stepId === stepId);
}

/**
 * countToolCalls — 统计 runtimeEvents 中指定工具的 tool_call 次数
 */
function countToolCalls(events: AgentRuntimeEvent[], toolName: string): number {
  return events.filter(
    (e): e is ToolRuntimeEvent =>
      e.kind === "tool_call" && e.toolName === toolName,
  ).length;
}

/**
 * countStepToolCalls — 统计指定 step 内的工具调用次数。
 *
 * 这个断言依赖 driver 在 tool_call 事件上填充 stepId。
 * 若旧 driver 没有 stepId，该断言会自然失败，提醒 case 作者不要误以为
 * 已经验证了“某一步没有写入”。
 */
function countStepToolCalls(
  events: AgentRuntimeEvent[],
  stepId: string,
  toolName: string,
): number {
  return events.filter(
    (e): e is ToolRuntimeEvent =>
      e.kind === "tool_call" && e.stepId === stepId && e.toolName === toolName,
  ).length;
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") {
    return result;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
}

function findMcpEvents(
  events: AgentRuntimeEvent[],
  kind?: McpRuntimeEvent["kind"],
): McpRuntimeEvent[] {
  return events.filter(
    (event): event is McpRuntimeEvent =>
      event.kind.startsWith("mcp_") &&
      (kind === undefined || event.kind === kind),
  );
}

function findTeamEvents(
  events: AgentRuntimeEvent[],
  kind?: TeamRuntimeEvent["kind"],
): TeamRuntimeEvent[] {
  const teamKinds = new Set<TeamRuntimeEvent["kind"]>([
    "team_start",
    "agent_spawned",
    "agent_message",
    "agent_tool_call",
    "handoff",
    "artifact_produced",
    "agent_completed",
    "agent_failed",
    "team_completed",
  ]);
  return events.filter(
    (event): event is TeamRuntimeEvent =>
      teamKinds.has(event.kind as TeamRuntimeEvent["kind"]) &&
      (kind === undefined || event.kind === kind),
  );
}
