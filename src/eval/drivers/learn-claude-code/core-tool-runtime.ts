/**
 * core-tool-runtime.ts — Eval 用真实核心工具注册表
 *
 * 职责：为 eval 提供只包含 bash/read/write/edit/editExact 的最小 ToolRegistry。
 *
 * 设计决策：
 * - 直接 import 底层工具定义和执行函数，而不是复用 createToolRegistry()。
 *   原因是 createToolRegistry() 的签名包含大量可选 provider 参数（todo/subagent/skill/
 *   memory/task/async/schedule/output）。虽然传入 undefined 也能工作，但直接组装更明确、
 *   更可控，避免了意外带入后续新增 provider 的风险。
 * - 每个工具执行时传入 projectRoot 作为路径边界，确保 eval case 的操作限制在临时
 *   workspace 内。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { bashToolDefinition, executeBash } from "../../../tools/bash.js";
import {
  runReadToolDefinition,
  runWriteToolDefinition,
  runEditToolDefinition,
  runEditExactToolDefinition,
  executeRead,
  executeWrite,
  executeEdit,
  executeEditExact,
} from "../../../tools/files.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type { ToolResult } from "../../../tools/types.js";

/**
 * createCoreEvalToolRegistry — 创建 eval 专用的真实核心工具注册表
 *
 * 只包含 bash/read/write/edit/editExact，不注册任何 todo/subagent/skill/memory 等工具。
 * 所有文件操作都限制在传入的 projectRoot 下。
 *
 * @param options.projectRoot - 工具操作的根目录（应设为临时 workspace）
 * @param options.includeBash - 是否注册 run_bash（默认 true）
 * @param options.includeRead - 是否注册 run_read（默认 true）
 * @param options.includeWrite - 是否注册 run_write（默认 true）
 * @param options.includeEdit - 是否注册 run_edit（默认 true）
 * @param options.includeEditExact - 是否注册 run_edit_exact（默认 true）
 */
export function createCoreEvalToolRegistry(options: {
  projectRoot: string;
  includeBash?: boolean;
  includeRead?: boolean;
  includeWrite?: boolean;
  includeEdit?: boolean;
  includeEditExact?: boolean;
}): ToolRegistry {
  // 使用数组保持工具注册顺序，与 LLM 看到的定义顺序一致
  const definitions: ChatCompletionTool[] = [];
  const executors = new Map<
    string,
    (args: Record<string, unknown>) => Promise<ToolResult>
  >();

  /**
   * register — 将单个工具注册到内部集合
   *
   * 同时把定义（供 LLM 调用时传入）和执行器（实际执行逻辑）配对存储。
   */
  function register(
    definition: ChatCompletionTool,
    execute: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): void {
    definitions.push(definition);
    executors.set(definition.function.name, execute);
  }

  // 注册 bash 工具
  // 直接调用 executeBash，传入 projectRoot 作为执行目录边界
  if (options.includeBash !== false) {
    register(bashToolDefinition, async (args) => {
      const command = String(args["command"] ?? "");
      return executeBash(command, options.projectRoot);
    });
  }

  // 注册文件读取工具
  // 传入 projectRoot 作为路径边界，防止读取 workspace 外文件
  if (options.includeRead !== false) {
    register(runReadToolDefinition, async (args) => {
      const path = String(args["path"] ?? "");
      return executeRead(path, options.projectRoot);
    });
  }

  // 注册文件写入工具
  // 传入 projectRoot 确保写入操作限制在临时 workspace 内
  if (options.includeWrite !== false) {
    register(runWriteToolDefinition, async (args) => {
      const path = String(args["path"] ?? "");
      const content = String(args["content"] ?? "");
      return executeWrite(path, content, options.projectRoot);
    });
  }

  // 注册文件编辑工具
  // run_edit 使用 replaceAll 语义，run_edit_exact 使用精确匹配次数语义
  if (options.includeEdit !== false) {
    register(runEditToolDefinition, async (args) => {
      const path = String(args["path"] ?? "");
      const oldString = String(args["old_string"] ?? "");
      const newString = String(args["new_string"] ?? "");
      return executeEdit(path, oldString, newString, options.projectRoot);
    });
  }

  if (options.includeEditExact !== false) {
    register(runEditExactToolDefinition, async (args) => {
      const path = String(args["path"] ?? "");
      const oldString = String(args["old_string"] ?? "");
      const newString = String(args["new_string"] ?? "");
      const expectedOccurrences = Number(args["expected_occurrences"] ?? 0);
      return executeEditExact(
        path,
        oldString,
        newString,
        expectedOccurrences,
        options.projectRoot,
      );
    });
  }

  return {
    getToolDefinitions() {
      return definitions;
    },
    getExecutor(name: string) {
      return executors.get(name);
    },
  };
}
