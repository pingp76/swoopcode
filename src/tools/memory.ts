/**
 * tools/memory.ts — Memory 工具提供者
 *
 * 职责：将 MemoryManager 包装成 LLM 可调用的工具（function calling）。
 *
 * 提供 4 个工具：
 * - run_memory_create: 创建或更新一条长期记忆
 * - run_memory_list: 列出所有 memory 摘要
 * - run_memory_read: 读取单条 memory 的完整内容
 * - run_memory_delete: 删除一条 memory
 *
 * 遵循与 TodoToolProvider、SkillToolProvider 完全一致的模式：
 * 导出 MemoryToolProvider 接口和 createMemoryToolProvider() 工厂函数。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolResult } from "./types.js";
import type { MemoryManager } from "../memory.js";

// ============================================================================
// 类型定义
// ============================================================================

/**
 * MemoryToolProvider — Memory 工具提供者接口
 *
 * 与 TodoToolProvider、SubagentToolProvider、SkillToolProvider 模式一致：
 * 提供 toolEntries 数组，由 createToolRegistry 批量注册。
 */
export interface MemoryToolProvider {
  /** 工具注册项数组：每个包含定义和执行函数 */
  toolEntries: Array<{
    definition: ChatCompletionTool;
    execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  }>;
}

// ============================================================================
// 工具定义
// ============================================================================

/** run_memory_create — 创建或更新一条长期记忆 */
const memoryCreateDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_memory_create",
    description:
      "Create or update a long-term memory. Use when the user explicitly asks to " +
      '"remember" something, or when the user confirms a suggested memory. ' +
      "Memory persists across sessions, so only store information that will be " +
      "valuable in many future conversations. Before creating a new memory, check " +
      "existing memories and prefer updating an existing name when the meaning is similar. " +
      "Never create memory without user confirmation.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description:
            "Unique identifier (lowercase letters, numbers, underscores, hyphens only)",
        },
        description: {
          type: "string",
          description: "One-line summary of this memory",
        },
        type: {
          type: "string",
          enum: ["user", "feedback", "project", "reference"],
          description:
            "Memory type: user=preference, feedback=correction, project=long-term convention, reference=external resource",
        },
        body: {
          type: "string",
          description: "Full content of this memory in Markdown",
        },
        allow_duplicate: {
          type: "boolean",
          description:
            "Set true only after the user explicitly confirms they want a separate memory even though a similar memory exists",
        },
      },
      required: ["name", "description", "type", "body"],
    },
  },
};

/** run_memory_list — 列出所有 memory 摘要 */
const memoryListDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_memory_list",
    description: "List all stored memories (summary only, no body content).",
    parameters: {
      type: "object",
      properties: {},
    },
  },
};

/** run_memory_read — 读取单条 memory 的完整内容 */
const memoryReadDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_memory_read",
    description: "Read the full content of a specific memory entry.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The memory name to read",
        },
      },
      required: ["name"],
    },
  },
};

/** run_memory_delete — 删除一条 memory */
const memoryDeleteDef: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_memory_delete",
    description: "Delete a long-term memory entry.",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "The memory name to delete",
        },
      },
      required: ["name"],
    },
  },
};

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * createMemoryToolProvider — 创建 Memory 工具提供者
 *
 * @param manager - MemoryManager 实例
 * @returns MemoryToolProvider，包含 4 个 memory 工具的定义和执行函数
 */
export function createMemoryToolProvider(
  manager: MemoryManager,
): MemoryToolProvider {
  /**
   * executeMemoryCreate — run_memory_create 的执行函数
   *
   * 校验 name 格式和 type 合法性后调用 manager.create()。
   * 错误时返回 ToolResult.error，不抛异常。
   */
  async function executeMemoryCreate(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = String(args["name"] ?? "");
    const description = String(args["description"] ?? "");
    const type = String(args["type"] ?? "");
    const body = String(args["body"] ?? "");
    const allowDuplicate = args["allow_duplicate"] === true;

    // 参数校验
    if (!name.trim()) {
      return { output: "Error: 'name' is required.", error: true };
    }
    if (!description.trim()) {
      return { output: "Error: 'description' is required.", error: true };
    }
    if (!body.trim()) {
      return { output: "Error: 'body' is required.", error: true };
    }
    if (description.includes("\n")) {
      return {
        output: "Error: 'description' must be a single line.",
        error: true,
      };
    }

    // name 格式校验（防止路径穿越）
    if (!/^[a-z0-9_-]+$/.test(name)) {
      return {
        output:
          "Error: Invalid name format. Only lowercase letters, numbers, underscores, and hyphens are allowed.",
        error: true,
      };
    }

    // type 合法性校验
    const validTypes = ["user", "feedback", "project", "reference"];
    if (!validTypes.includes(type)) {
      return {
        output: `Error: Invalid type "${type}". Must be one of: ${validTypes.join(", ")}.`,
        error: true,
      };
    }

    try {
      const input = {
        name,
        description,
        type: type as "user" | "feedback" | "project" | "reference",
        body,
      };
      const similar = manager.findSimilar(input);
      if (similar.length > 0 && !allowDuplicate) {
        const lines = similar.map(
          (item) =>
            `  - [${item.entry.meta.type}] ${item.entry.meta.name}: ${item.entry.meta.description} (${item.reason})`,
        );
        return {
          output: [
            "Potential duplicate memory found. No memory was written.",
            ...lines,
            "",
            "Teaching rule: reuse the existing memory name to update it, or ask the user whether the old memory should be deleted before creating a new one.",
            "If the user explicitly wants both memories, call run_memory_create again with allow_duplicate: true.",
          ].join("\n"),
          error: true,
        };
      }

      const entry = manager.create(input);
      return {
        output: `Memory saved: [${entry.meta.type}] ${entry.meta.name}: ${entry.meta.description}`,
        error: false,
      };
    } catch (err) {
      return {
        output: `Error: ${err instanceof Error ? err.message : String(err)}`,
        error: true,
      };
    }
  }

  /**
   * executeMemoryList — run_memory_list 的执行函数
   *
   * 返回索引风格的列表，不返回完整正文。
   */
  async function executeMemoryList(): Promise<ToolResult> {
    const metas = manager.list();
    if (metas.length === 0) {
      return { output: "No memories stored.", error: false };
    }

    const lines = metas.map(
      (m) => `  - [${m.type}] ${m.name}: ${m.description}`,
    );
    return {
      output: ["Memory:", ...lines].join("\n"),
      error: false,
    };
  }

  /**
   * executeMemoryRead — run_memory_read 的执行函数
   *
   * 返回完整的 meta 信息和正文。
   */
  async function executeMemoryRead(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = String(args["name"] ?? "");
    if (!name.trim()) {
      return { output: "Error: 'name' is required.", error: true };
    }

    const entry = manager.read(name);
    if (!entry) {
      return { output: `Error: Memory "${name}" not found.`, error: true };
    }

    // 格式化输出：meta 信息 + 正文
    const header = [
      `[${entry.meta.type}] ${entry.meta.name}`,
      `Description: ${entry.meta.description}`,
      `Created: ${entry.meta.createdAt}`,
      `Updated: ${entry.meta.updatedAt}`,
      "---",
    ].join("\n");

    return {
      output: `${header}\n${entry.body}`,
      error: false,
    };
  }

  /**
   * executeMemoryDelete — run_memory_delete 的执行函数
   */
  async function executeMemoryDelete(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = String(args["name"] ?? "");
    if (!name.trim()) {
      return { output: "Error: 'name' is required.", error: true };
    }

    // 防止路径穿越
    if (!/^[a-z0-9_-]+$/.test(name)) {
      return {
        output: "Error: Invalid name format.",
        error: true,
      };
    }

    const deleted = manager.delete(name);
    if (deleted) {
      return { output: `Memory "${name}" deleted.`, error: false };
    }
    return { output: `Error: Memory "${name}" not found.`, error: true };
  }

  // 构建工具注册项
  return {
    toolEntries: [
      { definition: memoryCreateDef, execute: executeMemoryCreate },
      { definition: memoryListDef, execute: executeMemoryList },
      { definition: memoryReadDef, execute: executeMemoryRead },
      { definition: memoryDeleteDef, execute: executeMemoryDelete },
    ],
  };
}
