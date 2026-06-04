# PDD21: 基座模型能力画像与 Agent Runtime Policy 抽象层设计

## 审阅结论

本阶段应该做一个 **基座模型能力画像 + Runtime Policy 解析层**，而不是做一个完整的多模型网关。

当前项目已经有 PDD1-2 引入的 `LLM Provider Profile`：

```text
LLM Provider Profile = provider/baseURL/model/apiKey/capabilities
LLM Adapter          = llm.ts 内部处理 provider 兼容差异
Agent Loop           = agent.ts 不知道 provider 细节
```

PDD21 要在这个基础上往前走一步：

```text
Foundation Model Profile = 描述具体基座模型的能力、限制、协议方言和优化建议
Runtime Policy Resolver  = 根据模型画像解析出本进程/本轮应该采用的 Agent 行为策略
LLM Adapter              = 根据 policy 做请求参数、streaming 聚合、reasoning 回放等协议适配
Agent Loop               = 只消费 RuntimePolicy，不写任何模型名分支
```

核心判断：

1. 这个方向是可行的，而且是未来支持 DeepSeek、Qwen、Kimi、MiniMax、MiMo、GLM 等模型时更稳的路线。
2. 抽象层不能变成 `if (model === "...")` 的分支堆；模型差异必须先变成结构化 profile，再由 policy resolver 转成少量领域内策略。
3. 第一版不做运行中自动切换模型、不做多模型投票、不做网关、也不做复杂成本调度；第一版只让 **当前启动时选定的模型** 自动获得合适的上下文、thinking、工具、缓存和协议策略。
4. Provider/model 信息不进入 system prompt。模型优化是 runtime 行为，不是提示词表演。

## 背景

过去几轮调研显示，新的 coding/agent 模型已经不再只是“OpenAI-compatible endpoint + 更大 context”：

- DeepSeek V4：1M context，自动 context cache，thinking 与 tool call 场景要求保留 reasoning 信息。
- MiniMax M3：1M context，原生多模态，自动 cache，thinking 分离，推荐 coding agent 场景可走 Anthropic-compatible。
- MiMo-V2.5-Pro：1M context，thinking、function call、structured output，tool 多轮需要回传 reasoning content。
- Qwen3.7-Max：1M context，强调 long-horizon agent、MCP、coding harness，支持 preserving thinking。
- Kimi K2.6：256K context，强 coding/agent/多模态，thinking + tool calls 需要回传 `reasoning_content`。
- GLM-5.1：官方常规 API 文档侧是 200K context，但强调长周期工程任务、tool streaming 与 checkpoint 式执行。

这些差异会影响 Agent 运行方式：

1. 上下文窗口和“实际有效上下文预算”不同。
2. 有些模型默认需要 thinking，有些只在复杂任务中适合开启。
3. 有些模型把 thinking 放进 `content` 的 `<think>`，有些放进 `reasoning_content`，有些放进 `reasoning_details`。
4. 多轮工具调用时，部分模型必须把 reasoning 字段原样带回下一轮。
5. 有些模型支持真实 prompt/context cache，且能返回 cache 命中统计。
6. 有些模型支持图片/视频 tool result，当前项目多数工具链仍假设 tool result 是字符串。
7. 有些模型更适合长周期执行，有些更适合低成本子任务，有些更适合多模态理解。

如果这些差异散落在 `agent.ts`、`llm.ts`、`compressor.ts` 和 prompt 文本里，项目会很快失去教学清晰度。PDD21 的目标是把这些差异收束成一个小而明确的运行策略层。

## 设计目标

1. 在现有 `LLMProviderProfile` 之上新增 **Foundation Model Profile**，描述具体模型能力，而不是只描述厂商 endpoint。
2. 新增 **RuntimePolicyResolver**，启动时根据 resolved provider/model/profile 生成 Agent Runtime Policy。
3. 让 `config.ts` 返回模型优化相关配置，供 `index.ts` 组装共享实例时注入。
4. 让 `llm.ts` 根据 policy 处理：
   - max token 字段差异
   - thinking 开关参数
   - reasoning content / reasoning details 提取与回放
   - streaming 中 reasoning/tool arguments 聚合
   - provider usage/cache 统计归一化
5. 让 `compressor.ts` 和 `message-block.ts` 根据 policy 使用不同上下文预算和压缩阈值。
6. 让 `cache-debug.ts` / `llm-logger.ts` 可以记录真实 cache hit/miss、reasoning tokens、effective context budget 等观测信息。
7. 保持 prompt cache 友好：不因模型策略在每轮重写 stable system prompt 或 tool definitions。
8. 保持主循环干净：`agent.ts` 不出现具体模型名、provider 名或厂商字段名。
9. 为后续实现提供明确 checklist、文件改动范围、测试策略和验收标准。

## 非目标

1. 不实现运行中 `/model switch`。
2. 不实现多模型自动路由、fallback、投票、judge 或 ensemble。
3. 不实现 LiteLLM、OpenRouter 或其他外部模型网关。
4. 不实现完整成本账单系统；第一版只记录 usage/cache telemetry。
5. 不把模型名、provider 名或“你正在使用某模型”的内容注入 system prompt。
6. 不为了某个模型改写通用工具描述。
7. 不把所有模型最新参数硬编码成永久真理；模型 profile 必须允许后续小范围更新。
8. 不在第一版支持完整多模态工具链；第一版只为 multimodal capability 留类型边界。
9. 不在第一版实现 Anthropic protocol adapter 的完整请求路径；第一版可先建协议抽象和 unsupported guard，后续 PDD 再实现。

## 核心原则

### 1. 能力驱动，不是模型名驱动

错误方向：

```ts
if (config.model === "kimi-k2.6") {
  // special behavior
}
```

正确方向：

```ts
if (runtimePolicy.reasoning.mustReplayWithToolCalls) {
  // generic behavior
}
```

模型名只用于 profile registry 查表；业务层只看能力与策略。

### 2. Profile 是事实，Policy 是决策

`FoundationModelProfile` 保存相对稳定的模型事实：

- context window
- max output
- protocol support
- thinking support
- tool calling support
- cache support
- modality support
- known quirks

`RuntimePolicy` 保存本 agent 本次运行的决策：

- 本次采用多少 context budget
- 是否默认开启 thinking
- 是否保存 raw assistant message
- 是否使用 long-context 压缩策略
- 是否记录真实 cache telemetry
- 使用哪个 request protocol

不要把这两者混在一起。事实表可以被测试校验；策略解析可以被场景测试覆盖。

### 3. Stable prefix 优先

模型 profile 和 runtime policy 是本地运行配置，不进入 stable system prompt。

稳定 system prompt 仍然只保存行为规则、项目指令、Task/TODO 选择规则、Skill/Memory 快照。动态模型策略通过本地代码影响消息布局和请求参数，不通过 prompt 影响 LLM。

### 4. 1M context 不是关闭压缩

1M 上下文模型仍然需要三类边界：

- 大 stdout / test log 不应反复进入上下文。
- 旧工具结果应该随时间衰减。
- 接近窗口上限时仍然要 compact。

区别是 threshold 和保留策略更宽松，而不是完全取消 OutputStore、P0/P1/P2。

### 5. Reasoning 是协议状态，不是普通文本

新模型逐渐把 thinking/reasoning 变成工具调用协议的一部分。它可能位于：

- `message.reasoning_content`
- `message.reasoning_details`
- `delta.reasoning_content`
- `content` 内的 `<think>...</think>`

这些内容有时必须随 assistant tool call 一起回放。项目不能再只保存 `content + toolCalls`，否则多轮工具调用会在部分模型上失败或质量下降。

## 总体架构

```text
process.env
  -> resolveLLMProviderConfig()
  -> resolveFoundationModelProfile()
  -> resolveRuntimePolicy()
  -> Config

index.ts
  -> createLLMClient(config.llm, config.runtimePolicy)
  -> createContextCompressor(config.compression, config.runtimePolicy)
  -> createAgent(... shared instances ...)

agent.ts
  -> prepare messages
  -> llm.chat(messages, tools, cacheDebug)
  -> handle tool calls / content

llm.ts
  -> adapter.prepareMessages()
  -> adapter.buildRequest()
  -> OpenAI SDK or future protocol client
  -> adapter.parseResponse()
  -> LLMResponse with assistantMessage + usage
```

`agent.ts` 仍然不认识具体 provider。它最多知道 `LLMResponse.assistantMessage` 需要写入 history，`LLMResponse.toolCalls` 需要执行。

## 新增术语

```text
Foundation Model Profile
  描述一个具体模型或模型族的静态能力画像。它回答“这个模型能做什么、限制是什么、协议方言是什么”。

Model Family
  一组共享能力与协议方言的模型，例如 kimi-k2.x、qwen3.7、minimax-m3。

Runtime Policy
  当前进程实际使用的 Agent 行为策略。它回答“在这个模型下，本 agent 应该怎么组织上下文、thinking、工具、缓存和输出”。

Protocol Adapter
  把项目内部统一的消息/工具/策略转换成某协议请求，并把响应转换回统一 LLMResponse。

Reasoning Replay
  当 assistant 消息含 tool calls 时，把模型返回的 reasoning 字段随 assistant 消息一起保存并发送给后续请求。

Effective Context Budget
  项目实际愿意使用的上下文预算。它通常小于官方 contextWindow，用于给输出、工具、误差和质量余量留空间。
```

## 类型设计

### `FoundationModelProfile`

建议新增 `src/foundation-models.ts`，或在第一版先扩展 `src/llm-providers.ts` 后再拆分。为了避免 `llm-providers.ts` 继续膨胀，推荐新文件。

```ts
export type ModelProtocol =
  | "openai-chat-completions"
  | "anthropic-messages";

export type ThinkingDefaultMode = "disabled" | "enabled" | "adaptive";

export interface FoundationModelProfile {
  id: string;
  displayName: string;
  provider: LLMProviderId;

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

  match: {
    /** 精确模型名，例如 kimi-k2.6 */
    exactModelIds: string[];
    /** 可选：模型名前缀，例如 qwen3.7- */
    modelIdPrefixes?: string[];
  };

  protocol: {
    preferred: ModelProtocol;
    fallbacks: ModelProtocol[];
    /** 第一版如果只实现 OpenAI，则 Anthropic profile 需要显式 unsupported guard */
    implemented: ModelProtocol[];
  };

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

  thinking: {
    supported: boolean;
    defaultMode: ThinkingDefaultMode;
    /** 支持的 effort 名称，例如 high/max；没有则不传 effort */
    efforts?: string[];
    /** 是否建议复杂 agent 任务默认开启 */
    enableForAgenticTasks: boolean;
    /** 是否建议普通聊天关闭 */
    disableForSimpleChat: boolean;
    /** provider 需要的 extra_body，例如 { thinking: { type: "enabled" } } */
    requestShape?: "none" | "extra_body_thinking" | "enable_thinking" | "chat_template_kwargs";
  };

  reasoning: {
    returned: boolean;
    /** assistant 有 tool_calls 时是否必须回放 reasoning 字段 */
    mustReplayWithToolCalls: boolean;
    /** 是否保存完整原始 assistant message，而不是只保存 content/toolCalls */
    preserveRawAssistantMessage: boolean;
    /** 响应字段位置 */
    responseFields: Array<
      | "reasoning_content"
      | "reasoning_details"
      | "content_think_tags"
    >;
    /** streaming delta 字段位置 */
    streamingDeltaFields: Array<
      | "reasoning_content"
      | "reasoning_details"
      | "content_think_tags"
    >;
  };

  tools: {
    supported: boolean;
    supportsToolChoiceRequired: boolean;
    allowedToolChoiceModes: Array<"auto" | "none" | "required">;
    /** streaming tool arguments 是否会分片，需要聚合 */
    streamingArguments: boolean;
    /** 是否存在 provider-specific tool stream 参数 */
    toolStreamParam?: string;
    /** 是否允许 tool result content 是多模态 blocks */
    multimodalToolResults: boolean;
  };

  cache: {
    supported: boolean;
    automatic: boolean;
    /** usage 中是否能读出 cache hit/miss */
    exposesUsage: boolean;
    usageFields: {
      hitTokens?: string;
      missTokens?: string;
      cachedTokens?: string;
    };
  };

  modalities: {
    text: boolean;
    image: boolean;
    video: boolean;
    audio: boolean;
  };

  optimizationHints: {
    /** 只作为 policy resolver 的输入，不进入 prompt */
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
    defaultCompressionMode: "aggressive" | "balanced" | "long_context";
    prefersStreaming: boolean;
    /** 是否建议子智能体使用更低成本模型；第一版只记录，不执行路由 */
    goodForSubagents: boolean;
  };

  knownQuirks: string[];
}
```

### Profile Registry 维护策略

Profile Registry 的确有过时风险。PDD21 的 registry 不是“永远正确的模型百科”，而是一个 **保守的、可审计的本地能力画像表**。实现时必须按以下规则控制维护成本和失效风险。

#### 1. Profile 分级

```text
verified
  已按官方文档核对，并至少通过本项目 smoke test 或同协议测试。

experimental
  官方文档存在，但本项目未 live 验证。可以使用，但启动时给 warning。

needs_review
  文档明确提示“实现前重新核对”，或已知模型 API 快速变化。默认不应自动匹配为优化 profile，
  除非用户显式设置 LLM_MODEL_PROFILE。
```

DeepSeek V4、Qwen3.7-Max、MiniMax M3 这类快速更新模型，在第一版实现时应先标记为 `experimental` 或 `needs_review`，完成 live smoke test 后再升级为 `verified`。

#### 2. 硬协议字段与优化提示分离

Profile 中字段分两类：

```text
Hard protocol fields
  影响请求能否成功的字段，例如 maxTokensField、thinking requestShape、reasoning responseFields、
  protocol、tool_call 格式、mustReplayWithToolCalls。

Optimization hints
  影响效果和成本的字段，例如 effectiveContextBudget、defaultCompressionMode、bestFor。
```

硬协议字段必须保守：

- 未确认时不要猜。
- 未确认时使用 generic fallback，或要求用户显式 `LLM_MODEL_PROFILE`。
- 如果用户显式选择一个 `needs_review` profile，启动时打印 warning。

优化提示可以有合理默认：

- context budget 可以保守偏小。
- compression mode 可以从 `balanced` 开始。
- cache telemetry 字段缺失时安全降级。

#### 3. Profile 新鲜度检查

`resolveFoundationModelProfile()` 不做网络请求，但可以根据 `verifiedAt` 和 `updateRisk` 产生本地 warning。

建议规则：

```text
updateRisk=high   且 verifiedAt 超过 30 天：启动 warning
updateRisk=medium 且 verifiedAt 超过 90 天：启动 warning
updateRisk=low    且 verifiedAt 超过 180 天：启动 warning
```

warning 示例：

```text
[model-profile] Profile "deepseek-v4" was last verified at 2026-06-01 and is marked high-risk.
Re-check official docs before relying on thinking/cache fields.
```

这只是提醒，不阻断启动。阻断只发生在：

- 用户选择了未实现协议。
- profile/provider 不兼容。
- override 超出 profile 声明能力。
- 硬协议字段缺失且没有安全 fallback。

#### 4. 模型版本与默认值

不要悄悄把旧 provider 默认模型从 `MiniMax-M2.7` 改成 `MiniMax-M3`。默认模型变更必须单独设计并更新 summary。

新增大模型时优先新增 profile：

```text
minimax-m2.7
minimax-m3
deepseek-v4
qwen3.7-max
```

不要用一个 `minimax_latest` profile 自动漂移到新模型。`latest` 可以作为用户自定义模型名，但 registry 不应把它当成稳定 profile，除非用户显式指定 `LLM_MODEL_PROFILE`。

#### 5. Generic fallback

如果模型名无法可靠匹配，必须 fallback 到：

```text
generic-openai-compatible
```

generic fallback 的原则是：

- 不开启 thinking。
- 不假设 reasoning replay。
- 不假设真实 cache usage 字段。
- 使用较保守 context budget。
- tools 按 provider 级能力处理。

这样即使 profile 过时，也最多损失优化效果，不应该因为猜错字段导致请求失败。

### `RuntimePolicy`

建议新增 `src/runtime-policy.ts`。

```ts
export interface RuntimePolicy {
  modelProfileId: string;
  provider: LLMProviderId;
  model: string;

  protocol: {
    selected: ModelProtocol;
    implemented: boolean;
  };

  context: {
    contextWindowTokens: number;
    effectiveBudgetTokens: number;
    longContextThresholdTokens: number;
    compressionMode: "aggressive" | "balanced" | "long_context";
    toolOutputCompressionThresholdTokens: number;
    decayThresholdLoops: number;
    decayPreviewTokens: number;
    compactKeepRecentBlocks: number;
  };

  request: {
    prefersStreaming: boolean;
    maxOutputTokens: number;
    maxTokensField: "max_tokens" | "max_completion_tokens";
    thinkingMode: ThinkingDefaultMode;
    reasoningEffort?: string;
    extraBody: Record<string, unknown>;
  };

  reasoning: {
    preserveRawAssistantMessage: boolean;
    mustReplayWithToolCalls: boolean;
    responseFields: FoundationModelProfile["reasoning"]["responseFields"];
    streamingDeltaFields: FoundationModelProfile["reasoning"]["streamingDeltaFields"];
  };

  tools: {
    supportsTools: boolean;
    supportsToolChoiceRequired: boolean;
    allowedToolChoiceModes: Array<"auto" | "none" | "required">;
    streamingArguments: boolean;
    multimodalToolResults: boolean;
  };

  cache: {
    supported: boolean;
    automatic: boolean;
    exposeUsage: boolean;
    usageFields: FoundationModelProfile["cache"]["usageFields"];
  };

  telemetry: {
    recordReasoningTokens: boolean;
    recordCacheTokens: boolean;
    recordEffectiveContextBudget: boolean;
  };
}
```

### `LLMResponse`

`src/llm.ts` 当前只返回 `content/toolCalls/finishReason`。PDD21 需要扩展为：

```ts
export interface LLMResponse {
  content: string | null;
  toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  finishReason: string | null;

  /**
   * 可直接写入 History 的 assistant 消息。
   * 当模型需要回放 reasoning_content/reasoning_details 时，agent 应优先保存它，
   * 而不是自己重新拼 content/tool_calls。
   */
  assistantMessage: ChatCompletionMessageParam;

  /**
   * 规范化后的 reasoning 内容，用于日志、调试和测试。
   * 不一定进入普通最终回复。
   */
  reasoning?: {
    content: string | null;
    details?: unknown;
    source:
      | "reasoning_content"
      | "reasoning_details"
      | "content_think_tags"
      | "none";
  };

  usage?: LLMUsageTelemetry;
}

export interface LLMUsageTelemetry {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  reasoningTokens?: number;
  cacheHitTokens?: number;
  cacheMissTokens?: number;
  cachedTokens?: number;
  raw?: unknown;
}
```

兼容策略：

- 第一版可以保留旧字段，新增字段不破坏测试 mock。
- mock LLMClient 在测试中可以只填 `content/toolCalls/finishReason`，由测试 helper 补默认 `assistantMessage`。
- `agent.ts` 后续写 history 时应改为优先使用 `response.assistantMessage`。

## Profile Registry 初始内容

第一版不要试图覆盖所有模型；先覆盖当前已调研且对策略有代表性的模型族。

### Generic OpenAI-compatible

```text
profile id: generic-openai-compatible
provider: openai_compatible
contextWindowTokens: 80000
effectiveContextBudgetTokens: 60000
maxOutputTokens: 4096
thinking.supported: false
reasoning.preserveRawAssistantMessage: false
cache.supported: false
compressionMode: balanced
```

用途：用户自定义 endpoint 或未知模型的保守 fallback。

### Kimi K2.6 / Kimi Platform

```text
profile id: kimi-k2.6
provider: kimi_platform_cn
contextWindowTokens: 262144
effectiveContextBudgetTokens: 180000
maxOutputTokens: 32768
thinking.defaultMode: enabled
reasoning.mustReplayWithToolCalls: true
reasoning.responseFields: reasoning_content
tools.allowedToolChoiceModes: auto, none
modalities: text, image, video
compressionMode: balanced
```

特殊要求：

- thinking + tools 场景保存并回放 `reasoning_content`。
- 如果未来接入 Kimi 内置 web search，需要额外处理 thinking 与 search 的兼容限制。
- 当前 `kimi_code_cn` 已有 streaming 偏好，PDD21 不应删除旧行为。

### DeepSeek V4

```text
profile id: deepseek-v4
provider: deepseek
contextWindowTokens: 1000000
effectiveContextBudgetTokens: 750000
longContextThresholdTokens: 512000
maxOutputTokens: 384000
thinking.defaultMode: adaptive 或 enabled
reasoning.mustReplayWithToolCalls: true
cache.supported: true
cache.automatic: true
compressionMode: long_context
```

特殊要求：

- 需要在实现前重新核对官方 model id、参数名和 thinking 开关。
- cache telemetry 应记录真实 hit/miss tokens。

### MiniMax M3

```text
profile id: minimax-m3
provider: minimax_cn 或 minimax_global
contextWindowTokens: 1000000
effectiveContextBudgetTokens: 512000
longContextThresholdTokens: 512000
maxOutputTokens: 80000
thinking.defaultMode: adaptive
reasoning.responseFields: reasoning_details 或 content_think_tags
cache.supported: true
cache.automatic: true
modalities: text, image, video
compressionMode: long_context
preferred protocol: anthropic-messages
fallback protocol: openai-chat-completions
```

第一版注意：

- 如果 Anthropic protocol adapter 未实现，应选择 OpenAI-compatible fallback，并在启动日志标注 fallback。
- MiniMax 当前项目 profile 仍是 M2.7；M3 接入应另开 provider/profile 或显式模型匹配，避免悄悄改变老用户默认行为。

### MiMo-V2.5-Pro

```text
profile id: mimo-v2.5-pro
provider: mimo
contextWindowTokens: 1048576
effectiveContextBudgetTokens: 700000
longContextThresholdTokens: 512000
maxOutputTokens: 128000
maxTokensField: max_completion_tokens
thinking.defaultMode: enabled
reasoning.mustReplayWithToolCalls: true
cache.supported: true
modalities: text
compressionMode: long_context
```

特殊要求：

- OpenAI-compatible 请求使用 `max_completion_tokens`。
- 多轮工具调用必须保留 reasoning 信息。

### Qwen3.7-Max

```text
profile id: qwen3.7-max
provider: qwen_dashscope
contextWindowTokens: 1000000
effectiveContextBudgetTokens: 650000
maxOutputTokens: 65536
thinking.defaultMode: adaptive
reasoning.mustReplayWithToolCalls: true
reasoning.responseFields: preserve_thinking / reasoning_content
cache.supported: provider-dependent
bestFor: long_horizon_agent, coding, office_workflow, mcp
compressionMode: long_context
preferred protocol: anthropic-messages
fallback protocol: openai-chat-completions
```

特殊要求：

- 实现前必须用 Context7 或官方文档重新确认 API 字段名。
- 它的重点是长周期执行，不是只扩大单轮 prompt。

### GLM-5.1

```text
profile id: glm-5.1
provider: zhipu
contextWindowTokens: 200000
effectiveContextBudgetTokens: 140000
maxOutputTokens: 128000
thinking.defaultMode: enabled
tools.toolStreamParam: tool_stream
compressionMode: balanced
bestFor: long_horizon_agent, coding
```

特殊要求：

- 不要把第三方渠道的 1M 宣称当成官方默认 profile。
- 如果用户配置的是某个 1M proxy，应创建单独 profile，例如 `glm-5.1-vendor-1m`。

## Profile 匹配规则

新增 `resolveFoundationModelProfile(input)`：

```ts
interface ResolveFoundationModelProfileInput {
  provider: LLMProviderId;
  model: string;
}
```

匹配顺序：

1. provider + exact model id 完全匹配。
2. provider + model id prefix 匹配。
3. provider 默认 model family 匹配。
4. fallback 到 `generic-openai-compatible`。

禁止只用 `model.includes("kimi")` 这类模糊匹配。模型名和 provider 必须共同参与判断，避免自建代理或别名误判。

如果用户通过 `LLM_MODEL` 使用模型别名，允许新增：

```text
LLM_MODEL_PROFILE=kimi-k2.6
```

解析优先级：

```text
model profile:
  1. LLM_MODEL_PROFILE 显式指定
  2. provider + exact model id
  3. provider + prefix
  4. generic fallback
```

显式 profile 必须校验 provider 是否兼容；例如 `LLM_PROVIDER=minimax_cn` 但 `LLM_MODEL_PROFILE=kimi-k2.6` 应报错，而不是猜测。

## Runtime Policy 解析规则

新增 `resolveRuntimePolicy(profile, env, options)`。

环境变量覆盖项：

```text
LLM_MODEL_PROFILE=...
LLM_CONTEXT_BUDGET=...
LLM_THINKING=auto|enabled|disabled|adaptive
LLM_REASONING_EFFORT=...
LLM_MAX_OUTPUT_TOKENS=...
LLM_PROTOCOL=openai-chat-completions|anthropic-messages
```

覆盖原则：

1. 用户显式环境变量优先于 profile 默认值。
2. 覆盖值必须被 profile 支持；不支持时报启动错误。
3. `LLM_CONTEXT_BUDGET` 不能超过 `contextWindowTokens`。
4. 如果 selected protocol 未实现，启动时报错；除非存在可实现 fallback，且用户没有显式指定 protocol。
5. thinking 关闭后，仍然要能回放历史里已有的 reasoning 字段，避免同一 session 中策略变化损坏历史。

## Runtime Policy Store 与短命令 CLI

PDD21 不能只把 thinking、reasoning effort 和 context budget 放在环境变量里。用户调试模型行为时，需要在 REPL 中快速查询和调整当前策略。

但 CLI 设计必须注意两点：

1. 调整的是 session-local runtime override，不是修改 `FoundationModelProfile`。
2. 命令要短，中文用户容易记、容易敲。长英文命令可以作为 alias，但不作为主要入口。

### RuntimePolicyStore

新增 `src/runtime-policy-store.ts`，保存 base policy 和本 session 的 override。

```ts
export interface RuntimePolicyOverride {
  thinkingMode?: ThinkingDefaultMode;
  reasoningEffort?: string | null;
  contextBudgetTokens?: number;
  maxOutputTokens?: number;
  compressionMode?: "aggressive" | "balanced" | "long_context";
  stableContextEnabled?: boolean;
  stableContextBudgetTokens?: number;
}

export interface RuntimePolicyStore {
  getBasePolicy(): RuntimePolicy;
  getPolicy(): RuntimePolicy;
  getOverride(): RuntimePolicyOverride;
  updateOverride(patch: RuntimePolicyOverride, source: "cli" | "system"): RuntimePolicy;
  resetOverride(source: "cli" | "system"): RuntimePolicy;
  snapshot(): RuntimePolicy;
}
```

`RuntimePolicyStore` 的职责：

- 运行中合并 base policy + override。
- 校验 override 是否被模型 profile 支持。
- 每次修改后重新派生 compression config。
- 通过 `SessionEventBuffer` 或 Transcript 记录 `runtime_policy_changed` 事件。
- 给 SubAgent / Async Run / Schedule 提供 policy snapshot。

`LLMClient` 不应只在创建时固化 policy。第一版推荐传入 `getRuntimePolicy()`：

```ts
createLLMClient({
  config: resolvedLLMConfig,
  getRuntimePolicy: () => runtimePolicyStore.getPolicy(),
  llmLogger,
});
```

这样 `/t 高` 或 `/m c 300k` 之后，下一次 LLM 请求自然使用新策略。

### Mid-session override 边界

`RuntimePolicyOverride` 和 `RuntimePolicy` 故意不对称。不是所有 policy 字段都适合运行中修改。

第一版允许 mid-session override 的字段只有：

```text
thinkingMode
reasoningEffort
contextBudgetTokens
maxOutputTokens
compressionMode
stableContextEnabled
stableContextBudgetTokens
```

这些字段只影响后续请求参数、上下文预算或装载策略，不改变 tool schema 和消息协议。

第一版明确不允许 mid-session override：

| 字段 | 禁止原因 | 替代方案 |
| ---- | -------- | -------- |
| `protocol.selected` | OpenAI / Anthropic 消息格式和工具格式不同，历史可能不兼容 | 新开 session 或重启 |
| `tools.supportsTools` / tool schema | 中途删减 tools 会破坏工具定义稳定前缀，也可能破坏 tool_call/tool_result 配对 | 保持 tools 稳定，用权限/执行层限制 |
| `reasoning.mustReplayWithToolCalls` | 这是协议正确性字段，不能按用户偏好关闭 | 只能换 profile 或新 session |
| `reasoning.responseFields` | 响应字段位置是 adapter 解析规则，不能运行中改 | 更新 profile/adapter 后重启 |
| `cache.supported` / `cache.usageFields` | cache 字段来自 provider usage，不是用户行为策略 | 更新 profile/adapter 后重启 |
| `modalities` | 多模态支持影响消息 content block 格式 | 换 profile 或新 session |

命令层如果收到这类请求，应明确提示：

```text
Protocol/tools/reasoning field changes require a new session or restart.
Runtime CLI only supports thinking, effort, context budget, max output, compression, and stable context toggles.
```

未来如果要支持运行中 protocol 对比，应另开设计：它需要 history 转换、tool schema 快照、transcript 分叉和 cache 前缀隔离，不属于 PDD21 第一版。

### 短命令优先

主要命令使用短 alias：

```text
/m                 # model/policy 状态
/t                 # thinking 状态
/t 开              # thinking enabled
/t 关              # thinking disabled
/t 自              # thinking adaptive
/t 高              # reasoning effort high
/t 最强            # reasoning effort max
/t 默认            # 清除 reasoning effort override
/m c 300k          # context budget = 300000 tokens
/m c 750000        # context budget = 750000 tokens
/m out 32k         # max output tokens = 32000
/m r               # reset runtime policy override
```

中文 alias：

```text
/模型              # 等同 /m
/思考              # 等同 /t
/思考 开
/思考 关
/思考 自
/思考 高
/思考 最强
/思考 默认
```

可选长命令 alias 只用于帮助文本或脚本：

```text
/model policy
/model thinking enabled
/model thinking disabled
/model thinking adaptive
/model effort high
/model effort max
/model context 300k
/model reset
```

不要把长命令作为文档里的首选路径。

### `/m` 输出格式

`/m` 应显示当前模型和策略摘要：

```text
Model policy
  provider: kimi_platform_cn
  model: kimi-k2.6
  profile: kimi-k2.6
  protocol: openai-chat-completions
  context: 180000 / 262144
  compression: balanced
  thinking: enabled
  effort: default
  reasoning replay: required for tool calls
  stable context: enabled, 92000 tokens loaded
```

如果存在 override，明确标出：

```text
Overrides:
  thinking: adaptive -> disabled
  context: 180000 -> 120000
```

### `/t` 参数映射

`/t` 同时负责 thinking mode 和 thinking level，避免用户记两套命令。

```text
/t 开     -> thinkingMode = enabled
/t 关     -> thinkingMode = disabled
/t 自     -> thinkingMode = adaptive
/t auto   -> thinkingMode = adaptive
/t on     -> thinkingMode = enabled
/t off    -> thinkingMode = disabled

/t 高     -> reasoningEffort = high
/t max    -> reasoningEffort = max
/t 最强   -> reasoningEffort = max
/t 默认   -> reasoningEffort override = null
```

如果某模型不支持指定 effort，命令必须报清楚：

```text
Model kimi-k2.6 does not support reasoning effort "max".
Supported: default only.
```

如果模型不支持 thinking：

```text
Current model profile does not support thinking mode.
```

### Policy 变更的历史策略

thinking mode 可以运行中切换，但历史消息要保守处理：

1. 切换只影响后续请求参数。
2. 历史里已经存在的 `reasoning_content` / `reasoning_details` 不删除。
3. 如果模型 profile 标记 `mustReplayWithToolCalls`，即使 thinking 关闭，也继续回放已有 assistant tool call 的 reasoning 字段。
4. 如果未来某模型不允许 mid-session 切换，应在 profile 中增加：

```ts
thinkingModeSwitch: {
  canSwitchMidSession: boolean;
  historyPolicy: "preserve" | "compact_before_switch" | "new_session_required";
}
```

第一版默认：

```text
canSwitchMidSession = true
historyPolicy = preserve
```

### SubAgent / Async Run / Schedule 快照规则

RuntimePolicyStore 是 session-local 可变状态，但异步执行不能半路变策略。

规则：

1. 主 Agent 每轮 LLM 请求读取最新 policy。
2. `run_subagent` 创建 child agent 时使用当时的 policy snapshot。
3. `run_async_start` 启动 command/subagent 时记录当时的 policy snapshot。
4. Schedule 触发 Async Run 时使用触发时的 policy snapshot。
5. 已经 running 的 async run 不受之后 `/t` 或 `/m c` 的影响。

这避免一个长任务前半段用 thinking enabled，后半段突然被前台 CLI 切成 disabled。

### CLI 实现文件

新增或修改：

- `src/runtime-policy-store.ts`
- `src/cli-commands.ts`
- `src/cli-commands.test.ts`
- `src/index.ts`

建议新增：

```ts
createModelPolicyCliCommand(runtimePolicyStore, logger, sessionEventBuffer)
createThinkingCliCommand(runtimePolicyStore, logger, sessionEventBuffer)
```

注册 alias：

```text
m, model, 模型
t, think, thinking, 思考
```

命令实现要共享同一套 parser，避免 `/t 高` 和 `/思考 高` 行为漂移。

压缩策略默认值：

```text
aggressive:
  maxContextTokens = min(effectiveBudget, 80000)
  thresholdToolOutput = 2000
  decayThreshold = 3
  decayPreview = 100
  compactKeepRecent = 4

balanced:
  maxContextTokens = effectiveBudget
  thresholdToolOutput = 4000
  decayThreshold = 5
  decayPreview = 200
  compactKeepRecent = 6

long_context:
  maxContextTokens = effectiveBudget
  thresholdToolOutput = 8000
  decayThreshold = 8
  decayPreview = 400
  compactKeepRecent = 10
```

第一版可以只把这些值注入 `Config.compression`，不需要让 `compressor.ts` 直接依赖完整 policy。

## Request Adapter 设计

### `LLMRequestAdapter`

建议在 `src/llm-adapter.ts` 中抽象 provider 协议方言。

```ts
export interface PreparedLLMRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  stream: boolean;
  extraBody?: Record<string, unknown>;
  maxTokensField: "max_tokens" | "max_completion_tokens";
  maxOutputTokens: number;
}

export interface LLMRequestAdapter {
  prepareMessages(messages: ChatCompletionMessageParam[]): ChatCompletionMessageParam[];
  buildRequest(input: {
    messages: ChatCompletionMessageParam[];
    tools?: ChatCompletionTool[];
  }): PreparedLLMRequest;
  parseNonStreamingResponse(response: unknown): LLMResponse;
  parseStreamingChunk(chunk: unknown, acc: StreamingAccumulator): void;
  finishStreaming(acc: StreamingAccumulator): LLMResponse;
}
```

第一版可只实现 `createOpenAIChatCompletionsAdapter(policy)`。未来 Anthropic adapter 另开 PDD 或后续任务实现。

### message prepare 责任

Adapter 只做协议字段适配，不做语义修复：

- 可以补充必须的 `reasoning_content: ""` 占位。
- 可以保留 raw assistant message 的 provider 字段。
- 不负责修复 tool_call/tool_result 顺序。
- 不负责合并连续 user 消息。
- 不负责压缩上下文。

顺序修复仍属于 `normalize.ts` 和 message pipeline。

### request build 责任

根据 policy 组装：

```ts
{
  model,
  messages,
  tools,
  stream,
  [policy.request.maxTokensField]: policy.request.maxOutputTokens,
  ...policy.request.extraBody
}
```

注意：

- 无 tools 时继续完全省略 `tools` 字段。
- 仅当 policy 支持 `tool_choice` 且项目未来需要时才传 `tool_choice`。
- thinking 参数放在 `extraBody`，不散落在 `llm.ts`。

## History 与 Message 保存策略

当前 `agent.ts` 很可能根据 `LLMResponse.content/toolCalls` 重新构造 assistant 消息。PDD21 后应改为：

```text
如果 response.assistantMessage 存在：
  直接写入 history
否则：
  用 content/toolCalls fallback 构造 assistant message
```

原因：

1. raw assistant message 可能包含 `reasoning_content`。
2. raw assistant message 可能包含 `reasoning_details`。
3. raw assistant message 可能包含 provider-specific 字段，后续请求必须带回。
4. 如果重新构造，容易丢失工具调用协议状态。

`History` 不需要理解这些字段含义，只要：

- 存储时允许 assistant message 保留 provider-specific 字段。
- `normalize.ts` 不要误删 message 顶层 provider 字段。
- `flattenToMessages()` 只清理内部 `_turnIndex` 等项目私有字段，不清理合法 provider 字段。

需要新增测试：assistant message 含 `reasoning_content` + `tool_calls`，经过 history -> normalize -> group -> flatten 后字段仍存在。

## Context Compressor 调整

第一版不重写压缩器，只让配置来自 runtime policy。

`loadConfig()` 当前读取：

```text
COMPRESS_TOOL_OUTPUT
COMPRESS_DECAY_THRESHOLD
COMPRESS_DECAY_PREVIEW
COMPRESS_MAX_CONTEXT
COMPACT_KEEP_RECENT
```

PDD21 后的优先级：

```text
compression:
  1. 显式 COMPRESS_* 环境变量
  2. RuntimePolicy.context 默认值
  3. 旧硬编码 fallback
```

这样用户仍可手动压缩得更激进，但默认值会随模型变化。

长上下文模型注意事项：

- `thresholdToolOutput` 可以放宽，但仍然要保留 P1。
- `decayThreshold` 可以放宽，但旧工具结果仍会衰减。
- `maxContextTokens` 使用 `effectiveBudgetTokens`，不是 `contextWindowTokens`。
- `compactKeepRecent` 可以增大，保留更多最近工具交互。

## 稳定大上下文装载策略

长上下文 profile 只把预算从 80K 放大到 500K/750K/1M，并不能自动产生好效果。Agent 还需要一个 **稳定大上下文装载器**，决定哪些内容进入长上下文、放在哪个位置、如何保持 cache-friendly。

本节目标：让 DeepSeek V4、MiniMax M3、MiMo、Qwen3.7 等长上下文模型获得结构化输入，而不是把文件、日志、摘要随手堆进 prompt。

### 与现有稳定上下文机制的关系

当前项目已经有一套 cache-friendly 稳定前缀机制，但它解决的是 **system prompt / tools / 动态 reminder** 的稳定性，不解决“长上下文模型应该装载哪些项目材料”。

现有机制：

| 机制 | 当前职责 | 当前边界 |
| ---- | -------- | -------- |
| `system-prompt.ts` stable snapshot | 启动时组合 `AGENTS.md`、Task/TODO 规则、Skill hint、Memory hint | 只处理稳定 system prompt，不负责装载源码、repo map、测试证据 |
| Turn reminders | 把 memory/mode/task/schedule/async 等动态状态用 user message 注入 | 只表达动态运行状态，不构造大上下文 |
| Tool registry 稳定顺序 | 保证 tools 定义顺序稳定，不按 mode 动态删减 | 只稳定工具 schema，不管理项目资料 |
| `cache-debug.ts` | 计算 system prompt / tools / stablePrefix hash | 当前 stablePrefix 只覆盖 system prompt + tools，不覆盖项目上下文 pack |
| `compressor.ts` | P0/P1/P2 压缩历史和工具输出 | 只处理已经进入 history 的内容，不主动发现和装载项目上下文 |
| SubAgent stable prompt | 子智能体复用父级 stable system prompt | 只复用 prompt snapshot，不复用项目上下文 pack |

PDD21 的稳定大上下文装载器不是替代这些机制，而是在它们后面新增一个 **Stable Project Context Pack**：

```text
system prompt snapshot     # 现有机制，仍然只设置一次
tools definitions          # 现有机制，顺序稳定
stable project context     # PDD21 新增：repo map / docs / pinned files
working set context        # PDD21 新增：当前任务相关文件
conversation history       # 现有 history + compressor 管线
dynamic evidence pack      # PDD21 新增：diff / test failure / output_id
current user query         # 当前真实用户输入，保持在最后
```

因此它带来的改动是：

1. `system-prompt.ts` 不需要塞入 repo map 或文件内容，避免 system prompt 变得巨大且难刷新。
2. `cache-debug.ts` 需要从“system/tools hash”扩展为“system/tools + stableContextHash + workingSetHash + evidenceHash”，但仍不能声称真实 cache hit。
3. `agent.ts` 的 `prepareMessages()` 需要在 message pipeline 中插入 `StableContextManager.buildMessages()` 的结果，但不能把文件选择逻辑写进主循环。
4. `compressor.ts` 仍负责历史压缩；stable context pack 自己负责预算、hash、排序和裁剪。
5. `sessionEventBuffer` 继续负责动态 reminder；stable context pack 只负责项目材料，不承载 mode/memory/schedule 等运行状态。
6. SubAgent / Async Run 需要拿到 stable context 的 snapshot，不能在运行中被前台 `/c` 命令半路改变。

命名上应避免混淆：

```text
Stable System Prompt
  现有机制。保存行为规则、项目指令、Skill/Memory snapshot。

Stable Project Context Pack
  PDD21 新增机制。保存 repo map、项目文档、pinned files 等项目材料。

Evidence Pack
  PDD21 新增机制。保存动态观察结果，靠近当前 query，不进入稳定前缀。
```

### 需要改动的现有路径

1. `index.ts`
   - 继续启动时设置 stable system prompt。
   - 新增 `StableContextManager` 实例并注入主 Agent、SubAgent provider、Async Run manager。

2. `agent.ts`
   - 当前 `prepareMessages()` 流程是 history entries -> normalize -> group -> decay -> compact -> flatten。
   - PDD21 后应变为：

```text
stable system prompt already lives in history.getMessages()
stable/working context messages from StableContextManager
normalized/compacted conversation messages
evidence messages from StableContextManager
current user query
```

   - 主循环只调用 manager，不实现 repo map 或文件选择。

3. `cache-debug.ts`
   - 保留现有 `systemPromptHash`、`toolsHash`、`stablePrefixHash`。
   - 新增可选字段：

```ts
stableContextHash?: string;
workingSetHash?: string;
evidenceHash?: string;
```

   - 旧测试继续覆盖 system/tools 稳定性，新测试覆盖 context pack hash。

4. `llm-logger.ts`
   - 日志中继续把 system prompt 和 tools 作为稳定前缀显示。
   - 新增 context pack 摘要：

```text
## Stable Project Context hash=... tokens=...
## Working Set hash=... tokens=...
## Evidence hash=... tokens=...
```

5. `tools/subagent.ts` 与 `async-runs.ts`
   - 现有逻辑复用父级 stable system prompt。
   - PDD21 后还要复用创建时的 stable context snapshot。

### 不应该改动的边界

1. 不把 repo map、pinned files、tool evidence 写进 system prompt。
2. 不让 `/c 扫` 或 `/c 加` 改变 tool definitions。
3. 不让 stable context loader 自动读取 `doc/todo.md`。
4. 不让 dynamic evidence 插入 stable context pack 中间。
5. 不让 cache-debug 把 hash stable 伪装成 provider cache hit。

### 核心原则

1. **稳定内容靠前，动态证据靠后**
   - repo map、设计文档、固定关键文件属于稳定上下文。
   - 当前 diff、测试失败、最近工具输出属于动态证据。
   - 动态证据不能插入稳定前缀中间，否则破坏 provider cache 命中。

2. **固定顺序**
   - 同一批内容必须按稳定规则排序。
   - 推荐顺序：context manifest -> repo map -> project docs -> pinned files -> selected working set -> dynamic evidence。

3. **以 source ref 和 hash 管理上下文**
   - 每个文件/片段都有 path、hash、token estimate。
   - 内容没变时，cache key 不变。

4. **大上下文不是全文仓库**
   - 1M budget 也装不下任意大仓库。
   - loader 要按优先级、预算和任务相关性选择。

5. **LLM 可见的是内容和来源，不是裸 agent 内部路径**
   - 可展示 repo 相对路径、hash、摘要。
   - 不暴露 agentHome 内部 artifact 绝对路径。

### 新增概念

```text
Stable Context Pack
  相对稳定、适合放在 prompt 前部的项目上下文包。

Working Set Pack
  当前任务相关文件和设计文档，变化频率中等。

Evidence Pack
  当前 turn 或最近几轮工具观察到的动态证据，例如 test failure、diff、command preview、output_id。

Context Manifest
  发送给 LLM 的目录表，列出本次装载了哪些内容、来源、hash 和 token 预算。
```

### 类型设计

建议新增 `src/stable-context.ts`。

```ts
export type ContextAssetKind =
  | "repo_map"
  | "project_doc"
  | "design_doc"
  | "source_file"
  | "test_file"
  | "diff"
  | "tool_evidence"
  | "summary";

export type ContextStability = "stable" | "semi_stable" | "dynamic";

export interface ContextAsset {
  id: string;
  kind: ContextAssetKind;
  stability: ContextStability;
  source: {
    path?: string;
    outputId?: string;
    label: string;
  };
  priority: number;
  tokenEstimate: number;
  contentHash: string;
  content: string;
}

export interface StableContextPack {
  id: string;
  createdAt: string;
  projectRoot: string;
  modelProfileId: string;
  policyContextBudget: number;
  tokenEstimate: number;
  assets: ContextAsset[];
  manifest: string;
}

export interface StableContextManager {
  getState(): StableContextState;
  rebuildRepoMap(): StableContextPack;
  pinPath(path: string): StableContextPack;
  unpinPath(path: string): StableContextPack;
  recordToolEvidence(input: ToolEvidenceInput): void;
  buildMessages(input: {
    policy: RuntimePolicy;
    currentQuery: string;
    recentFiles: string[];
  }): ChatCompletionMessageParam[];
}
```

### 分层布局

`buildMessages()` 生成的 context messages 应遵守固定布局：

```text
<stable-context-pack>
  <context-manifest>
  <repo-map>
  <project-docs>
  <pinned-files>
</stable-context-pack>

<working-set-pack>
  <relevant-design-docs>
  <recently-read-files>
  <selected-source-files>
</working-set-pack>

<evidence-pack>
  <current-diff>
  <test-failures>
  <tool-output-handles>
</evidence-pack>
```

这些可以作为额外 `user` messages 插入到当前 LLM 请求中：

```text
system prompt
stable context pack
working set pack
conversation/history
evidence pack
current user query
```

注意：

- stable context pack 应尽量在 history 前面，帮助 provider cache。
- evidence pack 应靠近 current user query，避免动态内容污染稳定前缀。
- 当前用户 query 必须仍然是最后的真实用户意图。

### 预算分配

RuntimePolicy 增加 stable context 预算：

```ts
contextLoading: {
  enabled: boolean;
  stablePackBudgetTokens: number;
  workingSetBudgetTokens: number;
  evidenceBudgetTokens: number;
  conversationReserveTokens: number;
  outputReserveTokens: number;
}
```

`long_context` 默认建议：

```text
effectiveContextBudget = 750000

stablePackBudget       = 300000
workingSetBudget       = 250000
evidenceBudget         = 80000
conversationReserve    = 70000
headroom/outputReserve = 50000
```

`balanced` 默认建议：

```text
effectiveContextBudget = 180000

stablePackBudget       = 50000
workingSetBudget       = 60000
evidenceBudget         = 30000
conversationReserve    = 30000
headroom/outputReserve = 10000
```

预算分配不是硬编码常量，应从 `RuntimePolicy.context.effectiveBudgetTokens` 按比例派生，并允许 env / CLI 覆盖。

### Context Budget Allocator

Stable Context Manager 不能自己随手分配预算。新增显式预算分配函数：

```ts
export interface ContextBudgetPlan {
  effectiveBudgetTokens: number;
  outputReserveTokens: number;
  conversationReserveTokens: number;
  stablePackBudgetTokens: number;
  workingSetBudgetTokens: number;
  evidenceBudgetTokens: number;
  headroomTokens: number;
}

export interface ContextBudgetOverrides {
  stableContextBudgetTokens?: number;
  evidenceBudgetTokens?: number;
  conversationReserveTokens?: number;
}

export function resolveContextBudgets(input: {
  effectiveBudgetTokens: number;
  compressionMode: "aggressive" | "balanced" | "long_context";
  maxOutputTokens: number;
  overrides?: ContextBudgetOverrides;
}): ContextBudgetPlan;
```

基本约束：

```text
stablePackBudget
+ workingSetBudget
+ evidenceBudget
+ conversationReserve
+ outputReserve
+ headroom
<= effectiveBudget
```

如果不满足，resolver 必须裁剪或报错，不能让各模块各算各的。

#### 默认公式

先保留输出与安全余量：

```text
outputReserve = min(maxOutputTokens, floor(effectiveBudget * 0.12))
headroom      = max(8000, floor(effectiveBudget * 0.05))
usable        = effectiveBudget - outputReserve - headroom
```

然后按模式分配：

```text
aggressive:
  stablePack    = usable * 0.20
  workingSet    = usable * 0.30
  evidence      = usable * 0.20
  conversation  = usable * 0.30

balanced:
  stablePack    = usable * 0.30
  workingSet    = usable * 0.35
  evidence      = usable * 0.15
  conversation  = usable * 0.20

long_context:
  stablePack    = usable * 0.42
  workingSet    = usable * 0.35
  evidence      = usable * 0.11
  conversation  = usable * 0.12
```

所有结果向下取整，并把剩余 token 放入 `headroomTokens`。

#### `/m c` 后如何重分配

当用户运行：

```text
/m c 300k
```

流程必须是：

```text
RuntimePolicyStore.updateOverride({ contextBudgetTokens: 300000 })
  -> resolveRuntimePolicy(...)
  -> resolveContextBudgets(effectiveBudget=300000, mode=currentCompressionMode)
  -> deriveCompressionConfig(...)
  -> StableContextManager 下次 buildMessages 使用新预算
```

也就是说，`/m c` 改的是全局 effective budget；stable/working/evidence/conversation 子预算必须自动重算。

`/c 预算 120k` 改的是 stable context loader 可用预算上限，不应改变模型整体 effective budget。它只影响：

```text
stablePackBudget + workingSetBudget + evidenceBudget
```

并且仍不能挤占 `conversationReserve`、`outputReserve` 和 `headroom`。

#### 裁剪优先级

当某一轮内容超过预算时，裁剪优先级必须固定：

```text
1. 裁剪 evidence pack
2. 裁剪 working set
3. 裁剪 stable pack
4. 最后才触发 conversation compact
```

原因：

- Evidence pack 最动态，最容易破坏 cache，应该只保留关键失败片段、diff 摘要和 output_id。
- Working set 与当前任务相关，但可通过 `run_read` 重新获取完整内容。
- Stable pack 是 cache-friendly 的核心，应该尽量保持不变。
- Conversation history 是用户交互语义，不能因为大 diff 临时膨胀就优先牺牲。

Evidence pack 过大时的处理规则：

```text
large diff       -> diff stat + touched files + hunk headers + output_id
test failure     -> failing test names + first/last relevant stack frames + output_id
long stdout      -> preview + output_id
many tool reads  -> path/hash list + most recent N files
```

如果裁剪后仍超预算，`StableContextManager.buildMessages()` 应返回 warning metadata，`llm-logger.ts` 记录：

```text
[context-budget] evidence truncated: 42000 -> 12000 tokens
[context-budget] working set truncated: 180000 -> 140000 tokens
```

### Repo Map

Repo map 是稳定大上下文的第一层，不是普通 `ls` 输出。

内容包括：

- 目录结构，过滤 `node_modules`、`dist`、`.git`、coverage、日志、二进制文件。
- 关键配置文件：`package.json`、`tsconfig.json`、`AGENTS.md`、`doc/summary.md`。
- 每个源码文件的相对路径、行数、简短角色描述（第一版可只用路径/行数，后续再用静态分析）。
- 测试文件与源文件的近似配对关系。
- 当前 git 分支与 dirty 文件列表。

Repo map 必须确定性排序：

```text
1. 项目说明与配置
2. src/ 下源码
3. src/**/*.test.ts
4. doc/ 下设计文档
5. skills/ 示例
```

### Project Docs / Design Docs

默认装载：

- `AGENTS.md` 不重复进入 stable context，因为它已经属于 system prompt。
- `doc/summary.md` 可进入 stable context，但应按预算截断或摘要。
- 当前任务明确引用的 PDD 全文优先进入 working set。
- 最近实现相关 PDD 可进入 stable pack 摘要。

规则：

1. 用户明确说“按 PDD21 实现”，则 `doc/pdd21.md` 进入 working set。
2. 用户只问普通代码问题，不自动塞全部 `doc/*.md`。
3. `doc/todo.md` 仍遵守项目指令，不进入 context loader。

### Pinned Files

用户或 agent 可以 pin 文件：

```text
/c 加 src/agent.ts
/c 加 doc/pdd21.md
/c 删 src/agent.ts
/c 列
```

Pinned files 属于 stable/semi-stable context：

- 内容 hash 不变时保持 stable。
- 文件变化后重新计算 hash。
- 超预算时优先保留文件头部、导出接口、关键函数摘要；完整内容可通过 `run_read` 再取。

### Tool Evidence

工具证据不应进入 stable pack。

Evidence pack 包含：

- 最近 `run_bash` 的失败摘要。
- 最近 test/lint/typecheck 的错误片段。
- 当前 `git diff --stat` 和关键 diff 摘要。
- OutputStore 的 `output_id` 引用。
- 最近 `run_read` 观察过的文件 hash。

规则：

1. 大工具输出仍走 OutputStore。
2. Evidence pack 只放失败/关键信号和 handle。
3. Evidence pack 每轮可变，必须靠近 current query。

### 短命令 CLI

稳定上下文同样需要短命令：

```text
/c                 # context 状态
/c 开              # 开启 stable context loader
/c 关              # 关闭 stable context loader
/c 扫              # rebuild repo map
/c 加 <path>       # pin path
/c 删 <path|id>    # unpin path
/c 列              # list loaded/pinned assets
/c 预算 300k       # stable context 总预算
```

Alias：

```text
/ctx
/上下文
/文
```

建议首选帮助文本：

```text
Usage:
  /c                show context pack status
  /c 扫             rebuild repo map
  /c 加 <path>      pin file/doc
  /c 删 <path|id>   unpin file/doc
  /c 开|关          enable/disable stable context
  /c 预算 <tokens>  set stable context budget
```

### 与 prompt cache 的关系

Stable context pack 的 cache-friendly 规则：

1. pack content 按 deterministic order 生成。
2. pack manifest 包含 asset hash。
3. 文件未变化时，pack 字符串完全一致。
4. dynamic evidence 永远不插入 stable pack。
5. 用户当前 query 不进入 stable pack。

`cache-debug.ts` 可以扩展：

```text
stableContextHash=...
workingSetHash=...
evidenceHash=...
```

但仍然不能把 hash stable 等同于 provider cache hit。

### 与 Agent 主循环的关系

Agent 主循环不负责选择文件。新增 `StableContextManager`，由 `agent.ts` 在 prepare messages 阶段调用：

```text
base messages from history
stableContextMessages = stableContextManager.buildMessages(...)
prepared messages = system + stableContextMessages + normalized history/current query
```

如果实现发现 `agent.ts` 需要知道 repo map、pinned files 或 design docs 的细节，说明边界放错了。

### 安全与边界

1. Context loader 只能读取 `projectRoot` 内文件。
2. 默认排除 `.env`、密钥、二进制、大型生成物、`node_modules`、`.git`。
3. 如果 path 被 `.gitignore` 忽略，不代表一定不能读；但默认不自动装载，需要用户 pin 或工具观察。
4. 不读取 `doc/todo.md`，遵守项目级指令。
5. 不把 agentHome 内部路径暴露给 LLM；OutputStore 只暴露 `output_id`。

### 实现文件

新增：

- `src/stable-context.ts`
- `src/stable-context.test.ts`

修改：

- `src/runtime-policy.ts`
- `src/runtime-policy-store.ts`
- `src/agent.ts`
- `src/cache-debug.ts`
- `src/cli-commands.ts`
- `src/cli-commands.test.ts`
- `src/index.ts`

### 验收标准

1. DeepSeek V4 profile 下，`/c 扫` 能生成 repo map，并显示 token 占用。
2. `doc/summary.md` 可按预算进入 stable context。
3. 用户 pin 的文件按稳定顺序进入 context pack。
4. test failure / diff 进入 evidence pack，不污染 stable pack。
5. stable pack 内容不变时 hash 不变。
6. 修改 pinned file 后 hash 改变。
7. `doc/todo.md` 不会被自动装载。
8. context loader 不读取 projectRoot 外文件。
9. `agent.ts` 不出现 repo map 选择细节。


## 通用内容重要性排序与上下文装载优化

### 背景

PDD21 已经实现了基座模型画像、RuntimePolicy、ContextBudget 和 StableContextManager 的第一版。当前 stable context loader 能生成 repo map、装载 pinned files 和 `doc/summary.md`，但文件选择仍偏保守。

如果后续实现类似下面的权重函数：

```ts
function calculateImportance(file: File): number {
  let score = 0;
  if (file.name === "package.json") score += 1000;
  if (file.name === "tsconfig.json") score += 900;
  if (file.name.match(/README/i)) score += 800;
  if (file.path.includes("src/App.")) score += 700;
  if (file.path.includes("src/main.")) score += 600;
  if (file.path.includes("src/index.")) score += 600;
  if (file.isCurrentlyOpen) score += 500;
  score += file.importedBy.length * 50;
  const hoursSinceEdit = (Date.now() - file.lastModified) / 3600000;
  score += Math.max(0, 200 - hoursSinceEdit * 10);
  score -= file.path.split("/").length * 20;
  if (file.path.includes(".test.") || file.path.includes(".spec.")) score -= 300;
  return score;
}
```

会产生明显的 JavaScript / TypeScript 项目偏置：

- `package.json`、`tsconfig.json`、`src/App.*`、`src/main.*` 对 Node / 前端项目有效，但对 Python、Rust、Go、Java、Terraform、文档仓库并不通用。
- 测试文件固定惩罚是错误的。修测试、debug、review diff、定位失败时，测试文件可能是最高优先级。
- 路径深度固定惩罚也不稳。monorepo、Java package、Kubernetes manifests、Terraform modules 的重要文件经常很深。
- 只用 `importedBy.length` 会偏向代码依赖图，无法覆盖 README、设计文档、schema、配置、CI、迁移、部署文件。

本设计是 PDD21 的补充，目标是让 stable context loader 从“JS 代码仓库排序器”升级为“通用项目内容重要性排序器”。

### 目标

1. 为任意项目类型生成稳定、可解释、可测试的文件重要性排序。
2. 对 JS/TS、Python、Rust、Go、Java/Kotlin、C/C++、文档仓库、Infra/IaC、API/schema 仓库都能给出合理默认。
3. 让文件排序同时考虑三类信号：
   - 项目静态结构：manifest、entrypoint、docs、schema、source、tests、infra。
   - 当前任务动态相关性：用户 query、recent files、diff、失败日志、当前打开文件。
   - 图结构与证据：import graph、test pairing、git changes、tool evidence。
4. 与 PDD21 的 StableContextManager 集成，但不把文件选择逻辑写进 `agent.ts`。
5. 保持 prompt cache 友好：稳定内容稳定排序，动态内容只影响 working set / evidence，不污染 stable pack。

### 非目标

1. 不实现全语言精确 AST 解析器。第一版使用轻量规则和可选的语言识别。
2. 不把整个仓库全文塞进 prompt。
3. 不读取 `doc/todo.md`，继续遵守项目指令。
4. 不让动态排序修改 system prompt 或 tool definitions。
5. 不为每个语言生态写复杂插件系统。第一版使用 registry + rule set，后续再扩展。

### 核心结论

文件重要性不应由一个硬编码函数决定，而应拆成四层：

```text
FileInventory
  收集项目文件事实：路径、大小、mtime、扩展名、是否测试、是否生成物、是否敏感、hash。

RepoClassifier
  识别项目生态：typescript、python、rust、go、java、infra、docs、mixed、unknown。

TaskIntentClassifier
  根据用户 query 和最近 evidence 判断当前任务：orientation、implementation、debug、review、testing、docs、refactor。

ContextRanker
  组合通用信号 + 生态信号 + 任务信号 + evidence 信号，输出可解释排序。
```

最终 scoring 不再是“某些文件名写死加分”，而是：

```text
score =
  roleScore
+ ecosystemScore
+ taskRelevanceScore
+ evidenceScore
+ graphScore
+ recencyScore
+ userSignalScore
- noisePenalty
```

每个分数都必须记录 reason，方便 CLI / 日志解释为什么某个文件进入上下文。

### 模块设计

新增 `src/context-ranking.ts`。

#### 类型

```ts
export type RepoEcosystem =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "kotlin"
  | "cpp"
  | "infra"
  | "docs"
  | "mixed"
  | "unknown";

export type TaskIntent =
  | "orientation"
  | "implementation"
  | "debug"
  | "review"
  | "testing"
  | "documentation"
  | "refactor"
  | "unknown";

export type FileRole =
  | "project_instruction"
  | "readme"
  | "project_summary"
  | "design_doc"
  | "manifest"
  | "lockfile"
  | "build_config"
  | "entrypoint"
  | "source"
  | "test"
  | "schema"
  | "migration"
  | "infra"
  | "ci_config"
  | "generated"
  | "binary"
  | "secret"
  | "unknown";

export interface FileFacts {
  path: string;
  name: string;
  extension: string;
  sizeBytes: number;
  lineCount?: number;
  lastModifiedMs?: number;
  contentHash?: string;
  roles: FileRole[];
  ecosystems: RepoEcosystem[];
  isCurrentlyOpen?: boolean;
  isRecentlyRead?: boolean;
  isGitModified?: boolean;
  isGitStaged?: boolean;
  isIgnored?: boolean;
  imports: string[];
  importedBy: string[];
  pairedFiles: string[];
}

export interface RepoClassification {
  primary: RepoEcosystem;
  all: RepoEcosystem[];
  confidence: number;
  reasons: string[];
  roots: string[];
}

export interface TaskContext {
  query: string;
  intent: TaskIntent;
  explicitlyMentionedPaths: string[];
  explicitlyMentionedTerms: string[];
  recentFiles: string[];
  openFiles: string[];
  changedFiles: string[];
  failingFiles: string[];
  stackTraceFiles: string[];
}

export interface ScoreReason {
  signal: string;
  points: number;
  note: string;
}

export interface RankedFile {
  path: string;
  score: number;
  facts: FileFacts;
  reasons: ScoreReason[];
}
```

#### 接口

```ts
export interface ContextRanker {
  classifyRepo(files: FileFacts[]): RepoClassification;
  classifyTask(input: {
    query: string;
    recentFiles: string[];
    openFiles: string[];
    changedFiles: string[];
    failingFiles: string[];
    stackTraceFiles: string[];
  }): TaskContext;
  rankFiles(input: {
    files: FileFacts[];
    repo: RepoClassification;
    task: TaskContext;
    maxResults?: number;
  }): RankedFile[];
}

export function createContextRanker(projectRoot: string): ContextRanker;
```

### 文件事实收集

第一版 inventory 只需要同步扫描项目目录，和 `stable-context.ts` 的安全边界一致。

#### 必须排除

默认自动装载时排除：

```text
node_modules/
.git/
dist/
build/
coverage/
.next/
.nuxt/
target/
vendor/
__pycache__/
.pytest_cache/
*.log
*.lock
*.png, *.jpg, *.gif, *.pdf, *.zip, *.tar, *.gz
.env
.env.*
```

注意：

- lockfile 默认不进 stable context，但可以作为 repo classification 信号。
- 二进制、图片、压缩包默认不装载。
- `.env` 和密钥文件永远不自动装载，即使用户 query 命中也要提示不能自动读取。
- `doc/todo.md` 永远不自动装载。

#### 文件角色识别

角色识别是通用排序的核心。

| Role | 示例 | 默认用途 |
| ---- | ---- | -------- |
| `project_instruction` | `AGENTS.md`, `CLAUDE.md` | 已进入 system prompt，不重复装载，可在 repo map 标注 |
| `readme` | `README.md` | orientation 高优先级 |
| `project_summary` | `doc/summary.md` | stable / working set 高优先级 |
| `design_doc` | `doc/pdd*.md`, `docs/*.md` | 被 query 命中时高优先级 |
| `manifest` | `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `pom.xml` | repo classification + orientation |
| `build_config` | `tsconfig.json`, `vite.config.ts`, `Makefile`, `CMakeLists.txt`, `build.gradle` | implementation/debug 相关 |
| `entrypoint` | `src/main.*`, `main.go`, `app.py`, `cmd/*/main.go`, `src/lib.rs` | orientation/implementation |
| `source` | `src/**/*.ts`, `*.py`, `*.rs`, `*.go`, `*.java` | working set 候选 |
| `test` | `*.test.ts`, `test_*.py`, `*_test.go`, `src/test/**` | testing/debug/review 时加分 |
| `schema` | `openapi.yaml`, `*.proto`, `schema.graphql`, Prisma schema | API 任务高优先级 |
| `infra` | `Dockerfile`, `compose.yaml`, `*.tf`, k8s yaml | deploy/infra 任务高优先级 |
| `ci_config` | `.github/workflows/*.yml` | CI/debug/review 高优先级 |
| `generated` | `dist/**`, generated marker | 默认降权或排除 |

### RepoClassifier

不能只看 `package.json`。分类应按 manifest + 文件分布 + 目录结构组合判断。

#### 生态信号

```text
typescript:
  package.json + tsconfig.json
  src/**/*.ts 或 src/**/*.tsx
  vite.config.ts / next.config.* / tsup.config.*

javascript:
  package.json
  src/**/*.js 或 src/**/*.jsx

python:
  pyproject.toml / requirements.txt / setup.py / poetry.lock
  **/*.py
  tests/ 或 test_*.py

rust:
  Cargo.toml
  src/main.rs / src/lib.rs
  tests/**/*.rs

go:
  go.mod
  **/*.go
  *_test.go

java:
  pom.xml / build.gradle
  src/main/java/**
  src/test/java/**

kotlin:
  build.gradle.kts
  src/main/kotlin/**

cpp:
  CMakeLists.txt / Makefile
  src/**/*.cc / src/**/*.cpp / include/**/*.h

infra:
  Dockerfile / compose.yaml / *.tf / k8s/*.yaml / helm charts

docs:
  README.md + docs/**/*.md
  缺少明显代码 manifest，Markdown 占比高
```

#### mixed repo

如果多个生态 confidence 都很高，primary 为 `mixed`，并记录 `all`：

```ts
{
  primary: "mixed",
  all: ["typescript", "python", "infra"],
  confidence: 0.92,
  roots: ["frontend", "backend", "deploy"]
}
```

monorepo 不应使用全局路径深度惩罚。应先识别 package roots，再在每个 root 内判断 entrypoint / tests / manifest。

### TaskIntentClassifier

任务类型决定动态权重。

#### 规则

```text
orientation:
  用户问“解释项目、架构、怎么运行、有哪些模块”

implementation:
  用户要求“实现、添加、修改、开发”

debug:
  用户提到 error、失败、报错、stack trace、测试不通过

review:
  用户说 review、检查、审查、有没有问题

testing:
  用户说测试、补测试、修测试、coverage

documentation:
  用户说文档、README、PDD、说明

refactor:
  用户说重构、整理、拆分、抽象
```

#### 任务对文件的影响

| Intent | 加分对象 | 降权对象 |
| ------ | -------- | -------- |
| orientation | README、summary、manifest、entrypoint、repo map | 深层测试、generated |
| implementation | 设计文档、相关 source、接口/schema、相邻测试 | 无关 docs |
| debug | failing files、stack trace、recent diff、相关测试、配置 | 无关 README |
| review | changed files、相关测试、边界模块、配置、schema | 未改动远端模块 |
| testing | test files、test helpers、source paired files、test config | 无关 entrypoint |
| documentation | README、docs、PDD、summary、API schema | 大段 source |
| refactor | 被引用多的 source、接口、测试、模块边界文件 | generated |

### Scoring 设计

#### 分数范围

避免一个信号压倒一切。建议每类信号封顶：

```text
roleScore            0..500
ecosystemScore       0..350
taskRelevanceScore   0..700
evidenceScore        0..900
graphScore           0..400
recencyScore         0..250
userSignalScore      0..1000
noisePenalty         0..1200
```

用户显式提到路径或 pin 文件可以最高优先级，但仍受安全边界约束。

#### 通用 roleScore

```text
project_summary       +420
readme                +380
design_doc            +300
manifest              +280
entrypoint            +260
schema                +240
build_config          +220
ci_config             +180
source                +140
test                  +120
infra                 +120
lockfile              +30
generated             -500
binary                -800
secret                -1200
```

这些不是最终排序，只是通用基线。

#### ecosystemScore

生态规则只在 repo classifier 匹配后生效。

例：

```text
typescript:
  package.json             +250
  tsconfig.json            +220
  src/main.ts              +220
  src/index.ts             +200
  vite.config.ts           +180

python:
  pyproject.toml           +250
  requirements.txt         +180
  app.py                   +220
  src/**/__init__.py       +80
  tests/conftest.py        +160

rust:
  Cargo.toml               +250
  src/lib.rs               +240
  src/main.rs              +220

go:
  go.mod                   +250
  main.go                  +220
  cmd/*/main.go            +220

java:
  pom.xml                  +230
  build.gradle             +230
  src/main/java/**         +160

infra:
  Dockerfile               +220
  compose.yaml             +220
  *.tf                     +180
  .github/workflows/*.yml  +170
```

关键点：JS/TS 规则只是一个 ecosystem profile，不能写进通用 scoring 主体。

#### taskRelevanceScore

query 命中必须优先：

```text
exact path mentioned         +1000
basename mentioned           +600
symbol/name term matched     +300
directory mentioned          +250
design doc id mentioned      +800
```

测试文件处理必须按 task intent 调整：

```text
if intent in ["debug", "testing", "review"]:
  test file +250
else if intent == "orientation":
  test file -120
else:
  test file 0
```

#### evidenceScore

工具证据比静态猜测更重要。

```text
stack trace file             +900
failing test file            +850
git changed file             +700
git staged file              +720
recent run_read file         +500
recent tool output mentions  +350
current open file            +450
```

Evidence score 属于动态信号，只应影响 working set / evidence pack，不应重新排序 stable pack。

#### graphScore

第一版可以轻量实现：

- TS/JS：用 import/export 字符串规则提取相对 imports。
- Python：识别 `import x`、`from x import y`，只做同项目近似映射。
- Go：识别 import blocks，结合 `go.mod` module name 做近似。
- Rust：识别 `mod`、`use crate::`、`use super::`。
- Java/Kotlin：识别 package/import，做路径近似。
- 其他：不构建 graph，graphScore = 0。

分数：

```text
importedByCount capped at 8: importedByCount * 35
importsCount capped at 8: importsCount * 10
paired test/source relation: +160 when task needs tests
central manifest/config referenced by many roots: +160
```

不要只靠 `importedBy.length`，否则 README、schema、CI、infra 永远吃亏。

#### recencyScore

最近修改有用，但不要每小时导致 stable pack 频繁重排。

规则：

```text
if file.isGitModified or file.isGitStaged:
  use evidenceScore, not recencyScore

if lastModifiedMs exists:
  hours = ...
  recencyScore = clamp(0, 180, 180 - hours * 4)
```

Recency 只影响 working set 排序，不影响 stable pack 排序。

#### noisePenalty

```text
generated marker             -800
minified file                -700
binary                       -1000
secret/env                   -1200
very large file > 1MB        -300 unless explicitly pinned
path in excluded dir         -1000
doc/todo.md                  -1000
```

### 稳定排序与 Pack 分层

#### Stable Pack

Stable pack 只允许稳定信号决定排序：

```text
project_instruction marker only, no content
repo map
README
doc/summary.md
manifest/build config summary
pinned files by normalized path
```

排序 tie-breaker：

```text
1. stable tier
2. roleScore + ecosystemScore
3. normalized path ascending
```

不使用：

- mtime
- open file
- git diff
- failing test
- query terms

#### Working Set Pack

Working set 使用完整 scoring：

```text
query-mentioned files
current design docs
changed files
recent files
graph-neighbor files
paired tests/source files
```

排序 tie-breaker：

```text
1. score desc
2. evidence count desc
3. normalized path ascending
```

#### Evidence Pack

Evidence pack 不装全文文件，装证据摘要：

```text
git diff stat
changed file list
failing test names
stack trace frames
tool output preview + output_id
```

Evidence pack 里的文件列表可以引用 `RankedFile`，但内容摘要应由 evidence manager 控制。

### 与 StableContextManager 的集成

修改 `src/stable-context.ts`：

```ts
import { createContextRanker } from "./context-ranking.js";

export interface StableContextManager {
  getState(): StableContextState;
  setEnabled(enabled: boolean): void;
  rebuildRepoMap(): StableContextPack;
  pinPath(filePath: string): void;
  unpinPath(filePath: string): void;
  buildMessages(input: {
    currentQuery: string;
    recentFiles: string[];
    openFiles: string[];
    changedFiles: string[];
    failingFiles: string[];
    stackTraceFiles: string[];
  }): ChatCompletionMessageParam[];
}
```

第一版如果 `agent.ts` 暂时没有 open files / failing files，可以传空数组。不要因此把 API 设计成只接收 string。

#### buildMessages 流程

```text
1. inventory = scan projectRoot
2. repo = ranker.classifyRepo(inventory.files)
3. task = ranker.classifyTask(current query + runtime evidence)
4. ranked = ranker.rankFiles({ files, repo, task })
5. stable assets = stable selection rules
6. working assets = top ranked dynamic candidates within budget
7. evidence assets = evidence manager output
8. build deterministic manifests with reasons and hashes
```

#### Manifest 增强

Context manifest 应包含排序原因摘要：

```text
<working-set-manifest>
  assets: 4
  tokens: 18320
  repo: mixed(typescript, docs)
  task: review
  - src/stable-context.ts score=1280 reasons=git_changed, query_term, source
  - src/stable-context.test.ts score=1110 reasons=git_changed, paired_test, review_task
</working-set-manifest>
```

这样 LLM 能知道为什么这些文件被装载，debug 也更容易。

### CLI 增强

在 `/c` 命令上增加两个子命令：

```text
/c 排              # 显示当前 query-less 的 top ranked files
/c why <path>      # 显示某个文件的重要性分数和原因
```

中文 alias：

```text
/c 因 <path>
```

`/c why` 输出示例：

```text
Context rank: src/stable-context.ts
  score: 1280
  role: source +140
  ecosystem: typescript source +120
  task: query matched "stable-context" +300
  evidence: git modified +700
  graph: imported by index.ts +35
  penalty: none
```

CLI 输出只用于用户查看，不进入 system prompt。

### 与 RuntimePolicy 的关系

PDD21 的 `RuntimePolicy.contextLoading` 继续负责预算。通用内容重要性排序层只决定“预算内放什么”。

```text
RuntimePolicy decides:
  stablePackBudgetTokens
  workingSetBudgetTokens
  evidenceBudgetTokens

ContextRanker decides:
  file order
  file role
  file explanation
  stable vs working candidacy
```

不要把不同模型的 profile 写进 ranker。模型只影响预算和压缩策略，不影响“Rust 的 Cargo.toml 是 manifest”这个事实。

### 安全边界

1. 所有路径必须用 `path.relative(projectRoot, resolved)` 校验，拒绝 `..` 开头和绝对 relative。
2. 自动扫描只读取 metadata；读取内容前必须确认文件未被排除且在预算内。
3. `.env`、密钥、二进制永不自动读。
4. Symlink 第一版可以跳过，避免绕过 projectRoot。
5. `doc/todo.md` 永不自动读。
6. generated 文件默认跳过，除非用户显式 pin，且仍要受大小和安全限制。

### 实现计划

#### Phase 1: Context Ranking 模块

新增：

- `src/context-ranking.ts`
- `src/context-ranking.test.ts`

实现：

1. `scanFileFacts(projectRoot)` 或由 `createContextRanker()` 内部扫描。
2. 文件角色识别。
3. Repo classification。
4. Task intent classification。
5. Scoring + reasons。
6. Deterministic sorting。

测试 fixture 至少覆盖：

```text
typescript project
python project
rust project
go project
docs-only project
infra project
mixed monorepo
```

#### Phase 2: StableContextManager 集成

修改：

- `src/stable-context.ts`
- `src/stable-context.test.ts`

实现：

1. 使用 `ContextRanker` 选择 working set。
2. Stable pack 不使用动态信号。
3. Working set 使用 query / recent / changed / failing 信号。
4. Manifest 输出 rank reasons。
5. 保持现有 `/c 加` pinned files 行为。

#### Phase 3: Agent Evidence 输入

修改：

- `src/agent.ts`
- `src/compressor.ts` 或新增 evidence collector

实现：

1. 将 recent read files、changed files、failing files 传入 `buildMessages()`。
2. 第一版可以只传 `recentFiles` 和空 evidence。
3. 后续再接入 git diff、test failure、OutputStore handles。

注意：`agent.ts` 只传事实，不参与排序。

#### Phase 4: CLI 与日志

修改：

- `src/cli-commands.ts`
- `src/cli-commands.test.ts`
- `src/llm-logger.ts`

实现：

1. `/c 排`
2. `/c why <path>` / `/c 因 <path>`
3. LLM logger 记录 pack manifest 的 rank reasons。

### 验收标准

1. 在只有 Python 文件的 fixture 中，`pyproject.toml`、`app.py`、`tests/conftest.py` 能得到合理分数，`package.json` 不会被假设存在。
2. 在 Rust fixture 中，`Cargo.toml`、`src/lib.rs`、`src/main.rs` 排名高于无关深层文件。
3. 在 docs-only fixture 中，README、`docs/*.md`、summary 排名高，不会因为缺少代码 manifest 而退化。
4. 在 infra fixture 中，`Dockerfile`、`compose.yaml`、`*.tf`、workflow yaml 能被识别。
5. 在 review intent 下，changed test files 不被惩罚。
6. 在 orientation intent 下，测试文件可降权，但不能固定 -300。
7. 在 monorepo fixture 中，深层 package entrypoint 不因路径深度被错误淘汰。
8. `/c why <path>` 能解释 score 来源。
9. Stable pack 排序不受 mtime、open file、git diff 影响。
10. Working set 排序可以受 query、diff、failing tests 影响。
11. `doc/todo.md`、`.env`、二进制、projectRoot 外路径不会被自动装载。
12. 所有新增/修改代码通过 `npm run typecheck`、相关 vitest、`npm run lint`。

### 给实现 Agent 的注意事项

1. 先把本章节的要求拆成 checklist，再编码。
2. 不要在 `agent.ts` 写文件名规则。
3. 不要把 JS/TS 规则写成全局默认，只能作为 ecosystem profile。
4. 不要让 test file 固定扣分。
5. 每个分数必须可解释，否则 ranking 很难 review。
6. 排序必须 deterministic，同分时按 normalized path 排。
7. 保持实现轻量，第一版不引入外部 parser。
8. 修改实现后更新 `doc/summary.md`，因为这是项目当前状态源。


## Cache Telemetry

当前 `cache-debug.ts` 是本地稳定前缀 hash，不是真实 provider cache hit rate。PDD21 后新增两个概念：

```text
Local Prefix Stability
  system prompt + tools 的本地 hash 是否稳定。

Provider Cache Usage
  API usage 返回的 cache hit/miss/cached tokens。
```

建议：

1. `cache-debug.ts` 保持原职责，不参与 provider usage 解析。
2. `llm.ts` / adapter 从 response usage 中解析 `LLMUsageTelemetry`。
3. `llm-logger.ts` 在 response 日志中记录：
   - promptTokens
   - completionTokens
   - reasoningTokens
   - cacheHitTokens
   - cacheMissTokens
   - cachedTokens
   - effectiveContextBudget
4. `formatCacheDebugLog()` 可追加本地 budget 信息，但不要声称是真实 cache hit。

## 与 Agent 主循环的关系

`agent.ts` 允许感知这些通用策略：

- `response.assistantMessage`
- `finishReason`
- context 超限触发 recovery/compact

`agent.ts` 不允许感知：

- `kimi`
- `qwen`
- `deepseek`
- `minimax`
- `mimo`
- `glm`
- `reasoning_content` 字段名
- `reasoning_details` 字段名
- `max_completion_tokens` 字段名

如果实现时发现必须在 `agent.ts` 判断 provider，说明抽象层没有收好，应回到 adapter/policy 设计。

## 与 SubAgent / Async Run / Schedule 的关系

第一版所有执行路径共享同一个 LLMClient 和 RuntimePolicy。

要求：

1. `index.ts` 只解析一次 model profile 和 runtime policy。
2. 主 Agent、SubAgent、Async Run subagent 都复用同一个 LLMClient 或同一份 policy 创建的 client。
3. Schedule 触发 Async Run 时不重新解析 provider。
4. 如果未来支持 cheap subagent model，那是新的多模型路由 PDD，不在本阶段做。

原因：共享实例必须真实共享，避免同一 session 不同执行路径使用不同策略，导致 history/reasoning 回放不一致。

## 配置与启动日志

启动日志建议从：

```text
Agent started (provider: kimi_code_cn, model: kimi-for-coding, project: ...)
```

扩展为：

```text
Agent started (
  provider: kimi_platform_cn,
  model: kimi-k2.6,
  profile: kimi-k2.6,
  protocol: openai-chat-completions,
  contextBudget: 180000,
  thinking: enabled
)
```

不要输出 API key。

如果 selected protocol fallback：

```text
[model-policy] preferred protocol anthropic-messages is not implemented; using openai-chat-completions fallback for minimax-m3
```

如果用户显式指定未实现 protocol：

```text
Configured protocol "anthropic-messages" for model profile "minimax-m3" is not implemented yet.
Use LLM_PROTOCOL=openai-chat-completions or implement the Anthropic adapter.
```

## 文件改动范围

### 新增文件

1. `src/foundation-models.ts`
   - profile 类型
   - registry
   - profile 解析函数
   - provider/model/profile 校验

2. `src/runtime-policy.ts`
   - RuntimePolicy 类型
   - policy resolver
   - env override parser
   - compression default derivation

3. `src/context-budget.ts`
   - `resolveContextBudgets()`
   - 子预算比例派生
   - override 校验与裁剪计划

4. `src/runtime-policy-store.ts`
   - session-local runtime override
   - thinking/context/max output 更新与校验
   - policy snapshot

5. `src/stable-context.ts`
   - stable context pack / working set / evidence pack
   - repo map builder
   - pinned file 管理
   - context messages 构建

6. `src/llm-adapter.ts`
   - request adapter 接口
   - OpenAI Chat Completions adapter
   - response usage/reasoning 解析 helper

7. `src/foundation-models.test.ts`
   - profile 匹配、fallback、显式 profile 校验、profile freshness warning

8. `src/runtime-policy.test.ts`
   - policy 默认值、env 覆盖、非法覆盖报错

9. `src/context-budget.test.ts`
   - 预算公式、总和约束、`/m c` 后重分配、裁剪优先级

10. `src/runtime-policy-store.test.ts`
   - CLI override 合并、reset、snapshot、非法更新报错

11. `src/stable-context.test.ts`
   - repo map、pin/unpin、hash 稳定性、预算裁剪、安全边界

12. `src/llm-adapter.test.ts`
   - reasoning 回放、streaming reasoning/tool arguments 聚合、max token 字段

### 修改文件

1. `src/llm-providers.ts`
   - 保持 provider 连接配置职责。
   - 可增加 provider id，例如 `deepseek`、`mimo`、`qwen_dashscope`、`zhipu`、`minimax_global`。
   - 不把所有 model policy 塞回这个文件。

2. `src/config.ts`
   - 返回 `modelProfile` 与 `runtimePolicy`。
   - compression 默认值从 runtime policy 派生。

3. `src/cli-commands.ts`
   - 注册 `/m`、`/模型`、`/t`、`/思考`、`/c`、`/上下文` 等短命令。
   - 命令只修改 runtime override 或 stable context manager，不改 system prompt。

4. `src/cli-commands.test.ts`
   - 覆盖短命令 alias、中文参数、非法值报错。

5. `src/llm.ts`
   - 使用 adapter 构建请求和解析响应。
   - `LLMResponse` 增加 `assistantMessage/reasoning/usage`。
   - streaming 聚合增加 reasoning fields。

6. `src/agent.ts`
   - 写入 assistant history 时优先使用 `response.assistantMessage`。
   - 在 prepare messages 阶段插入 `StableContextManager.buildMessages()` 的结果。
   - 不新增 provider/model 分支。

7. `src/history.ts` / `src/message-block.ts` / `src/normalize.ts`
   - 确认 provider-specific assistant 顶层字段不会被误删。
   - 内部 `_xxx` 字段仍必须清理。

8. `src/llm-logger.ts`
   - 记录 usage telemetry。
   - 记录当前 runtime policy 摘要。
   - 对 reasoning 内容可截断记录，避免日志爆炸。

9. `src/cache-debug.ts`
   - 可选增加 budget / stableContextHash / workingSetHash / evidenceHash 字段；不要混淆真实 cache usage。

10. `src/index.ts`
   - 组装根创建一次 runtime policy store、stable context manager 并注入。
   - 启动日志显示 profile/policy 摘要。

11. `doc/summary.md`
   - 实现完成后更新当前项目状态。

## 实施步骤

### Step 1: 新增 Foundation Model Profile 层

Checklist:

1. 新增 `src/foundation-models.ts`。
2. 定义 `FoundationModelProfile`。
3. 为 profile 增加 `documentation.verifiedAt/updateRisk/status/sourceUrls`。
4. 建立最小 registry：
   - `generic-openai-compatible`
   - `kimi-k2.6`
   - `kimi-code`
   - `minimax-m2.7`
   - 可选：`deepseek-v4`、`minimax-m3`、`mimo-v2.5-pro`、`qwen3.7-max`、`glm-5.1`
5. 实现 `resolveFoundationModelProfile()`。
6. 支持 `LLM_MODEL_PROFILE` 显式指定。
7. 对 provider/profile 不兼容报错。
8. 对 stale/high-risk profile 产生 warning，不做网络请求。
9. 增加单元测试。

建议第一版 registry 允许“未来模型 profile 暂不作为默认 provider”，避免没有 live key 时影响现有测试。

### Step 2: 新增 Runtime Policy Resolver

Checklist:

1. 新增 `src/runtime-policy.ts`。
2. 定义 `RuntimePolicy`。
3. 从 profile 派生 context/thinking/tools/cache/reasoning/request 策略。
4. 支持环境变量覆盖。
5. 校验非法覆盖：
   - context budget 超窗
   - thinking enabled 但模型不支持
   - reasoning effort 不支持
   - protocol 未实现
   - max output 超过 profile 限制
6. 将 compression 默认值作为 resolver 输出。
7. 调用 `resolveContextBudgets()` 派生 stable/working/evidence/conversation 子预算。
8. 增加测试覆盖。

### Step 3: 新增 Context Budget Allocator

Checklist:

1. 新增 `src/context-budget.ts`。
2. 实现 `resolveContextBudgets()`。
3. 保证子预算总和不超过 effective budget。
4. 支持 `aggressive`、`balanced`、`long_context` 三种比例。
5. 支持 stable/evidence/conversation overrides。
6. 规定 evidence -> workingSet -> stablePack -> conversation compact 的裁剪优先级。
7. 增加 `context-budget.test.ts`。

### Step 4: 新增 Runtime Policy Store 与短命令 CLI

Checklist:

1. 新增 `src/runtime-policy-store.ts`。
2. 支持 `getPolicy()` / `updateOverride()` / `resetOverride()` / `snapshot()`。
3. `updateOverride()` 校验 thinking、reasoning effort、context budget、max output 是否被当前 profile 支持。
4. `updateOverride()` 后重新派生 compression config。
5. `LLMClient` 改为通过 `getRuntimePolicy()` 获取当前 policy。
6. `run_subagent`、`run_async_start`、Schedule trigger 使用当时的 policy snapshot。
7. 新增 `/m`、`/模型`、`/t`、`/思考` 命令。
8. `/t 开|关|自|高|最强|默认` 支持中文参数。
9. `/m c 300k` 支持 k/K 后缀解析。
10. 拒绝 protocol/tools/cache/reasoning 协议字段的 mid-session override，并提示需要新 session 或重启。
11. policy 变更写入 session event 或 transcript。
12. 增加 `runtime-policy-store.test.ts` 和 `cli-commands.test.ts`。

### Step 5: Config 接入

Checklist:

1. `loadConfig()` 先 resolve provider config。
2. 再 resolve model profile。
3. 再 resolve runtime policy。
4. `Config` 增加：

```ts
modelProfile: FoundationModelProfile;
runtimePolicy: RuntimePolicy;
```

5. `index.ts` 用 `runtimePolicy` 创建 `RuntimePolicyStore`。
6. compression 默认值改为：
   - 显式 env 覆盖优先
   - 否则取 `runtimePolicy.context.*`
7. 更新 `config.test.ts`。

### Step 6: LLM Adapter 接入

Checklist:

1. 新增 `src/llm-adapter.ts`。
2. 将 `llm.ts` 中 Kimi Code 的 reasoning placeholder 逻辑迁入 adapter。
3. 将 max token 字段、thinking extraBody、streaming 开关交给 adapter。
4. non-streaming 解析：
   - content
   - tool_calls
   - finish_reason
   - assistantMessage raw/preserved
   - reasoning
   - usage
5. streaming 解析：
   - content delta
   - tool_calls delta by index
   - reasoning_content delta
   - reasoning_details delta 如可用
   - finish_reason
   - usage chunk 如 provider 返回
6. 增加 adapter 单元测试。

### Step 7: Agent History 保存 raw assistant

Checklist:

1. 找到 `agent.ts` 写 assistant message 的位置。
2. 改成优先写 `response.assistantMessage`。
3. fallback 保持旧逻辑，保证 mock 测试容易迁移。
4. 增加测试：
   - LLM 返回 assistantMessage 含 reasoning_content + tool_calls。
   - Agent 执行工具后下一轮传给 LLM 的 messages 仍含 reasoning_content。
5. 确认 Transcript 仍记录 assistant 原始消息。

### Step 8: Message pipeline 保留 provider 字段

Checklist:

1. 检查 `normalize.ts` 是否只清理项目内部 `_xxx` 字段。
2. 检查 `groupToBlocks()` / `flattenToMessages()` 是否保留 assistant 顶层 provider 字段。
3. 增加 round-trip 测试：
   - `reasoning_content`
   - `reasoning_details`
   - `tool_calls`
   - `audio_content` 或未知 provider 字段
4. 确认 `_turnIndex/_loopIndex/_messageSequence` 仍不会发给 LLM。

### Step 9: Stable Context Manager 接入

Checklist:

1. 新增 `src/stable-context.ts`。
2. 实现 repo map builder，过滤 `node_modules`、`dist`、`.git`、coverage、二进制和敏感文件。
3. 默认不读取 `doc/todo.md`。
4. 支持 `pinPath()` / `unpinPath()` / `rebuildRepoMap()`。
5. 实现 stable pack / working set / evidence pack 的固定排序。
6. 实现 content hash、token estimate、manifest。
7. `agent.ts` prepare messages 阶段调用 `StableContextManager.buildMessages()`。
8. `/c`、`/上下文`、`/文` 支持状态、扫描、pin、unpin、开关和预算命令。
9. tool result / test failure / diff 只进入 evidence pack。
10. 使用 `ContextBudgetPlan` 做预算裁剪，不自行重复计算预算。
11. 增加 `stable-context.test.ts` 和相关 CLI 测试。

### Step 10: Telemetry 与日志

Checklist:

1. 定义 `LLMUsageTelemetry`。
2. adapter 从 response usage 提取 usage。
3. `llm-logger.ts` 记录 usage 摘要。
4. reasoning 内容日志默认截断，例如 1000 字符。
5. cache hit/miss 字段缺失时不报错。
6. 记录当前 runtime policy 摘要。
7. 记录 stableContextHash / workingSetHash / evidenceHash。
8. 增加 logger 测试，确认不会泄漏 API key。

### Step 11: 启动日志与 Summary

Checklist:

1. `index.ts` 启动日志打印 provider/model/profile/policy 摘要。
2. 不打印 apiKey。
3. 实现完成后更新 `doc/summary.md`。
4. 文档说明 PDD21 已完成部分和未完成部分。

## 测试计划

### 单元测试

运行：

```bash
npx vitest run src/foundation-models.test.ts
npx vitest run src/runtime-policy.test.ts
npx vitest run src/context-budget.test.ts
npx vitest run src/runtime-policy-store.test.ts
npx vitest run src/stable-context.test.ts
npx vitest run src/llm-adapter.test.ts
npx vitest run src/llm-providers.test.ts
npx vitest run src/config.test.ts
npx vitest run src/cli-commands.test.ts
npx vitest run src/normalize.test.ts src/message-block.test.ts src/history.test.ts
```

重点用例：

1. 未知模型 fallback 到 generic profile。
2. `LLM_MODEL_PROFILE` 显式指定成功。
3. provider/profile 不兼容时报错。
4. `LLM_CONTEXT_BUDGET` 超过窗口时报错。
5. thinking enabled 但模型不支持时报错。
6. Anthropic protocol 未实现且被显式指定时报错。
7. preferred protocol 未实现但 fallback 可用时成功并有 warning。
8. long_context profile 派生更宽松压缩配置。
9. high-risk stale profile 产生 warning，不阻断启动。
10. generic fallback 不猜测 thinking/cache/reasoning 字段。
11. `resolveContextBudgets()` 保证子预算总和不超过 effective budget。
12. `/m c 300k` 后 stable/working/evidence/conversation 子预算自动重算。
13. evidence 过大时先被裁剪，不挤占 stable pack。
14. adapter 正确使用 `max_completion_tokens`。
15. adapter 正确聚合 streaming tool arguments。
16. adapter 正确聚合 streaming reasoning_content。
17. assistantMessage 的 reasoning 字段经过 message pipeline 后仍保留。
18. `_turnIndex` 等内部字段仍被清理。
19. `/t 开|关|自|高|最强|默认` 能更新或清除对应 runtime override。
20. `/m c 300k` 能更新 context budget，并拒绝超过窗口的值。
21. protocol/tools/cache/reasoning 协议字段 mid-session override 被拒绝。
22. `/c 扫` 生成稳定 repo map。
23. `/c 加 <path>` pin 文件后进入 stable/working context pack。
24. `doc/todo.md` 不会被 stable context 自动装载。
25. stable pack 在文件未变化时 hash 保持不变。

### 集成测试

运行：

```bash
npx vitest run src/agent.test.ts
npx vitest run src/async-runs.test.ts src/tools/subagent.test.ts
npx vitest run src/cli-commands.test.ts
npm run typecheck
npm test
```

重点用例：

1. 主 Agent 使用 mock LLM 返回 reasoning_content + tool_calls，下一轮请求保留 reasoning_content。
2. SubAgent 复用同一 runtime policy。
3. Async Run subagent 不重新解析 provider。
4. Schedule 触发 Async Run 不改变 policy。
5. context compression 默认值随 profile 改变。
6. CLI 修改 thinking 后，下一轮主 Agent 请求使用新 policy。
7. 已启动 Async Run 不受之后 CLI policy 变更影响。
8. Stable context messages 插入到 history/current query 之前，evidence pack 靠近当前 query。

### Live smoke test（可选）

只有用户提供 key 或本机已有配置时运行。

Kimi K2.6：

```bash
LLM_PROVIDER=kimi_platform_cn \
LLM_MODEL=kimi-k2.6 \
MOONSHOT_API_KEY=... \
npm run dev
```

MiniMax M3 / DeepSeek / Qwen / MiMo / GLM：

- 实现前必须重新核对官方文档。
- smoke test 至少覆盖普通聊天和一次 tool call。
- thinking + tool call 模型必须覆盖第二轮回放。

## 验收标准

1. `agent.ts` 没有新增具体模型名或 provider 名分支。
2. `llm-providers.ts` 仍然只负责连接配置和 provider 级能力，不吞下全部模型策略。
3. 新增 `FoundationModelProfile` registry，能解释当前模型为什么采用某种 runtime policy。
4. `Config` 中能看到 resolved model profile 和 runtime policy。
5. 长上下文模型默认压缩阈值更宽松，但 P1/P0/P2 仍可用。
6. thinking/tool-call 模型能保留并回放 reasoning 字段。
7. streaming 聚合能同时处理 content、tool arguments、reasoning delta。
8. usage/cache telemetry 能被记录，字段缺失时安全降级。
9. SubAgent、Async Run、Schedule 共享同一策略。
10. `/m`、`/模型`、`/t`、`/思考` 能查询和调整 runtime policy，且中文短参数可用。
11. `/c`、`/上下文`、`/文` 能查询、扫描、pin/unpin 和调整 stable context。
12. Stable context pack 有 deterministic order 和 hash，动态 evidence 不污染 stable pack。
13. `doc/todo.md` 不会被自动装载。
14. Profile registry 有 freshness/status/source metadata，stale profile 有 warning。
15. Runtime CLI 明确拒绝 protocol/tools/cache/reasoning 的 mid-session override。
16. Context budget allocator 明确保证子预算总和不超过 effective budget，并按固定顺序裁剪。
17. 所有新增/修改文件通过 typecheck 和相关测试。
18. `doc/summary.md` 在实现完成后更新。

## 常见错误与防线

### 错误 1：把模型策略写进 system prompt

症状：

```text
If you are Kimi, preserve reasoning_content...
```

问题：

- 破坏 stable prefix。
- 把 runtime 协议责任推给 LLM。
- 模型可能照着描述输出无意义内容。

防线：

- 模型策略只在 profile/policy/adapter 中实现。
- system prompt 不出现 provider/model 特殊分支。

### 错误 2：在 agent.ts 里写模型分支

症状：

```ts
if (provider === "deepseek") ...
```

问题：

- 主循环被 provider 方言污染。
- 后续每加一个模型都要改核心循环。

防线：

- agent 只消费 `RuntimePolicy` 和统一 `LLMResponse`。
- provider-specific 字段只在 adapter 处理。

### 错误 3：只保存 content，丢掉 raw assistant

症状：

- 第一轮 tool call 成功。
- 第二轮请求 400。
- 或模型质量明显下降。

原因：

- `reasoning_content` / `reasoning_details` 被丢弃。

防线：

- `LLMResponse.assistantMessage` 是标准写 history 入口。
- message pipeline round-trip 测试保护 provider 字段。

### 错误 4：把官方 contextWindow 当成默认预算

症状：

- 1M 模型每轮都塞满 1M。
- 成本和延迟暴涨。
- 输出空间不足。

防线：

- 使用 `effectiveContextBudgetTokens`。
- 超长上下文需要 longContextThreshold。
- 工具大输出仍用 OutputStore。

### 错误 5：混淆本地 prefix hash 和真实 cache hit

症状：

- 日志显示 prefix stable，就声称 cache hit。

问题：

- 本地 hash 只能说明请求前缀稳定，不能证明 provider 真的命中 cache。

防线：

- `cache-debug.ts` 继续叫 local prefix debug。
- provider cache usage 从 response usage 读取。

## 后续扩展方向

PDD21 第一版完成后，可以继续拆后续 PDD：

1. **Anthropic Messages Adapter**
   - 支持 MiniMax M3 / Qwen3.7 / Kimi Code 的 Anthropic-compatible 入口。
   - 处理 content blocks、tool_use/tool_result、thinking blocks。

2. **Task Shape Classifier**
   - 根据用户请求和当前 session 状态判断 simple_chat / coding / long_horizon_agent / multimodal。
   - Policy resolver 可按 task shape 调整 thinking 与 context budget。

3. **多模型路由**
   - 主模型、cheap subagent、verifier、vision model 分开配置。
   - 这需要新的共享实例边界和 history 隔离设计。

4. **多模态 Tool Result**
   - 让工具结果支持 text/image/video blocks。
   - OutputStore 需要登记 content type 和可读 handle。

5. **成本感知调度**
   - 根据 prompt/cache/output usage 做预算提示。
   - 先观测，再决策，不要第一版就调度。

## 实现前检查清单

实现 PDD21 前，coding agent 必须：

1. 重新读取本文件。
2. 逐条提取 checklist。
3. 读取 `doc/summary.md`。
4. 读取 `doc/pdd1-2.md`。
5. 如果新增具体模型 profile，使用 Context7 或官方文档核对该模型最新 API 字段。
6. 先实现 profile/policy 测试，再改 `llm.ts`。
7. 每次遇到 provider 特殊字段，优先放 adapter，不要放 agent。
8. 实现后逐条回查本 PDD 的验收标准。
