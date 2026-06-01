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
 * - 文件超过 maxSize 时轮转为 llm.log.1、llm.log.2……
 * - 每次 Agent 启动时追加启动标记，不再清空旧日志
 */

import * as fs from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { LLMResponse } from "./llm.js";
import type { CacheDebugState } from "./cache-debug.js";
import { rotateLogFileIfNeeded } from "./log-rotation.js";

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
 * formatSystemPrompt — 单独格式化 system prompt
 *
 * 从消息列表中提取 system 消息，单独显示在日志最前面，
 * 强调它是 cache 稳定前缀的第一部分。
 *
 * 若传入 cacheDebug，附加 hash 和变化标记。
 */
function formatSystemPrompt(
  content: string,
  cacheDebug?: CacheDebugState,
): string {
  const lines = [`System Prompt:`];
  lines.push(indent(content, 2));
  if (cacheDebug) {
    const changedMark = cacheDebug.changed.systemPrompt ? "CHANGED" : "stable";
    lines.push(
      indent(
        `# hash=${cacheDebug.current.systemPromptHash} (${changedMark})`,
        2,
      ),
    );
  }
  return lines.join("\n");
}

/**
 * formatMessages — 格式化消息列表（不含 system）
 *
 * 每条消息完整输出，包括角色、内容、tool_calls 等。
 * 多行内容会缩进对齐。不截断任何内容。
 */
function formatMessages(messages: ChatCompletionMessageParam[]): string {
  const lines = [`Messages (${messages.length}):`];
  for (const msg of messages) {
    const roleTag = `[${msg.role}]`;

    if (
      msg.role === "assistant" &&
      "tool_calls" in msg &&
      Array.isArray(msg.tool_calls)
    ) {
      if (msg.content) {
        lines.push(
          indent(`${roleTag} ${formatMessageContent(msg.content)}`, 2),
        );
      } else {
        lines.push(indent(`${roleTag}`, 2));
      }
      for (const tc of msg.tool_calls) {
        lines.push(indent(`→ tool_call:`, 6));
        lines.push(indent(`id: ${tc.id}`, 8));
        lines.push(indent(`function: ${tc.function.name}`, 8));
        try {
          const parsed = JSON.parse(tc.function.arguments);
          lines.push(
            indent(`arguments: ${JSON.stringify(parsed, null, 2)}`, 8),
          );
        } catch {
          lines.push(indent(`arguments: ${tc.function.arguments}`, 8));
        }
      }
    } else if (msg.role === "tool") {
      const toolCallId = "tool_call_id" in msg ? msg.tool_call_id : "(unknown)";
      lines.push(indent(`${roleTag} tool_call_id=${toolCallId}`, 2));
      lines.push(indent(formatMessageContent(msg.content), 6));
    } else {
      lines.push(indent(`${roleTag} ${formatMessageContent(msg.content)}`, 2));
    }
  }
  return lines.join("\n");
}

/**
 * formatTools — 格式化工具定义列表
 *
 * 若传入 cacheDebug，在标题行附加 toolsHash 和变化标记，
 * 便于直接从工具结构观察工具定义是否发生变化。
 */
function formatTools(
  tools: ChatCompletionTool[],
  cacheDebug?: CacheDebugState,
): string {
  if (tools.length === 0) return "Tools: (none)";
  const changedMark = cacheDebug
    ? cacheDebug.changed.tools
      ? "CHANGED"
      : "stable"
    : null;
  const hashSuffix = cacheDebug
    ? ` hash=${cacheDebug.current.toolsHash} (${changedMark})`
    : "";
  const lines = [`Tools (${tools.length}):${hashSuffix}`];
  for (const t of tools) {
    if (t.function) {
      lines.push(
        `  - ${t.function.name}: ${t.function.description ?? "(no description)"}`,
      );
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
 * formatMessageContent — 将消息的 content 格式化为可读的字符串
 *
 * 处理 string、array（多模态内容块）和 null/undefined 三种情况。
 * 当 content 为数组时，提取 text 类型的内容块；遇到非 text 类型用占位符表示。
 */
function formatMessageContent(
  content: string | unknown[] | null | undefined,
): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    if (content.length === 0) return "(empty array)";
    const parts = content
      .filter(
        (b): b is Record<string, unknown> =>
          typeof b === "object" && b !== null,
      )
      .map((b) => {
        if (b.type === "text" && typeof b.text === "string") return b.text;
        return `<${b.type}>`;
      });
    if (parts.length > 0) return parts.join("\n");
    return JSON.stringify(content);
  }
  return "(null)";
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
 * @param options.logDir - 日志目录（默认 Agent 全局运行目录下的 "logs"）
 * @param options.maxSize - 文件最大字节数（默认 1MB），超过后清空重写
 */
export function createLLMLogger(options?: {
  logDir?: string;
  maxSize?: number;
  keepFiles?: number;
}): LLMLogger {
  const logDir =
    options?.logDir ??
    path.resolve(
      process.env["AGENT_HOME"] ??
        path.resolve(homedir(), ".learn-claude-code-ts"),
      "logs",
    );
  const maxSize = options?.maxSize ?? 5 * 1024 * 1024; // 5MB
  const keepFiles = options?.keepFiles ?? 5;
  const logFile = path.join(logDir, "llm.log");

  // 确保 logs 目录存在
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // 每次启动追加启动标记。写入前先检查轮转，避免一个长期运行的 llm.log
  // 因为反复 append 变成无限增长的单个大文件。
  const bootTimestamp = new Date().toISOString();
  appendLog(
    `${SEPARATOR}\n[BOOT] ${bootTimestamp}\n${SEPARATOR}\n\n`,
  );

  /**
   * appendLog — 追加日志，超过大小限制时清空重来
   */
  function appendLog(content: string): void {
    try {
      rotateLogFileIfNeeded(logFile, {
        maxFileBytes: maxSize,
        keepFiles,
        onWarning: (message) => console.warn(message),
      });
    } catch {
      // 轮转失败不阻塞日志写入；appendFileSync 会在文件不存在时自动创建。
    }
    fs.appendFileSync(logFile, content + "\n");
  }

  return {
    logRequest(messages, tools, cacheDebug) {
      const timestamp = new Date().toISOString();

      // 将 system prompt 从 messages 中分离，日志中先显示稳定前缀（system + tools），
      // 再显示动态消息，这样更符合 cache-friendly 请求布局的直观理解。
      const systemMsg = messages.find((m) => m.role === "system");
      const systemContent =
        typeof systemMsg?.content === "string" ? systemMsg.content : null;
      const nonSystemMessages = messages.filter((m) => m.role !== "system");

      const lines = ["", SEPARATOR, `[REQUEST] ${timestamp}`, SEPARATOR];

      // 1. System Prompt — cache 稳定前缀的第一部分
      if (systemContent) {
        lines.push(formatSystemPrompt(systemContent, cacheDebug));
      }

      // 2. Tools — cache 稳定前缀的第二部分
      if (tools && tools.length > 0) {
        lines.push(formatTools(tools, cacheDebug));
      }

      // 3. Messages（不含 system）— 动态部分，不断增长和变化
      if (nonSystemMessages.length > 0) {
        lines.push(formatMessages(nonSystemMessages));
      }

      lines.push("");
      const log = lines
        .filter((line, idx) => idx > 0 || line !== "")
        .join("\n");
      appendLog(log);
    },

    logResponse(response, durationMs) {
      const elapsed = (durationMs / 1000).toFixed(1);
      const timestamp = new Date().toISOString();
      const lines = [
        SEPARATOR,
        `[RESPONSE] ${timestamp} (${elapsed}s)`,
        SEPARATOR,
        `Content: ${response.content ?? "(null)"}`,
        formatToolCalls(response),
      ];

      // 记录 usage telemetry（如果可用）
      if (response.usage) {
        const u = response.usage;
        const usageParts: string[] = [];
        if (u.promptTokens !== undefined) usageParts.push(`prompt=${u.promptTokens}`);
        if (u.completionTokens !== undefined) usageParts.push(`completion=${u.completionTokens}`);
        if (u.totalTokens !== undefined) usageParts.push(`total=${u.totalTokens}`);
        if (u.reasoningTokens !== undefined) usageParts.push(`reasoning=${u.reasoningTokens}`);
        if (u.cacheHitTokens !== undefined) usageParts.push(`cache_hit=${u.cacheHitTokens}`);
        if (u.cacheMissTokens !== undefined) usageParts.push(`cache_miss=${u.cacheMissTokens}`);
        if (u.cachedTokens !== undefined) usageParts.push(`cached=${u.cachedTokens}`);
        if (usageParts.length > 0) {
          lines.push(`Usage: ${usageParts.join(", ")}`);
        }
      }

      // 记录 reasoning 内容摘要（截断至 200 字符，避免日志爆炸）
      if (response.reasoning?.content) {
        const reasoningPreview = response.reasoning.content.slice(0, 200);
        const suffix = response.reasoning.content.length > 200 ? "..." : "";
        lines.push(`Reasoning (${response.reasoning.source}): ${reasoningPreview}${suffix}`);
      }

      lines.push("");
      appendLog(lines.join("\n"));
    },
  };
}
