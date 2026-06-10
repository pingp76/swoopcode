/**
 * mcp-trace.ts — Eval MCP 事件辅助模块
 *
 * 职责：把 MCP fixture/client 运行时观察到的生命周期、工具和资源事件
 * 统一转换为 Eval Trace 的标准事件。
 *
 * 这里不保存完整参数或 secret，只记录 serverId、toolName、resourceUri、
 * errorCode 和短文本摘要，便于集成测试做结构化断言。
 */

import type {
  AgentRuntimeEvent,
  McpRuntimeEvent,
} from "../core/case-schema.js";

/** MCP trace 发射函数。 */
export type McpTraceEmitter = (event: AgentRuntimeEvent) => void;

/**
 * emitMcpEvent — 发射 MCP runtime event
 *
 * driver 的 emitEvent 会统一补 id/timestamp，因此这里保持薄封装。
 */
export function emitMcpEvent(
  emit: McpTraceEmitter,
  event: Omit<McpRuntimeEvent, "id" | "timestamp" | "source" | "stepId"> & {
    stepId?: string | undefined;
  },
): void {
  emit({
    ...event,
    source: "driver",
  } as AgentRuntimeEvent);
}

/**
 * previewMcpText — 生成安全的短文本摘要
 *
 * MCP tool/resource 可能返回较长内容；trace 只需要做断言和调试，
 * 因此截断到固定长度，避免 trace 文件膨胀。
 */
export function previewMcpText(text: string, limit = 500): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}...`;
}
