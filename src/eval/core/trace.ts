/**
 * trace.ts — TraceRecorder 运行时事件收集器
 *
 * 职责：在 eval case 执行过程中收集标准化运行时事件和步骤痕迹。
 *
 * 设计原则：
 * - 提供一个简单的 push API，driver 和 runner 都可以写入事件
 * - 事件带自动生成的 id 和 ISO 时间戳
 * - 最终把收集的数据组装成 EvalTrace 结构
 */

import type {
  AgentRuntimeEvent,
  EvalStepTrace,
  EvalTrace,
  EvalAssertionResult,
  EvalCaseMode,
  EvalRunError,
  EvalJudgeResult,
} from "./case-schema.js";

/**
 * TraceRecorder — 事件收集器接口
 *
 * 为什么需要接口？
 * - 未来可能实现“只记录最后 N 条”或“按条件过滤”的变体
 * - 测试时可以用 mock recorder 替代
 */
export interface TraceRecorder {
  /** 记录一条运行时事件 */
  pushEvent(event: AgentRuntimeEvent | Omit<AgentRuntimeEvent, "id" | "timestamp">): void;
  /** 开始一个步骤 */
  startStep(stepId: string, query: string): void;
  /** 结束一个步骤 */
  endStep(stepId: string, finalOutput?: string, exitCode?: number, error?: EvalRunError): void;
  /** 获取当前已记录的步骤痕迹（只读视图） */
  getStepTraces(): EvalStepTrace[];
  /** 组装最终 EvalTrace */
  buildTrace(options: {
    caseId: string;
    title: string;
    mode: EvalCaseMode;
    workspaceRoot?: string | undefined;
    assertions: EvalAssertionResult[];
    error?: EvalRunError | undefined;
    judge?: EvalJudgeResult | undefined;
  }): EvalTrace;
}

/**
 * createTraceRecorder — 创建标准 TraceRecorder
 *
 * 内部维护事件数组和步骤数组，线程不安全（单线程 eval 足够）。
 */
export function createTraceRecorder(): TraceRecorder {
  // 运行时事件列表：按发生顺序追加
  const events: AgentRuntimeEvent[] = [];
  // 步骤痕迹列表：按 startStep 调用顺序追加
  const stepTraces: EvalStepTrace[] = [];
  // 记录每个 stepId 在 stepTraces 中的索引，方便 endStep 时定位
  const stepIndexById = new Map<string, number>();

  /**
   * makeEventId — 生成事件唯一标识
   *
   * 格式：时间戳-随机后缀，简单且足够 eval 场景使用
   */
  function makeEventId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * makeTimestamp — 生成 ISO 格式时间戳
   */
  function makeTimestamp(): string {
    return new Date().toISOString();
  }

  return {
    pushEvent(event): void {
      // 补全 id 和 timestamp，确保每条事件都有唯一标识和时间。
      // 如果传入的事件已自带 id/timestamp（如 driver 内部已生成），则保留原值。
      const fullEvent: AgentRuntimeEvent = {
        ...event,
        id: (event as AgentRuntimeEvent).id ?? makeEventId(),
        timestamp: (event as AgentRuntimeEvent).timestamp ?? makeTimestamp(),
      } as AgentRuntimeEvent;
      events.push(fullEvent);
    },

    startStep(stepId, query): void {
      const trace: EvalStepTrace = {
        stepId,
        query,
        startedAt: makeTimestamp(),
      };
      stepIndexById.set(stepId, stepTraces.length);
      stepTraces.push(trace);
    },

    endStep(stepId, finalOutput, exitCode, error): void {
      const idx = stepIndexById.get(stepId);
      if (idx === undefined) {
        // 防御性处理：如果找不到对应 step，追加一条新的（理论上不应发生）
        const fallbackTrace: EvalStepTrace = {
          stepId,
          query: "",
          startedAt: makeTimestamp(),
          endedAt: makeTimestamp(),
        };
        if (finalOutput !== undefined) fallbackTrace.finalOutput = finalOutput;
        if (exitCode !== undefined) fallbackTrace.exitCode = exitCode;
        if (error !== undefined) fallbackTrace.error = error;
        stepTraces.push(fallbackTrace);
        return;
      }
      const trace = stepTraces[idx]!;
      trace.endedAt = makeTimestamp();
      if (finalOutput !== undefined) trace.finalOutput = finalOutput;
      if (exitCode !== undefined) trace.exitCode = exitCode;
      if (error !== undefined) trace.error = error;
    },

    getStepTraces(): EvalStepTrace[] {
      return stepTraces.slice();
    },

    buildTrace(options): EvalTrace {
      const trace: EvalTrace = {
        caseId: options.caseId,
        title: options.title,
        startedAt: stepTraces[0]?.startedAt ?? makeTimestamp(),
        endedAt: makeTimestamp(),
        mode: options.mode,
        steps: stepTraces.slice(),
        runtimeEvents: events.slice(),
        assertions: options.assertions.slice(),
      };
      if (options.workspaceRoot !== undefined) {
        trace.workspaceRoot = options.workspaceRoot;
      }
      if (options.error !== undefined) {
        trace.error = options.error;
      }
      if (options.judge !== undefined) {
        trace.judge = options.judge;
      }
      return trace;
    },
  };
}
