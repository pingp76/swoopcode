/**
 * compressor.ts — 上下文压缩器模块
 *
 * 职责：实现三层压缩机制，管理压缩状态。
 *
 * 三层压缩机制：
 * - P0 衰减压缩：随对话推进，逐步缩短旧的工具调用结果
 * - P1 即时压缩：工具执行后，将过大的输出存入文件
 * - P2 全量压缩：上下文超过阈值时，将历史压缩为摘要
 *
 * 设计模式：工厂函数 + 闭包（与项目中其他模块一致）。
 * 内部状态（hasCompacted、lastSummary 等）通过闭包保护，
 * 外部只能通过接口方法访问。
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { MessageBlock } from "./message-block.js";
import { estimateTokens, truncateToTokens } from "./message-block.js";
import type { OutputStore } from "./output-store.js";

// ---------------------------------------------------------------------------
// 接口定义
// ---------------------------------------------------------------------------

/**
 * CompressionConfig — 压缩配置项
 *
 * 所有配置项都有默认值，通过环境变量覆盖。
 */
export interface CompressionConfig {
  /** 即时压缩的 token 阈值（超过此值存文件） */
  thresholdToolOutput: number;
  /** 衰减压缩的轮次阈值（超过此轮数的工具结果会被截断） */
  decayThreshold: number;
  /** 衰减后保留的 token 数 */
  decayPreviewTokens: number;
  /** 触发全量压缩的 token 阈值 */
  maxContextTokens: number;
  /** 全量压缩时保留的最近消息块数 */
  compactKeepRecent: number;
  /** 需要 P1 即时压缩的工具名列表（默认只压缩 run_bash） */
  compressibleTools: string[];
  /** 大输出存储目录，默认是 Agent 全局运行根目录下的 .task_outputs */
  outputDir: string;
  /** 可选 OutputStore：注入后用 output_id 取代裸路径引用 */
  outputStore?: OutputStore;
}

/**
 * CompressedToolResult — 即时压缩的结果
 */
export interface CompressedToolResult {
  /** 返回给 LLM 的内容（preview 或原文） */
  content: string;
  /** 如果存了文件，记录文件路径 */
  persistedPath?: string;
  /** 如果通过 OutputStore 登记，记录稳定 output_id */
  outputId?: string;
}

/**
 * CompactResult — 全量压缩的结果
 */
export interface CompactResult {
  /** 压缩后的消息块列表 */
  blocks: MessageBlock[];
  /** 摘要文本 */
  summary: string;
}

/**
 * CompressorState — 压缩器内部状态
 */
export interface CompressorState {
  /** 是否已做过全量压缩 */
  hasCompacted: boolean;
  /** 最近一次摘要文本（连续压缩时复用） */
  lastSummary?: string;
  /** 最近操作过的文件路径 */
  recentFiles: string[];
}

/**
 * ContextCompressor — 上下文压缩器接口
 *
 * 对应设计文档 pdd6.md 中定义的三种压缩机制。
 */
export interface ContextCompressor {
  /**
   * P1 即时压缩：工具执行后调用
   *
   * 内部根据工具名和输出大小自动决策是否压缩：
   * - 工具名不在 compressibleTools 列表中 → 直接返回原文
   * - 输出未超阈值 → 直接返回原文
   * - 输出超阈值 → 存文件，返回 preview
   */
  compressToolResult(
    toolName: string,
    toolCallId: string,
    output: string,
  ): CompressedToolResult;
  /** P0 衰减压缩：每次全 session LLM loop 前调用 */
  decayOldBlocks(
    blocks: MessageBlock[],
    currentLoopIndex: number,
  ): MessageBlock[];
  /** P2 全量压缩：上下文超过阈值时调用 */
  compactHistory(blocks: MessageBlock[]): CompactResult;
  /** 获取当前压缩状态 */
  getState(): CompressorState;
  /** 清理临时文件 */
  cleanup(): void;
}

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: CompressionConfig = {
  thresholdToolOutput: 2000,
  decayThreshold: 3,
  decayPreviewTokens: 100,
  maxContextTokens: 80000,
  compactKeepRecent: 4,
  compressibleTools: ["run_bash"],
  outputDir: resolve(
    process.env["AGENT_HOME"] ?? resolve(homedir(), ".learn-claude-code-ts"),
    ".task_outputs",
  ),
};

interface PersistedToolOutputRef {
  relativePath?: string;
  outputId?: string;
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createContextCompressor — 创建上下文压缩器实例
 *
 * @param config - 压缩配置（可选，未提供的项使用默认值）
 * @returns ContextCompressor 接口的实现
 */
export function createContextCompressor(
  config?: Partial<CompressionConfig>,
): ContextCompressor {
  // 合并用户配置和默认配置
  const cfg: CompressionConfig = { ...DEFAULT_CONFIG, ...config };

  // ---- 内部状态（闭包保护） ----
  let hasCompacted = false;
  let lastSummary: string | undefined;
  const recentFiles: string[] = [];
  const persistedPaths: Set<string> = new Set();
  // 追踪已存文件的 toolCallId → 文件相对路径，衰减压缩时用于追加路径引用
  const persistedToolOutputs: Map<string, PersistedToolOutputRef> = new Map();

  // 存储目录路径由组装根注入；若单独使用压缩器，默认也写入 Agent 全局目录。
  const outputDir = cfg.outputDir;

  return {
    // -----------------------------------------------------------------------
    // P1 即时压缩
    // -----------------------------------------------------------------------
    compressToolResult(
      toolName: string,
      toolCallId: string,
      output: string,
    ): CompressedToolResult {
      // 工具名不在可压缩列表中，直接返回原文
      if (!cfg.compressibleTools.includes(toolName)) {
        return { content: output };
      }

      const tokens = estimateTokens(output);

      // 未超阈值，直接返回原文
      if (tokens <= cfg.thresholdToolOutput) {
        return { content: output };
      }

      try {
        if (cfg.outputStore) {
          const record = cfg.outputStore.writeText({
            sourceKind: "tool_result",
            sourceId: toolCallId,
            toolName,
            content: output,
          });
          const filePath = resolve(outputDir, record.relativePath);
          persistedPaths.add(filePath);
          persistedToolOutputs.set(toolCallId, { outputId: record.id });

          const preview = truncateToTokens(output, cfg.thresholdToolOutput);
          return {
            content:
              `<persisted-output tool-call-id="${toolCallId}" output-id="${record.id}">\n` +
              `Full output saved as output_id: ${record.id}\n` +
              `Read it with run_output_read({"output_id":"${record.id}"})\n` +
              `Preview (first ~${cfg.thresholdToolOutput} tokens):\n` +
              `${preview}\n` +
              `</persisted-output>`,
            persistedPath: filePath,
            outputId: record.id,
          };
        }

        // 未注入 OutputStore 时保留旧教学行为：直接写入 outputDir 下的文件。
        const relativePath = `.task_outputs/${toolCallId}.txt`;
        const filePath = resolve(outputDir, `${toolCallId}.txt`);
        // 确保目录存在
        if (!existsSync(outputDir)) {
          mkdirSync(outputDir, { recursive: true });
        }
        writeFileSync(filePath, output, "utf-8");
        persistedPaths.add(filePath);
        // 追踪 toolCallId → 文件路径，衰减压缩时用于追加路径引用
        persistedToolOutputs.set(toolCallId, { relativePath });

        // 返回带预览的格式，嵌入 toolCallId 便于 LLM 标识
        const preview = truncateToTokens(output, cfg.thresholdToolOutput);
        return {
          content:
            `<persisted-output tool-call-id="${toolCallId}">\n` +
            `Full output saved to: ${relativePath}\n` +
            `Preview (first ~${cfg.thresholdToolOutput} tokens):\n` +
            `${preview}\n` +
            `</persisted-output>`,
          persistedPath: filePath,
        };
      } catch {
        // 文件写入失败，降级返回原始输出
        return { content: output };
      }
    },

    // -----------------------------------------------------------------------
    // P0 衰减压缩
    // -----------------------------------------------------------------------
    decayOldBlocks(
      blocks: MessageBlock[],
      currentLoopIndex: number,
    ): MessageBlock[] {
      return blocks.map((block) => {
        // 没有时间信息的块，不处理。loopIndex 是新版年龄基准，
        // round 只作为旧测试和旧调用点的兼容 fallback。
        const blockLoopIndex = block.loopIndex ?? block.round;
        if (blockLoopIndex === undefined) return block;

        // 判断是否为"旧"块：年龄表示已经经过多少次 LLM 思考循环。
        const age = currentLoopIndex - blockLoopIndex;
        if (age <= cfg.decayThreshold) return block;

        // text 块和 summary 块：不修改
        if (block.type === "text" || block.type === "summary") return block;

        // tool_use 块：截断 tool result 的 content
        if (block.type === "tool_use") {
          const truncatedResults = block.toolResults.map((tr) => {
            const content = typeof tr.content === "string" ? tr.content : "";
            const truncated = truncateToTokens(content, cfg.decayPreviewTokens);

            // 检查该 toolCallId 是否有已存文件，有则追加路径引用
            const tcId =
              "tool_call_id" in tr
                ? (tr as { tool_call_id: string }).tool_call_id
                : undefined;
            const persistedRef = tcId
              ? persistedToolOutputs.get(tcId)
              : undefined;
            const finalContent = persistedRef
              ? `${truncated}\n${formatPersistedOutputRef(persistedRef)}`
              : truncated;

            // 创建新的 tool 消息，保留 tool_call_id
            return {
              ...tr,
              content: finalContent,
            } as ChatCompletionMessageParam;
          });

          return {
            ...block,
            toolResults: truncatedResults,
          };
        }

        return block;
      });
    },

    // -----------------------------------------------------------------------
    // P2 全量压缩
    // -----------------------------------------------------------------------
    compactHistory(blocks: MessageBlock[]): CompactResult {
      const keepCount = cfg.compactKeepRecent;

      // 分离需要保留的块和需要压缩的块
      const recentBlocks = blocks.slice(-keepCount);
      const oldBlocks = blocks.slice(0, Math.max(0, blocks.length - keepCount));

      // 如果没有旧块需要压缩，直接返回
      if (oldBlocks.length === 0) {
        return {
          blocks,
          summary: "",
        };
      }

      // 按类型压缩旧块，构建摘要文本
      const summaryLines: string[] = [];

      // 如果之前已有摘要，先加入
      if (lastSummary) {
        summaryLines.push(lastSummary);
        summaryLines.push("---");
      }

      for (const block of oldBlocks) {
        if (block.type === "text") {
          const userContent = block.user ? extractText(block.user) : "";
          const assistantContent = block.assistant
            ? extractText(block.assistant)
            : "";
          // user 消息全文保留（意图不可丢失）
          if (userContent) {
            summaryLines.push(`User: ${userContent}`);
          }
          // assistant 回复保留最后一条（简短）
          if (assistantContent) {
            summaryLines.push(
              `Assistant: ${truncateToTokens(assistantContent, 200)}`,
            );
          }
        } else if (block.type === "tool_use") {
          // 从 assistant 的 tool_calls 提取工具名和参数概要
          const callSummaries = extractToolCallSummaries(block.assistant);
          // 从 tool results 提取结果概要
          const resultSummaries = block.toolResults.map((tr) => {
            const content = extractText(tr);
            return `[${truncateToTokens(content, 100)}]`;
          });
          summaryLines.push(
            `Tool: ${callSummaries.join(", ")} → ${resultSummaries.join(", ")}`,
          );

          // 追踪文件路径（从 run_read/run_write/run_edit 工具调用中提取）
          extractFilePaths(block.assistant).forEach((f) => {
            if (!recentFiles.includes(f)) {
              recentFiles.push(f);
            }
          });
        } else if (block.type === "summary") {
          // 之前的 summary 块：保留文本
          summaryLines.push(extractText(block.user));
        }
      }

      // 构建摘要消息
      const summaryText = `[Context Summary]\n${summaryLines.join("\n")}`;

      // 创建 summary 消息块
      const firstOldBlock = oldBlocks[0];
      const firstRound = firstOldBlock?.round;
      const firstTurnIndex = firstOldBlock?.turnIndex;
      const firstLoopRound = firstOldBlock?.loopRound;
      const firstLoopIndex = firstOldBlock?.loopIndex;
      const firstMessageSequence = firstOldBlock?.messageSequence;
      const summaryBlock: MessageBlock =
        firstRound !== undefined
          ? {
              type: "summary",
              user: {
                role: "user",
                content: summaryText,
              } as ChatCompletionMessageParam,
              round: firstRound,
            }
          : {
              type: "summary",
              user: {
                role: "user",
                content: summaryText,
              } as ChatCompletionMessageParam,
            };

      if (firstTurnIndex !== undefined) summaryBlock.turnIndex = firstTurnIndex;
      if (firstLoopRound !== undefined) summaryBlock.loopRound = firstLoopRound;
      if (firstLoopIndex !== undefined) summaryBlock.loopIndex = firstLoopIndex;
      if (firstMessageSequence !== undefined) {
        summaryBlock.messageSequence = firstMessageSequence;
      }

      // 更新内部状态
      hasCompacted = true;
      lastSummary = summaryText;

      return {
        blocks: [summaryBlock, ...recentBlocks],
        summary: summaryText,
      };
    },

    // -----------------------------------------------------------------------
    // 状态访问
    // -----------------------------------------------------------------------
    getState(): CompressorState {
      const state: CompressorState = {
        hasCompacted,
        recentFiles: [...recentFiles],
      };
      if (lastSummary !== undefined) {
        state.lastSummary = lastSummary;
      }
      return state;
    },

    // -----------------------------------------------------------------------
    // 清理
    // -----------------------------------------------------------------------
    cleanup(): void {
      // 未注入 OutputStore 时，压缩器拥有自己写出的临时输出目录，可以整体清理。
      // 注入 OutputStore 后，输出是登记过的 Agent artifact，不能由 compressor cleanup 删除。
      if (!cfg.outputStore && existsSync(outputDir)) {
        try {
          rmSync(outputDir, { recursive: true, force: true });
        } catch {
          // 清理失败不影响主流程
        }
      }
      persistedPaths.clear();
      persistedToolOutputs.clear();
    },
  };
}

function formatPersistedOutputRef(ref: PersistedToolOutputRef): string {
  if (ref.outputId) {
    return `[Full output: output_id ${ref.outputId}; read with run_output_read]`;
  }
  return `[Full output: ${ref.relativePath ?? "unknown"}]`;
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

/**
 * extractText — 从消息中提取文本内容
 */
function extractText(msg: ChatCompletionMessageParam): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          typeof b === "object" && b !== null && "text" in b,
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/**
 * extractToolCallSummaries — 从 assistant 消息中提取工具调用摘要
 *
 * 格式："{工具名}({参数概要})"
 */
function extractToolCallSummaries(
  assistant: ChatCompletionMessageParam,
): string[] {
  if (!("tool_calls" in assistant) || !Array.isArray(assistant.tool_calls)) {
    return [];
  }
  return assistant.tool_calls.map((tc) => {
    const name = tc.function.name;
    // 从参数中提取简短概要
    try {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      // 取第一个参数的值作为概要
      const firstValue = Object.values(args)[0];
      if (firstValue !== undefined && firstValue !== null) {
        const short = truncateToTokens(String(firstValue), 50);
        return `${name}(${short})`;
      }
    } catch {
      // JSON 解析失败，直接用原始字符串
    }
    return `${name}(...)`;
  });
}

/**
 * extractFilePaths — 从工具调用参数中提取文件路径
 *
 * 用于更新 recentFiles 状态。
 */
function extractFilePaths(assistant: ChatCompletionMessageParam): string[] {
  const paths: string[] = [];
  if (!("tool_calls" in assistant) || !Array.isArray(assistant.tool_calls)) {
    return paths;
  }
  for (const tc of assistant.tool_calls) {
    try {
      const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      // 常见的文件路径参数名
      if (typeof args["path"] === "string") paths.push(args["path"]);
      if (typeof args["filePath"] === "string") paths.push(args["filePath"]);
    } catch {
      // 忽略解析失败
    }
  }
  return paths;
}
