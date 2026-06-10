/**
 * mcp-runtime.ts — learn-claude-code eval MCP adapter
 *
 * 职责：把 PDD24 的 MCP fixture server 接入当前项目真实 Agent 工具链。
 *
 * 关键边界：
 * - Eval Core 只知道 schema/assertion/event，不知道当前项目 ToolRegistry
 * - 这里负责把 MCP tools/resources 转换成 Agent 可见的 run_mcp_* 工具
 * - 当前没有生产 MCP manager，因此用 in-process fixture client 模拟 transport
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type {
  AgentRuntimeEvent,
  EvalMcpServerPlan,
} from "../../core/case-schema.js";
import type { ToolExecutor, ToolRegistry } from "../../../tools/registry.js";
import type { ToolResult } from "../../../tools/types.js";
import {
  createEvalMcpFixtureServer,
  readMcpResources,
  readMcpTools,
  type EvalMcpFixtureServer,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "../../mcp/fixture-server.js";
import { emitMcpEvent, previewMcpText } from "../../mcp/mcp-trace.js";

const DEFAULT_MCP_CLIENT_TIMEOUT_MS = 5_000;
const MCP_TIMEOUT_ERROR_CODE = -32001;
const MCP_SERVER_ERROR_CODE = -32000;

class McpRequestTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`MCP request timed out after ${timeoutMs}ms`);
    this.name = "McpRequestTimeoutError";
  }
}

let nextJsonRpcRequestId = 1;

function makeJsonRpcRequestId(): number {
  const id = nextJsonRpcRequestId;
  nextJsonRpcRequestId += 1;
  return id;
}

export interface CreateEvalMcpRuntimeOptions {
  servers: EvalMcpServerPlan[];
  emitEvent: (event: AgentRuntimeEvent) => void;
  getStepId?: () => string | undefined;
  clientTimeoutMs?: number;
}

export interface EvalMcpRuntime {
  tools: ToolRegistry;
  cleanup(): Promise<void>;
}

interface StartedMcpServer {
  plan: EvalMcpServerPlan;
  server: EvalMcpFixtureServer;
  tools: ListedMcpTool[];
  resources: ListedMcpResource[];
}

interface ListedMcpTool {
  serverId: string;
  mcpName: string;
  agentToolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface ListedMcpResource {
  serverId: string;
  uri: string;
  name: string;
  mimeType?: string;
}

/**
 * createEvalMcpRuntime — 启动 MCP fixtures 并生成 Agent 工具注册表
 */
export async function createEvalMcpRuntime(
  options: CreateEvalMcpRuntimeOptions,
): Promise<EvalMcpRuntime> {
  const clientTimeoutMs =
    options.clientTimeoutMs ?? DEFAULT_MCP_CLIENT_TIMEOUT_MS;
  const startedServers: StartedMcpServer[] = [];

  for (const plan of options.servers) {
    const server = createEvalMcpFixtureServer(plan);
    await server.start();
    emitMcpEvent(options.emitEvent, {
      kind: "mcp_server_start",
      serverId: plan.id,
      message: `transport=${plan.transport}`,
    });

    await initializeServer(server, options, clientTimeoutMs);
    const tools = await listServerTools(server, options, clientTimeoutMs);
    const resources = await listServerResources(server, clientTimeoutMs);
    startedServers.push({ plan, server, tools, resources });
  }

  const registryOptions: Parameters<typeof createMcpToolRegistry>[0] = {
    startedServers,
    emitEvent: options.emitEvent,
    clientTimeoutMs,
  };
  if (options.getStepId !== undefined) {
    registryOptions.getStepId = options.getStepId;
  }
  const tools = createMcpToolRegistry(registryOptions);

  return {
    tools,
    async cleanup(): Promise<void> {
      for (const started of startedServers) {
        await started.server.stop();
        emitMcpEvent(options.emitEvent, {
          kind: "mcp_server_stop",
          serverId: started.plan.id,
        });
      }
    },
  };
}

/**
 * combineToolRegistries — 把基础 registry 和 eval adapter registry 合并
 *
 * 这个函数避免修改生产 createToolRegistry 的签名，让 MCP adapter 可以独立替换。
 */
export function combineToolRegistries(
  registries: ToolRegistry[],
): ToolRegistry {
  const definitions = registries.flatMap((registry) =>
    registry.getToolDefinitions(),
  );
  const seen = new Set<string>();
  for (const definition of definitions) {
    const name = definition.function.name;
    if (seen.has(name)) {
      throw new Error(
        `Duplicate tool name across combined registries: ${name}`,
      );
    }
    seen.add(name);
  }

  return {
    getToolDefinitions() {
      return definitions;
    },
    getExecutor(name) {
      for (const registry of registries) {
        const executor = registry.getExecutor(name);
        if (executor) {
          return executor;
        }
      }
      return undefined;
    },
  };
}

async function initializeServer(
  server: EvalMcpFixtureServer,
  options: CreateEvalMcpRuntimeOptions,
  timeoutMs: number,
): Promise<void> {
  const response = await requestWithTimeout(
    server,
    {
      jsonrpc: "2.0",
      id: makeJsonRpcRequestId(),
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "learn-claude-code-eval", version: "0.1.0" },
      },
    },
    timeoutMs,
  );
  if (response && "error" in response) {
    emitMcpEvent(options.emitEvent, {
      kind: "mcp_error",
      serverId: server.id,
      errorCode: response.error.code,
      message: response.error.message,
    });
    throw new Error(
      `MCP fixture ${server.id} initialize failed: ${response.error.message}`,
    );
  }
  emitMcpEvent(options.emitEvent, {
    kind: "mcp_initialize",
    serverId: server.id,
  });
  await requestWithTimeout(
    server,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    timeoutMs,
  );
}

async function listServerTools(
  server: EvalMcpFixtureServer,
  options: CreateEvalMcpRuntimeOptions,
  timeoutMs: number,
): Promise<ListedMcpTool[]> {
  const response = await requestWithTimeout(
    server,
    { jsonrpc: "2.0", id: makeJsonRpcRequestId(), method: "tools/list" },
    timeoutMs,
  );
  if (response && "error" in response) {
    emitMcpEvent(options.emitEvent, {
      kind: "mcp_error",
      serverId: server.id,
      errorCode: response.error.code,
      message: response.error.message,
    });
    return [];
  }

  return readMcpTools(response).map((tool) => {
    const listed: ListedMcpTool = {
      serverId: server.id,
      mcpName: tool.name,
      agentToolName: buildMcpToolName(server.id, tool.name),
      description: tool.description,
      inputSchema: tool.inputSchema,
    };
    emitMcpEvent(options.emitEvent, {
      kind: "mcp_tools_list",
      serverId: server.id,
      toolName: tool.name,
    });
    return listed;
  });
}

async function listServerResources(
  server: EvalMcpFixtureServer,
  timeoutMs: number,
): Promise<ListedMcpResource[]> {
  const response = await requestWithTimeout(
    server,
    { jsonrpc: "2.0", id: makeJsonRpcRequestId(), method: "resources/list" },
    timeoutMs,
  );
  return readMcpResources(response).map((resource) => {
    const listed: ListedMcpResource = {
      serverId: server.id,
      uri: resource.uri,
      name: resource.name,
    };
    if (resource.mimeType !== undefined) {
      listed.mimeType = resource.mimeType;
    }
    return listed;
  });
}

function createMcpToolRegistry(options: {
  startedServers: StartedMcpServer[];
  emitEvent: (event: AgentRuntimeEvent) => void;
  getStepId?: () => string | undefined;
  clientTimeoutMs: number;
}): ToolRegistry {
  const definitions: ChatCompletionTool[] = [];
  const executors = new Map<string, ToolExecutor>();
  const toolNameSet = new Set<string>();

  for (const started of options.startedServers) {
    for (const tool of started.tools) {
      if (toolNameSet.has(tool.agentToolName)) {
        throw new Error(
          `Duplicate generated MCP tool name: ${tool.agentToolName}`,
        );
      }
      toolNameSet.add(tool.agentToolName);
      definitions.push(toChatToolDefinition(tool));
      executors.set(tool.agentToolName, async (args) =>
        executeMcpTool(started.server, tool, args, options),
      );
    }
  }

  const allResources = options.startedServers.flatMap(
    (server) => server.resources,
  );
  if (allResources.length > 0) {
    definitions.push(createResourceReadDefinition(allResources));
    executors.set("run_mcp_resource_read", async (args) =>
      executeMcpResourceRead(args, options),
    );
  }

  return {
    getToolDefinitions() {
      return definitions;
    },
    getExecutor(name) {
      return executors.get(name);
    },
  };
}

function toChatToolDefinition(tool: ListedMcpTool): ChatCompletionTool {
  return {
    type: "function",
    function: {
      name: tool.agentToolName,
      description: [
        `Call MCP server "${tool.serverId}" tool "${tool.mcpName}".`,
        tool.description,
      ].join(" "),
      parameters: tool.inputSchema,
    },
  };
}

function createResourceReadDefinition(
  resources: ListedMcpResource[],
): ChatCompletionTool {
  const resourceLines = resources
    .map(
      (resource) => `${resource.serverId}:${resource.uri} (${resource.name})`,
    )
    .join("\n");
  return {
    type: "function",
    function: {
      name: "run_mcp_resource_read",
      description:
        "Read a text resource from an MCP fixture server. Available resources:\n" +
        resourceLines,
      parameters: {
        type: "object",
        properties: {
          server_id: {
            type: "string",
            description: "MCP server id that owns the resource",
            enum: Array.from(
              new Set(resources.map((resource) => resource.serverId)),
            ),
          },
          uri: {
            type: "string",
            description: "Exact MCP resource URI to read",
            enum: Array.from(
              new Set(resources.map((resource) => resource.uri)),
            ),
          },
        },
        required: ["server_id", "uri"],
      },
    },
  };
}

async function executeMcpTool(
  server: EvalMcpFixtureServer,
  tool: ListedMcpTool,
  args: Record<string, unknown>,
  options: {
    emitEvent: (event: AgentRuntimeEvent) => void;
    getStepId?: () => string | undefined;
    clientTimeoutMs: number;
  },
): Promise<ToolResult> {
  emitMcpEvent(options.emitEvent, {
    kind: "mcp_tool_call",
    stepId: options.getStepId?.(),
    serverId: tool.serverId,
    toolName: tool.mcpName,
  });

  try {
    const response = await requestWithTimeout(
      server,
      {
        jsonrpc: "2.0",
        id: makeJsonRpcRequestId(),
        method: "tools/call",
        params: { name: tool.mcpName, arguments: args },
      },
      options.clientTimeoutMs,
    );
    if (!response) {
      return { output: "MCP tool call returned no response", error: true };
    }
    if ("error" in response) {
      emitMcpEvent(options.emitEvent, {
        kind: "mcp_error",
        stepId: options.getStepId?.(),
        serverId: tool.serverId,
        toolName: tool.mcpName,
        errorCode: response.error.code,
        message: response.error.message,
      });
      return {
        output: `MCP error ${response.error.code}: ${response.error.message}`,
        error: true,
      };
    }
    const text = readTextContent(response);
    emitMcpEvent(options.emitEvent, {
      kind: "mcp_tool_result",
      stepId: options.getStepId?.(),
      serverId: tool.serverId,
      toolName: tool.mcpName,
      message: previewMcpText(text),
    });
    return {
      output: text,
      error: response.result["isError"] === true,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCode =
      err instanceof McpRequestTimeoutError
        ? MCP_TIMEOUT_ERROR_CODE
        : MCP_SERVER_ERROR_CODE;
    emitMcpEvent(options.emitEvent, {
      kind: "mcp_error",
      stepId: options.getStepId?.(),
      serverId: tool.serverId,
      toolName: tool.mcpName,
      errorCode,
      message,
    });
    if (isMcpCrashMessage(message)) {
      emitMcpEvent(options.emitEvent, {
        kind: "mcp_server_stop",
        stepId: options.getStepId?.(),
        serverId: tool.serverId,
        message,
      });
    }
    return { output: `MCP request failed: ${message}`, error: true };
  }
}

async function executeMcpResourceRead(
  args: Record<string, unknown>,
  options: {
    startedServers: StartedMcpServer[];
    emitEvent: (event: AgentRuntimeEvent) => void;
    getStepId?: () => string | undefined;
    clientTimeoutMs: number;
  },
): Promise<ToolResult> {
  const serverId = String(args["server_id"] ?? "");
  const uri = String(args["uri"] ?? "");
  const started = options.startedServers.find(
    (item) => item.plan.id === serverId,
  );
  if (!started) {
    return { output: `Unknown MCP server: ${serverId}`, error: true };
  }

  try {
    const response = await requestWithTimeout(
      started.server,
      {
        jsonrpc: "2.0",
        id: makeJsonRpcRequestId(),
        method: "resources/read",
        params: { uri },
      },
      options.clientTimeoutMs,
    );
    if (!response) {
      return { output: "MCP resource read returned no response", error: true };
    }
    if ("error" in response) {
      emitMcpEvent(options.emitEvent, {
        kind: "mcp_error",
        stepId: options.getStepId?.(),
        serverId,
        resourceUri: uri,
        errorCode: response.error.code,
        message: response.error.message,
      });
      return {
        output: `MCP error ${response.error.code}: ${response.error.message}`,
        error: true,
      };
    }
    const text = readResourceText(response);
    emitMcpEvent(options.emitEvent, {
      kind: "mcp_resource_read",
      stepId: options.getStepId?.(),
      serverId,
      resourceUri: uri,
      message: previewMcpText(text),
    });
    return { output: text, error: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const errorCode =
      err instanceof McpRequestTimeoutError
        ? MCP_TIMEOUT_ERROR_CODE
        : MCP_SERVER_ERROR_CODE;
    emitMcpEvent(options.emitEvent, {
      kind: "mcp_error",
      stepId: options.getStepId?.(),
      serverId,
      resourceUri: uri,
      errorCode,
      message,
    });
    if (isMcpCrashMessage(message)) {
      emitMcpEvent(options.emitEvent, {
        kind: "mcp_server_stop",
        stepId: options.getStepId?.(),
        serverId,
        message,
      });
    }
    return { output: `MCP request failed: ${message}`, error: true };
  }
}

async function requestWithTimeout(
  server: EvalMcpFixtureServer,
  request: JsonRpcRequest,
  timeoutMs: number,
): Promise<JsonRpcResponse | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      server.request(request),
      new Promise<JsonRpcResponse>((_, reject) => {
        timer = setTimeout(
          () => reject(new McpRequestTimeoutError(timeoutMs)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function readTextContent(response: JsonRpcResponse): string {
  if ("error" in response) {
    return response.error.message;
  }
  const content = response.result["content"];
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((item) =>
      typeof item === "object" &&
      item !== null &&
      "text" in item &&
      typeof item.text === "string"
        ? item.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function readResourceText(response: JsonRpcResponse): string {
  if ("error" in response) {
    return response.error.message;
  }
  const contents = response.result["contents"];
  if (!Array.isArray(contents)) {
    return "";
  }
  return contents
    .map((item) =>
      typeof item === "object" &&
      item !== null &&
      "text" in item &&
      typeof item.text === "string"
        ? item.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

function buildMcpToolName(serverId: string, toolName: string): string {
  return `run_mcp_${sanitizeToolSegment(serverId)}_${sanitizeToolSegment(toolName)}`;
}

function sanitizeToolSegment(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, "_");
  return sanitized || "fixture";
}

function isMcpCrashMessage(message: string): boolean {
  return message.includes("crashed after");
}
