/**
 * live-mcp-suite.test.ts — MCP Live E2E 测试
 *
 * 职责：使用真实 LLM + 真实 Agent loop + MCP fixture runtime，
 * 验证模型能发现并调用 MCP tool/resource，而不是只跑 scripted tool_call。
 *
 * 当前状态：
 *   暂时无条件 skip。项目尚未实现生产级 MCP runtime / 第三方 MCP
 *   server 接入，这里的 case 只覆盖 eval fixture harness，不能代表真实 MCP 功能。
 */

import { describe, expect, it } from "vitest";
import type { EvalCase } from "../core/case-schema.js";
import { runEvalCase } from "../core/runner.js";
import { createJudgeLLM, createLiveDriver } from "./_driver-factory.js";

const suite = describe.skip;

const judgeLLM =
  process.env["EVAL_JUDGE"] === "1" ? createJudgeLLM() : undefined;

suite("Live MCP Suite", () => {
  it("uses a live LLM to call an MCP fixture tool", async () => {
    const evalCase: EvalCase = {
      id: "live-mcp-fixture-tool-call",
      title: "Live MCP: fixture tool call",
      mode: "live",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "live", live: { maxCalls: 10 } },
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
                    description:
                      "Lookup a ticket decision and return the release marker.",
                    inputSchema: {
                      type: "object",
                      properties: { id: { type: "string" } },
                      required: ["id"],
                    },
                    result: {
                      contentText:
                        "Ticket TICKET-42 is approved. Marker MCP_LIVE_TOOL_OK.",
                    },
                  },
                ],
              },
            ],
          },
        },
        maxRounds: 10,
      },
      steps: [
        {
          query: [
            "Use the available MCP ticket lookup tool to check TICKET-42.",
            "Report the decision and include the exact marker returned by the tool.",
            "Do not answer from your own knowledge; call the MCP tool.",
          ].join("\n"),
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
          text: "MCP_LIVE_TOOL_OK",
        },
        { kind: "finalOutputContains", text: "approved" },
        { kind: "finalOutputContains", text: "MCP_LIVE_TOOL_OK" },
        { kind: "allToolsSucceeded" },
      ],
      judge: {
        rubric: {
          goal: "Agent must call the MCP ticket lookup tool and ground the final answer in the tool result.",
          passCriteria: [
            "The MCP tool is called before the final answer",
            "The final answer includes the tool marker",
            "The decision is reported as approved",
          ],
          failCriteria: [
            "Answers without calling the MCP tool",
            "Omits or mutates MCP_LIVE_TOOL_OK",
            "Invents a different decision",
          ],
          scoring: { minPassingScore: 7, maxScore: 10 },
        },
      },
    };

    const result = await runEvalCase(evalCase, createLiveDriver, judgeLLM);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  }, 90_000);

  it("uses a live LLM to read an MCP resource", async () => {
    const evalCase: EvalCase = {
      id: "live-mcp-resource-read-grounded-answer",
      title: "Live MCP: resource read grounded answer",
      mode: "live",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "live", live: { maxCalls: 10 } },
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
        maxRounds: 10,
      },
      steps: [
        {
          query: [
            "Read the MCP resource fixture://release-policy from server fixture.",
            "Tell me the release gate exactly as written in that resource.",
          ].join("\n"),
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
      judge: {
        rubric: {
          goal: "Agent must read the MCP resource and answer only with information grounded in it.",
          passCriteria: [
            "The MCP resource read tool is used",
            "The release gate MCP_RESOURCE_OK is returned exactly",
            "The answer does not invent extra policy",
          ],
          failCriteria: [
            "Answers without reading the resource",
            "Mutates the release gate",
            "Adds unsupported policy details",
          ],
          scoring: { minPassingScore: 7, maxScore: 10 },
        },
      },
    };

    const result = await runEvalCase(evalCase, createLiveDriver, judgeLLM);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  }, 90_000);

  it("uses a live LLM to report MCP tool errors honestly", async () => {
    const evalCase: EvalCase = {
      id: "live-mcp-tool-error-recovery",
      title: "Live MCP: tool error recovery",
      mode: "live",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "live", live: { maxCalls: 10 } },
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
                    description: "Lookup a ticket decision.",
                    inputSchema: {
                      type: "object",
                      properties: { id: { type: "string" } },
                      required: ["id"],
                    },
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
        maxRounds: 10,
      },
      steps: [
        {
          query: [
            "Use the MCP ticket lookup tool to check TICKET-404.",
            "If the tool reports an error, say that the lookup failed or was not found.",
            "Do not claim the ticket is approved unless the tool says so.",
          ].join("\n"),
        },
      ],
      assertions: [
        {
          kind: "mcpToolCalled",
          serverId: "fixture",
          toolName: "lookup_ticket",
        },
        { kind: "mcpErrorCode", serverId: "fixture", code: -32002 },
        { kind: "finalOutputMatches", pattern: "(not found|failed|could not)" },
      ],
    };

    const result = await runEvalCase(evalCase, createLiveDriver, judgeLLM);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  }, 90_000);
});
