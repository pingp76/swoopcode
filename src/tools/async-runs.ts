/**
 * async-runs.ts — Async Run 工具提供者
 *
 * 职责：定义 4 个 async run 工具，让 LLM 可以启动、查询和管理异步运行实例。
 *
 * 四个工具：
 * - run_async_start: 启动异步运行（command 或 subagent）
 * - run_async_check: 查询单个运行状态
 * - run_async_list: 列出所有运行
 * - run_async_output_read: 读取完整输出
 *
 * 设计要点：
 * - 工具返回 JSON 格式的结构化数据（不是纯文本）
 * - run_id 是唯一身份，避免与 PDD12 的 task_id 混淆
 * - 参数校验严格：参数错误直接返回 error，不创建 record
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolResult } from "./types.js";
import type {
  AsyncRunManager,
  AsyncRunRecord,
} from "../async-runs.js";
import type { AsyncCommandPolicy } from "../execution-policy.js";

/**
 * AsyncRunToolProvider — async run 工具提供者接口
 */
export interface AsyncRunToolProvider {
  toolEntries: Array<{
    definition: ChatCompletionTool;
    execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  }>;
}

// ---------------------------------------------------------------------------
// 工具定义
// ---------------------------------------------------------------------------

const runAsyncStartDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_async_start",
    description:
      "Start a non-blocking async run. Use this for long-running tasks " +
      "that should execute in parallel while you continue other work. " +
      "Supports two executors: 'command' (bash) and 'subagent' (delegated AI task). " +
      "Max 3 concurrent async runs. Check status with run_async_check or run_async_list. " +
      "Read output with run_async_output_read.",
    parameters: {
      type: "object",
      properties: {
        executor: {
          type: "string",
          enum: ["command", "subagent"],
          description: "The executor type: 'command' for shell commands, 'subagent' for delegated AI tasks",
        },
        command: {
          type: "string",
          description:
            "Bash command to execute (required when executor='command'). " +
            "Choose this executor when you already know the exact command and raw stdout/stderr is sufficient. " +
            'Examples: "npm run typecheck", "git diff", "npm test".',
        },
        prompt: {
          type: "string",
          description:
            "Task prompt for the subagent (required when executor='subagent'). " +
            "Choose this executor when the goal is clear but the exact steps are not — " +
            "the child Agent will explore, read files, run diagnostic commands, and return a summary.",
        },
        title: {
          type: "string",
          description: "Short descriptive title for this async run",
        },
        group_id: {
          type: "string",
          description: "Optional: associated Task Group ID",
        },
        task_id: {
          type: "string",
          description: "Optional: associated Task ID within the group",
        },
        resources: {
          type: "object",
          description: "Resource declaration: read_paths and write_paths (write_paths must be empty in v1)",
          properties: {
            read_paths: {
              type: "array",
              items: { type: "string" },
              description: "Paths the async run is allowed to read",
              default: [],
            },
            write_paths: {
              type: "array",
              items: { type: "string" },
              description: "Paths the async run is allowed to write (must be empty in v1)",
              default: [],
            },
          },
          required: ["read_paths", "write_paths"],
        },
        timeout_ms: {
          type: "number",
          description: "Timeout in milliseconds (default 120000, max 300000)",
        },
        max_rounds: {
          type: "number",
          description: "Max rounds for subagent (default 8, max 20)",
        },
      },
      required: ["executor", "title", "resources"],
    },
  },
};

const runAsyncCheckDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_async_check",
    description: "Check the status of a single async run by ID.",
    parameters: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "The async run ID",
        },
      },
      required: ["run_id"],
    },
  },
};

const runAsyncListDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_async_list",
    description: "List async runs with optional status filter.",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["running", "completed", "failed", "timeout", "abandoned"],
          description: "Filter by status",
        },
        include_terminal: {
          type: "boolean",
          description: "Include completed/failed/timeout runs (default true)",
        },
      },
    },
  },
};

const runAsyncOutputReadDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_async_output_read",
    description: "Read the full output of an async run by ID.",
    parameters: {
      type: "object",
      properties: {
        run_id: {
          type: "string",
          description: "The async run ID",
        },
        max_bytes: {
          type: "number",
          description: "Maximum bytes to read (default 20000, max 100000)",
        },
      },
      required: ["run_id"],
    },
  },
};

// ---------------------------------------------------------------------------
// 格式化辅助函数
// ---------------------------------------------------------------------------

/**
 * formatAsyncRunRecord — 将 record 格式化为 JSON 字符串输出
 */
function formatAsyncRunRecord(record: AsyncRunRecord): string {
  return JSON.stringify(
    {
      type: "async_run_started",
      run_id: record.id,
      status: record.status,
      executor: record.executor,
      title: record.title,
      group_id: record.groupId,
      persistent_task_id: record.persistentTaskId,
      started_at: record.startedAt,
      timeout_at: record.timeoutAt,
      resource_claim: {
        read_paths: record.resourceClaim.readPaths,
        write_paths: record.resourceClaim.writePaths,
      },
    },
    null,
    2,
  );
}

/**
 * formatAsyncRunStatus — 将 record 格式化为状态查询输出
 */
function formatAsyncRunStatus(record: AsyncRunRecord): string {
  return JSON.stringify(
    {
      type: "async_run_status",
      run_id: record.id,
      status: record.status,
      executor: record.executor,
      title: record.title,
      started_at: record.startedAt,
      finished_at: record.finishedAt ?? null,
      duration_ms: record.durationMs ?? null,
      preview: record.preview,
      output_ref: record.outputPath
        ? {
            run_id: record.id,
            output_id: record.outputId ?? null,
            path: record.outputPath,
          }
        : null,
      error: record.error ?? null,
    },
    null,
    2,
  );
}

/**
 * formatAsyncRunList — 将 record 数组格式化为列表输出
 */
function formatAsyncRunList(records: AsyncRunRecord[]): string {
  return JSON.stringify(
    {
      type: "async_run_list",
      count: records.length,
      runs: records.map((r) => ({
        run_id: r.id,
        title: r.title,
        status: r.status,
        executor: r.executor,
        started_at: r.startedAt,
        timeout_at: r.timeoutAt,
        finished_at: r.finishedAt ?? null,
        duration_ms: r.durationMs ?? null,
        preview: r.preview,
        output_id: r.outputId ?? null,
      })),
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createAsyncRunToolProvider — 创建 Async Run 工具提供者
 *
 * @param manager - AsyncRunManager 实例
 */
export function createAsyncRunToolProvider(
  manager: AsyncRunManager,
  commandPolicy?: AsyncCommandPolicy,
): AsyncRunToolProvider {
  async function executeStart(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const executor = String(args["executor"] ?? "");
    const title = String(args["title"] ?? "").trim();

    if (!title) {
      return { output: "Error: title is required", error: true };
    }

    if (executor !== "command" && executor !== "subagent") {
      return {
        output: "Error: executor must be 'command' or 'subagent'",
        error: true,
      };
    }

    const command = args["command"] ? String(args["command"]) : undefined;
    const prompt = args["prompt"] ? String(args["prompt"]) : undefined;

    if (executor === "command" && !command) {
      return {
        output: "Error: command is required when executor='command'",
        error: true,
      };
    }

    if (executor === "subagent" && !prompt) {
      return {
        output: "Error: prompt is required when executor='subagent'",
        error: true,
      };
    }

    // resources 必填校验
    if (!args["resources"]) {
      return {
        output: "Error: resources is required",
        error: true,
      };
    }

    // resources 必须是对象（不能是数组），且必须包含 read_paths 和 write_paths
    const resources = args["resources"];
    if (
      typeof resources !== "object" ||
      Array.isArray(resources) ||
      resources === null
    ) {
      return {
        output: "Error: resources must be an object with read_paths and write_paths",
        error: true,
      };
    }
    if (!Array.isArray((resources as Record<string, unknown>)["read_paths"])) {
      return {
        output: "Error: resources.read_paths must be an array",
        error: true,
      };
    }
    if (!Array.isArray((resources as Record<string, unknown>)["write_paths"])) {
      return {
        output: "Error: resources.write_paths must be an array",
        error: true,
      };
    }

    // command executor 必须经过 commandPolicy 预检
    if (executor === "command" && command && commandPolicy) {
      const validation = commandPolicy.validate(command);
      if (!validation.allowed) {
        return {
          output: `Error: ${validation.reason}`,
          error: true,
        };
      }
    }

    try {
      const startInput: import("../async-runs.js").StartAsyncRunInput = {
        executor: executor as "command" | "subagent",
        title,
      };
      if (command) startInput.command = command;
      if (prompt) startInput.prompt = prompt;
      if (args["group_id"])
        startInput.groupId = String(args["group_id"]);
      if (args["task_id"])
        startInput.persistentTaskId = String(args["task_id"]);
      if (args["resources"])
        startInput.resources = args["resources"] as {
          read_paths?: string[];
          write_paths?: string[];
        };
      if (args["timeout_ms"] !== undefined) {
        const timeoutMs = Number(args["timeout_ms"]);
        if (timeoutMs < 0) {
          return { output: "Error: timeout_ms must be non-negative", error: true };
        }
        startInput.timeoutMs = timeoutMs;
      }
      if (args["max_rounds"] !== undefined) {
        const maxRounds = Number(args["max_rounds"]);
        if (maxRounds < 0) {
          return { output: "Error: max_rounds must be non-negative", error: true };
        }
        startInput.maxRounds = maxRounds;
      }

      const record = manager.start(startInput);

      return {
        output: formatAsyncRunRecord(record),
        error: false,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      return {
        output: `Error starting async run: ${message}`,
        error: true,
      };
    }
  }

  async function executeCheck(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const runId = String(args["run_id"] ?? "");
    if (!runId) {
      return { output: "Error: run_id is required", error: true };
    }

    const record = manager.check(runId);
    if (!record) {
      return {
        output: `Error: Async run not found: ${runId}`,
        error: true,
      };
    }

    return {
      output: formatAsyncRunStatus(record),
      error: false,
    };
  }

  async function executeList(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const status = args["status"]
      ? String(args["status"])
      : undefined;
    const query: import("../async-runs.js").AsyncRunListQuery = {};
    if (status) query.status = status as import("../async-runs.js").AsyncRunStatus;
    if (args["include_terminal"] !== undefined)
      query.includeTerminal = Boolean(args["include_terminal"]);

    const records = manager.list(query);

    return {
      output: formatAsyncRunList(records),
      error: false,
    };
  }

  async function executeOutputRead(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const runId = String(args["run_id"] ?? "");
    if (!runId) {
      return { output: "Error: run_id is required", error: true };
    }

    const maxBytes =
      args["max_bytes"] !== undefined
        ? Number(args["max_bytes"])
        : undefined;
    if (maxBytes !== undefined && maxBytes < 0) {
      return { output: "Error: max_bytes must be non-negative", error: true };
    }

    try {
      const readInput: import("../async-runs.js").ReadAsyncRunOutputInput = {
        runId,
      };
      if (maxBytes !== undefined) readInput.maxBytes = maxBytes;
      const content = manager.readOutput(readInput);
      const record = manager.check(runId);
      return {
        output: JSON.stringify(
          {
            type: "async_run_output",
            run_id: runId,
            output_id: record?.outputId ?? null,
            content,
          },
          null,
          2,
        ),
        error: false,
      };
    } catch (err) {
      const message =
        err instanceof Error ? err.message : String(err);
      return {
        output: `Error reading output: ${message}`,
        error: true,
      };
    }
  }

  return {
    toolEntries: [
      {
        definition: runAsyncStartDefinition,
        execute: executeStart,
      },
      {
        definition: runAsyncCheckDefinition,
        execute: executeCheck,
      },
      {
        definition: runAsyncListDefinition,
        execute: executeList,
      },
      {
        definition: runAsyncOutputReadDefinition,
        execute: executeOutputRead,
      },
    ],
  };
}
