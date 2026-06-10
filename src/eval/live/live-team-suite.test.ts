/**
 * live-team-suite.test.ts — Agent Team Live E2E 测试
 *
 * 职责：使用真实 LLM 驱动 planner/implementer/reviewer 等成员，
 * 验证 Team harness 的全真集成路径。
 *
 * 当前状态：
 *   暂时无条件 skip。项目尚未实现生产级 Agent Team runtime；
 *   mixed case 也只覆盖 eval MCP fixture harness，不能代表真实 Team/MCP 功能。
 */

import { describe, expect, it } from "vitest";
import type { CodingAgentDriver } from "../core/driver.js";
import type { EvalCase } from "../core/case-schema.js";
import { runEvalCase } from "../core/runner.js";
import { createJudgeLLM } from "./_driver-factory.js";
import { createLearnClaudeCodeTeamDriver } from "../drivers/learn-claude-code/team-driver.js";

const suite = describe.skip;
const mixedSuite = describe.skip;

const judgeLLM =
  process.env["EVAL_JUDGE"] === "1" ? createJudgeLLM() : undefined;

suite("Live Team Suite", () => {
  it("uses a live LLM team to edit and review a file", async () => {
    const evalCase: EvalCase = {
      id: "live-team-review-and-fix",
      title: "Live Team: review and fix",
      mode: "live",
      workspace: {
        initialFiles: {
          "src/message.ts": 'export const message = "draft";\n',
        },
      },
      driver: {
        kind: "learn-claude-code-team",
        llm: { kind: "live", live: { maxCalls: 24 } },
        workspace: "eval",
        agentHome: "temp",
        topology: "supervisor",
        members: [
          { id: "planner", role: "planner", tools: ["read"], maxRounds: 4 },
          {
            id: "implementer",
            role: "implementer",
            tools: ["core"],
            maxRounds: 8,
          },
          { id: "reviewer", role: "reviewer", tools: ["read"], maxRounds: 6 },
        ],
        maxTeamSteps: 8,
      },
      steps: [
        {
          query: [
            "Use the team workflow.",
            "Planner: make a brief plan only.",
            "Implementer: modify src/message.ts so message becomes TEAM_LIVE_DONE.",
            "Reviewer: read src/message.ts after the change and report whether TEAM_LIVE_DONE is present.",
            "Do not claim completion until the reviewer has inspected the final file.",
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
          text: "TEAM_LIVE_DONE",
        },
        {
          kind: "teamAgentToolCalled",
          agentId: "reviewer",
          toolName: "run_read",
        },
        { kind: "teamAllAgentsCompleted" },
      ],
      judge: {
        rubric: {
          goal: "A live LLM team should plan, implement, and review a requested file change.",
          passCriteria: [
            "The implementer actually edits src/message.ts",
            "The reviewer reads the final file",
            "The final summary does not claim an unperformed review",
          ],
          failCriteria: [
            "No file change is made",
            "Reviewer does not inspect the file",
            "Final summary contradicts the trace",
          ],
          scoring: { minPassingScore: 7, maxScore: 10 },
        },
      },
    };

    const result = await runEvalCase(evalCase, createTeamDriver, judgeLLM);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  }, 120_000);
});

mixedSuite("Live Team + MCP Suite", () => {
  it("delegates an MCP fixture lookup to a live LLM researcher", async () => {
    const evalCase: EvalCase = {
      id: "live-team-mcp-tool-delegation",
      title: "Live Team + MCP: tool delegation",
      mode: "live",
      driver: {
        kind: "learn-claude-code-team",
        llm: { kind: "live", live: { maxCalls: 12 } },
        workspace: "eval",
        agentHome: "temp",
        topology: "supervisor",
        members: [
          {
            id: "researcher",
            role: "researcher",
            tools: ["mcp"],
            maxRounds: 8,
          },
        ],
        mcpServers: [
          {
            id: "fixture",
            kind: "fixture",
            transport: "stdio",
            tools: [
              {
                name: "lookup_ticket",
                description:
                  "Lookup a ticket decision and return the team MCP marker.",
                inputSchema: {
                  type: "object",
                  properties: { id: { type: "string" } },
                  required: ["id"],
                },
                result: {
                  contentText:
                    "Ticket TICKET-42 is approved. Marker TEAM_MCP_LIVE_OK.",
                },
              },
            ],
          },
        ],
        maxTeamSteps: 8,
      },
      steps: [
        {
          query: [
            "Ask the researcher to use the MCP ticket lookup tool for TICKET-42.",
            "The final team output must include the exact marker returned by MCP.",
          ].join("\n"),
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
        { kind: "finalOutputContains", text: "TEAM_MCP_LIVE_OK" },
      ],
    };

    const result = await runEvalCase(evalCase, createTeamDriver, judgeLLM);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  }, 120_000);
});

async function createTeamDriver(
  plan: EvalCase["driver"],
): Promise<CodingAgentDriver> {
  if (plan.kind !== "learn-claude-code-team") {
    throw new Error(`Unsupported live team driver kind: ${plan.kind}`);
  }
  return createLearnClaudeCodeTeamDriver(
    plan as Extract<EvalCase["driver"], { kind: "learn-claude-code-team" }>,
  );
}
