/**
 * runtime-policy.ts — Agent Runtime Policy 解析模块
 *
 * 职责：根据 FoundationModelProfile 解析出当前进程/本轮应该采用的 Agent 行为策略。
 *
 * 设计原则：
 * - Profile 是事实，Policy 是决策。不要把这两者混在一起。
 * - 事实表可以被测试校验；策略解析可以被场景测试覆盖。
 * - 模型策略不进 system prompt，通过本地代码影响请求参数和消息布局。
 */

import type {
  FoundationModelProfile,
  ModelProtocol,
  ThinkingDefaultMode,
} from "./foundation-models.js";
import type { LLMProviderId } from "./llm-providers.js";
import type { ContextBudgetPlan } from "./context-budget.js";
import { resolveContextBudgets } from "./context-budget.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * RuntimePolicy — 当前 Agent 进程实际使用的运行策略
 *
 * 回答"在这个模型下，本 agent 应该怎么组织上下文、thinking、工具、缓存和输出"。
 */
export interface RuntimePolicy {
  /** 来源 profile id */
  modelProfileId: string;
  /** provider 标识 */
  provider: LLMProviderId;
  /** 模型名 */
  model: string;

  /** 协议策略 */
  protocol: {
    /** 选中的协议 */
    selected: ModelProtocol;
    /** 是否已实现 */
    implemented: boolean;
  };

  /** 上下文策略 */
  context: {
    /** 官方窗口 */
    contextWindowTokens: number;
    /** 实际使用预算 */
    effectiveBudgetTokens: number;
    /** 超长上下文阈值 */
    longContextThresholdTokens: number;
    /** 压缩模式 */
    compressionMode: "aggressive" | "balanced" | "long_context";
    /** 工具输出即时压缩阈值 */
    toolOutputCompressionThresholdTokens: number;
    /** 衰减压缩轮次阈值 */
    decayThresholdLoops: number;
    /** 衰减后保留预览 token 数 */
    decayPreviewTokens: number;
    /** 全量压缩保留最近消息块数 */
    compactKeepRecentBlocks: number;
  };

  /** 请求策略 */
  request: {
    /** 是否优先 streaming */
    prefersStreaming: boolean;
    /** 最大输出 token */
    maxOutputTokens: number;
    /** max token 字段名 */
    maxTokensField: "max_tokens" | "max_completion_tokens";
    /** thinking 模式 */
    thinkingMode: ThinkingDefaultMode;
    /** reasoning effort 级别 */
    reasoningEffort?: string;
    /** 额外请求体字段 */
    extraBody: Record<string, unknown>;
  };

  /** reasoning 处理策略 */
  reasoning: {
    /** 响应中是否返回 reasoning 内容 */
    returned: boolean;
    /** 是否保存完整原始 assistant message */
    preserveRawAssistantMessage: boolean;
    /** tool_calls 时是否必须回放 reasoning */
    mustReplayWithToolCalls: boolean;
    /** 响应字段位置 */
    responseFields: FoundationModelProfile["reasoning"]["responseFields"];
    /** streaming delta 字段位置 */
    streamingDeltaFields: FoundationModelProfile["reasoning"]["streamingDeltaFields"];
  };

  /** 工具策略 */
  tools: {
    /** 是否支持 tools */
    supportsTools: boolean;
    /** 是否支持 tool_choice=required */
    supportsToolChoiceRequired: boolean;
    /** 允许的 tool_choice 模式 */
    allowedToolChoiceModes: Array<"auto" | "none" | "required">;
    /** streaming arguments 是否需要聚合 */
    streamingArguments: boolean;
    /** 是否允许多模态 tool results */
    multimodalToolResults: boolean;
  };

  /** Cache 策略 */
  cache: {
    /** 是否支持 cache */
    supported: boolean;
    /** 是否自动启用 */
    automatic: boolean;
    /** 是否暴露 usage */
    exposeUsage: boolean;
    /** usage 字段映射 */
    usageFields: FoundationModelProfile["cache"]["usageFields"];
  };

  /** 遥测策略 */
  telemetry: {
    /** 是否记录 reasoning tokens */
    recordReasoningTokens: boolean;
    /** 是否记录 cache tokens */
    recordCacheTokens: boolean;
    /** 是否记录 effective context budget */
    recordEffectiveContextBudget: boolean;
  };

  /** 上下文装载策略（PDD21：Stable Context Manager 使用） */
  contextLoading?: ContextBudgetPlan;
}

// ---------------------------------------------------------------------------
// 压缩默认值派生
// ---------------------------------------------------------------------------

interface CompressionDefaults {
  maxContextTokens: number;
  thresholdToolOutput: number;
  decayThreshold: number;
  decayPreview: number;
  compactKeepRecent: number;
}

/**
 * 根据压缩模式派生默认压缩参数
 *
 * 导出供 runtime-policy-store.ts 复用，避免硬编码阈值漂移。
 */
export function deriveCompressionDefaults(
  mode: "aggressive" | "balanced" | "long_context",
  effectiveBudget: number,
): CompressionDefaults {
  switch (mode) {
    case "aggressive":
      return {
        maxContextTokens: Math.min(effectiveBudget, 80000),
        thresholdToolOutput: 2000,
        decayThreshold: 3,
        decayPreview: 100,
        compactKeepRecent: 4,
      };
    case "balanced":
      return {
        maxContextTokens: effectiveBudget,
        thresholdToolOutput: 4000,
        decayThreshold: 5,
        decayPreview: 200,
        compactKeepRecent: 6,
      };
    case "long_context":
      return {
        maxContextTokens: effectiveBudget,
        thresholdToolOutput: 8000,
        decayThreshold: 8,
        decayPreview: 400,
        compactKeepRecent: 10,
      };
  }
}

// ---------------------------------------------------------------------------
// Policy Resolver
// ---------------------------------------------------------------------------

/**
 * 解析 Runtime Policy
 *
 * 从 profile 派生策略，支持环境变量覆盖。
 *
 * @param profile - 已解析的 FoundationModelProfile
 * @param model - 实际使用的模型名
 * @param env - 环境变量对象，默认 process.env
 * @returns RuntimePolicy
 * @throws 覆盖值非法时抛出错误
 */
export function resolveRuntimePolicy(
  profile: FoundationModelProfile,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimePolicy {
  // 教学导读：
  // Policy resolver 是"模型事实 → 运行决策"的转换层。
  // 它把 profile 里的静态能力描述，转化为当前进程可以直接消费的行为策略。
  // 关键设计：所有覆盖值必须先校验是否被 profile 支持，不支持时报启动错误，
  // 而不是静默忽略或降级。这避免了"用户以为开启了 thinking，实际没开"的困惑。

  // 1. 解析协议
  const protocol = resolveProtocol(profile, env);

  // 2. 解析 thinking 模式
  const thinkingMode = resolveThinkingMode(profile, env);

  // 3. 解析 reasoning effort
  const reasoningEffort = resolveReasoningEffort(profile, env);

  // 4. 解析 context budget
  const contextBudget = resolveContextBudget(profile, env);

  // 5. 解析 max output tokens
  const maxOutputTokens = resolveMaxOutputTokens(profile, env);

  // 6. 构建 extraBody（thinking 参数）
  const extraBody = buildExtraBody(profile, thinkingMode, reasoningEffort);

  // 7. 派生压缩默认值
  const compressionMode = profile.optimizationHints.defaultCompressionMode;
  const compressionDefaults = deriveCompressionDefaults(
    compressionMode,
    contextBudget,
  );

  // 8. 派生上下文预算分配（供 Stable Context Manager 使用）
  const contextBudgetPlan = resolveContextBudgets({
    effectiveBudgetTokens: contextBudget,
    compressionMode,
    maxOutputTokens,
  });

  return {
    modelProfileId: profile.id,
    provider: profile.provider,
    model,

    protocol,

    context: {
      contextWindowTokens: profile.limits.contextWindowTokens,
      effectiveBudgetTokens: contextBudget,
      longContextThresholdTokens:
        profile.limits.longContextThresholdTokens ?? contextBudget,
      compressionMode,
      toolOutputCompressionThresholdTokens:
        compressionDefaults.thresholdToolOutput,
      decayThresholdLoops: compressionDefaults.decayThreshold,
      decayPreviewTokens: compressionDefaults.decayPreview,
      compactKeepRecentBlocks: compressionDefaults.compactKeepRecent,
    },

    request: (() => {
      const request: RuntimePolicy["request"] = {
        prefersStreaming: profile.optimizationHints.prefersStreaming,
        maxOutputTokens,
        maxTokensField: profile.limits.maxTokensField,
        thinkingMode,
        extraBody,
      };
      if (reasoningEffort !== undefined) {
        request.reasoningEffort = reasoningEffort;
      }
      return request;
    })(),

    reasoning: {
      returned: profile.reasoning.returned,
      preserveRawAssistantMessage:
        profile.reasoning.preserveRawAssistantMessage,
      mustReplayWithToolCalls: profile.reasoning.mustReplayWithToolCalls,
      responseFields: profile.reasoning.responseFields,
      streamingDeltaFields: profile.reasoning.streamingDeltaFields,
    },

    tools: {
      supportsTools: profile.tools.supported,
      supportsToolChoiceRequired: profile.tools.supportsToolChoiceRequired,
      allowedToolChoiceModes: profile.tools.allowedToolChoiceModes,
      streamingArguments: profile.tools.streamingArguments,
      multimodalToolResults: profile.tools.multimodalToolResults,
    },

    cache: {
      supported: profile.cache.supported,
      automatic: profile.cache.automatic,
      exposeUsage: profile.cache.exposesUsage,
      usageFields: profile.cache.usageFields,
    },

    telemetry: {
      recordReasoningTokens: profile.reasoning.returned,
      recordCacheTokens: profile.cache.supported && profile.cache.exposesUsage,
      recordEffectiveContextBudget: true,
    },

    ...(contextBudgetPlan !== undefined
      ? { contextLoading: contextBudgetPlan }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 内部解析辅助函数
// ---------------------------------------------------------------------------

/**
 * 解析协议策略
 *
 * 规则：
 * 1. 如果用户显式指定 protocol，必须已实现，否则报错
 * 2. 如果首选协议未实现，自动降级到 fallback
 * 3. 如果所有协议都未实现，报错
 */
function resolveProtocol(
  profile: FoundationModelProfile,
  env: NodeJS.ProcessEnv,
): { selected: ModelProtocol; implemented: boolean } {
  const explicitProtocol = env["LLM_PROTOCOL"] as ModelProtocol | undefined;

  if (explicitProtocol) {
    // 用户显式指定 protocol，必须校验是否已实现
    if (!profile.protocol.implemented.includes(explicitProtocol)) {
      throw new Error(
        `Configured protocol "${explicitProtocol}" for model profile "${profile.id}" is not implemented yet. ` +
          `Use LLM_PROTOCOL=${profile.protocol.implemented[0] ?? "openai-chat-completions"} or implement the adapter.`,
      );
    }
    return { selected: explicitProtocol, implemented: true };
  }

  // 未显式指定：首选协议已实现则直接使用
  if (profile.protocol.implemented.includes(profile.protocol.preferred)) {
    return { selected: profile.protocol.preferred, implemented: true };
  }

  // 首选未实现：尝试 fallback
  for (const fallback of profile.protocol.fallbacks) {
    if (profile.protocol.implemented.includes(fallback)) {
      // 启动时 warning：用户可能期望首选协议
      console.warn(
        `[model-policy] preferred protocol ${profile.protocol.preferred} is not implemented; using ${fallback} fallback for ${profile.id}`,
      );
      return { selected: fallback, implemented: true };
    }
  }

  // 没有任何可用协议
  throw new Error(
    `No implemented protocol available for model profile "${profile.id}". ` +
      `Implemented: ${profile.protocol.implemented.join(", ")}.`,
  );
}

/**
 * 解析 thinking 模式
 */
function resolveThinkingMode(
  profile: FoundationModelProfile,
  env: NodeJS.ProcessEnv,
): ThinkingDefaultMode {
  const explicit = env["LLM_THINKING"] as ThinkingDefaultMode | undefined;
  if (!explicit) {
    return profile.thinking.defaultMode;
  }

  // 校验值合法性
  const validModes: ThinkingDefaultMode[] = ["disabled", "enabled", "adaptive"];
  if (!validModes.includes(explicit)) {
    throw new Error(
      `Invalid LLM_THINKING value "${explicit}". Valid values: ${validModes.join(", ")}.`,
    );
  }

  // 校验模型是否支持 thinking
  if (explicit !== "disabled" && !profile.thinking.supported) {
    throw new Error(
      `Model profile "${profile.id}" does not support thinking mode. ` +
        `Set LLM_THINKING=disabled or use a different model.`,
    );
  }

  return explicit;
}

/**
 * 解析 reasoning effort
 */
function resolveReasoningEffort(
  profile: FoundationModelProfile,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const explicit = env["LLM_REASONING_EFFORT"];
  if (!explicit) {
    return undefined;
  }

  // 如果模型没有声明支持的 efforts，默认只允许 "default"
  const validEfforts = profile.thinking.efforts ?? ["default"];
  if (!validEfforts.includes(explicit)) {
    throw new Error(
      `Model ${profile.id} does not support reasoning effort "${explicit}". ` +
        `Supported: ${validEfforts.join(", ")}.`,
    );
  }

  return explicit;
}

/**
 * 解析 context budget
 */
function resolveContextBudget(
  profile: FoundationModelProfile,
  env: NodeJS.ProcessEnv,
): number {
  const explicit = env["LLM_CONTEXT_BUDGET"];
  if (!explicit) {
    return profile.limits.effectiveContextBudgetTokens;
  }

  const budget = Number(explicit);
  if (Number.isNaN(budget) || budget <= 0) {
    throw new Error(
      `Invalid LLM_CONTEXT_BUDGET value "${explicit}". Must be a positive number.`,
    );
  }

  if (budget > profile.limits.contextWindowTokens) {
    throw new Error(
      `LLM_CONTEXT_BUDGET (${budget}) exceeds model context window (${profile.limits.contextWindowTokens}).`,
    );
  }

  return budget;
}

/**
 * 解析 max output tokens
 */
function resolveMaxOutputTokens(
  profile: FoundationModelProfile,
  env: NodeJS.ProcessEnv,
): number {
  const explicit = env["LLM_MAX_OUTPUT_TOKENS"];
  if (!explicit) {
    return profile.limits.maxOutputTokens;
  }

  const tokens = Number(explicit);
  if (Number.isNaN(tokens) || tokens <= 0) {
    throw new Error(
      `Invalid LLM_MAX_OUTPUT_TOKENS value "${explicit}". Must be a positive number.`,
    );
  }

  if (tokens > profile.limits.maxOutputTokens) {
    throw new Error(
      `LLM_MAX_OUTPUT_TOKENS (${tokens}) exceeds profile limit (${profile.limits.maxOutputTokens}).`,
    );
  }

  return tokens;
}

/**
 * 构建 extraBody
 *
 * 根据 profile.thinking.requestShape 决定 thinking 参数放在请求体的哪个位置。
 *
 * 导出供 runtime-policy-store.ts 复用，避免代码重复。
 */
export function buildExtraBody(
  profile: FoundationModelProfile,
  thinkingMode: ThinkingDefaultMode,
  reasoningEffort: string | undefined,
): Record<string, unknown> {
  const extraBody: Record<string, unknown> = {};

  if (!profile.thinking.supported || thinkingMode === "disabled") {
    return extraBody;
  }

  const shape = profile.thinking.requestShape ?? "none";

  switch (shape) {
    case "extra_body_thinking": {
      extraBody["thinking"] = {
        type: thinkingMode === "enabled" ? "enabled" : "auto",
      };
      break;
    }
    case "enable_thinking": {
      extraBody["enable_thinking"] = true;
      break;
    }
    case "chat_template_kwargs": {
      extraBody["chat_template_kwargs"] = {
        enable_thinking: true,
      };
      break;
    }
    case "none":
    default: {
      // 不添加额外字段
      break;
    }
  }

  // reasoning effort 如果存在，作为独立字段加入
  if (reasoningEffort) {
    extraBody["reasoning_effort"] = reasoningEffort;
  }

  return extraBody;
}

// ---------------------------------------------------------------------------
// 辅助导出
// ---------------------------------------------------------------------------

/**
 * 将 RuntimePolicy 的压缩策略转换为 CompressionConfig 可用的平面对象
 *
 * 供 config.ts 在组装配置时使用。
 */
export type { ThinkingDefaultMode } from "./foundation-models.js";

export function extractCompressionDefaultsFromPolicy(policy: RuntimePolicy): {
  thresholdToolOutput: number;
  decayThreshold: number;
  decayPreviewTokens: number;
  maxContextTokens: number;
  compactKeepRecent: number;
} {
  return {
    thresholdToolOutput: policy.context.toolOutputCompressionThresholdTokens,
    decayThreshold: policy.context.decayThresholdLoops,
    decayPreviewTokens: policy.context.decayPreviewTokens,
    maxContextTokens: policy.context.effectiveBudgetTokens,
    compactKeepRecent: policy.context.compactKeepRecentBlocks,
  };
}
