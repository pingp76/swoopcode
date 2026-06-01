/**
 * runtime-policy-store.ts — Runtime Policy 会话级存储模块
 *
 * 职责：保存 base policy 和本 session 的 runtime override，
 * 提供合并后的当前策略，支持运行时 CLI 调整。
 *
 * 设计原则：
 * - 调整的是 session-local runtime override，不是修改 FoundationModelProfile。
 * - 每次修改后重新派生 compression config。
 * - SubAgent / Async Run 使用 snapshot() 获取不可变副本。
 */

import type { RuntimePolicy } from "./runtime-policy.js";
import type { ThinkingDefaultMode } from "./foundation-models.js";
import type { FoundationModelProfile } from "./foundation-models.js";
import {
  resolveRuntimePolicy,
  buildExtraBody,
  deriveCompressionDefaults,
} from "./runtime-policy.js";
import { resolveContextBudgets } from "./context-budget.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * RuntimePolicyOverride — 会话级策略覆盖
 */
export interface RuntimePolicyOverride {
  /** thinking 模式覆盖 */
  thinkingMode?: ThinkingDefaultMode;
  /** reasoning effort 覆盖（null 表示清除） */
  reasoningEffort?: string | null;
  /** context budget 覆盖 */
  contextBudgetTokens?: number;
  /** max output tokens 覆盖 */
  maxOutputTokens?: number;
  /** 压缩模式覆盖 */
  compressionMode?: "aggressive" | "balanced" | "long_context";
  /** stable context loader 开关 */
  stableContextEnabled?: boolean;
}

/**
 * RuntimePolicyStore — 策略存储接口
 */
export interface RuntimePolicyStore {
  /** 获取基础 policy（不含 override） */
  getBasePolicy(): RuntimePolicy;
  /** 获取合并 override 后的当前 policy */
  getPolicy(): RuntimePolicy;
  /** 获取当前 override */
  getOverride(): RuntimePolicyOverride;
  /** 更新 override，返回合并后的新 policy */
  updateOverride(
    patch: RuntimePolicyOverride,
    source: "cli" | "system",
  ): RuntimePolicy;
  /** 重置 override，返回 base policy */
  resetOverride(source: "cli" | "system"): RuntimePolicy;
  /** 获取当前 policy 的不可变快照 */
  snapshot(): RuntimePolicy;
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * 创建 RuntimePolicyStore
 *
 * @param profile - 已解析的模型画像
 * @param model - 实际模型名
 * @param env - 环境变量（用于重新解析 base policy）
 */
export function createRuntimePolicyStore(
  profile: FoundationModelProfile,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimePolicyStore {
  // basePolicy 由 profile + env 解析得到，是"不随会话变化"的基准策略。
  const basePolicy = resolveRuntimePolicy(profile, model, env);

  // 当前会话的 override，初始为空。
  let override: RuntimePolicyOverride = {};

  // -------------------------------------------------------------------------
  // 内部辅助：合并 override 到 base policy
  // -------------------------------------------------------------------------

  function mergePolicy(): RuntimePolicy {
    const merged: RuntimePolicy = { ...basePolicy };

    // context 字段浅拷贝后覆盖
    merged.context = { ...basePolicy.context };
    if (override.contextBudgetTokens !== undefined) {
      merged.context.effectiveBudgetTokens = override.contextBudgetTokens;
    }
    if (override.compressionMode !== undefined) {
      merged.context.compressionMode = override.compressionMode;
      // 重新派生压缩阈值（复用 runtime-policy.ts 的 deriveCompressionDefaults）
      const defaults = deriveCompressionDefaults(
        override.compressionMode,
        merged.context.effectiveBudgetTokens,
      );
      merged.context.toolOutputCompressionThresholdTokens = defaults.thresholdToolOutput;
      merged.context.decayThresholdLoops = defaults.decayThreshold;
      merged.context.decayPreviewTokens = defaults.decayPreview;
      merged.context.compactKeepRecentBlocks = defaults.compactKeepRecent;
    }

    // request 字段浅拷贝后覆盖
    merged.request = { ...basePolicy.request };
    if (override.thinkingMode !== undefined) {
      merged.request.thinkingMode = override.thinkingMode;
      // 重新构建 extraBody
      merged.request.extraBody = buildExtraBody(profile, override.thinkingMode, merged.request.reasoningEffort);
    }
    if (override.reasoningEffort !== undefined) {
      if (override.reasoningEffort === null) {
        delete merged.request.reasoningEffort;
      } else {
        merged.request.reasoningEffort = override.reasoningEffort;
      }
      // 重新构建 extraBody
      merged.request.extraBody = buildExtraBody(
        profile,
        merged.request.thinkingMode,
        merged.request.reasoningEffort,
      );
    }
    if (override.maxOutputTokens !== undefined) {
      merged.request.maxOutputTokens = override.maxOutputTokens;
    }

    // 如果 context budget 或 compression mode 发生变化，重新计算 contextLoading
    if (
      override.contextBudgetTokens !== undefined ||
      override.compressionMode !== undefined ||
      override.maxOutputTokens !== undefined
    ) {
      merged.contextLoading = resolveContextBudgets({
        effectiveBudgetTokens: merged.context.effectiveBudgetTokens,
        compressionMode: merged.context.compressionMode,
        maxOutputTokens: merged.request.maxOutputTokens,
      });
    }

    return merged;
  }

  // -------------------------------------------------------------------------
  // 校验 override 是否合法
  // -------------------------------------------------------------------------

  function validateOverride(patch: RuntimePolicyOverride): void {
    // 显式拒绝非法字段的 mid-session override
    // PDD21 规定：protocol/tools/reasoning/cache/modalities 等协议字段
    // 不能运行中修改，必须新开 session 或重启。
    const allowedKeys = new Set([
      "thinkingMode",
      "reasoningEffort",
      "contextBudgetTokens",
      "maxOutputTokens",
      "compressionMode",
      "stableContextEnabled",
    ]);
    const illegalKeys = Object.keys(patch).filter((k) => !allowedKeys.has(k));
    if (illegalKeys.length > 0) {
      throw new Error(
        `Protocol/tools/reasoning field changes require a new session or restart. ` +
          `Runtime CLI only supports thinking, effort, context budget, max output, compression, and stable context toggles. ` +
          `Illegal fields: ${illegalKeys.join(", ")}.`,
      );
    }

    if (
      patch.thinkingMode !== undefined &&
      patch.thinkingMode !== "disabled" &&
      !profile.thinking.supported
    ) {
      throw new Error(
        `Model profile "${profile.id}" does not support thinking mode.`,
      );
    }

    if (patch.reasoningEffort !== undefined && patch.reasoningEffort !== null) {
      const validEfforts = profile.thinking.efforts ?? ["default"];
      if (!validEfforts.includes(patch.reasoningEffort)) {
        throw new Error(
          `Model ${profile.id} does not support reasoning effort "${patch.reasoningEffort}". Supported: ${validEfforts.join(", ")}.`,
        );
      }
    }

    if (patch.contextBudgetTokens !== undefined) {
      if (patch.contextBudgetTokens > profile.limits.contextWindowTokens) {
        throw new Error(
          `Context budget (${patch.contextBudgetTokens}) exceeds model context window (${profile.limits.contextWindowTokens}).`,
        );
      }
      if (patch.contextBudgetTokens <= 0) {
        throw new Error("Context budget must be a positive number.");
      }
    }

    if (patch.maxOutputTokens !== undefined) {
      if (patch.maxOutputTokens > profile.limits.maxOutputTokens) {
        throw new Error(
          `Max output tokens (${patch.maxOutputTokens}) exceeds profile limit (${profile.limits.maxOutputTokens}).`,
        );
      }
      if (patch.maxOutputTokens <= 0) {
        throw new Error("Max output tokens must be a positive number.");
      }
    }
  }

  return {
    getBasePolicy() {
      return basePolicy;
    },

    getPolicy() {
      return mergePolicy();
    },

    getOverride() {
      return { ...override };
    },

    updateOverride(patch, _source) {
      validateOverride(patch);
      override = { ...override, ...patch };
      // 清除值为 null 的字段
      if (patch.reasoningEffort === null) {
        // 已经通过 spread 合并了，但 override 里仍保留 reasoningEffort: null
        // 这是有意的设计：null 表示"用户显式清除了 effort"
      }
      return mergePolicy();
    },

    resetOverride(_source) {
      override = {};
      return basePolicy;
    },

    snapshot() {
      // 深拷贝确保外部不能修改内部状态
      return JSON.parse(JSON.stringify(mergePolicy())) as RuntimePolicy;
    },
  };
}


