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
    case "fileContains":
      return await runFileContains(assertion, ctx);
    case "noWritesOutsideWorkspace":
      return runNoWritesOutsideWorkspace(assertion, ctx);
    case "toolCalled":
      return runToolCalled(assertion, ctx);
    case "toolNotCalled":
      return runToolNotCalled(assertion, ctx);
    case "toolCallCount":
      return runToolCallCount(assertion, ctx);
    case "toolArgsContain":
      return runToolArgsContain(assertion, ctx);
    case "noToolErrors":
      return runNoToolErrors(assertion, ctx);
    case "allToolsSucceeded":
      return runAllToolsSucceeded(assertion, ctx);
    case "transcriptEventTypes":
      return runTranscriptEventTypes(assertion, ctx);
    case "permissionPromptShown":
      return runPermissionPromptShown(assertion, ctx);
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

function runAllStepsCompleted(_assertion: unknown, ctx: EvalAssertionContext): EvalAssertionResult {
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
function isPathWithinWorkspace(absolutePath: string, workspaceRoot: string): boolean {
  return absolutePath === workspaceRoot || absolutePath.startsWith(workspaceRoot + sep);
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
    (e): e is ToolRuntimeEvent => e.kind === "tool_call" || e.kind === "tool_result",
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
    evidence: { totalToolResults: toolResults.length, failedCount: failed.length },
  };
}

function runPermissionPromptShown(
  _assertion: unknown,
  ctx: EvalAssertionContext,
): EvalAssertionResult {
  const prompts = ctx.runtimeEvents.filter((e) => e.kind === "permission_prompt");
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

function runNoToolErrors(_assertion: unknown, ctx: EvalAssertionContext): EvalAssertionResult {
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
    actual.length === expected.length && actual.every((v, i) => v === expected[i]);
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
  assertion: { fn: (ctx: EvalAssertionContext) => boolean | Promise<boolean>; message: string },
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
function findStepTrace(stepId: string | undefined, ctx: EvalAssertionContext): EvalStepTrace | undefined {
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
    (e): e is ToolRuntimeEvent => e.kind === "tool_call" && e.toolName === toolName,
  ).length;
}
