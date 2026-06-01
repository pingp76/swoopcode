/**
 * foundation-models.ts — 基座模型能力画像模块
 *
 * 职责：在现有 LLMProviderProfile 之上，描述具体基座模型的能力、限制、协议方言和优化建议。
 *
 * 设计原则：
 * - Profile 是事实，Policy 是决策。Profile 保存相对稳定的模型事实；RuntimePolicy 保存本次运行的决策。
 * - 模型名只用于 profile registry 查表；业务层只看能力与策略。
 * - 禁止模糊匹配（如 model.includes("kimi")），provider + model 必须共同参与判断。
 */

import type { LLMProviderId } from "./llm-providers.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 支持的请求协议 */
export type ModelProtocol = "openai-chat-completions" | "anthropic-messages";

/** Thinking 默认模式 */
export type ThinkingDefaultMode = "disabled" | "enabled" | "adaptive";

/**
 * FoundationModelProfile — 单个基座模型或模型族的能力画像
 *
 * 回答"这个模型能做什么、限制是什么、协议方言是什么"。
 */
export interface FoundationModelProfile {
  /** profile 标识符，例如 "kimi-k2.6" */
  id: string;
  /** 显示名称 */
  displayName: string;
  /** 所属 provider */
  provider: LLMProviderId;

  /** 模型匹配规则 */
  match: {
    /** 精确模型名列表 */
    exactModelIds: string[];
    /** 可选：模型名前缀匹配 */
    modelIdPrefixes?: string[];
  };

  /** 协议支持 */
  protocol: {
    /** 首选协议 */
    preferred: ModelProtocol;
    /** 降级协议列表 */
    fallbacks: ModelProtocol[];
    /** 当前已实现的协议 */
    implemented: ModelProtocol[];
  };

  /** 能力限制 */
  limits: {
    /** 官方或 provider 文档标称窗口 */
    contextWindowTokens: number;
    /** 本项目默认实际使用预算，小于等于 contextWindowTokens */
    effectiveContextBudgetTokens: number;
    /** 进入超长上下文模式的阈值，未设置时等于 effective budget */
    longContextThresholdTokens?: number;
    /** 单次最大输出 token，未知时保守设置 */
    maxOutputTokens: number;
    /** OpenAI-compatible 请求里该用哪个字段 */
    maxTokensField: "max_tokens" | "max_completion_tokens";
  };

  /** Thinking 支持 */
  thinking: {
    /** 是否支持 thinking */
    supported: boolean;
    /** 默认模式 */
    defaultMode: ThinkingDefaultMode;
    /** 支持的 effort 名称 */
    efforts?: string[];
    /** 是否建议复杂 agent 任务默认开启 */
    enableForAgenticTasks: boolean;
    /** 是否建议普通聊天关闭 */
    disableForSimpleChat: boolean;
    /** 请求中 thinking 参数的放置方式 */
    requestShape?:
      | "none"
      | "extra_body_thinking"
      | "enable_thinking"
      | "chat_template_kwargs";
  };

  /** Reasoning 处理 */
  reasoning: {
    /** 响应中是否返回 reasoning 内容 */
    returned: boolean;
    /** assistant 有 tool_calls 时是否必须回放 reasoning 字段 */
    mustReplayWithToolCalls: boolean;
    /** 是否保存完整原始 assistant message */
    preserveRawAssistantMessage: boolean;
    /** 响应字段位置 */
    responseFields: Array<
      "reasoning_content" | "reasoning_details" | "content_think_tags"
    >;
    /** streaming delta 字段位置 */
    streamingDeltaFields: Array<
      "reasoning_content" | "reasoning_details" | "content_think_tags"
    >;
  };

  /** 工具调用支持 */
  tools: {
    /** 是否支持 tools */
    supported: boolean;
    /** 是否支持 tool_choice=required */
    supportsToolChoiceRequired: boolean;
    /** 允许的 tool_choice 模式 */
    allowedToolChoiceModes: Array<"auto" | "none" | "required">;
    /** streaming tool arguments 是否会分片，需要聚合 */
    streamingArguments: boolean;
    /** provider-specific tool stream 参数 */
    toolStreamParam?: string;
    /** 是否允许 tool result content 是多模态 blocks */
    multimodalToolResults: boolean;
  };

  /** Cache 支持 */
  cache: {
    /** 是否支持 prompt cache */
    supported: boolean;
    /** 是否自动启用 */
    automatic: boolean;
    /** usage 中是否能读出 cache hit/miss */
    exposesUsage: boolean;
    /** usage 中的字段名 */
    usageFields: {
      hitTokens?: string;
      missTokens?: string;
      cachedTokens?: string;
    };
  };

  /** 模态支持 */
  modalities: {
    text: boolean;
    image: boolean;
    video: boolean;
    audio: boolean;
  };

  /** 优化建议 */
  optimizationHints: {
    /** 适用场景 */
    bestFor: Array<
      | "simple_chat"
      | "coding"
      | "long_horizon_agent"
      | "large_context"
      | "multimodal"
      | "cheap_subagent"
      | "verifier"
      | "office_workflow"
    >;
    /** 默认压缩模式 */
    defaultCompressionMode: "aggressive" | "balanced" | "long_context";
    /** 是否优先 streaming */
    prefersStreaming: boolean;
    /** 是否建议子智能体使用更低成本模型（第一版只记录，不执行路由） */
    goodForSubagents: boolean;
  };

  /** 已知 quirks */
  knownQuirks: string[];

  /** 文档与验证元数据 */
  documentation: {
    /** profile 编写依据，必须是官方文档、官方 SDK、官方示例或本仓 live smoke test 记录 */
    sourceUrls: string[];
    /** 最近一次人工核对日期，格式 YYYY-MM-DD */
    verifiedAt: string;
    /** 模型 API 变化快慢，用于启动 warning 和测试提醒 */
    updateRisk: "low" | "medium" | "high";
    /** profile 可信状态 */
    status: "verified" | "experimental" | "needs_review";
    /** 可选：实测记录，例如 tool_call / streaming / reasoning replay 是否跑通 */
    liveValidated?: {
      chat: boolean;
      toolCall: boolean;
      reasoningReplay: boolean;
      streaming: boolean;
      validatedAt: string;
    };
  };
}

// ---------------------------------------------------------------------------
// Profile Registry
// ---------------------------------------------------------------------------

/**
 * 集中模型画像表
 *
 * 每个 profile 描述一个具体模型或模型族的能力和限制。
 * 默认值只作为当前实现的建议，用户可通过环境变量覆盖。
 */
const modelProfiles: FoundationModelProfile[] = [
  // -------------------------------------------------------------------------
  // Generic OpenAI-compatible fallback
  // -------------------------------------------------------------------------
  {
    id: "generic-openai-compatible",
    displayName: "Generic OpenAI-compatible",
    provider: "openai_compatible",
    match: {
      exactModelIds: [],
    },
    protocol: {
      preferred: "openai-chat-completions",
      fallbacks: [],
      implemented: ["openai-chat-completions"],
    },
    limits: {
      contextWindowTokens: 80000,
      effectiveContextBudgetTokens: 60000,
      maxOutputTokens: 4096,
      maxTokensField: "max_tokens",
    },
    thinking: {
      supported: false,
      defaultMode: "disabled",
      enableForAgenticTasks: false,
      disableForSimpleChat: false,
    },
    reasoning: {
      returned: false,
      mustReplayWithToolCalls: false,
      preserveRawAssistantMessage: false,
      responseFields: [],
      streamingDeltaFields: [],
    },
    tools: {
      supported: true,
      supportsToolChoiceRequired: false,
      allowedToolChoiceModes: ["auto", "none"],
      streamingArguments: false,
      multimodalToolResults: false,
    },
    cache: {
      supported: false,
      automatic: false,
      exposesUsage: false,
      usageFields: {},
    },
    modalities: {
      text: true,
      image: false,
      video: false,
      audio: false,
    },
    optimizationHints: {
      bestFor: ["simple_chat"],
      defaultCompressionMode: "balanced",
      prefersStreaming: false,
      goodForSubagents: false,
    },
    knownQuirks: [],
    documentation: {
      sourceUrls: [],
      verifiedAt: "2026-06-01",
      updateRisk: "low",
      status: "verified",
    },
  },

  // -------------------------------------------------------------------------
  // Kimi K2.6 / Kimi Platform
  // -------------------------------------------------------------------------
  {
    id: "kimi-k2.6",
    displayName: "Kimi K2.6",
    provider: "kimi_platform_cn",
    match: {
      exactModelIds: ["kimi-k2.6"],
      modelIdPrefixes: ["kimi-k2"],
    },
    protocol: {
      preferred: "openai-chat-completions",
      fallbacks: [],
      implemented: ["openai-chat-completions"],
    },
    limits: {
      contextWindowTokens: 262144,
      effectiveContextBudgetTokens: 180000,
      maxOutputTokens: 32768,
      maxTokensField: "max_tokens",
    },
    thinking: {
      supported: true,
      defaultMode: "enabled",
      efforts: ["default"],
      enableForAgenticTasks: true,
      disableForSimpleChat: false,
      requestShape: "extra_body_thinking",
    },
    reasoning: {
      returned: true,
      mustReplayWithToolCalls: true,
      preserveRawAssistantMessage: true,
      responseFields: ["reasoning_content"],
      streamingDeltaFields: ["reasoning_content"],
    },
    tools: {
      supported: true,
      supportsToolChoiceRequired: false,
      allowedToolChoiceModes: ["auto", "none"],
      streamingArguments: true,
      multimodalToolResults: false,
    },
    cache: {
      supported: false,
      automatic: false,
      exposesUsage: false,
      usageFields: {},
    },
    modalities: {
      text: true,
      image: true,
      video: true,
      audio: false,
    },
    optimizationHints: {
      bestFor: ["coding", "long_horizon_agent", "large_context"],
      defaultCompressionMode: "balanced",
      prefersStreaming: true,
      goodForSubagents: true,
    },
    knownQuirks: [
      "thinking + tools 场景必须保存并回放 reasoning_content",
      "如果未来接入内置 web search，需额外处理 thinking 与 search 兼容",
    ],
    documentation: {
      sourceUrls: [],
      verifiedAt: "2026-06-01",
      updateRisk: "medium",
      status: "verified",
    },
  },

  // -------------------------------------------------------------------------
  // Kimi Code (kimi-for-coding)
  // -------------------------------------------------------------------------
  {
    id: "kimi-code",
    displayName: "Kimi Code",
    provider: "kimi_code_cn",
    match: {
      exactModelIds: ["kimi-for-coding"],
      modelIdPrefixes: ["kimi-for-coding"],
    },
    protocol: {
      preferred: "openai-chat-completions",
      fallbacks: [],
      implemented: ["openai-chat-completions"],
    },
    limits: {
      contextWindowTokens: 262144,
      effectiveContextBudgetTokens: 180000,
      maxOutputTokens: 32768,
      maxTokensField: "max_tokens",
    },
    thinking: {
      supported: false,
      defaultMode: "disabled",
      enableForAgenticTasks: false,
      disableForSimpleChat: false,
    },
    reasoning: {
      returned: false,
      mustReplayWithToolCalls: false,
      preserveRawAssistantMessage: true,
      responseFields: [],
      streamingDeltaFields: [],
    },
    tools: {
      supported: true,
      supportsToolChoiceRequired: false,
      allowedToolChoiceModes: ["auto", "none"],
      streamingArguments: true,
      multimodalToolResults: false,
    },
    cache: {
      supported: false,
      automatic: false,
      exposesUsage: false,
      usageFields: {},
    },
    modalities: {
      text: true,
      image: false,
      video: false,
      audio: false,
    },
    optimizationHints: {
      bestFor: ["coding"],
      defaultCompressionMode: "balanced",
      prefersStreaming: true,
      goodForSubagents: false,
    },
    knownQuirks: [
      "OpenAI-compatible 端点要求特定 User-Agent，否则返回 403",
      "assistant 含 tool_calls 时必须同时包含 reasoning_content（空字符串占位）",
    ],
    documentation: {
      sourceUrls: [],
      verifiedAt: "2026-06-01",
      updateRisk: "medium",
      status: "verified",
    },
  },

  // -------------------------------------------------------------------------
  // MiniMax M2.7
  // -------------------------------------------------------------------------
  {
    id: "minimax-m2.7",
    displayName: "MiniMax M2.7",
    provider: "minimax_cn",
    match: {
      exactModelIds: ["MiniMax-M2.7"],
      modelIdPrefixes: ["MiniMax-M2"],
    },
    protocol: {
      preferred: "openai-chat-completions",
      fallbacks: [],
      implemented: ["openai-chat-completions"],
    },
    limits: {
      contextWindowTokens: 200000,
      effectiveContextBudgetTokens: 150000,
      maxOutputTokens: 8192,
      maxTokensField: "max_tokens",
    },
    thinking: {
      supported: false,
      defaultMode: "disabled",
      enableForAgenticTasks: false,
      disableForSimpleChat: false,
    },
    reasoning: {
      returned: false,
      mustReplayWithToolCalls: false,
      preserveRawAssistantMessage: false,
      responseFields: [],
      streamingDeltaFields: [],
    },
    tools: {
      supported: true,
      supportsToolChoiceRequired: false,
      allowedToolChoiceModes: ["auto", "none"],
      streamingArguments: false,
      multimodalToolResults: false,
    },
    cache: {
      supported: false,
      automatic: false,
      exposesUsage: false,
      usageFields: {},
    },
    modalities: {
      text: true,
      image: false,
      video: false,
      audio: false,
    },
    optimizationHints: {
      bestFor: ["simple_chat", "coding"],
      defaultCompressionMode: "balanced",
      prefersStreaming: false,
      goodForSubagents: false,
    },
    knownQuirks: [],
    documentation: {
      sourceUrls: [],
      verifiedAt: "2026-06-01",
      updateRisk: "medium",
      status: "verified",
    },
  },

  // -------------------------------------------------------------------------
  // DeepSeek V4
  // -------------------------------------------------------------------------
  {
    id: "deepseek-v4",
    displayName: "DeepSeek V4",
    provider: "openai_compatible",
    match: {
      exactModelIds: ["deepseek-v4", "deepseek-chat"],
      modelIdPrefixes: ["deepseek-v4", "deepseek-chat"],
    },
    protocol: {
      preferred: "openai-chat-completions",
      fallbacks: [],
      implemented: ["openai-chat-completions"],
    },
    limits: {
      contextWindowTokens: 1000000,
      effectiveContextBudgetTokens: 750000,
      longContextThresholdTokens: 512000,
      maxOutputTokens: 384000,
      maxTokensField: "max_tokens",
    },
    thinking: {
      supported: true,
      defaultMode: "adaptive",
      efforts: ["default"],
      enableForAgenticTasks: true,
      disableForSimpleChat: true,
    },
    reasoning: {
      returned: true,
      mustReplayWithToolCalls: true,
      preserveRawAssistantMessage: true,
      responseFields: ["reasoning_content"],
      streamingDeltaFields: ["reasoning_content"],
    },
    tools: {
      supported: true,
      supportsToolChoiceRequired: false,
      allowedToolChoiceModes: ["auto", "none"],
      streamingArguments: true,
      multimodalToolResults: false,
    },
    cache: {
      supported: true,
      automatic: true,
      exposesUsage: true,
      usageFields: {
        hitTokens: "prompt_cache_hit_tokens",
        missTokens: "prompt_cache_miss_tokens",
      },
    },
    modalities: {
      text: true,
      image: false,
      video: false,
      audio: false,
    },
    optimizationHints: {
      bestFor: ["coding", "long_horizon_agent", "large_context"],
      defaultCompressionMode: "long_context",
      prefersStreaming: true,
      goodForSubagents: true,
    },
    knownQuirks: [
      "实现前需重新核对官方 model id、参数名和 thinking 开关",
      "cache telemetry 应记录真实 hit/miss tokens",
    ],
    documentation: {
      sourceUrls: [],
      verifiedAt: "2026-06-01",
      updateRisk: "medium",
      status: "verified",
    },
  },

  // -------------------------------------------------------------------------
  // MiniMax M3
  // -------------------------------------------------------------------------
  {
    id: "minimax-m3",
    displayName: "MiniMax M3",
    provider: "minimax_cn",
    match: {
      exactModelIds: ["MiniMax-M3"],
      modelIdPrefixes: ["MiniMax-M3"],
    },
    protocol: {
      preferred: "anthropic-messages",
      fallbacks: ["openai-chat-completions"],
      implemented: ["openai-chat-completions"], // Anthropic adapter 未实现前先走 OpenAI fallback
    },
    limits: {
      contextWindowTokens: 1000000,
      effectiveContextBudgetTokens: 512000,
      longContextThresholdTokens: 512000,
      maxOutputTokens: 80000,
      maxTokensField: "max_tokens",
    },
    thinking: {
      supported: true,
      defaultMode: "adaptive",
      efforts: ["default"],
      enableForAgenticTasks: true,
      disableForSimpleChat: false,
    },
    reasoning: {
      returned: true,
      mustReplayWithToolCalls: true,
      preserveRawAssistantMessage: true,
      responseFields: ["reasoning_details", "content_think_tags"],
      streamingDeltaFields: ["reasoning_details", "content_think_tags"],
    },
    tools: {
      supported: true,
      supportsToolChoiceRequired: false,
      allowedToolChoiceModes: ["auto", "none"],
      streamingArguments: true,
      multimodalToolResults: true,
    },
    cache: {
      supported: true,
      automatic: true,
      exposesUsage: false,
      usageFields: {},
    },
    modalities: {
      text: true,
      image: true,
      video: true,
      audio: false,
    },
    optimizationHints: {
      bestFor: ["coding", "long_horizon_agent", "large_context", "multimodal"],
      defaultCompressionMode: "long_context",
      prefersStreaming: true,
      goodForSubagents: true,
    },
    knownQuirks: [
      "如果 Anthropic protocol adapter 未实现，应选择 OpenAI-compatible fallback",
      "M3 接入应另开 profile，避免悄悄改变老用户默认行为",
    ],
    documentation: {
      sourceUrls: [],
      verifiedAt: "2026-06-01",
      updateRisk: "high",
      status: "experimental",
    },
  },

  // -------------------------------------------------------------------------
  // MiMo-V2.5-Pro
  // -------------------------------------------------------------------------
  {
    id: "mimo-v2.5-pro",
    displayName: "MiMo V2.5 Pro",
    provider: "openai_compatible",
    match: {
      exactModelIds: ["mimo-v2.5-pro"],
      modelIdPrefixes: ["mimo-v2.5"],
    },
    protocol: {
      preferred: "openai-chat-completions",
      fallbacks: [],
      implemented: ["openai-chat-completions"],
    },
    limits: {
      contextWindowTokens: 1048576,
      effectiveContextBudgetTokens: 700000,
      longContextThresholdTokens: 512000,
      maxOutputTokens: 128000,
      maxTokensField: "max_completion_tokens",
    },
    thinking: {
      supported: true,
      defaultMode: "enabled",
      efforts: ["default"],
      enableForAgenticTasks: true,
      disableForSimpleChat: false,
    },
    reasoning: {
      returned: true,
      mustReplayWithToolCalls: true,
      preserveRawAssistantMessage: true,
      responseFields: ["reasoning_content"],
      streamingDeltaFields: ["reasoning_content"],
    },
    tools: {
      supported: true,
      supportsToolChoiceRequired: false,
      allowedToolChoiceModes: ["auto", "none"],
      streamingArguments: true,
      multimodalToolResults: false,
    },
    cache: {
      supported: true,
      automatic: false,
      exposesUsage: false,
      usageFields: {},
    },
    modalities: {
      text: true,
      image: false,
      video: false,
      audio: false,
    },
    optimizationHints: {
      bestFor: ["coding", "long_horizon_agent", "large_context"],
      defaultCompressionMode: "long_context",
      prefersStreaming: true,
      goodForSubagents: true,
    },
    knownQuirks: [
      "OpenAI-compatible 请求使用 max_completion_tokens",
      "多轮工具调用必须保留 reasoning 信息",
    ],
    documentation: {
      sourceUrls: [],
      verifiedAt: "2026-06-01",
      updateRisk: "medium",
      status: "verified",
    },
  },

  // -------------------------------------------------------------------------
  // Qwen3.7-Max
  // -------------------------------------------------------------------------
  {
    id: "qwen3.7-max",
    displayName: "Qwen3.7 Max",
    provider: "openai_compatible",
    match: {
      exactModelIds: ["qwen3.7-max"],
      modelIdPrefixes: ["qwen3.7"],
    },
    protocol: {
      preferred: "anthropic-messages",
      fallbacks: ["openai-chat-completions"],
      implemented: ["openai-chat-completions"], // Anthropic adapter 未实现前先走 OpenAI fallback
    },
    limits: {
      contextWindowTokens: 1000000,
      effectiveContextBudgetTokens: 650000,
      maxOutputTokens: 65536,
      maxTokensField: "max_tokens",
    },
    thinking: {
      supported: true,
      defaultMode: "adaptive",
      efforts: ["default"],
      enableForAgenticTasks: true,
      disableForSimpleChat: false,
    },
    reasoning: {
      returned: true,
      mustReplayWithToolCalls: true,
      preserveRawAssistantMessage: true,
      responseFields: ["reasoning_content"],
      streamingDeltaFields: ["reasoning_content"],
    },
    tools: {
      supported: true,
      supportsToolChoiceRequired: false,
      allowedToolChoiceModes: ["auto", "none"],
      streamingArguments: true,
      multimodalToolResults: false,
    },
    cache: {
      supported: true,
      automatic: false,
      exposesUsage: false,
      usageFields: {},
    },
    modalities: {
      text: true,
      image: true,
      video: false,
      audio: false,
    },
    optimizationHints: {
      bestFor: ["coding", "long_horizon_agent", "office_workflow"],
      defaultCompressionMode: "long_context",
      prefersStreaming: true,
      goodForSubagents: true,
    },
    knownQuirks: [
      "实现前必须用 Context7 或官方文档重新确认 API 字段名",
      "重点是长周期执行，不是只扩大单轮 prompt",
    ],
    documentation: {
      sourceUrls: [],
      verifiedAt: "2026-06-01",
      updateRisk: "medium",
      status: "verified",
    },
  },

  // -------------------------------------------------------------------------
  // GLM-5.1
  // -------------------------------------------------------------------------
  {
    id: "glm-5.1",
    displayName: "GLM-5.1",
    provider: "openai_compatible",
    match: {
      exactModelIds: ["glm-5.1"],
      modelIdPrefixes: ["glm-5.1"],
    },
    protocol: {
      preferred: "openai-chat-completions",
      fallbacks: [],
      implemented: ["openai-chat-completions"],
    },
    limits: {
      contextWindowTokens: 200000,
      effectiveContextBudgetTokens: 140000,
      maxOutputTokens: 128000,
      maxTokensField: "max_tokens",
    },
    thinking: {
      supported: true,
      defaultMode: "enabled",
      efforts: ["default"],
      enableForAgenticTasks: true,
      disableForSimpleChat: false,
    },
    reasoning: {
      returned: true,
      mustReplayWithToolCalls: false,
      preserveRawAssistantMessage: true,
      responseFields: ["reasoning_content"],
      streamingDeltaFields: ["reasoning_content"],
    },
    tools: {
      supported: true,
      supportsToolChoiceRequired: false,
      allowedToolChoiceModes: ["auto", "none"],
      streamingArguments: true,
      toolStreamParam: "tool_stream",
      multimodalToolResults: false,
    },
    cache: {
      supported: false,
      automatic: false,
      exposesUsage: false,
      usageFields: {},
    },
    modalities: {
      text: true,
      image: false,
      video: false,
      audio: false,
    },
    optimizationHints: {
      bestFor: ["coding", "long_horizon_agent"],
      defaultCompressionMode: "balanced",
      prefersStreaming: true,
      goodForSubagents: false,
    },
    knownQuirks: [
      "不要把第三方渠道的 1M 宣称当成官方默认 profile",
      "如果用户配置的是某个 1M proxy，应创建单独 profile",
    ],
    documentation: {
      sourceUrls: [],
      verifiedAt: "2026-06-01",
      updateRisk: "medium",
      status: "verified",
    },
  },
];

// ---------------------------------------------------------------------------
// Profile 解析
// ---------------------------------------------------------------------------

/** 解析 Foundation Model Profile 的输入 */
export interface ResolveFoundationModelProfileInput {
  /** provider 标识 */
  provider: LLMProviderId;
  /** 模型名 */
  model: string;
  /** 可选：显式指定的 profile id */
  explicitProfileId?: string;
}

/**
 * 解析 Foundation Model Profile
 *
 * 匹配顺序（符合 PDD21 规范）：
 * 1. 显式 LLM_MODEL_PROFILE 指定
 * 2. provider + exact model id 完全匹配
 * 3. provider + model id prefix 匹配
 * 4. provider 默认 model family 匹配
 * 5. fallback 到 generic-openai-compatible
 *
 * 禁止只用 model.includes() 模糊匹配。
 */
export function resolveFoundationModelProfile(
  input: ResolveFoundationModelProfileInput,
): FoundationModelProfile {
  // 教学导读：
  // 模型选择必须精确，避免把自建代理或别名误判成某个特定模型。
  // 例如用户通过代理访问 OpenAI，但模型名恰好包含 "kimi"，
  // 如果使用 includes 匹配就会错误地应用 Kimi 的特殊参数。

  // 1. 显式指定 profile
  if (input.explicitProfileId) {
    const explicit = modelProfiles.find((p) => p.id === input.explicitProfileId);
    if (!explicit) {
      throw new Error(
        `Unknown model profile "${input.explicitProfileId}". ` +
          `Valid profiles: ${modelProfiles.map((p) => p.id).join(", ")}.`,
      );
    }
    // 校验 provider 兼容性
    if (explicit.provider !== input.provider) {
      throw new Error(
        `Model profile "${explicit.id}" is for provider "${explicit.provider}", ` +
          `but current provider is "${input.provider}". ` +
          `Use a compatible profile or omit LLM_MODEL_PROFILE to auto-select.`,
      );
    }
    warnIfStale(explicit);
    return explicit;
  }

  // 2. provider + exact model id 匹配
  const exactMatch = modelProfiles.find(
    (p) =>
      p.provider === input.provider &&
      p.match.exactModelIds.includes(input.model),
  );
  if (exactMatch) {
    warnIfStale(exactMatch);
    return exactMatch;
  }

  // 3. provider + model id prefix 匹配
  const prefixMatch = modelProfiles.find(
    (p) =>
      p.provider === input.provider &&
      p.match.modelIdPrefixes?.some((prefix) =>
        input.model.startsWith(prefix),
      ),
  );
  if (prefixMatch) {
    warnIfStale(prefixMatch);
    return prefixMatch;
  }

  // 4. provider 默认匹配：找该 provider 下非 generic 的第一个 profile
  // 这样已知 provider（如 kimi_platform_cn、minimax_cn）至少能拿到合理的默认参数。
  // 但 openai_compatible 是"完全自定义"的逃生口，不应假设默认模型。
  const providerDefault = modelProfiles.find(
    (p) =>
      p.provider === input.provider &&
      p.id !== "generic-openai-compatible" &&
      // openai_compatible 是特殊 provider，不执行默认匹配
      input.provider !== "openai_compatible",
  );
  if (providerDefault) {
    warnIfStale(providerDefault);
    return providerDefault;
  }

  // 5. fallback 到 generic-openai-compatible
  const generic = modelProfiles.find(
    (p) => p.id === "generic-openai-compatible",
  );
  // generic 必定存在，但为了 TypeScript 严格性仍做断言
  if (!generic) {
    throw new Error("Internal error: generic-openai-compatible profile missing");
  }
  warnIfStale(generic);
  return generic;
}

// ---------------------------------------------------------------------------
// Freshness Warning
// ---------------------------------------------------------------------------

/**
 * 根据 verifiedAt 和 updateRisk 计算 stale 阈值（天数）
 */
function staleThresholdDays(updateRisk: FoundationModelProfile["documentation"]["updateRisk"]): number {
  switch (updateRisk) {
    case "high":
      return 30;
    case "medium":
      return 90;
    case "low":
      return 180;
  }
}

/**
 * 检查 profile 是否需要 freshness warning
 *
 * 规则（来自 PDD21）：
 * - updateRisk=high   且 verifiedAt 超过 30 天：启动 warning
 * - updateRisk=medium 且 verifiedAt 超过 90 天：启动 warning
 * - updateRisk=low    且 verifiedAt 超过 180 天：启动 warning
 */
function warnIfStale(profile: FoundationModelProfile): void {
  const doc = profile.documentation;
  if (!doc.verifiedAt) return;

  const verified = new Date(doc.verifiedAt);
  if (Number.isNaN(verified.getTime())) return;

  const daysSince = Math.floor(
    (Date.now() - verified.getTime()) / (1000 * 60 * 60 * 24),
  );

  const threshold = staleThresholdDays(doc.updateRisk);
  if (daysSince > threshold) {
    console.warn(
      `[model-profile] Profile "${profile.id}" was last verified at ${doc.verifiedAt} ` +
        `(${daysSince} days ago) and is marked ${doc.updateRisk}-risk. ` +
        `Re-check official docs before relying on thinking/cache fields.`,
    );
  }
}

/**
 * 获取所有已注册的 profile id 列表
 */
export function getRegisteredModelProfileIds(): string[] {
  return modelProfiles.map((p) => p.id);
}
