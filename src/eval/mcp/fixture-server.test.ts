/**
 * fixture-server.test.ts — MCP fixture server 协议测试
 *
 * 这组测试不调用真实 LLM，只验证 PDD24 所需的最小 MCP JSON-RPC 行为：
 * initialize、tools/list、tools/call、resources/list、resources/read 和 error。
 *
 * 当前生产 MCP runtime 尚未实现，先 skip MCP harness 测试，避免 CI
 * 报告被误读为真实 MCP 功能已完成。
 */

import { describe, expect, it } from "vitest";
import {
  createEvalMcpFixtureServer,
  readMcpResources,
  readMcpTools,
} from "./fixture-server.js";

describe.skip("createEvalMcpFixtureServer", () => {
  it("handles initialize, tools/list and tools/call", async () => {
    const server = createEvalMcpFixtureServer({
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
    });

    await server.start();
    const init = await server.request({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18" },
    });
    expect(init).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: "2025-06-18" },
    });
    await server.request({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const listed = await server.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
    });
    expect(readMcpTools(listed).map((tool) => tool.name)).toEqual([
      "lookup_ticket",
    ]);

    const called = await server.request({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "lookup_ticket", arguments: { id: "TICKET-42" } },
    });
    expect(called).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [{ type: "text", text: "Ticket TICKET-42 is approved" }],
        isError: false,
      },
    });
  });

  it("handles resources/list and resources/read", async () => {
    const server = createEvalMcpFixtureServer({
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
    });

    await server.start();
    await server.request({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.request({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const listed = await server.request({
      jsonrpc: "2.0",
      id: 2,
      method: "resources/list",
    });
    expect(readMcpResources(listed).map((resource) => resource.uri)).toEqual([
      "fixture://release-policy",
    ]);

    const read = await server.request({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "fixture://release-policy" },
    });
    expect(read).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        contents: [
          {
            uri: "fixture://release-policy",
            mimeType: "text/plain",
            text: "Release gate: MCP_RESOURCE_OK",
          },
        ],
      },
    });
  });

  it("returns JSON-RPC errors for fixture tool failures", async () => {
    const server = createEvalMcpFixtureServer({
      id: "fixture",
      kind: "fixture",
      transport: "stdio",
      tools: [
        {
          name: "lookup_ticket",
          description: "Lookup a ticket decision",
          inputSchema: { type: "object", properties: {} },
          result: { errorCode: -32002, errorMessage: "Ticket not found" },
        },
      ],
    });

    await server.start();
    await server.request({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await server.request({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });

    const response = await server.request({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "lookup_ticket" },
    });

    expect(response).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32002, message: "Ticket not found" },
    });
  });
});
