/**
 * team-suite.test.ts — Agent Team Harness 确定性集成测试
 *
 * 职责：用 scripted LLM 驱动真实 Team driver，验证 spawn、handoff、
 * 成员工具边界、失败恢复、权限继承和 MCP delegation。
 *
 * 注意：当前项目尚未实现生产级 Agent Team runtime。
 * 这组测试只验证 eval harness 原型，先整体 skip，避免 CI 报告让人误解
 * “Agent Team 功能已经真实可用”。
 */

import { describe, expect, it } from "vitest";
import type { CodingAgentDriver } from "../core/driver.js";
import type { EvalCase } from "../core/case-schema.js";
import { runEvalCase } from "../core/runner.js";
import { createLearnClaudeCodeTeamDriver } from "../drivers/learn-claude-code/team-driver.js";

describe.skip("Agent Team eval harness", () => {
  it("runs planner, implementer and reviewer over a real workspace", async () => {
    const evalCase: EvalCase = {
      id: "team-review-and-fix",
      title: "Team review and fix",
      mode: "scripted",
      workspace: {
        initialFiles: {
          "src/message.ts": 'export const message = "draft";\n',
        },
      },
      driver: {
        kind: "learn-claude-code-team",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content:
                "Plan: implementer should change src/message.ts, reviewer should read it afterward.",
              toolCalls: [],
              finishReason: "stop",
            },
            {
              content: null,
              toolCalls: [
                {
                  id: "call_impl_edit",
                  name: "run_edit_exact",
                  args: {
                    path: "src/message.ts",
                    old_string: '"draft"',
                    new_string: '"TEAM_DONE"',
                    expected_occurrences: 1,
                  },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "Implementation changed message to TEAM_DONE.",
              toolCalls: [],
              finishReason: "stop",
            },
            {
              content: null,
              toolCalls: [
                {
                  id: "call_review_read",
                  name: "run_read",
                  args: { path: "src/message.ts" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "Review passed: src/message.ts contains TEAM_DONE.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        workspace: "eval",
        agentHome: "temp",
        topology: "supervisor",
        members: [
          { id: "planner", role: "planner", tools: ["read"] },
          { id: "implementer", role: "implementer", tools: ["core"] },
          { id: "reviewer", role: "reviewer", tools: ["read"] },
        ],
        maxTeamSteps: 8,
      },
      steps: [
        {
          query: [
            "Use the team workflow to change src/message.ts so message becomes TEAM_DONE.",
            "Have a reviewer inspect the final file before reporting completion.",
          ].join("\n"),
        },
      ],
      assertions: [
        { kind: "teamAgentSpawned", agentId: "planner" },
        { kind: "teamAgentSpawned", agentId: "implementer" },
        { kind: "teamAgentSpawned", agentId: "reviewer" },
        { kind: "teamHandoffOccurred", from: "planner", to: "implementer" },
        { kind: "teamHandoffOccurred", from: "implementer", to: "reviewer" },
        {
          kind: "teamArtifactContains",
          path: "src/message.ts",
          text: "TEAM_DONE",
        },
        {
          kind: "teamAgentToolCalled",
          agentId: "reviewer",
          toolName: "run_read",
        },
        { kind: "teamAllAgentsCompleted" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  });

  it("runs readonly analysis members without write tools", async () => {
    const evalCase: EvalCase = {
      id: "team-parallel-readonly-analysis",
      title: "Team readonly analysis",
      mode: "scripted",
      workspace: {
        initialFiles: {
          "src/a.ts": "export const token = 'TOKEN_A';\n",
          "src/b.ts": "export const token = 'TOKEN_B';\n",
        },
      },
      driver: {
        kind: "learn-claude-code-team",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_a",
                  name: "run_read",
                  args: { path: "src/a.ts" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "src/a.ts contains TOKEN_A.",
              toolCalls: [],
              finishReason: "stop",
            },
            {
              content: null,
              toolCalls: [
                {
                  id: "call_b",
                  name: "run_read",
                  args: { path: "src/b.ts" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "src/b.ts contains TOKEN_B.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        workspace: "eval",
        agentHome: "temp",
        topology: "supervisor",
        members: [
          { id: "analyst_a", role: "researcher", tools: ["read"] },
          { id: "analyst_b", role: "researcher", tools: ["read"] },
        ],
        maxTeamSteps: 8,
      },
      steps: [
        {
          query:
            "Have two readonly analysis members inspect src/a.ts and src/b.ts and report both tokens.",
        },
      ],
      assertions: [
        { kind: "teamAgentSpawned", agentId: "analyst_a" },
        { kind: "teamAgentSpawned", agentId: "analyst_b" },
        { kind: "finalOutputContains", text: "TOKEN_A" },
        { kind: "finalOutputContains", text: "TOKEN_B" },
        {
          kind: "teamAgentToolNotCalled",
          agentId: "analyst_a",
          toolName: "run_write",
        },
        {
          kind: "teamAgentToolNotCalled",
          agentId: "analyst_b",
          toolName: "run_write",
        },
        { kind: "teamNoUnauthorizedWrites" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  });

  it("records member failure and still completes the team run", async () => {
    const evalCase: EvalCase = {
      id: "team-member-failure-recovery",
      title: "Team member failure recovery",
      mode: "scripted",
      workspace: {
        initialFiles: {
          "src/message.ts": 'export const message = "TEAM_DONE";\n',
        },
      },
      driver: {
        kind: "learn-claude-code-team",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_review_fail",
                  name: "run_read",
                  args: { path: "src/message.ts" },
                },
              ],
              finishReason: "tool_calls",
            },
          ],
        },
        workspace: "eval",
        agentHome: "temp",
        topology: "supervisor",
        members: [
          {
            id: "reviewer",
            role: "reviewer",
            tools: ["read"],
            failAfterFirstToolCall: true,
          },
        ],
        maxTeamSteps: 4,
      },
      steps: [{ query: "Have reviewer inspect src/message.ts." }],
      assertions: [
        { kind: "teamAgentSpawned", agentId: "reviewer" },
        { kind: "teamAgentFailed", agentId: "reviewer" },
        { kind: "finalOutputContains", text: "failed" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  });

  it("inherits permission denial for team writes", async () => {
    const evalCase: EvalCase = {
      id: "team-permission-inheritance",
      title: "Team permission inheritance",
      mode: "scripted",
      driver: {
        kind: "learn-claude-code-team",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_write_denied",
                  name: "run_write",
                  args: {
                    path: "blocked-team.txt",
                    content: "TEAM_DENIED",
                  },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content:
                "The write was denied, so blocked-team.txt was not created.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        terminal: { permissionAnswers: [false] },
        workspace: "eval",
        agentHome: "temp",
        topology: "supervisor",
        tools: { kind: "core", core: { permissionMode: "default" } },
        members: [{ id: "implementer", role: "implementer", tools: ["core"] }],
        maxTeamSteps: 4,
      },
      steps: [{ query: "Ask the implementer to write blocked-team.txt." }],
      assertions: [
        { kind: "permissionPromptShown" },
        { kind: "fileNotExists", path: "blocked-team.txt" },
        { kind: "teamNoUnauthorizedWrites" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  });

  it("delegates an MCP fixture tool to a team researcher", async () => {
    const evalCase: EvalCase = {
      id: "team-mcp-tool-delegation",
      title: "Team MCP tool delegation",
      mode: "scripted",
      driver: {
        kind: "learn-claude-code-team",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_research_mcp",
                  name: "run_mcp_fixture_lookup_ticket",
                  args: { id: "TICKET-42" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "Researcher found that TICKET-42 is approved via MCP.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        workspace: "eval",
        agentHome: "temp",
        topology: "supervisor",
        members: [{ id: "researcher", role: "researcher", tools: ["mcp"] }],
        mcpServers: [
          {
            id: "fixture",
            kind: "fixture",
            transport: "stdio",
            tools: [
              {
                name: "lookup_ticket",
                description: "Lookup a ticket decision.",
                inputSchema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                },
                result: { contentText: "Ticket TICKET-42 is approved" },
              },
            ],
          },
        ],
        maxTeamSteps: 6,
      },
      steps: [
        {
          query:
            "Ask the researcher to use MCP to look up TICKET-42 and summarize the result.",
        },
      ],
      assertions: [
        { kind: "teamAgentSpawned", agentId: "researcher" },
        {
          kind: "teamAgentToolCalled",
          agentId: "researcher",
          toolName: "run_mcp_fixture_lookup_ticket",
        },
        {
          kind: "mcpToolCalled",
          serverId: "fixture",
          toolName: "lookup_ticket",
        },
        { kind: "finalOutputContains", text: "approved" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  });
});

async function createDriver(
  plan: EvalCase["driver"],
): Promise<CodingAgentDriver> {
  if (plan.kind !== "learn-claude-code-team") {
    throw new Error(`Unsupported driver kind: ${plan.kind}`);
  }
  return createLearnClaudeCodeTeamDriver(
    plan as Extract<EvalCase["driver"], { kind: "learn-claude-code-team" }>,
  );
}
