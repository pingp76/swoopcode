/**
 * runner.ts — Eval Case 核心运行器
 *
 * 职责：编排单个 eval case 的完整生命周期。
 *
 * 生命周期：
 * 1. validateEvalCase(case)
 * 2. createTraceRecorder(case)
 * 3. create workspace
 * 4. write initialFiles
 * 5. create driver from case.driver
 * 6. driver.startCase({ caseId, workspaceRoot })
 * 7. for each step: driver.send({ stepId, query })
 * 8. collect driver.readEvents()
 * 9. run assertions
 * 10. optionally write trace
 * 11. driver.close()
 * 12. cleanup workspace unless keepOnFailure
 * 13. return EvalRunResult
 *
 * 设计原则：
 * - runner 不直接使用 Vitest 的 expect()，返回结构化结果
 * - 断言失败不抛异常，而是记录到 result 中
 * - 同一 case 内多个 step 复用同一个 driver 实例
 */

import type {
  EvalCase,
  EvalRunResult,
  EvalRunStatus,
  EvalCaseMode,
  EvalAssertionResult,
  EvalRunError,
  AgentRuntimeEvent,
} from "./case-schema.js";
import type { CodingAgentDriver } from "./driver.js";
import { createEvalWorkspace } from "./workspace.js";
import { createTraceRecorder } from "./trace.js";
import { runAssertions } from "./assertions.js";
import { writeEvalTrace } from "./trace-writer.js";

/**
 * runEvalCase — 执行单个 eval case
 *
 * @param evalCase - 要执行的 case
 * @param createDriver - driver 工厂函数，根据 driver plan 创建具体 driver 实例
 * @returns 结构化执行结果
 */
export async function runEvalCase(
  evalCase: EvalCase,
  createDriver: (plan: EvalCase["driver"]) => Promise<CodingAgentDriver>,
): Promise<EvalRunResult> {
  // 1. 校验 case 结构合法性
  validateEvalCase(evalCase);

  // 2. 创建 trace 记录器
  const traceRecorder = createTraceRecorder();

  // 3. 创建临时 workspace
  const workspace = await createEvalWorkspace(evalCase.workspace);

  // 用于收集所有运行时事件（包括 driver 返回的和 traceRecorder 收集的）
  const allRuntimeEvents: AgentRuntimeEvent[] = [];
  let runError: EvalRunError | undefined;

  // 辅助函数：将事件同时写入 runner 的数组和 traceRecorder
  // 按 event.id 去重，防止 send() 增量事件与 readEvents() 全量快照重叠
  const seenEventIds = new Set<string>();
  function recordEvents(events: AgentRuntimeEvent[]): void {
    for (const ev of events) {
      if (!seenEventIds.has(ev.id)) {
        seenEventIds.add(ev.id);
        allRuntimeEvents.push(ev);
        // 同时推入 traceRecorder，确保最终 trace 包含完整 runtimeEvents
        traceRecorder.pushEvent(ev);
      }
    }
  }

  try {
    // 5. 创建 driver
    const driver = await createDriver(evalCase.driver);

    // 6. 启动 case
    await driver.startCase({ caseId: evalCase.id, workspaceRoot: workspace.root });

    // 7. 逐步骤执行
    for (const step of evalCase.steps) {
      const stepId = step.id ?? `step_${evalCase.steps.indexOf(step)}`;
      traceRecorder.startStep(stepId, step.query);

      try {
        const turnResult = await driver.send({ stepId, query: step.query });
        traceRecorder.endStep(stepId, turnResult.finalOutput, turnResult.exitCode);

        // 合并本步返回的事件
        if (turnResult.events) {
          recordEvents(turnResult.events);
        }
      } catch (stepErr) {
        const message = stepErr instanceof Error ? stepErr.message : String(stepErr);
        const error: EvalRunError = { message, stepId };
        traceRecorder.endStep(stepId, undefined, undefined, error);
        runError = error;
        // 步骤出错后中断后续步骤
        break;
      }
    }

    // 8. 收集 driver 的全部事件（如果 driver 支持 readEvents）
    if (driver.readEvents) {
      try {
        const driverEvents = await driver.readEvents();
        recordEvents(driverEvents);
      } catch {
        // readEvents 失败不阻塞主流程
      }
    }

    // 11. 关闭 driver
    await driver.close();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runError = { message };
  }

  // 9. 执行断言
  const stepTraces = traceRecorder.getStepTraces();

  const assertionCtx = {
    caseId: evalCase.id,
    stepTraces,
    runtimeEvents: allRuntimeEvents,
    workspaceRoot: workspace.root,
  };



  // 合并 case 级断言和 step 级断言
  // step 级断言如果没有显式 stepId，自动绑定到当前 step，避免误匹配到最后一步
  const stepAssertions = evalCase.steps.flatMap((step, idx) => {
    const stepId = step.id ?? `step_${idx}`;
    return (step.assertions ?? []).map((a) => {
      // 使用运行时类型检查：只有带 stepId 属性的断言才需要绑定
      if ("stepId" in a && a.stepId === undefined) {
        return { ...a, stepId };
      }
      return a;
    });
  });
  const allAssertions = [...evalCase.assertions, ...stepAssertions];

  const assertionResults = await runAssertions(allAssertions, assertionCtx);

  // 计算总体状态
  const hardPassed = assertionResults.every((r) => r.passed);
  let status: EvalRunStatus;
  if (runError) {
    status = "error";
  } else if (hardPassed) {
    status = "passed";
  } else {
    status = "failed";
  }

  // 组装 trace
  const traceOptions: {
    caseId: string;
    title: string;
    mode: EvalCaseMode;
    workspaceRoot?: string;
    assertions: EvalAssertionResult[];
    error?: EvalRunError;
  } = {
    caseId: evalCase.id,
    title: evalCase.title,
    mode: (evalCase.mode ?? "scripted") as EvalCaseMode,
    workspaceRoot: workspace.root,
    assertions: assertionResults,
  };
  if (runError !== undefined) {
    traceOptions.error = runError;
  }
  const trace = traceRecorder.buildTrace(traceOptions);

  // 10. 可选写入 trace JSON
  // 默认不启用，除非 case 显式设置 enabled=true 或 EVAL_TRACE_DIR 环境变量存在
  const traceEnabled =
    evalCase.trace?.enabled === true || !!process.env["EVAL_TRACE_DIR"];
  const traceWriterOptions: { enabled: boolean; outputDir?: string } = { enabled: traceEnabled };
  if (evalCase.trace?.outputDir !== undefined) {
    traceWriterOptions.outputDir = evalCase.trace.outputDir;
  }
  const tracePath = await writeEvalTrace(trace, traceWriterOptions);

  // 12. 清理 workspace（如果 case 失败且设置了 keepOnFailure，则保留）
  const shouldKeep = evalCase.workspace?.keepOnFailure === true && status !== "passed";
  if (!shouldKeep) {
    try {
      await workspace.cleanup();
    } catch {
      // cleanup 失败不阻塞结果返回
    }
  }

  // 13. 返回结果
  const result: {
    caseId: string;
    title: string;
    status: EvalRunStatus;
    passed: boolean;
    steps: typeof stepTraces;
    runtimeEvents: typeof allRuntimeEvents;
    assertions: typeof assertionResults;
    tracePath?: string;
    error?: EvalRunError;
  } = {
    caseId: evalCase.id,
    title: evalCase.title,
    status,
    passed: status === "passed",
    steps: stepTraces,
    runtimeEvents: allRuntimeEvents,
    assertions: assertionResults,
  };
  if (tracePath !== null) {
    result.tracePath = tracePath;
  }
  if (runError !== undefined) {
    result.error = runError;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Case 校验
// ---------------------------------------------------------------------------

/**
 * validateEvalCase — 校验 case 结构合法性
 *
 * 校验规则：
 * 1. id 非空，只允许 [a-z0-9._-]
 * 2. steps 至少一项
 * 3. assertions 至少一项
 * 4. driver 必须存在，并且 kind 非空
 * 5. learn-claude-code-in-process driver 的 scripted 模式必须提供 scriptedResponses
 * 6. replay 模式必须提供 replayFile
 * 7. live 模式必须显式 opt-in（EVAL_LIVE=1）
 * 8. workspace.initialFiles 路径必须是相对路径，不能包含 .. 逃逸
 * 9. fake tool 名称不能重复
 * 10. assertion 中引用的 stepId 必须存在（含自动生成的 step_${index}）
 * 11. toolCallCount.count 不能为负数
 * 12. 未实现的 assertion kind 应被拒绝（如 workspaceDiffContains）
 */
function validateEvalCase(evalCase: EvalCase): void {
  if (!evalCase.id) {
    throw new Error("EvalCase id is required");
  }
  if (!/^[a-z0-9._-]+$/.test(evalCase.id)) {
    throw new Error(
      `EvalCase id must only contain lowercase letters, numbers, dots, hyphens, and underscores: ${evalCase.id}`,
    );
  }

  if (!evalCase.title) {
    throw new Error("EvalCase title is required");
  }

  if (!evalCase.steps || evalCase.steps.length === 0) {
    throw new Error(`EvalCase ${evalCase.id}: steps must have at least one item`);
  }

  if (!evalCase.assertions || evalCase.assertions.length === 0) {
    throw new Error(`EvalCase ${evalCase.id}: assertions must have at least one item`);
  }

  if (!evalCase.driver || !evalCase.driver.kind) {
    throw new Error(`EvalCase ${evalCase.id}: driver.kind is required`);
  }

  // 对 learn-claude-code-in-process driver 做额外校验
  if (evalCase.driver.kind === "learn-claude-code-in-process") {
    const plan = evalCase.driver as Extract<
      EvalCase["driver"],
      { kind: "learn-claude-code-in-process" }
    >;
    if (plan.llm.kind === "scripted") {
      if (!plan.llm.scriptedResponses || plan.llm.scriptedResponses.length === 0) {
        throw new Error(
          `EvalCase ${evalCase.id}: scripted mode requires at least one scriptedResponse`,
        );
      }
    }
    if (plan.llm.kind === "replay") {
      if (!plan.llm.replayFile) {
        throw new Error(
          `EvalCase ${evalCase.id}: replay mode requires replayFile`,
        );
      }
    }
    if (plan.llm.kind === "live") {
      if (process.env["EVAL_LIVE"] !== "1") {
        throw new Error(
          `EvalCase ${evalCase.id}: live mode requires EVAL_LIVE=1 environment variable`,
        );
      }
    }
  }

  // 校验 workspace.initialFiles 路径安全
  if (evalCase.workspace?.initialFiles) {
    for (const path of Object.keys(evalCase.workspace.initialFiles)) {
      try {
        // 复用 workspace.ts 的校验逻辑：检查绝对路径和 .. 逃逸
        if (path.startsWith("/") || path.split(/[/\\]/).some((p) => p === "..")) {
          throw new Error(`Workspace path must not contain '..': ${path}`);
        }
      } catch (err) {
        throw new Error(
          `EvalCase ${evalCase.id}: invalid initialFiles path: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  // 校验 fake tool 名称不重复
  if (evalCase.driver.kind === "learn-claude-code-in-process") {
    const plan = evalCase.driver as Extract<
      EvalCase["driver"],
      { kind: "learn-claude-code-in-process" }
    >;
    if (plan.tools?.kind === "fake" && plan.tools.fakeTools) {
      const fakeToolNames = new Set<string>();
      for (const ft of plan.tools.fakeTools) {
        if (fakeToolNames.has(ft.name)) {
          throw new Error(
            `EvalCase ${evalCase.id}: duplicate fake tool name "${ft.name}"`,
          );
        }
        fakeToolNames.add(ft.name);
      }
    }
    // 第二批已支持 core 工具，不再拒绝
  }

  // 收集所有有效的 stepId（显式 id + 自动生成的 step_${index}）
  const validStepIds = new Set<string>();
  evalCase.steps.forEach((s, idx) => {
    if (s.id) validStepIds.add(s.id);
    validStepIds.add(`step_${idx}`);
  });

  // 校验 assertions
  const allAssertions = [
    ...evalCase.assertions,
    ...evalCase.steps.flatMap((s) => s.assertions ?? []),
  ];
  for (const assertion of allAssertions) {
    if ("stepId" in assertion && assertion.stepId && !validStepIds.has(assertion.stepId)) {
      throw new Error(
        `EvalCase ${evalCase.id}: assertion references unknown stepId "${assertion.stepId}"`,
      );
    }
    if (assertion.kind === "toolCallCount" && assertion.count < 0) {
      throw new Error(
        `EvalCase ${evalCase.id}: toolCallCount.count must be non-negative`,
      );
    }
    // 拒绝第一批未实现的断言 kind
    if (assertion.kind === "workspaceDiffContains") {
      throw new Error(
        `EvalCase ${evalCase.id}: assertion kind "workspaceDiffContains" is not implemented in batch 1`,
      );
    }
  }
}
