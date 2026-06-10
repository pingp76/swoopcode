/**
 * team-trace.ts — Agent Team trace 辅助模块
 *
 * 职责：提供 Team runtime event 的发射与摘要工具。
 *
 * Team trace 需要按 agentId/role 分组展示成员消息和工具调用，
 * 但 Eval Core 仍只保存扁平 runtimeEvents；这里负责把扁平事件还原成
 * judge/report 更容易消费的结构。
 */

import type {
  AgentRuntimeEvent,
  EvalAssertionResult,
  EvalJudgeRubric,
  TeamRuntimeEvent,
} from "../core/case-schema.js";

export type TeamTraceEmitter = (event: AgentRuntimeEvent) => void;

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

export function emitTeamEvent(
  emit: TeamTraceEmitter,
  event: Omit<TeamRuntimeEvent, "id" | "timestamp" | "source" | "stepId"> & {
    stepId?: string | undefined;
  },
): void {
  emit({
    ...event,
    source: "driver",
  } as AgentRuntimeEvent);
}

export function previewTeamText(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}

export function buildTeamJudgeInput(options: {
  caseId: string;
  userQuery: string;
  finalOutput: string;
  runtimeEvents: AgentRuntimeEvent[];
  hardAssertionResults: EvalAssertionResult[];
  rubric: EvalJudgeRubric;
}): TeamJudgeInput {
  const teamEvents = options.runtimeEvents.filter(
    (event): event is TeamRuntimeEvent => isTeamEvent(event),
  );
  const agents = new Map<
    string,
    {
      agentId: string;
      role: string;
      completed: boolean;
      failed: boolean;
      toolCalls: string[];
      summaryPreview: string;
    }
  >();

  for (const event of teamEvents) {
    if (event.agentId) {
      const existing = agents.get(event.agentId) ?? {
        agentId: event.agentId,
        role: event.role ?? "unknown",
        completed: false,
        failed: false,
        toolCalls: [],
        summaryPreview: "",
      };
      if (event.role) existing.role = event.role;
      if (event.kind === "agent_tool_call" && event.toolName) {
        existing.toolCalls.push(event.toolName);
      }
      if (event.kind === "agent_message" && event.textPreview) {
        existing.summaryPreview = event.textPreview;
      }
      if (event.kind === "agent_completed") existing.completed = true;
      if (event.kind === "agent_failed") existing.failed = true;
      agents.set(event.agentId, existing);
    }
  }

  return {
    caseId: options.caseId,
    userQuery: options.userQuery,
    finalOutput: options.finalOutput,
    agents: Array.from(agents.values()),
    handoffs: teamEvents
      .filter((event) => event.kind === "handoff")
      .map((event) => ({
        from: event.agentId ?? "",
        to: event.targetAgentId ?? "",
        note: event.textPreview ?? "",
      })),
    artifacts: teamEvents
      .filter((event) => event.kind === "artifact_produced")
      .map((event) => ({
        path: event.artifactPath ?? "",
        preview: event.textPreview ?? "",
      })),
    hardAssertionResults: options.hardAssertionResults,
    rubric: options.rubric,
  };
}

function isTeamEvent(event: AgentRuntimeEvent): boolean {
  return (
    event.kind === "team_start" ||
    event.kind === "agent_spawned" ||
    event.kind === "agent_message" ||
    event.kind === "agent_tool_call" ||
    event.kind === "handoff" ||
    event.kind === "artifact_produced" ||
    event.kind === "agent_completed" ||
    event.kind === "agent_failed" ||
    event.kind === "team_completed"
  );
}
