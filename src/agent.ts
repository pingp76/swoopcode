/**
 * agent.ts — Agent 主循环模块
 *
 * 职责：实现 Coding Agent 的核心循环 —— think → act → observe。
 *
 * Agent 循环的工作原理（这是所有 AI Agent 的核心模式）：
 *
 *   ┌─────────────────────────────────────────┐
 *   │  1. THINK: 将对话历史发给 LLM            │
 *   │  2. ACT:  LLM 返回文本回复 或 工具调用    │
 *   │  3. OBSERVE:                            │
 *   │     - 如果是工具调用 → 执行工具，将结果   │
 *   │       加入历史，回到步骤 1               │
 *   │     - 如果是文本回复 → 返回给用户        │
 *   └─────────────────────────────────────────┘
 *
 * 这个循环会一直运行，直到 LLM 不再请求工具调用为止。
 * 也就是说，一个用户问题可能触发多轮 LLM 调用：
 * - 第 1 轮：LLM 决定调用 bash 工具查看文件
 * - 第 2 轮：LLM 看到文件内容，决定再调用 bash 工具运行代码
 * - 第 3 轮：LLM 看到运行结果，生成最终的文字回复给用户
 *
 * 内部步骤函数（从 run() 主循环中提取，各自职责明确）：
 * - appendMessage(): 向 history 添加消息（round 元信息由 history 统一管理）
 * - prepareMessages(): 消息处理管道（从 history 读取带 round 的条目 → normalize → group → decay → compact → flatten）
 * - handleToolCalls(): 工具调用循环（解析参数 → 执行 → P1 压缩 → 回写历史）
 * - buildRoundLimitResponse(): 子智能体轮次上限检测与截断响应
 */

import OpenAI from "openai";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { Logger } from "./logger.js";
import type { LLMClient } from "./llm.js";
import type { History, HistoryEntry } from "./history.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { TodoManager } from "./todo.js";
import type { ContextCompressor } from "./compressor.js";
import type { PermissionManager, AskUserFn } from "./permission.js";
import type { HookRunner } from "./hooks.js";
import type { SystemPromptProvider } from "./system-prompt.js";
import type { SessionEventBuffer } from "./session-events.js";
import type { TranscriptStore } from "./transcript.js";
import type { AsyncRunManager } from "./async-runs.js";
import type { ScheduleManager } from "./schedules.js";
import { createNoopHookRunner } from "./hooks.js";
import { normalizeMessages } from "./normalize.js";
import {
  groupToBlocks,
  flattenToMessages,
  estimateMessagesTokens,
  stripRound,
} from "./message-block.js";
import type { MessageBlock } from "./message-block.js";
import { createCacheDebugTracker, formatCacheDebugLog } from "./cache-debug.js";
import {
  createRecoveryState,
  classifyLLMError,
  decideRecovery,
  formatRecoveryNotice,
  formatFailureMessage,
  sleep,
  DEFAULT_RECOVERY_CONFIG,
} from "./recovery.js";

/**
 * Agent — Agent 的接口
 *
 * 目前只有一个方法 run()：接收用户输入，返回 Agent 的最终回复。
 * 父智能体和子智能体都实现这个接口，区别在于依赖注入的参数不同。
 */
export interface Agent {
  run(query: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// createAgent
// ---------------------------------------------------------------------------

/**
 * createAgent — 创建 Agent 实例
 *
 * @param deps - Agent 的依赖项（通过依赖注入传入，便于测试和替换）
 *   - llm:         LLM 客户端，用于调用大模型
 *   - history:     对话历史管理器，用于维护上下文
 *   - tools:       工具注册表，用于查找和执行工具
 *   - logger:      日志器，用于输出调试信息
 *   - todoManager: 可选，TODO 管理器（子智能体不需要）
 *   - maxRounds:   可选，最大循环轮数（子智能体需要此限制，防止无限循环）
 *   - compressor:  上下文压缩器，用于管理上下文长度
 *   - maxContextTokens: 可选，触发全量压缩的 token 阈值（子智能体可独立配置）
 */
export function createAgent(deps: {
  llm: LLMClient;
  history: History;
  tools: ToolRegistry;
  logger: Logger;
  todoManager?: TodoManager;
  maxRounds?: number;
  compressor: ContextCompressor;
  maxContextTokens?: number;
  /** 权限管理器（必需），在工具执行前检查权限 */
  permissionManager: PermissionManager;
  /** 用户确认回调（可选，子智能体不传，ask 决策降级为 deny） */
  askUserFn?: AskUserFn;
  /** Hook 运行器（可选，不传时使用空操作 runner，不触发任何 Hook） */
  hookRunner?: HookRunner;
  /** System prompt 提供者（可选，用于生成 turn reminders） */
  systemPromptProvider?: SystemPromptProvider;
  /** 会话事件缓冲区（可选，用于注入 out-of-band 状态变化提醒） */
  sessionEventBuffer?: SessionEventBuffer;
  /** 原始 transcript 存储（可选，不参与 prompt 构建） */
  transcriptStore?: TranscriptStore;
  /** 当前 Agent 对应的 sessionId（与 transcriptStore 配套使用） */
  sessionId?: string;
  /** Async run 管理器（可选，仅主 Agent 注入，子智能体不传递） */
  asyncRunManager?: Pick<
    AsyncRunManager,
    "drainNotifications" | "checkForegroundToolConflict"
  >;
  /** Schedule 管理器（可选，仅主 Agent 注入，子智能体不传递） */
  scheduleManager?: Pick<ScheduleManager, "drainNotifications">;
  /** AbortSignal（可选，用于外部取消 Agent 运行，如 async run timeout） */
  abortSignal?: AbortSignal;
}): Agent {
  const {
    llm,
    history,
    tools,
    logger,
    todoManager,
    maxRounds,
    compressor,
    maxContextTokens = 80000,
    permissionManager,
    askUserFn,
    hookRunner,
    systemPromptProvider,
    sessionEventBuffer,
    transcriptStore,
    sessionId,
    asyncRunManager,
    scheduleManager,
    abortSignal,
  } = deps;

  // 没有传入 hookRunner 时使用空操作实现，避免所有调用处都要做 if 判断
  const hooks = hookRunner ?? createNoopHookRunner();

  // SessionStart 标记：每个 Agent 实例只在第一次 run() 时触发一次
  let sessionStarted = false;

  // Cache Debug 追踪器：监控 system prompt / tools / prefix 稳定性
  const cacheDebugTracker = createCacheDebugTracker();

  // =====================================================================
  // 内部步骤函数
  //
  // 以下函数从 run() 主循环中提取，各自封装一个明确的职责。
  // 它们共享 createAgent 闭包中的 history、tools、compressor 等变量，
  // 不改变外部行为。
  //
  // 注意：round 元信息由 history 统一管理，不再需要 agent 维护平行数组。
  // =====================================================================

  /**
   * appendMessage — 向 history 添加消息
   *
   * 封装 history.add(message, { round }) 调用。
   * round 元信息由 history 内部统一管理，无需额外维护平行数组。
   */
  function appendMessage(
    message: ChatCompletionMessageParam,
    round: number,
  ): void {
    history.add(message, { round });
    // transcript 是 append-only 原始事件流，专门服务未来搜索/回放/分析。
    // 它不参与 prepareMessages，也不会因为 compact 而被改写。
    if (transcriptStore && sessionId) {
      transcriptStore.appendMessage({ sessionId, round, message });
    }
  }

  /**
   * prepareMessages — 消息处理管道
   *
   * 完整流程：从 history 读取带 round 的条目 → 标注 _round → normalize → group → decay → [compact] → flatten。
   * 如果压缩过程中任何环节出错，降级使用标准化后的消息。
   *
   * system prompt 独立于压缩管道：在最后拼接到消息列表头部。
   * 因为 groupToBlocks 会跳过 system 消息，放入管道会导致丢失。
   *
   * @param roundCount - 当前 agent loop 轮次，用于衰减压缩判断
   * @returns 最终给 LLM 的消息列表
   */
  function prepareMessages(roundCount: number): ChatCompletionMessageParam[] {
    // 从 history 获取带 round 元信息的条目（不含 system prompt）
    const entries = history.getEntries();

    // system prompt 独立于压缩管道处理：
    // groupToBlocks 会跳过 system 消息，导致丢失。
    // 因此在最后单独拼接到消息列表头部。
    const systemPrompt = history.getSystemPrompt();
    const systemMsg: ChatCompletionMessageParam | null = systemPrompt
      ? ({
          role: "system",
          content: systemPrompt,
        } as ChatCompletionMessageParam)
      : null;

    // 将 HistoryEntry[] 转换为带 _round 的消息列表（不含 system prompt）
    const annotated = annotateEntries(entries);
    const normalized = normalizeMessages(annotated);

    try {
      const blocks = groupToBlocks(normalized);

      // P0 衰减压缩：缩短旧的工具结果
      const decayed = compressor.decayOldBlocks(blocks, roundCount);

      // P2 全量压缩：上下文超过阈值时触发
      let finalBlocks = decayed;
      const tokenEstimate = estimateMessagesTokens(normalized);
      if (tokenEstimate > maxContextTokens) {
        logger.info(
          "Context over threshold (%d > %d), compacting...",
          tokenEstimate,
          maxContextTokens,
        );
        const compacted = compressor.compactHistory(decayed);
        finalBlocks = compacted.blocks;
      }

      const result = flattenToMessages(finalBlocks);

      // groupToBlocks → flattenToMessages 是有损转换：
      // 当只有 user 消息（没有配对的 assistant）时，user 被缓冲为 pendingUser
      // 但不生成 block，导致输出为空。此时回退到标准化消息。
      if (result.length === 0 && normalized.length > 0) {
        const fallback = [...normalized];
        if (systemMsg) fallback.unshift(systemMsg);
        return fallback;
      }

      if (systemMsg) result.unshift(systemMsg);
      return result;
    } catch (compressErr) {
      // 压缩管道任何环节出错，降级使用标准化后的消息
      logger.warn(
        "Compression pipeline failed, using normalized messages: %s",
        compressErr instanceof Error
          ? compressErr.message
          : String(compressErr),
      );
      const fallback = [...normalized];
      if (systemMsg) fallback.unshift(systemMsg);
      return fallback;
    }
  }

  /**
   * annotateEntries — 将 HistoryEntry[] 转换为带 _round 元数据的消息列表
   *
   * 替代之前的 annotateWithRounds()：
   * - round 信息来自 history 内部，不再需要 agent 维护平行数组
   * - system prompt 在 prepareMessages 中独立处理，不再插入此列表
   * - 每个 entry 自带 round，无对齐风险
   */
  function annotateEntries(
    entries: HistoryEntry[],
  ): ChatCompletionMessageParam[] {
    const result: ChatCompletionMessageParam[] = [];

    // 将 entry 转换为带 _round 的消息
    for (const entry of entries) {
      if (entry.round !== undefined) {
        result.push({
          ...entry.message,
          _round: entry.round,
        } as unknown as ChatCompletionMessageParam);
      } else {
        result.push(entry.message);
      }
    }

    return result;
  }

  /**
   * handleToolCalls — 处理 LLM 返回的工具调用
   *
   * 对每个 toolCall：
   * 1. 查找执行器（找不到 → 写错误 tool_result）
   * 2. JSON.parse 参数（失败 → 写错误 tool_result）
   * 3. 执行工具
   * 4. P1 即时压缩（对 run_bash 的大输出）
   * 5. 通过 appendMessage() 回写历史
   *
   * @param toolCalls - LLM 返回的工具调用列表
   * @param roundCount - 当前轮次
   */
  async function handleToolCalls(
    toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[],
    roundCount: number,
  ): Promise<void> {
    // 延迟注入缓冲区：Hook 的 exitCode 2 消息不能在 tool_result 之间插入，
    // 否则会破坏 OpenAI API 的 tool_call / tool_result 配对规则。
    // 所有待注入消息在当前 assistant 的所有 tool_result 写完后统一追加。
    const pendingHookMessages: string[] = [];

    for (const toolCall of toolCalls) {
      // 外部中止信号检查：timeout 后不再执行新的 tool call
      if (abortSignal?.aborted) {
        appendMessage(
          {
            role: "tool",
            tool_call_id: toolCall.id,
            content: "Tool execution skipped: async run timed out",
          } as ChatCompletionMessageParam,
          roundCount,
        );
        continue;
      }

      const fnName = toolCall.function.name;
      const executor = tools.getExecutor(fnName);

      if (!executor) {
        logger.warn("Unknown tool: %s", fnName);
        appendMessage(
          {
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: Unknown tool "${fnName}"`,
          } as ChatCompletionMessageParam,
          roundCount,
        );
        continue;
      }

      logger.info("Tool call: %s(%s)", fnName, toolCall.function.arguments);

      // 解析工具参数
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(toolCall.function.arguments) as Record<
          string,
          unknown
        >;
      } catch (parseError) {
        logger.warn(
          "Failed to parse tool args: %s",
          parseError instanceof Error ? parseError.message : String(parseError),
        );
        appendMessage(
          {
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Error: Invalid JSON in tool arguments: ${toolCall.function.arguments}`,
          } as ChatCompletionMessageParam,
          roundCount,
        );
        continue;
      }

      // 权限检查：在工具执行前拦截
      const decision = permissionManager.check({
        toolName: fnName,
        args,
      });

      if (decision.action === "deny") {
        logger.info("Permission denied: %s — %s", fnName, decision.reason);
        appendMessage(
          {
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Permission denied: ${decision.reason}`,
          } as ChatCompletionMessageParam,
          roundCount,
        );
        continue;
      }

      if (decision.action === "ask") {
        // 子智能体没有 askUserFn，ask 降级为 deny
        if (!askUserFn) {
          logger.info(
            "Permission denied (no confirmation callback): %s",
            fnName,
          );
          appendMessage(
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content:
                "Permission denied: confirmation is required but unavailable.",
            } as ChatCompletionMessageParam,
            roundCount,
          );
          continue;
        }

        const approved = await askUserFn(decision.message);
        if (!approved) {
          logger.info("User denied: %s — %s", fnName, decision.message);
          appendMessage(
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content: `User denied: ${decision.message}`,
            } as ChatCompletionMessageParam,
            roundCount,
          );
          continue;
        }
      }

      // === Async 前台冲突检查 ===
      // 在权限检查通过后、PreToolUse Hook 之前检查前台工具是否与 running async run 冲突
      if (asyncRunManager) {
        const conflict = asyncRunManager.checkForegroundToolConflict({
          toolName: fnName,
          args,
        });
        if (conflict.blocked) {
          logger.info("Async foreground conflict: %s", conflict.reason);
          appendMessage(
            {
              role: "tool",
              tool_call_id: toolCall.id,
              content: `Blocked: ${conflict.reason}`,
            } as ChatCompletionMessageParam,
            roundCount,
          );
          continue;
        }
      }

      // PreToolUse Hook：权限检查通过后、工具真正执行前触发
      // 这里 Hook 看到的是"已经被系统允许、即将执行"的工具调用
      const preResult = await hooks.run({
        name: "PreToolUse",
        payload: {
          toolCallId: toolCall.id,
          toolName: fnName,
          args,
          round: roundCount,
        },
      });

      if (preResult.exitCode === 1) {
        // exitCode 1：阻止工具执行
        // 必须写入一条 role: "tool" 消息来满足 tool_call 配对
        logger.info(
          "PreToolUse hook blocked: %s — %s",
          fnName,
          preResult.message ?? "no reason",
        );
        appendMessage(
          {
            role: "tool",
            tool_call_id: toolCall.id,
            content: `Blocked by PreToolUse hook: ${preResult.message ?? "no reason"}`,
          } as ChatCompletionMessageParam,
          roundCount,
        );
        continue;
      }

      // exitCode 2：记录待注入消息，工具照常执行
      // 消息在所有 tool_result 写完后统一追加，避免破坏消息格式
      if (preResult.exitCode === 2 && preResult.message) {
        pendingHookMessages.push(`[Hook: PreToolUse]\n${preResult.message}`);
      }

      // 执行工具
      const result = await executor(args);

      // P1 即时压缩：compressor 内部根据工具名和输出大小决定是否压缩
      const compressed = compressor.compressToolResult(
        fnName,
        toolCall.id,
        result.output,
      );
      const toolOutput = compressed.content;

      logger.info(
        "Tool result (%s): %s",
        result.error ? "error" : "ok",
        toolOutput.slice(0, 200),
      );

      // 将工具执行结果加入历史
      appendMessage(
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: toolOutput,
        } as ChatCompletionMessageParam,
        roundCount,
      );

      // PostToolUse Hook：工具执行、P1 压缩、tool_result 写入后触发
      // payload.output 是"已经经过 P1 即时压缩后的内容"
      const postResult = await hooks.run({
        name: "PostToolUse",
        payload: {
          toolCallId: toolCall.id,
          toolName: fnName,
          args,
          round: roundCount,
          output: toolOutput,
          error: result.error,
        },
      });

      // PostToolUse 的 exitCode 1：工具已经执行，不能撤销
      // 将其解释为"阻止后续静默继续"，注入警告提醒让模型知道
      if (postResult.exitCode === 1) {
        pendingHookMessages.push(
          `[Hook: PostToolUse]\nPostToolUse requested block after tool execution: ${
            postResult.message ?? "no reason"
          }`,
        );
      }

      // exitCode 2：注入补充观察或提醒
      if (postResult.exitCode === 2 && postResult.message) {
        pendingHookMessages.push(`[Hook: PostToolUse]\n${postResult.message}`);
      }
    }

    // 延迟注入：所有 tool_result 写完后，统一追加 Hook 补充消息为 user 消息
    // 这样保证：(1) 每个 tool_call 都有对应 tool_result
    //         (2) Hook 补充内容能被下一轮 LLM 看到
    //         (3) 多工具调用时，不会在 tool_result 之间插入 user 消息
    for (const msg of pendingHookMessages) {
      appendMessage({ role: "user", content: msg }, roundCount);
    }
  }

  /**
   * buildRoundLimitResponse — 子智能体轮次上限检测
   *
   * 当超过 maxRounds 时，从历史中倒找最后一条 assistant 文本消息
   * 生成截断摘要。仅子智能体使用（maxRounds 由调用方设定）。
   *
   * @param roundCount - 当前轮次
   * @returns 截断响应字符串，或 null（未超限）
   */
  function buildRoundLimitResponse(roundCount: number): string | null {
    if (maxRounds === undefined || roundCount <= maxRounds) {
      return null;
    }

    logger.info("Reached max rounds limit (%d)", maxRounds);
    const lastAssistantMsg = [...history.getMessages()]
      .reverse()
      .find(
        (m) =>
          m.role === "assistant" && typeof m.content === "string" && m.content,
      );
    const summary =
      lastAssistantMsg && typeof lastAssistantMsg.content === "string"
        ? lastAssistantMsg.content
        : "Task incomplete: reached maximum rounds before generating a final response.";
    return `[Round limit reached (${maxRounds})] ${summary}`;
  }

  /**
   * compactCurrentHistoryForRecovery — 当 API 报 context window 超限时，强制压缩当前 history 并写回
   *
   * 流程与 prepareMessages 一致，但会把压缩后的结果写回 history.replaceEntries()，
   * 确保下一次请求携带的上下文真的变短。
   * system prompt 不参与此流程，仍由 history 独立维护。
   */
  function compactCurrentHistoryForRecovery(roundCount: number): void {
    const entries = history.getEntries();
    const annotated = annotateEntries(entries);
    const normalized = normalizeMessages(annotated);
    const blocks = groupToBlocks(normalized);
    const decayed = compressor.decayOldBlocks(blocks, roundCount);
    const compacted = compressor.compactHistory(decayed);
    const newEntries = blocksToEntries(compacted.blocks);
    history.replaceEntries(newEntries);
    if (transcriptStore && sessionId) {
      transcriptStore.append({
        sessionId,
        type: "history_replaced",
        round: roundCount,
        payload: {
          reason: "context_length_recovery",
          beforeEntryCount: entries.length,
          afterEntryCount: newEntries.length,
          summary: compacted.summary,
        },
      });
    }
  }

  /**
   * blocksToEntries — 将 MessageBlock[] 转换为 HistoryEntry[]
   *
   * 与 flattenToMessages 对应，但保留 round 元信息并清除 _round 内部字段。
   *
   * 优先读取每条消息自己的 _round，缺失时才 fallback 到 block.round。
   * 避免 compact 写回时把一个 block 内所有消息的 round 统一覆盖。
   */
  function blocksToEntries(blocks: MessageBlock[]): HistoryEntry[] {
    const entries: HistoryEntry[] = [];
    for (const block of blocks) {
      if (block.type === "text") {
        if (block.user) {
          const r = readRoundFromMessage(block.user) ?? block.round;
          const entry: HistoryEntry = { message: stripRound(block.user) };
          if (r !== undefined) entry.round = r;
          entries.push(entry);
        }
        if (block.assistant) {
          const r = readRoundFromMessage(block.assistant) ?? block.round;
          const entry: HistoryEntry = { message: stripRound(block.assistant) };
          if (r !== undefined) entry.round = r;
          entries.push(entry);
        }
      } else if (block.type === "tool_use") {
        if (block.user) {
          const r = readRoundFromMessage(block.user) ?? block.round;
          const entry: HistoryEntry = { message: stripRound(block.user) };
          if (r !== undefined) entry.round = r;
          entries.push(entry);
        }
        const rAssistant = readRoundFromMessage(block.assistant) ?? block.round;
        const assistantEntry: HistoryEntry = {
          message: stripRound(block.assistant),
        };
        if (rAssistant !== undefined) assistantEntry.round = rAssistant;
        entries.push(assistantEntry);
        for (const tr of block.toolResults) {
          const r = readRoundFromMessage(tr) ?? block.round;
          const entry: HistoryEntry = { message: stripRound(tr) };
          if (r !== undefined) entry.round = r;
          entries.push(entry);
        }
      } else if (block.type === "summary") {
        const r = readRoundFromMessage(block.user) ?? block.round;
        const entry: HistoryEntry = { message: stripRound(block.user) };
        if (r !== undefined) entry.round = r;
        entries.push(entry);
      }
    }
    return entries;
  }

  /**
   * readRoundFromMessage — 从消息的 _round 内部字段读取轮次
   */
  function readRoundFromMessage(
    msg: ChatCompletionMessageParam,
  ): number | undefined {
    const annotated = msg as ChatCompletionMessageParam & { _round?: number };
    return annotated._round;
  }

  /**
   * appendContinuationReminder — LLM 输出被截断后，追加一条 user reminder
   *
   * 作为普通 user 消息注入，不修改 system prompt。
   * 必须在已经保存 assistant 部分输出之后追加。
   */
  function appendContinuationReminder(roundCount: number): void {
    appendMessage(
      {
        role: "user",
        content: `<system-reminder source="recovery">\n你的上一次输出因为长度限制中断了。请从断点继续输出，不要从头重写，也不要重复已经完成的工具调用。\n</system-reminder>`,
      },
      roundCount,
    );
  }

  // =====================================================================
  // Agent 实例
  // =====================================================================

  return {
    /**
     * run — 执行一次 Agent 循环
     *
     * 主循环骨架清晰可见六步：
     * 1. 轮次上限检测（子智能体）
     * 2. TODO 中断注入（父智能体）
     * 3. 消息处理管道（prepareMessages）
     * 4. 调用 LLM
     * 5. 处理工具调用（handleToolCalls）
     * 6. 返回最终回复
     *
     * @param query - 用户输入的查询文本
     * @returns Agent 的最终文字回复
     */
    async run(query) {
      logger.info("User query: %s", query);

      // 收集本轮需要注入的 reminder 消息
      // 顺序：1. 用户原始 query  2. turn reminders  3. out-of-band reminders
      const reminderMessages: string[] = [];

      // 2. systemPromptProvider 根据 query 生成的本轮提醒
      if (systemPromptProvider) {
        const turnReminders = systemPromptProvider.buildTurnReminders({
          query,
        });
        for (const r of turnReminders) {
          reminderMessages.push(
            `<system-reminder source="${r.source}">\n${r.message}\n</system-reminder>`,
          );
        }
      }

      // 3. sessionEventBuffer 中积累的 out-of-band 提醒
      if (sessionEventBuffer) {
        const events = sessionEventBuffer.drain();
        for (const e of events) {
          reminderMessages.push(
            `<system-reminder source="${e.source}">\n${e.message}\n</system-reminder>`,
          );
        }
      }

      // SessionStart Hook：在用户消息写入之前触发
      // 必须在 appendMessage 之前，否则 block 时 user 消息已经写入 history，
      // 下次 run() 不再触发 SessionStart，被阻止的 query 反而会进入 LLM 上下文。
      if (!sessionStarted) {
        sessionStarted = true;
        const sessionResult = await hooks.run({
          name: "SessionStart",
          payload: { query },
        });

        // exitCode 1：阻止会话（如安全策略不允许），直接返回，不写入 history
        if (sessionResult.exitCode === 1) {
          return sessionResult.message ?? "Session blocked by hook.";
        }

        // exitCode 2：注入补充提示，在用户消息之后作为 user 消息追加到历史
        if (sessionResult.exitCode === 2 && sessionResult.message) {
          // 先写入用户消息，再写入 reminder 和 Hook 补充消息
          appendMessage({ role: "user", content: query }, 0);
          for (const msg of reminderMessages) {
            appendMessage({ role: "user", content: msg }, 0);
          }
          appendMessage(
            {
              role: "user",
              content: `[Hook: SessionStart]\n${sessionResult.message}`,
            },
            0,
          );
        } else {
          // exitCode 0：正常写入用户消息 + reminders
          appendMessage({ role: "user", content: query }, 0);
          for (const msg of reminderMessages) {
            appendMessage({ role: "user", content: msg }, 0);
          }
        }
      } else {
        // 后续 run() 调用：写入用户消息 + reminders
        appendMessage({ role: "user", content: query }, 0);
        for (const msg of reminderMessages) {
          appendMessage({ role: "user", content: msg }, 0);
        }
      }

      // Agent 主循环：不断调用 LLM，直到它不再请求工具调用
      // 每次 run() 创建独立的恢复状态，避免死循环和重复执行
      const recoveryState = createRecoveryState();
      let roundCount = 0;
      // 累积因 finishReason === "length" 被截断的多段输出
      let accumulatedContent = "";

      for (;;) {
        roundCount++;

        // 0. 外部中止信号检查（如 async run timeout）
        if (abortSignal?.aborted) {
          logger.info("Agent run aborted by external signal");
          return "[Async run timed out or was cancelled]";
        }

        // 1. 子智能体轮次上限检测
        const limitResponse = buildRoundLimitResponse(roundCount);
        if (limitResponse !== null) return limitResponse;

        // 2. 父智能体的 TODO 轮次检测（子智能体没有 todoManager，跳过）
        if (todoManager) {
          const interruptMsg = todoManager.tickRound();
          if (interruptMsg) {
            appendMessage({ role: "user", content: interruptMsg }, roundCount);
          }
        }

        // 2.5. async run 通知 drain（子智能体没有 asyncRunManager，跳过）
        //      在每次 LLM 调用前 drain 通知队列，确保模型及时知道 async run 状态变化
        if (asyncRunManager) {
          const notifications = asyncRunManager.drainNotifications();
          if (notifications.length > 0) {
            const lines = ["Async run updates:"];
            for (const n of notifications) {
              lines.push(
                `- run_id: ${n.runId}`,
                `  title: ${n.title}`,
                `  executor: ${n.executor}`,
                `  status: ${n.status}`,
                `  preview: ${n.preview}`,
                `  full_output: use run_async_output_read with run_id ${n.runId}`,
              );
            }
            const reminderContent = `<system-reminder source="async-run">\n${lines.join("\n")}\n</system-reminder>`;
            logger.info(
              "Injecting %d async run notification(s) into conversation",
              notifications.length,
            );
            appendMessage(
              {
                role: "user",
                content: reminderContent,
              },
              roundCount,
            );
          }
        }

        // 2.6. schedule 通知 drain（子智能体没有 scheduleManager，跳过）
        //      在每次 LLM 调用前 drain schedule 通知队列，确保模型及时知道定时任务状态变化
        if (scheduleManager) {
          const notifications = scheduleManager.drainNotifications();
          if (notifications.length > 0) {
            const lines = ["Schedule updates:"];
            for (const n of notifications) {
              lines.push(
                `- schedule: ${n.scheduleId}`,
                `  occurrence: ${n.occurrenceId}`,
                `  type: ${n.type}`,
                `  message: ${n.message}`,
              );
              if (n.asyncRunId) {
                lines.push(`  async_run: ${n.asyncRunId}`);
              }
            }
            const reminderContent = `<system-reminder source="schedule">\n${lines.join("\n")}\n</system-reminder>`;
            logger.info(
              "Injecting %d schedule notification(s) into conversation",
              notifications.length,
            );
            appendMessage(
              {
                role: "user",
                content: reminderContent,
              },
              roundCount,
            );
          }
        }

        // 3. 消息处理管道
        let finalMsgs = prepareMessages(roundCount);
        const toolDefs = tools.getToolDefinitions();
        logger.debug(
          "Calling LLM with %d messages, %d tools",
          finalMsgs.length,
          toolDefs.length,
        );

        // 4. 调用 LLM（带错误恢复）
        //    先计算 cache debug hash，监控前缀稳定性
        let cacheState = cacheDebugTracker.inspect({
          messages: finalMsgs,
          tools: toolDefs,
        });
        logger.info(formatCacheDebugLog(cacheState));

        let response: import("./llm.js").LLMResponse;

        // 恢复循环：根据错误类型执行 backoff / compact / fail
        for (;;) {
          try {
            response = await llm.chat(finalMsgs, toolDefs, cacheState);
            break; // 成功，跳出恢复循环
          } catch (error) {
            const rawError = error as { status?: unknown; code?: unknown };
            // 诊断：记录原始错误信息，帮助定位真正的失败原因
            logger.error(
              "LLM call raw error: status=%s code=%s message=%s",
              rawError.status ?? "N/A",
              rawError.code ?? "N/A",
              error instanceof Error ? error.message : String(error),
            );
            const kind = classifyLLMError(error);
            const action = decideRecovery(kind, recoveryState);

            if (action === "backoff") {
              recoveryState.apiRetryCount++;
              logger.warn(formatRecoveryNotice(action, kind, recoveryState));
              if (transcriptStore && sessionId) {
                transcriptStore.append({
                  sessionId,
                  type: "recovery_event",
                  round: roundCount,
                  payload: {
                    kind,
                    action,
                    apiRetryCount: recoveryState.apiRetryCount,
                  },
                });
              }
              await sleep(DEFAULT_RECOVERY_CONFIG.retryDelayMs);
              continue;
            }

            if (action === "compact") {
              recoveryState.compactRetryCount++;
              logger.info(formatRecoveryNotice(action, kind, recoveryState));
              if (transcriptStore && sessionId) {
                transcriptStore.append({
                  sessionId,
                  type: "recovery_event",
                  round: roundCount,
                  payload: {
                    kind,
                    action,
                    compactRetryCount: recoveryState.compactRetryCount,
                  },
                });
              }
              try {
                compactCurrentHistoryForRecovery(roundCount);
              } catch (compactErr) {
                logger.warn(
                  "Compact failed: %s",
                  compactErr instanceof Error
                    ? compactErr.message
                    : String(compactErr),
                );
                return formatFailureMessage(kind, error);
              }
              // compact 后需要重新构建消息列表，并同步重算 cache debug
              finalMsgs = prepareMessages(roundCount);
              cacheState = cacheDebugTracker.inspect({
                messages: finalMsgs,
                tools: toolDefs,
              });
              logger.info(formatCacheDebugLog(cacheState));
              continue;
            }

            logger.error(formatRecoveryNotice(action, kind, recoveryState));
            if (transcriptStore && sessionId) {
              transcriptStore.append({
                sessionId,
                type: "recovery_event",
                round: roundCount,
                payload: { kind, action },
              });
            }
            return formatFailureMessage(kind, error);
          }
        }

        logger.debug(
          "LLM response: content=%s, toolCalls=%d",
          response.content ? "yes" : "none",
          response.toolCalls.length,
        );

        // 将模型的回复加入历史
        appendMessage(
          {
            role: "assistant",
            content: response.content ?? null,
            tool_calls:
              response.toolCalls.length > 0 ? response.toolCalls : undefined,
          } as ChatCompletionMessageParam,
          roundCount,
        );

        // 5. 处理工具调用
        //    如果响应包含 tool_calls，即使 finishReason 异常，
        //    也优先按工具调用流程处理，避免破坏 tool_call / tool_result 配对。
        if (response.toolCalls.length > 0) {
          await handleToolCalls(response.toolCalls, roundCount);
          continue;
        }

        // 6. 没有工具调用 → 最终回复
        //    检查输出是否因长度被截断（finishReason === "length"）
        if (response.finishReason === "length") {
          const action = decideRecovery("output_interrupted", recoveryState);
          if (action === "continue") {
            recoveryState.continueRetryCount++;
            logger.info(
              formatRecoveryNotice(
                "continue",
                "output_interrupted",
                recoveryState,
              ),
            );
            if (transcriptStore && sessionId) {
              transcriptStore.append({
                sessionId,
                type: "recovery_event",
                round: roundCount,
                payload: {
                  kind: "output_interrupted",
                  action,
                  continueRetryCount: recoveryState.continueRetryCount,
                },
              });
            }
            // 累积本次被截断的部分输出
            accumulatedContent += response.content ?? "";
            appendContinuationReminder(roundCount);
            continue; // 进入下一轮 LLM 调用，请求从断点继续
          }
          // 超过继续次数上限，返回累积的部分内容加中断说明
          return `[模型输出被截断，已达到继续次数上限]\n${accumulatedContent}${response.content ?? ""}`;
        }

        if (response.content) {
          return accumulatedContent + response.content;
        }
        return accumulatedContent || "(no response)";
      }
    },
  };
}
