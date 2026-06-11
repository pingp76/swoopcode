/**
 * team-assertions.ts — Team assertion 辅助函数
 *
 * 职责：提供 Team 事件筛选工具。真正的 EvalAssertion 执行在
 * core/assertions.ts 中完成，因为 runner 只调一个统一断言入口。
 */

import type {
  AgentRuntimeEvent,
  TeamRuntimeEvent,
} from "../core/case-schema.js";

const TEAM_EVENT_KINDS = new Set<TeamRuntimeEvent["kind"]>([
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

export function isTeamRuntimeEvent(
  event: AgentRuntimeEvent,
): event is TeamRuntimeEvent {
  return TEAM_EVENT_KINDS.has(event.kind as TeamRuntimeEvent["kind"]);
}

export function listTeamToolCalls(
  events: AgentRuntimeEvent[],
  agentId: string,
): string[] {
  return events
    .filter(isTeamRuntimeEvent)
    .filter(
      (event) => event.kind === "agent_tool_call" && event.agentId === agentId,
    )
    .map((event) => event.toolName)
    .filter((toolName): toolName is string => toolName !== undefined);
}
