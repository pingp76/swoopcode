/**
 * tool-trace.ts — ToolRegistry 追踪包装器
 *
 * 职责：在不修改真实工具实现的前提下，记录 tool_call 和 tool_result 事件。
 *
 * 设计原则：
 * - getToolDefinitions() 原样返回底层 registry 的定义
 * - getExecutor(name) 返回 wrapped executor
 * - wrapped executor 记录开始时间、参数、结果、错误和耗时
 * - 如果底层 executor throw，记录 error 后重新 throw，保持 Agent 原行为
 * - ToolResult 中的 error: true 记录为工具失败，但不等同于 JS throw
 */

import type { ToolRegistry } from "../../../tools/registry.js";
import type { ToolResult } from "../../../tools/types.js";
import type { AgentRuntimeEvent } from "../../core/case-schema.js";

/**
 * wrapToolRegistryForTrace — 为 ToolRegistry 包装追踪层
 *
 * @param registry - 底层工具注册表
 * @param emitEvent - 事件发射回调
 * @returns 包装后的 ToolRegistry
 */
export function wrapToolRegistryForTrace(
  registry: ToolRegistry,
  emitEvent: (event: AgentRuntimeEvent) => void,
): ToolRegistry {
  return {
    getToolDefinitions() {
      // 原样透传底层定义，不改变 LLM 看到的工具 schema
      return registry.getToolDefinitions();
    },

    getExecutor(name: string) {
      const executor = registry.getExecutor(name);
      if (!executor) {
        return undefined;
      }

      // 返回包装后的执行函数
      return async (args: Record<string, unknown>): Promise<ToolResult> => {
        // 记录 tool_call 事件
        emitEvent({
          kind: "tool_call",
          source: "tool",
          toolName: name,
          args,
        } as AgentRuntimeEvent);

        try {
          const result = await executor(args);

          // 记录 tool_result 事件
          emitEvent({
            kind: "tool_result",
            source: "tool",
            toolName: name,
            result: result.output.slice(0, 500),
            error: result.error,
          } as AgentRuntimeEvent);

          return result;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);

          // JS throw 也记录为 error 事件，然后重新 throw，保持 Agent 原行为
          emitEvent({
            kind: "tool_result",
            source: "tool",
            toolName: name,
            result: message,
            error: true,
          } as AgentRuntimeEvent);

          throw err;
        }
      };
    },
  };
}
