/**
 * mcp-suite.test.ts — MCP Harness 确定性集成测试
 *
 * 职责：使用 scripted LLM 驱动真实 Agent loop，验证 MCP fixture
 * 通过 full-tools driver 被暴露为 run_mcp_* 工具，并产生结构化 trace。
 *
 * 注意：当前项目尚未实现生产级 MCP runtime / 第三方 MCP server 接入。
 * 这组测试只验证 eval fixture harness，先整体 skip，避免 CI 报告让人误解
 * “MCP 功能已经真实可用”。
 */

import { describe, expect, it } from "vitest";
import type { CodingAgentDriver } from "../core/driver.js";
import type { EvalCase } from "../core/case-schema.js";
import { runEvalCase } from "../core/runner.js";
import { createLearnClaudeCodeInProcessDriver } from "../drivers/learn-claude-code/in-process-driver.js";

describe.skip("MCP eval harness", () => {
  it("calls a fixture MCP tool and grounds the final answer", async () => {
    const evalCase: EvalCase = {
      id: "mcp-fixture-tool-call",
      title: "MCP fixture tool call",
      mode: "scripted",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_mcp_1",
                  name: "run_mcp_fixture_lookup_ticket",
                  args: { id: "TICKET-42" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "Ticket TICKET-42 is approved.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["mcp"],
            mcpServers: [
              {
                id: "fixture",
                kind: "fixture",
                transport: "stdio",
                tools: [
                  {
                    name: "lookup_ticket",
                    description: "Lookup a ticket decision",
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
          },
        },
        maxRounds: 8,
      },
      steps: [
        {
          query:
            "Use the ticket lookup MCP tool to check TICKET-42 and report the decision.",
        },
      ],
      assertions: [
        { kind: "mcpServerStarted", serverId: "fixture" },
        {
          kind: "mcpToolListed",
          serverId: "fixture",
          toolName: "lookup_ticket",
        },
        {
          kind: "mcpToolCalled",
          serverId: "fixture",
          toolName: "lookup_ticket",
        },
        {
          kind: "mcpToolResultContains",
          serverId: "fixture",
          toolName: "lookup_ticket",
          text: "approved",
        },
        { kind: "finalOutputContains", text: "approved" },
        { kind: "allToolsSucceeded" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  });

  it("reads a fixture MCP resource", async () => {
    const evalCase: EvalCase = {
      id: "mcp-resource-read-grounded-answer",
      title: "MCP resource read grounded answer",
      mode: "scripted",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_mcp_resource",
                  name: "run_mcp_resource_read",
                  args: {
                    server_id: "fixture",
                    uri: "fixture://release-policy",
                  },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "The release gate is MCP_RESOURCE_OK.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["mcp"],
            mcpServers: [
              {
                id: "fixture",
                kind: "fixture",
                transport: "stdio",
                resources: [
                  {
                    uri: "fixture://release-policy",
                    name: "Release policy",
                    mimeType: "text/plain",
                    text: "Release gate: MCP_RESOURCE_OK",
                  },
                ],
              },
            ],
          },
        },
        maxRounds: 8,
      },
      steps: [
        {
          query:
            "Read the release policy MCP resource and tell me the release gate.",
        },
      ],
      assertions: [
        {
          kind: "mcpResourceRead",
          serverId: "fixture",
          uri: "fixture://release-policy",
        },
        { kind: "finalOutputContains", text: "MCP_RESOURCE_OK" },
        { kind: "allToolsSucceeded" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  });

  it("records MCP tool errors so the Agent can recover honestly", async () => {
    const evalCase: EvalCase = {
      id: "mcp-tool-error-recovery",
      title: "MCP tool error recovery",
      mode: "scripted",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_mcp_error",
                  name: "run_mcp_fixture_lookup_ticket",
                  args: { id: "TICKET-404" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "Ticket lookup failed: ticket not found.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["mcp"],
            mcpServers: [
              {
                id: "fixture",
                kind: "fixture",
                transport: "stdio",
                tools: [
                  {
                    name: "lookup_ticket",
                    description: "Lookup a ticket decision",
                    inputSchema: { type: "object", properties: {} },
                    result: {
                      errorCode: -32002,
                      errorMessage: "Ticket not found",
                    },
                  },
                ],
              },
            ],
          },
        },
        maxRounds: 8,
      },
      steps: [{ query: "Use MCP to look up TICKET-404." }],
      assertions: [
        {
          kind: "mcpToolCalled",
          serverId: "fixture",
          toolName: "lookup_ticket",
        },
        { kind: "mcpErrorCode", serverId: "fixture", code: -32002 },
        { kind: "finalOutputMatches", pattern: "(not found|failed)" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  });

  it("turns slow MCP tool calls into timeout errors", async () => {
    const evalCase: EvalCase = {
      id: "mcp-tool-timeout",
      title: "MCP tool timeout",
      mode: "scripted",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_mcp_timeout",
                  name: "run_mcp_fixture_lookup_ticket",
                  args: { id: "TICKET-SLOW" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "The MCP lookup failed because it timed out.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["mcp"],
            mcpClientTimeoutMs: 5,
            mcpServers: [
              {
                id: "fixture",
                kind: "fixture",
                transport: "stdio",
                behavior: { delayMs: 100 },
                tools: [
                  {
                    name: "lookup_ticket",
                    description: "Lookup a ticket decision",
                    inputSchema: { type: "object", properties: {} },
                    result: { contentText: "late response" },
                  },
                ],
              },
            ],
          },
        },
        maxRounds: 8,
      },
      steps: [{ query: "Use MCP to look up TICKET-SLOW." }],
      assertions: [
        {
          kind: "mcpToolCalled",
          serverId: "fixture",
          toolName: "lookup_ticket",
        },
        { kind: "mcpErrorCode", serverId: "fixture", code: -32001 },
        { kind: "allStepsCompleted" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  });

  it("records MCP server crash and does not hang the case", async () => {
    const evalCase: EvalCase = {
      id: "mcp-server-crash",
      title: "MCP server crash",
      mode: "scripted",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_mcp_crash",
                  name: "run_mcp_fixture_lookup_ticket",
                  args: { id: "TICKET-CRASH" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "The MCP server crashed, so the lookup failed.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["mcp"],
          },
        },
        mcpServers: [
          {
            id: "fixture",
            kind: "fixture",
            transport: "stdio",
            behavior: { crashAfterRequest: "tools/call" },
            tools: [
              {
                name: "lookup_ticket",
                description: "Lookup a ticket decision",
                inputSchema: { type: "object", properties: {} },
                result: { contentText: "unreachable response" },
              },
            ],
          },
        ],
        maxRounds: 8,
      },
      steps: [{ query: "Use MCP to look up TICKET-CRASH." }],
      assertions: [
        { kind: "mcpServerStarted", serverId: "fixture" },
        {
          kind: "mcpToolCalled",
          serverId: "fixture",
          toolName: "lookup_ticket",
        },
        { kind: "mcpErrorCode", serverId: "fixture", code: -32000 },
        { kind: "mcpServerStopped", serverId: "fixture" },
        { kind: "allStepsCompleted" },
        { kind: "finalOutputMatches", pattern: "(crashed|failed)" },
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
  if (plan.kind !== "learn-claude-code-in-process") {
    throw new Error(`Unsupported driver kind: ${plan.kind}`);
  }
  return createLearnClaudeCodeInProcessDriver(
    plan as Extract<
      EvalCase["driver"],
      { kind: "learn-claude-code-in-process" }
    >,
  );
}
