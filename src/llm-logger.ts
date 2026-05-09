/**
 * llm-logger.ts — LLM 通信日志记录器
 *
 * 职责：将 Agent 与 LLM 之间的原始通信完整记录到本地文件。
 *
 * 设计原则：
 * - **完整保留原始内容**：不做任何截断或省略，确保能从日志中发现所有问题
 * - **格式化为易读结构**：缩进、角色标签、JSON 美化，方便人眼阅读
 * - **请求-响应成对**：每组用空行 + 分隔线隔开，一目了然
 *
 * 文件策略：
 * - 固定文件 logs/llm.log，不按 session 创建新文件
 * - 文件超过 maxSize 时清空重写（从头开始）
 * - 每次 Agent 启动时写入启动标记
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { LLMResponse } from "./llm.js";
import type { CacheDebugState } from "./cache-debug.js";

// ============================================================
// 接口定义
// ============================================================

/**
 * LLMLogger — LLM 通信日志记录器接口
 */
export interface LLMLogger {
  logRequest(
    messages: ChatCompletionMessageParam[],
    tools?: ChatCompletionTool[],
    cacheDebug?: CacheDebugState,
  ): void;
  logResponse(response: LLMResponse, durationMs: number): void;
}

// ============================================================
// 格式化函数
// ============================================================

const SEPARATOR = "=".repeat(60);

/**
 * formatMessages — 格式化消息列表
 *
 * 每条消息完整输出，包括角色、内容、tool_calls 等。
 * 多行内容会缩进对齐。不截断任何内容。
 */
function formatMessages(messages: ChatCompletionMessageParam[]): string {
  const lines = [`Messages (${messages.length}):`];
  for (const msg of messages) {
    const roleTag = `[${msg.role}]`;

    if (msg.role === "assistant" && "tool_calls" in msg && Array.isArray(msg.tool_calls)) {
      if (msg.content) {
        lines.push(indent(`${roleTag} ${msg.content}`, 2));
      } else {
        lines.push(indent(`${roleTag}`, 2));
      }
      for (const tc of msg.tool_calls) {
        lines.push(indent(`→ tool_call:`, 6));
        lines.push(indent(`id: ${tc.id}`, 8));
        lines.push(indent(`function: ${tc.function.name}`, 8));
        try {
          const parsed = JSON.parse(tc.function.arguments);
          lines.push(indent(`arguments: ${JSON.stringify(parsed, null, 2)}`, 8));
        } catch {
          lines.push(indent(`arguments: ${tc.function.arguments}`, 8));
        }
      }
    } else if (msg.role === "tool") {
      const toolCallId = "tool_call_id" in msg ? msg.tool_call_id : "(unknown)";
      lines.push(indent(`${roleTag} tool_call_id=${toolCallId}`, 2));
      lines.push(indent(String(msg.content ?? "(null)"), 6));
    } else {
      const content = msg.content ?? "(null)";
      lines.push(indent(`${roleTag} ${content}`, 2));
    }
  }
  return lines.join("\n");
}

/**
 * formatTools — 格式化工具定义列表
 */
function formatTools(tools: ChatCompletionTool[]): string {
  if (tools.length === 0) return "Tools: (none)";
  const lines = [`Tools (${tools.length}):`];
  for (const t of tools) {
    if (t.function) {
      lines.push(`  - ${t.function.name}: ${t.function.description ?? "(no description)"}`);
    }
  }
  return lines.join("\n");
}

/**
 * formatToolCalls — 格式化 LLM 返回的工具调用
 */
function formatToolCalls(response: LLMResponse): string {
  if (response.toolCalls.length === 0) return "Tool Calls: (none)";

  const lines = [`Tool Calls (${response.toolCalls.length}):`];
  for (let i = 0; i < response.toolCalls.length; i++) {
    const tc = response.toolCalls[i]!;
    lines.push(`  [${i}] ${tc.function.name}:`);
    try {
      const parsed = JSON.parse(tc.function.arguments);
      lines.push(indent(JSON.stringify(parsed, null, 2), 6));
    } catch {
      lines.push(indent(tc.function.arguments, 6));
    }
  }
  return lines.join("\n");
}

/**
 * indent — 给多行文本的每一行添加缩进
 */
function indent(text: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return text
    .split("\n")
    .map((line) => prefix + line)
    .join("\n");
}

// ============================================================
// 工厂函数
// ============================================================

/**
 * createLLMLogger — 创建 LLM 通信日志记录器
 *
 * @param options.logDir - 日志目录（默认 "logs"）
 * @param options.maxSize - 文件最大字节数（默认 1MB），超过后清空重写
 */
export function createLLMLogger(options?: {
  logDir?: string;
  maxSize?: number;
}): LLMLogger {
  const logDir = options?.logDir ?? "logs";
  const maxSize = options?.maxSize ?? 1024 * 1024; // 1MB
  const logFile = path.join(logDir, "llm.log");

  // 确保 logs 目录存在
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // 每次启动清空文件，写入启动标记
  const bootTimestamp = new Date().toISOString();
  fs.writeFileSync(
    logFile,
    `${SEPARATOR}\n[BOOT] ${bootTimestamp}\n${SEPARATOR}\n\n`,
  );

  /**
   * appendLog — 追加日志，超过大小限制时清空重来
   */
  function appendLog(content: string): void {
    try {
      const stat = fs.statSync(logFile);
      if (stat.size >= maxSize) {
        // 超过大小限制，清空文件并写入重置标记
        const resetTimestamp = new Date().toISOString();
        fs.writeFileSync(
          logFile,
          `${SEPARATOR}\n[RESET] ${resetTimestamp} — file exceeded ${maxSize} bytes\n${SEPARATOR}\n\n`,
        );
      }
    } catch {
      // 文件不存在，appendFileSync 会自动创建
    }
    fs.appendFileSync(logFile, content + "\n");
  }

  return {
    logRequest(messages, tools, cacheDebug) {
      const timestamp = new Date().toISOString();
      const lines = [
        "",
        SEPARATOR,
        `[REQUEST] ${timestamp}`,
        SEPARATOR,
        formatMessages(messages),
        tools && tools.length > 0 ? formatTools(tools) : "",
      ];
      if (cacheDebug) {
        lines.push(
          `Cache Debug:\n  systemPromptHash: ${cacheDebug.current.systemPromptHash}\n  toolsHash: ${cacheDebug.current.toolsHash}\n  stablePrefixHash: ${cacheDebug.current.stablePrefixHash}\n  systemPromptChanged: ${cacheDebug.changed.systemPrompt ? "yes" : "no"}\n  toolsChanged: ${cacheDebug.changed.tools ? "yes" : "no"}`,
        );
      }
      lines.push("");
      const log = lines.filter((line, idx) => idx > 0 || line !== "").join("\n");
      appendLog(log);
    },

    logResponse(response, durationMs) {
      const elapsed = (durationMs / 1000).toFixed(1);
      const timestamp = new Date().toISOString();
      const log = [
        SEPARATOR,
        `[RESPONSE] ${timestamp} (${elapsed}s)`,
        SEPARATOR,
        `Content: ${response.content ?? "(null)"}`,
        formatToolCalls(response),
        "",
      ].join("\n");
      appendLog(log);
    },
  };
}
