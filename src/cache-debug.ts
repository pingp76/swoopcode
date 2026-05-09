/**
 * cache-debug.ts — Prompt Cache 稳定性调试模块
 *
 * 职责：计算 system prompt、tools、stable prefix 的 hash，
 * 帮助开发者观察请求前缀是否发生变化。
 *
 * 核心原则：
 * - 这是教学版缓存观测信息，不声称是底层 API 的真实 cache hit rate
 * - Hash 只用于调试，不参与业务逻辑
 * - 使用 Node 内置 crypto，不新增外部依赖
 */

import { createHash } from "node:crypto";
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";

// ============================================================================
// 接口定义
// ============================================================================

/**
 * CacheDebugSnapshot — 单次请求的缓存调试快照
 */
export interface CacheDebugSnapshot {
  /** system prompt 的 SHA256 hash */
  systemPromptHash: string;
  /** 工具定义的 SHA256 hash */
  toolsHash: string;
  /** 稳定前缀（system prompt + tools）的 SHA256 hash */
  stablePrefixHash: string;
  /** 消息数量 */
  messageCount: number;
  /** 工具数量 */
  toolCount: number;
}

/**
 * CacheDebugState — 包含当前快照和变化标记
 */
export interface CacheDebugState {
  current: CacheDebugSnapshot;
  changed: {
    systemPrompt: boolean;
    tools: boolean;
    stablePrefix: boolean;
  };
}

// ============================================================================
// 稳定序列化
// ============================================================================

/**
 * stableStringify — 稳定 JSON 序列化
 *
 * 规则：
 * - 普通对象按 key 排序
 * - 数组保持顺序
 * - string 原样进入
 * - undefined 值被跳过（与 JSON.stringify 一致）
 */
function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    const pairs = keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return "{" + pairs.join(",") + "}";
  }
  return "null";
}

// ============================================================================
// Hash 计算
// ============================================================================

/**
 * sha256 — 计算字符串的 SHA256 hash（取前 8 位，便于日志阅读）
 */
function sha256(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex").slice(0, 8);
}

/**
 * computeSystemPromptHash — 从消息列表中提取 system prompt 并计算 hash
 *
 * 取第一条 role === "system" 的 message content。
 * 如果没有 system message，hash 为空字符串的 hash。
 */
function computeSystemPromptHash(messages: ChatCompletionMessageParam[]): string {
  const systemMsg = messages.find((m) => m.role === "system");
  const content =
    typeof systemMsg?.content === "string"
      ? systemMsg.content
      : JSON.stringify(systemMsg?.content ?? "");
  return sha256(content);
}

/**
 * computeToolsHash — 计算工具定义列表的 hash
 */
function computeToolsHash(tools: ChatCompletionTool[]): string {
  return sha256(stableStringify(tools));
}

/**
 * computeStablePrefixHash — 计算稳定前缀的 hash
 *
 * 教学版定义为：system prompt content + tools JSON
 */
function computeStablePrefixHash(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
): string {
  const systemMsg = messages.find((m) => m.role === "system");
  const systemContent =
    typeof systemMsg?.content === "string"
      ? systemMsg.content
      : JSON.stringify(systemMsg?.content ?? "");
  return sha256(systemContent + stableStringify(tools));
}

// ============================================================================
// 追踪器
// ============================================================================

/**
 * createCacheDebugTracker — 创建缓存调试追踪器
 *
 * 内部保存上一次快照，每次 inspect 时对比并标记变化。
 */
export function createCacheDebugTracker(): {
  inspect(input: {
    messages: ChatCompletionMessageParam[];
    tools: ChatCompletionTool[];
  }): CacheDebugState;
} {
  let lastSnapshot: CacheDebugSnapshot | null = null;

  return {
    inspect(input): CacheDebugState {
      const current: CacheDebugSnapshot = {
        systemPromptHash: computeSystemPromptHash(input.messages),
        toolsHash: computeToolsHash(input.tools),
        stablePrefixHash: computeStablePrefixHash(input.messages, input.tools),
        messageCount: input.messages.length,
        toolCount: input.tools.length,
      };

      const state: CacheDebugState = {
        current,
        changed: {
          systemPrompt: lastSnapshot
            ? lastSnapshot.systemPromptHash !== current.systemPromptHash
            : false,
          tools: lastSnapshot
            ? lastSnapshot.toolsHash !== current.toolsHash
            : false,
          stablePrefix: lastSnapshot
            ? lastSnapshot.stablePrefixHash !== current.stablePrefixHash
            : false,
        },
      };

      lastSnapshot = current;
      return state;
    },
  };
}

// ============================================================================
// 格式化输出
// ============================================================================

/**
 * formatCacheDebugLog — 将 CacheDebugState 格式化为单行日志字符串
 *
 * 示例：
 *   [cache] systemPrompt=stable tools=stable prefix=stable systemHash=abc123 toolsHash=def456
 *   [cache] prefix changed: system prompt changed
 */
export function formatCacheDebugLog(state: CacheDebugState): string {
  const { current, changed } = state;
  const spStatus = changed.systemPrompt ? "changed" : "stable";
  const toolsStatus = changed.tools ? "changed" : "stable";
  const prefixStatus = changed.stablePrefix ? "changed" : "stable";

  const parts = [
    `[cache] systemPrompt=${spStatus}`,
    `tools=${toolsStatus}`,
    `prefix=${prefixStatus}`,
    `systemHash=${current.systemPromptHash}`,
    `toolsHash=${current.toolsHash}`,
    `msgs=${current.messageCount}`,
    `tools=${current.toolCount}`,
  ];

  return parts.join(" ");
}
