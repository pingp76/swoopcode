/**
 * team-assertions.test.ts — Team assertion helper 单元测试
 *
 * 当前生产 Agent Team runtime 尚未实现，先 skip Team harness/helper 测试，
 * 避免 CI 报告被误读为真实 Team 功能已完成。
 */

import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent } from "../core/case-schema.js";
import { isTeamRuntimeEvent, listTeamToolCalls } from "./team-assertions.js";

describe.skip("team assertion helpers", () => {
  it("filters team events and groups tool calls by agent", () => {
    const events: AgentRuntimeEvent[] = [
      {
        id: "team-1",
        timestamp: "2026-06-10T00:00:00.000Z",
        kind: "agent_tool_call",
        source: "driver",
        teamId: "team",
        agentId: "reviewer",
        role: "reviewer",
        toolName: "run_read",
      },
      {
        id: "tool-1",
        timestamp: "2026-06-10T00:00:01.000Z",
        kind: "tool_call",
        source: "tool",
        toolName: "run_read",
      },
    ] as AgentRuntimeEvent[];

    expect(events.filter(isTeamRuntimeEvent)).toHaveLength(1);
    expect(listTeamToolCalls(events, "reviewer")).toEqual(["run_read"]);
  });
});
