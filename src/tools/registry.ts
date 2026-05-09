/**
 * registry.ts — 工具注册表
 *
 * 职责：统一管理所有可用工具（注册、查询、获取定义列表）。
 *
 * 为什么需要注册表？
 * - Agent 在调用 LLM 时，需要传入所有工具的定义（让模型知道能调用哪些工具）
 * - Agent 收到模型的 tool_call 后，需要根据工具名找到对应的执行函数
 * - 注册表把"工具定义"和"工具执行"绑定在一起，管理起来更清晰
 *
 * 扩展性设计：
 * - 要添加新工具，只需要调用 register() 注册一个新的 ToolEntry
 * - 不需要修改 agent.ts 或其他模块的代码
 * - 这就是"开放-封闭原则"：对扩展开放，对修改封闭
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { bashToolDefinition, executeBash } from "./bash.js";
import {
  runReadToolDefinition,
  executeRead,
  runWriteToolDefinition,
  executeWrite,
  runEditToolDefinition,
  executeEdit,
} from "./files.js";
import type { ToolResult } from "./types.js";
import type { TodoToolProvider } from "../todo.js";
import type { SubagentToolProvider } from "./subagent.js";
import type { SkillToolProvider } from "../skills.js";
import type { MemoryToolProvider } from "./memory.js";

/**
 * ToolExecutor — 工具执行函数的类型
 *
 * 每个工具都需要提供一个执行函数：
 * - 接收一个参数字典（来自 LLM 的 JSON 解析结果）
 * - 返回 Promise<ToolResult>（因为工具执行通常是异步的）
 *
 * 参数类型为 Record<string, unknown> 而非 Record<string, string>，
 * 因为 LLM 返回的 JSON 经 JSON.parse 后值可以是 string、number、array。
 * 工具实现时需用 String() / Number() 等做类型转换。
 */
export type ToolExecutor = (args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * ToolEntry — 工具注册项
 *
 * 把"定义"和"执行"绑定在一起：
 * - definition：告诉 LLM 这个工具的接口（名称、参数、描述）
 * - execute：实际执行工具逻辑的函数
 */
interface ToolEntry {
  definition: ChatCompletionTool;
  execute: ToolExecutor;
}

/**
 * ToolRegistry — 工具注册表的接口
 *
 * 只暴露两个方法：
 * - getToolDefinitions：获取所有工具的定义（用于传给 LLM）
 * - getExecutor：根据工具名获取执行函数（用于处理 tool_call）
 */
export interface ToolRegistry {
  getToolDefinitions(): ChatCompletionTool[];
  getExecutor(name: string): ToolExecutor | undefined;
}

/**
 * createToolRegistry — 创建工具注册表
 *
 * @param todoProvider - 可选的 TodoToolProvider，提供 todo 管理工具
 * @param subagentProvider - 可选的 SubagentToolProvider，提供子智能体工具
 * @param skillProvider - 可选的 SkillToolProvider，提供 run_skill 技能调用工具
 *
 * 使用 Map 存储已注册的工具，以工具名为 key，ToolEntry 为 value。
 * Map 查找是 O(1) 的，比遍历数组更高效。
 *
 * 【稳定性要求】同一个进程内，多次 getToolDefinitions() 返回相同顺序。
 * 重复注册同名工具会抛错。CLI 命令不得在会话中途修改已注册工具定义。
 */
export function createToolRegistry(
  todoProvider?: TodoToolProvider,
  subagentProvider?: SubagentToolProvider,
  skillProvider?: SkillToolProvider,
  memoryProvider?: MemoryToolProvider,
): ToolRegistry {
  // 工具映射表：工具名 → 工具注册项
  const tools = new Map<string, ToolEntry>();
  // 按注册顺序维护的数组，保证 getToolDefinitions() 输出顺序稳定
  const orderedEntries: ToolEntry[] = [];

  /**
   * register — 注册一个工具
   *
   * 从工具定义中提取函数名作为 Map 的 key，
   * 将定义和执行函数一起存储。
   *
   * 同名工具重复注册会抛错，防止意外覆盖导致行为不一致。
   */
  function register(entry: ToolEntry): void {
    const name = entry.definition.function?.name;
    if (!name) throw new Error("Tool definition must have a function name");
    if (tools.has(name)) {
      throw new Error(`Tool "${name}" is already registered`);
    }
    tools.set(name, entry);
    orderedEntries.push(entry);
  }

  // 注册 bash 工具
  register({
    definition: bashToolDefinition,
    execute: async (args) => executeBash(String(args["command"] ?? "")),
  });

  // 注册文件读取工具
  register({
    definition: runReadToolDefinition,
    execute: async (args) => executeRead(String(args["path"] ?? "")),
  });

  // 注册文件写入工具
  register({
    definition: runWriteToolDefinition,
    execute: async (args) =>
      executeWrite(String(args["path"] ?? ""), String(args["content"] ?? "")),
  });

  // 注册文件编辑工具
  register({
    definition: runEditToolDefinition,
    execute: async (args) =>
      executeEdit(
        String(args["path"] ?? ""),
        String(args["old_string"] ?? ""),
        String(args["new_string"] ?? ""),
      ),
  });

  // 注册 todo 管理工具（6 个工具）
  // 通过 TodoToolProvider 获取定义和执行函数，与 bash/files 工具完全一致的模式
  if (todoProvider) {
    for (const entry of todoProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册子智能体工具（1 个工具）
  // 通过 SubagentToolProvider 获取定义和执行函数
  // 子智能体本身的注册表中不会传入此 provider，从而防止递归
  if (subagentProvider) {
    for (const entry of subagentProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册 skill 工具（1 个工具）
  // 通过 SkillToolProvider 获取定义和执行函数
  // 子智能体的注册表中不会传入此 provider，自然排除 skill 工具
  if (skillProvider) {
    for (const entry of skillProvider.toolEntries) {
      register(entry);
    }
  }

  // 注册 memory 工具（4 个工具）
  // 通过 MemoryToolProvider 获取定义和执行函数
  // 子智能体的注册表中不会传入此 provider，子智能体不能直接操作 memory
  if (memoryProvider) {
    for (const entry of memoryProvider.toolEntries) {
      register(entry);
    }
  }

  return {
    // 返回所有工具的定义列表，用于传给 LLM API
    // 使用 orderedEntries 保证顺序稳定，不因 Map 内部实现而变化
    getToolDefinitions() {
      return orderedEntries.map((t) => t.definition);
    },

    // 根据工具名查找执行函数，找不到返回 undefined
    getExecutor(name) {
      return tools.get(name)?.execute;
    },
  };
}
