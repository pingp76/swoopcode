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
import type { SessionEventBuffer } from "../session-events.js";

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
      'Create or update a long-term memory. Use when the user explicitly asks to ' +
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
 * @param options.sessionEventBuffer - 可选的会话事件缓冲区，用于在 create/delete 后推送 reminder
 * @returns MemoryToolProvider，包含 4 个 memory 工具的定义和执行函数
 */
export function createMemoryToolProvider(
  manager: MemoryManager,
  options?: {
    sessionEventBuffer?: SessionEventBuffer;
  },
): MemoryToolProvider {
  // 设计导读：
  // Memory 工具操作的是“会影响未来会话的长期知识”，比 TODO/Task 更敏感。
  // 因此工具层做了更严格的参数校验和重复检测：
  // - name 只能是安全文件名字符，避免路径穿越
  // - description 必须单行，避免索引格式混乱
  // - create 前先 findSimilar，避免模型反复写入语义重复记忆
  //
  // 注意：Memory 创建/删除不会立即重写当前会话的 stable system prompt。
  // 它通过 sessionEventBuffer 告知后续轮次，这是 prompt cache 稳定性与实时性的取舍。

  const sessionEventBuffer = options?.sessionEventBuffer;
  /**
   * executeMemoryCreate — run_memory_create 的执行函数
   *
   * 校验 name 格式和 type 合法性后调用 manager.create()。
   * 错误时返回 ToolResult.error，不抛异常。
   */
  async function executeMemoryCreate(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    // 从 LLM 传入的参数中提取各字段，缺失时默认转为空字符串
    const name = String(args["name"] ?? "");
    const description = String(args["description"] ?? "");
    const type = String(args["type"] ?? "");
    const body = String(args["body"] ?? "");
    // allow_duplicate 只接受显式 true，其他值视为 false
    const allowDuplicate = args["allow_duplicate"] === true;

    // 参数校验：必填字段不能为空
    if (!name.trim()) {
      return { output: "Error: 'name' is required.", error: true };
    }
    if (!description.trim()) {
      return { output: "Error: 'description' is required.", error: true };
    }
    if (!body.trim()) {
      return { output: "Error: 'body' is required.", error: true };
    }
    // description 必须是单行，换行会导致格式混乱
    if (description.includes("\n")) {
      return {
        output: "Error: 'description' must be a single line.",
        error: true,
      };
    }

    // name 格式校验（防止路径穿越）：只允许小写字母、数字、下划线和连字符
    if (!/^[a-z0-9_-]+$/.test(name)) {
      return {
        output:
          "Error: Invalid name format. Only lowercase letters, numbers, underscores, and hyphens are allowed.",
        error: true,
      };
    }

    // type 合法性校验：必须是预定义的四个枚举值之一
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
      // 先查找是否已有语义相似的 memory，避免无意义的重复创建
      // 这是一个教学上很有价值的策略：长期记忆不是 append-only 垃圾桶。
      // 模型很容易把同一条偏好换个说法写很多遍，后续 prompt 会越来越嘈杂。
      // 先阻止疑似重复，让模型或用户决定是否真的需要新条目。
      const similar = manager.findSimilar(input);
      if (similar.length > 0 && !allowDuplicate) {
        // 发现潜在重复时，列出所有相似项供 LLM 决策
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

      // 通过所有校验后，调用 manager 真正创建 memory
      const entry = manager.create(input);
      const outputLines = [
        `Memory saved: [${entry.meta.type}] ${entry.meta.name}: ${entry.meta.description}`,
        "Note: the stable system prompt memory snapshot is unchanged for cache stability. Use run_memory_list/read for the latest memory if needed.",
      ];
      // 如果有会话事件缓冲区，推送提醒，让后续轮次知道 memory 已变更
      // 这里不直接修改 system prompt，也不强制重新 scan。
      // 当前轮模型已经拿到了旧 prompt 前缀；强行替换会破坏 cache 和可解释性。
      if (sessionEventBuffer) {
        sessionEventBuffer.push({
          source: "memory",
          message:
            "Memory was created or updated by tool call. Use memory tools if the latest entry matters in later turns.",
        });
      }
      return {
        output: outputLines.join("\n"),
        error: false,
      };
    } catch (err) {
      // 捕获 manager 抛出的异常，统一包装为 ToolResult 错误返回
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
    // 获取所有 memory 的元数据列表
    const metas = manager.list();
    // 空列表时给出明确提示
    if (metas.length === 0) {
      return { output: "No memories stored.", error: false };
    }

    // 将每个 memory 的元数据格式化为 "- [type] name: description" 的行
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

    // 从 manager 读取指定 name 的 memory
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

    // 删除前同样校验 name 格式，防止路径穿越攻击
    if (!/^[a-z0-9_-]+$/.test(name)) {
      return {
        output: "Error: Invalid name format.",
        error: true,
      };
    }

    // 调用 manager.delete，返回是否成功删除
    const deleted = manager.delete(name);
    if (deleted) {
      const outputLines = [
        `Memory "${name}" deleted.`,
        "Note: the stable system prompt memory snapshot may still mention it until prompt snapshot refresh.",
      ];
      // 删除成功时同样推送事件提醒，告知后续轮次快照尚未刷新
      // corner case：当前 system prompt 可能仍包含刚删除的 memory。
      // 所以工具输出和 reminder 都明确告诉模型“snapshot 可能还没刷新”。
      if (sessionEventBuffer) {
        sessionEventBuffer.push({
          source: "memory",
          message: `Memory "${name}" was deleted by tool call. The stable system prompt snapshot may still mention it until snapshot refresh.`,
        });
      }
      return { output: outputLines.join("\n"), error: false };
    }
    // name 不存在时返回错误
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
