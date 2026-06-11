/**
 * fixture-server.ts — Eval 专用 MCP fixture server
 *
 * 职责：提供一个可控的、最小 MCP JSON-RPC server，用于端到端测试
 * Agent 是否能发现、调用 MCP tool，并基于 MCP resource 作答。
 *
 * 设计边界：
 * - 这是 eval fixture，不是生产 MCP server 管理器
 * - 当前以 in-process request/response 模拟 transport，保留 stdio/http 计划字段
 * - 方法和 payload shape 遵循 MCP 2025-06-18 的最小子集
 */

import type {
  EvalMcpFixtureResource,
  EvalMcpFixtureTool,
  EvalMcpServerPlan,
} from "../core/case-schema.js";

export const MCP_PROTOCOL_VERSION = "2025-06-18";

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcErrorObject {
  code: number;
  message: string;
  data?: unknown;
}

export type JsonRpcResponse =
  | {
      jsonrpc: "2.0";
      id: JsonRpcId | null;
      result: Record<string, unknown>;
    }
  | {
      jsonrpc: "2.0";
      id: JsonRpcId | null;
      error: JsonRpcErrorObject;
    };

export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpResourceInfo {
  uri: string;
  name: string;
  mimeType?: string;
}

export interface EvalMcpFixtureServer {
  readonly id: string;
  readonly plan: EvalMcpServerPlan;
  start(): Promise<void>;
  stop(): Promise<void>;
  request(request: JsonRpcRequest): Promise<JsonRpcResponse | null>;
}

/**
 * createEvalMcpFixtureServer — 创建 MCP fixture server
 *
 * server 本身只负责协议行为；trace 由 mcp-runtime 的 client 侧记录，
 * 这样协议测试可以独立运行，不依赖 learn-claude-code driver。
 */
export function createEvalMcpFixtureServer(
  plan: EvalMcpServerPlan,
): EvalMcpFixtureServer {
  const tools = new Map((plan.tools ?? []).map((tool) => [tool.name, tool]));
  const resources = new Map(
    (plan.resources ?? []).map((resource) => [resource.uri, resource]),
  );
  let started = false;
  let initialized = false;

  return {
    id: plan.id,
    plan,

    async start(): Promise<void> {
      validateServerPlan(plan);
      started = true;
    },

    async stop(): Promise<void> {
      started = false;
      initialized = false;
    },

    async request(request): Promise<JsonRpcResponse | null> {
      if (!started) {
        throw new Error(`MCP fixture server "${plan.id}" is not running`);
      }

      // PDD24 的 timeout case 关注 tool 调用慢响应；initialize/list 阶段保持快速，
      // 否则 case 会在 driver 启动时失败，无法测试 Agent 的错误恢复路径。
      if (
        plan.behavior?.delayMs !== undefined &&
        request.method === "tools/call"
      ) {
        await sleep(plan.behavior.delayMs);
      }

      if (plan.behavior?.crashAfterRequest === request.method) {
        started = false;
        throw new Error(
          `MCP fixture server "${plan.id}" crashed after ${request.method}`,
        );
      }

      return handleRequest(request);
    },
  };

  function handleRequest(request: JsonRpcRequest): JsonRpcResponse | null {
    // MCP initialized 是 notification，没有 id 时不返回 response。
    if (request.method === "notifications/initialized") {
      initialized = true;
      return null;
    }

    const id = request.id ?? null;
    switch (request.method) {
      case "initialize":
        return handleInitialize(id);
      case "tools/list":
        return result(id, { tools: listTools() });
      case "tools/call":
        return handleToolCall(id, request.params ?? {});
      case "resources/list":
        return result(id, { resources: listResources() });
      case "resources/read":
        return handleResourceRead(id, request.params ?? {});
      case "prompts/list":
        return result(id, { prompts: [] });
      default:
        return error(id, -32601, `Method not found: ${request.method}`);
    }
  }

  function handleInitialize(id: JsonRpcId | null): JsonRpcResponse {
    if (plan.behavior?.failInitialize === true) {
      return error(id, -32000, `MCP fixture "${plan.id}" initialize failed`);
    }
    return result(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {
        tools: plan.capabilities?.tools === false ? undefined : {},
        resources: plan.capabilities?.resources === false ? undefined : {},
        prompts: plan.capabilities?.prompts === true ? {} : undefined,
      },
      serverInfo: {
        name: plan.id,
        title: `Eval MCP fixture ${plan.id}`,
        version: "0.1.0",
      },
    });
  }

  function handleToolCall(
    id: JsonRpcId | null,
    params: Record<string, unknown>,
  ): JsonRpcResponse {
    if (!initialized) {
      return error(
        id,
        -32000,
        "MCP client did not send initialized notification",
      );
    }
    const name = typeof params["name"] === "string" ? params["name"] : "";
    if (!name) {
      return error(id, -32602, "tools/call requires params.name");
    }
    const tool = tools.get(name);
    if (!tool) {
      return error(id, -32602, `Unknown MCP tool: ${name}`);
    }
    if ("errorCode" in tool.result) {
      return error(
        id,
        tool.result.errorCode,
        tool.result.errorMessage,
        tool.result.data,
      );
    }
    return result(id, {
      content: [{ type: "text", text: tool.result.contentText }],
      isError: false,
    });
  }

  function handleResourceRead(
    id: JsonRpcId | null,
    params: Record<string, unknown>,
  ): JsonRpcResponse {
    if (!initialized) {
      return error(
        id,
        -32000,
        "MCP client did not send initialized notification",
      );
    }
    const uri = typeof params["uri"] === "string" ? params["uri"] : "";
    if (!uri) {
      return error(id, -32602, "resources/read requires params.uri");
    }
    const resource = resources.get(uri);
    if (!resource) {
      return error(id, -32002, "Resource not found", { uri });
    }
    const content: { uri: string; text: string; mimeType?: string } = {
      uri: resource.uri,
      text: resource.text,
    };
    if (resource.mimeType !== undefined) {
      content.mimeType = resource.mimeType;
    }
    return result(id, { contents: [content] });
  }

  function listTools(): McpToolInfo[] {
    if (plan.capabilities?.tools === false) {
      return [];
    }
    return Array.from(tools.values()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }

  function listResources(): McpResourceInfo[] {
    if (plan.capabilities?.resources === false) {
      return [];
    }
    return Array.from(resources.values()).map((resource) => {
      const info: McpResourceInfo = {
        uri: resource.uri,
        name: resource.name,
      };
      if (resource.mimeType !== undefined) {
        info.mimeType = resource.mimeType;
      }
      return info;
    });
  }
}

function validateServerPlan(plan: EvalMcpServerPlan): void {
  if (!/^[a-zA-Z0-9._-]+$/.test(plan.id)) {
    throw new Error(`Invalid MCP fixture server id: ${plan.id}`);
  }
  validateUniqueNames(
    "MCP fixture tool",
    plan.tools ?? [],
    (tool) => tool.name,
  );
  validateUniqueNames(
    "MCP fixture resource",
    plan.resources ?? [],
    (resource) => resource.uri,
  );
}

function validateUniqueNames<T>(
  label: string,
  items: T[],
  getName: (item: T) => string,
): void {
  const names = new Set<string>();
  for (const item of items) {
    const name = getName(item);
    if (names.has(name)) {
      throw new Error(`Duplicate ${label}: ${name}`);
    }
    names.add(name);
  }
}

function result(
  id: JsonRpcId | null,
  payload: Record<string, unknown>,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result: payload };
}

function error(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  const errorObject: JsonRpcErrorObject = { code, message };
  if (data !== undefined) {
    errorObject.data = data;
  }
  return { jsonrpc: "2.0", id, error: errorObject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 测试辅助：从 tools/list response 中取出 tools。 */
export function readMcpTools(response: JsonRpcResponse | null): McpToolInfo[] {
  if (!response || "error" in response) {
    return [];
  }
  return Array.isArray(response.result["tools"])
    ? (response.result["tools"] as McpToolInfo[])
    : [];
}

/** 测试辅助：从 resources/list response 中取出 resources。 */
export function readMcpResources(
  response: JsonRpcResponse | null,
): McpResourceInfo[] {
  if (!response || "error" in response) {
    return [];
  }
  return Array.isArray(response.result["resources"])
    ? (response.result["resources"] as McpResourceInfo[])
    : [];
}

export type { EvalMcpFixtureResource, EvalMcpFixtureTool, EvalMcpServerPlan };
