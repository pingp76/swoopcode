/**
 * llm-providers.ts — LLM Provider Profile 抽象层
 *
 * 职责：将厂商差异（默认 endpoint、默认模型、key 环境变量、能力标记）
 * 集中声明为静态 profile，启动时解析为 ResolvedLLMConfig。
 *
 * 设计原则：
 * - registry 是启动后不变的静态数据
 * - resolver 只读 env，不做网络请求
 * - 不把 apiKey 写进错误日志或普通日志
 * - provider 切换只发生在进程启动时，不修改 system prompt 或 tool definitions
 */

/**
 * 支持的 provider id 列表
 *
 * 新增 OpenAI-compatible provider 时，只需要：
 * 1. 在此 union 中加一项
 * 2. 在 providerProfiles 中新增 profile
 * 3. 为默认 baseURL、默认模型、key env 和能力加测试
 */
export type LLMProviderId =
  | "openai_compatible"
  | "minimax_cn"
  | "kimi_platform_cn"
  | "kimi_code_cn"
  | "zhipuai_cn";

/**
 * Provider 能力标记
 *
 * 描述某个 provider 或模型对特定功能的支持情况，供 llm.ts 做兼容决策。
 */
export interface LLMProviderCapabilities {
  /** 是否支持 tools/function calling */
  supportsTools: boolean;
  /** 是否支持 tool_choice=required */
  supportsToolChoiceRequired: boolean;
  /** 是否优先使用 streaming（如 Kimi Code 文档要求） */
  prefersStreaming: boolean;
  /** 是否支持 thinking/reasoning 模式 */
  supportsThinking: boolean;
}

/**
 * Provider Profile — 单个厂商的静态配置描述
 */
export interface LLMProviderProfile {
  id: LLMProviderId;
  displayName: string;
  protocol: "openai-chat-completions";
  defaultBaseURL?: string;
  defaultModel?: string;
  /** 除 LLM_API_KEY 之外的 provider 专用 key 环境变量，按优先级排列 */
  apiKeyEnvNames: string[];
  capabilities: LLMProviderCapabilities;
}

/**
 * ResolvedLLMConfig — 启动时由 profile + env override 解析得到的最终配置
 *
 * Agent 循环、子智能体、Async Run 都只依赖这个对象，不感知 provider 细节。
 */
export interface ResolvedLLMConfig {
  provider: LLMProviderId;
  displayName: string;
  apiKey: string;
  baseURL: string;
  model: string;
  capabilities: LLMProviderCapabilities;
}

// ---------------------------------------------------------------------------
// Provider Profile Registry
// ---------------------------------------------------------------------------

/**
 * 集中 profile 表
 *
 * 每个 profile 声明了该厂商的默认连接方式和能力。
 * 默认值只作为当前实现的建议，用户可通过环境变量覆盖。
 */
const providerProfiles: Record<LLMProviderId, LLMProviderProfile> = {
  openai_compatible: {
    id: "openai_compatible",
    displayName: "OpenAI-compatible",
    protocol: "openai-chat-completions",
    apiKeyEnvNames: [],
    capabilities: {
      supportsTools: true,
      supportsToolChoiceRequired: false,
      prefersStreaming: false,
      supportsThinking: false,
    },
  },
  minimax_cn: {
    id: "minimax_cn",
    displayName: "MiniMax CN",
    protocol: "openai-chat-completions",
    defaultBaseURL: "https://api.minimaxi.com/v1",
    defaultModel: "MiniMax-M2.7",
    apiKeyEnvNames: ["MINIMAX_CN_API_KEY", "MINIMAX_API_KEY"],
    capabilities: {
      supportsTools: true,
      supportsToolChoiceRequired: false,
      prefersStreaming: false,
      supportsThinking: false,
    },
  },
  kimi_platform_cn: {
    id: "kimi_platform_cn",
    displayName: "Kimi Platform CN",
    protocol: "openai-chat-completions",
    defaultBaseURL: "https://api.moonshot.cn/v1",
    defaultModel: "kimi-k2.6",
    apiKeyEnvNames: ["MOONSHOT_API_KEY"],
    capabilities: {
      supportsTools: true,
      supportsToolChoiceRequired: false,
      prefersStreaming: false,
      supportsThinking: true,
    },
  },
  kimi_code_cn: {
    id: "kimi_code_cn",
    displayName: "Kimi Code CN",
    protocol: "openai-chat-completions",
    defaultBaseURL: "https://api.kimi.com/coding/v1",
    defaultModel: "kimi-for-coding",
    apiKeyEnvNames: ["KIMI_CODE_API_KEY"],
    capabilities: {
      supportsTools: true,
      supportsToolChoiceRequired: false,
      prefersStreaming: true,
      // 注：官方文档曾提到 legacy OpenAI format，但当前 OpenAI SDK
      // tools/tool_calls 路径已实测可用（普通聊天 + tool call 闭环成功）。
      supportsThinking: false,
    },
  },
  zhipuai_cn: {
    id: "zhipuai_cn",
    displayName: "ZhipuAI CN",
    protocol: "openai-chat-completions",
    // 智谱官方 SDK 文档使用 open.bigmodel.cn 的 v4 基础路径。
    // 这里作为可运行默认值；企业代理或自建网关仍通过 LLM_BASE_URL 覆盖。
    defaultBaseURL: "https://open.bigmodel.cn/api/paas/v4/",
    defaultModel: "glm-5.2",
    apiKeyEnvNames: ["ZHIPUAI_API_KEY", "BIGMODEL_API_KEY"],
    capabilities: {
      supportsTools: true,
      supportsToolChoiceRequired: false,
      prefersStreaming: true,
      supportsThinking: true,
    },
  },
};

/**
 * 所有合法的 provider id 列表，用于错误提示
 */
const VALID_PROVIDER_IDS = Object.keys(providerProfiles) as LLMProviderId[];

// ---------------------------------------------------------------------------
// 公开函数
// ---------------------------------------------------------------------------

/**
 * 获取指定 provider id 的 profile
 *
 * @param id - provider 标识符
 * @returns 对应的 LLMProviderProfile
 * @throws 若 id 不合法，抛出错误并列出所有合法 id
 */
export function getLLMProviderProfile(id: string): LLMProviderProfile {
  const profile = providerProfiles[id as LLMProviderId];
  if (!profile) {
    throw new Error(
      `Unknown LLM provider "${id}". ` +
        `Valid providers: ${VALID_PROVIDER_IDS.join(", ")}.`,
    );
  }
  return profile;
}

/**
 * 从环境变量解析最终的 LLM 配置
 *
 * 解析优先级（符合 PDD1-2 规范）：
 * - provider: LLM_PROVIDER > 从 LLM_BASE_URL 启发式推断 > 默认 openai_compatible
 * - apiKey: LLM_API_KEY > profile.apiKeyEnvNames 顺序 > 报错
 * - baseURL: LLM_BASE_URL > profile.defaultBaseURL > 报错
 * - model: LLM_MODEL > profile.defaultModel > 报错
 *
 * 启发式推断：如果用户未设置 LLM_PROVIDER，但 LLM_BASE_URL 匹配某个已知
 * provider 的默认 endpoint，则自动选择该 provider。这样用户只写旧三项也能
 * 自动获得 provider 能力标记（如 streaming、User-Agent 等）。
 *
 * @param env - 环境变量对象，默认为 process.env
 * @returns 解析后的 ResolvedLLMConfig
 */
export function resolveLLMProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedLLMConfig {
  // 设计套路：用静态 Provider Profile 收敛“供应商方言”。
  // 配置解析层负责决定 provider/baseURL/model/capabilities，
  // llm.ts 只消费解析后的 ResolvedLLMConfig。
  //
  // 这样新增 provider 时不需要到处改 if/else：
  // 1. 在 providerProfiles 里新增 profile
  // 2. 测试 env 解析和能力标记
  // 3. 只有确实存在传输层特殊要求时，才在 llm.ts 加小范围适配

  // 1. 解析 provider id
  // 优先级：显式 LLM_PROVIDER > 从 baseURL 推断 > 默认 openai_compatible
  // 显式 LLM_PROVIDER 优先级最高，是为了避免启发式误判。
  // 用户使用代理、自建网关或同域不同路径时，baseURL 可能看起来像某个 provider，
  // 但真实能力并不相同。
  const explicitProvider = env["LLM_PROVIDER"] as LLMProviderId | undefined;
  const providerId =
    explicitProvider ??
    inferProviderFromBaseURL(env["LLM_BASE_URL"]) ??
    "openai_compatible";
  const profile = getLLMProviderProfile(providerId);

  // 2. 解析 apiKey
  const apiKey = resolveApiKey(env, profile);

  // 3. 解析 baseURL
  const baseURL = resolveBaseURL(env, profile);

  // 4. 解析 model
  const model = resolveModel(env, profile);

  return {
    provider: profile.id,
    displayName: profile.displayName,
    apiKey,
    baseURL,
    model,
    capabilities: profile.capabilities,
  };
}

// ---------------------------------------------------------------------------
// 启发式推断
// ---------------------------------------------------------------------------

/**
 * 根据 baseURL 推断 provider id
 *
 * 当 LLM_PROVIDER 未显式设置时，若 LLM_BASE_URL 与某个已知 provider 的
 * 默认 endpoint 完全一致，则自动选择该 provider。这改善了"只写旧三项"
 * 的用户体验，同时不破坏使用代理或自定义 endpoint 的场景。
 */
function inferProviderFromBaseURL(
  baseURL: string | undefined,
): LLMProviderId | null {
  // 启发式推断只做“完全一致”的默认 endpoint 匹配。
  // 不做 includes/startsWith 模糊匹配，是为了避免把自定义代理误判成官方 provider。
  // 这是配置系统里常见的保守策略：宁可要求用户显式声明，也不要猜错能力标记。
  if (!baseURL) return null;
  for (const [id, profile] of Object.entries(providerProfiles)) {
    if (profile.defaultBaseURL === baseURL) {
      return id as LLMProviderId;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 内部解析辅助函数
// ---------------------------------------------------------------------------

/**
 * 解析 apiKey
 *
 * 优先级：LLM_API_KEY > profile.apiKeyEnvNames > 报错
 */
function resolveApiKey(
  env: NodeJS.ProcessEnv,
  profile: LLMProviderProfile,
): string {
  // key 解析顺序体现了“通用覆盖专用”的设计：
  // LLM_API_KEY 方便用户用同一套变量快速切 provider；
  // provider 专用 key 则方便在本机同时配置多个供应商。

  // 第一优先级：通用 LLM_API_KEY
  const genericKey = env["LLM_API_KEY"];
  if (genericKey) {
    return genericKey;
  }

  // 第二优先级：provider 专用 key，按声明顺序
  for (const keyName of profile.apiKeyEnvNames) {
    const value = env[keyName];
    if (value) {
      return value;
    }
  }

  // 缺失：构造清晰的错误提示，列出候选环境变量
  // 注意错误信息只列变量名，不打印任何已存在 key 的值。
  // 配置错误日志泄漏 API key 是真实项目里很常见、也很危险的坑。
  const candidateNames = ["LLM_API_KEY", ...profile.apiKeyEnvNames];
  throw new Error(
    `Missing LLM API key for provider "${profile.id}". ` +
      `Set one of: ${candidateNames.join(", ")}.`,
  );
}

/**
 * 解析 baseURL
 *
 * 优先级：LLM_BASE_URL > profile.defaultBaseURL > 报错
 */
function resolveBaseURL(
  env: NodeJS.ProcessEnv,
  profile: LLMProviderProfile,
): string {
  // baseURL 允许显式覆盖，是为了支持代理、私有部署和兼容网关。
  // 但一旦用户覆盖 baseURL，provider capabilities 仍来自 LLM_PROVIDER/profile；
  // 所以如果兼容网关能力不同，应该显式选择 openai_compatible 或新增 profile。
  const explicit = env["LLM_BASE_URL"];
  if (explicit) {
    return explicit;
  }

  if (profile.defaultBaseURL) {
    return profile.defaultBaseURL;
  }

  throw new Error(
    `Missing LLM base URL for provider "${profile.id}". ` +
      `Set LLM_BASE_URL or use a provider with a known default endpoint.`,
  );
}

/**
 * 解析 model
 *
 * 优先级：LLM_MODEL > profile.defaultModel > 报错
 */
function resolveModel(
  env: NodeJS.ProcessEnv,
  profile: LLMProviderProfile,
): string {
  // model 解析和 baseURL 类似：用户显式设置优先。
  // profile.defaultModel 只是教学项目的可运行默认值，不代表生产推荐模型。
  const explicit = env["LLM_MODEL"];
  if (explicit) {
    return explicit;
  }

  if (profile.defaultModel) {
    return profile.defaultModel;
  }

  throw new Error(
    `Missing LLM model for provider "${profile.id}". ` +
      `Set LLM_MODEL or use a provider with a known default model.`,
  );
}
