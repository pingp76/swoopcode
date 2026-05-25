# PDD1-2: LLM Provider Profile 抽象层与 Kimi Code CN 接入设计

## 审阅结论

本阶段要增加的是一个 **简单的模型供应商抽象层**，不是完整的模型网关，也不是运行中动态切换模型系统。

当前项目的 `LLMClient` 已经足够薄：

```text
agent.ts
  -> llm.chat(messages, tools, cacheDebug)
  -> llm.ts
  -> OpenAI SDK chat.completions.create({ model, messages, tools })
```

因此本设计应保留这个教学友好的边界：

```text
LLM Provider Profile = 启动时把 provider id 解析成 apiKey/baseURL/model/能力标记
LLM Adapter = 在 llm.ts 边界处理 provider 兼容差异
Agent Loop = 不知道 provider 细节，只依赖 LLMClient.chat()
```

不要引入 LiteLLM、统一网关、成本统计、动态 fallback、负载均衡或运行中切换。那些能力更适合生产网关，但会把本项目的教学主线从“coding agent 内部如何工作”带到“模型平台如何运维”。

本次新增的主要目标是支持 **Kimi Code CN / Coding Plan**，同时让未来增加 DeepSeek、Qwen、豆包、普通 Moonshot Kimi 等 OpenAI-compatible 模型时，只需要新增一个 profile，而不是改主 Agent 循环。

## 背景

当前 `config.ts` 只读取三项模型配置：

```text
LLM_API_KEY
LLM_BASE_URL
LLM_MODEL
```

当前 `llm.ts` 直接用 OpenAI SDK：

```text
new OpenAI({ apiKey, baseURL })
client.chat.completions.create({ model, messages, tools })
```

这已经适合大多数 OpenAI-compatible API。但是随着支持更多国内模型，会出现三类问题：

1. 不同厂商的默认 `baseURL`、默认模型名、推荐 key 环境变量不同。
2. 有些厂商支持 `tools`，但部分高级参数不兼容，例如 `tool_choice=required`。
3. Kimi Code CN 这种面向第三方 coding agent 的接口，文档中要求使用特定 endpoint、模型名，并提示开启 legacy OpenAI API format 和 streaming。

如果继续把这些差异塞进 `.env` 和 `llm.ts` 注释里，后续 agent 很容易在实现其他厂商时复制粘贴出多套分支。PDD1-2 的目标是给出一个足够小但清晰的扩展点。

## 文档依据

本设计参考当前公开文档：

- Kimi API Tool Use：`https://platform.kimi.com/docs/api/tool-use`
- Kimi API Chat：`https://platform.kimi.com/docs/api/chat`
- Kimi OpenAI 迁移说明：`https://platform.kimi.com/docs/guide/migrating-from-openai-to-kimi`
- Kimi Code 第三方 Agent：`https://www.kimi.com/code/docs/en/more/third-party-agents.html`
- OpenAI Node SDK：`https://github.com/openai/openai-node`

当前文档显示：

1. 普通 Kimi / Moonshot API 可通过 OpenAI SDK + `https://api.moonshot.cn/v1` 调用 Chat Completions，并支持 `tools`。
2. 普通 Kimi API 示例模型包含 `kimi-k2.6`。
3. Kimi 迁移文档提示 `tool_choice=required` 兼容性需要特别处理，不能假设所有 OpenAI 参数都可直接透传。
4. Kimi Code 第三方 Agent 文档给 Roo Code 的配置是 `https://api.kimi.com/coding/v1`、模型 `kimi-for-coding`，并要求开启 legacy OpenAI API format 和 streaming。
5. Kimi Code 给 Claude Code 的配置是 `ANTHROPIC_BASE_URL=https://api.kimi.com/coding/`，这说明 coding plan 接口和普通 Moonshot 开放平台接口不是同一个概念。

后续实现前应再次核对这些文档，因为模型名、endpoint 和兼容要求可能变化。

## 设计目标

1. 增加 `LLM_PROVIDER` 配置，表示当前进程启动时使用哪个 provider profile。
2. 保留 `LLM_API_KEY`、`LLM_BASE_URL`、`LLM_MODEL` 作为通用覆盖项，兼容现有使用方式。
3. 新增一个集中 profile 表，声明 provider 的默认 endpoint、默认模型名、key 环境变量和能力标记。
4. `llm.ts` 继续导出同一个 `LLMClient` 接口，Agent、SubAgent、Async Run 不感知 provider 差异。
5. 支持 Kimi Code CN profile，默认使用 `https://api.kimi.com/coding/v1` 和 `kimi-for-coding`。
6. 支持普通 Kimi / Moonshot CN profile，默认使用 `https://api.moonshot.cn/v1` 和当前 Kimi API 文档示例模型。
7. provider 兼容差异只在 `config.ts` / 新增 resolver / `llm.ts` 边界处理。
8. 保持 prompt cache 友好：provider 切换只发生在进程启动时，不在同一 session 中修改 system prompt 或 tool definitions。
9. 增加测试覆盖，确保 profile 解析、环境变量覆盖、Kimi Code streaming 标记和工具调用兼容行为不会漂移。

## 非目标

1. 不实现运行中 `/model switch`。
2. 不实现同一轮请求的多模型 fallback。
3. 不实现 LiteLLM 或其他外部网关。
4. 不实现成本统计、额度管理、provider 健康检查或路由策略。
5. 不把 provider 差异写进 `agent.ts`。
6. 不为 Kimi 单独改写 system prompt、工具描述或权限规则。
7. 不在 repo 中保存 API key。
8. 不把 Kimi Code 的 Anthropic-compatible Claude Code 路径作为第一版目标；第一版只走 OpenAI-compatible / legacy OpenAI format 路径。

## 核心术语

```text
Provider Profile
  一个静态配置项，描述某个厂商或某个兼容入口的默认连接方式和能力。

Resolved LLM Config
  启动时由 profile + env override 解析得到的最终配置。

LLM Adapter
  llm.ts 内部的兼容层，把统一的 LLMClient.chat() 调用转换成某个 provider 能接受的请求。

Protocol
  当前第一版只支持 openai-chat-completions。未来如果真的要支持 Anthropic 原生消息格式，再新增 protocol。
```

## Provider ID 设计

建议第一版支持这些 provider id：

```ts
export type LLMProviderId =
  | "openai_compatible"
  | "minimax_cn"
  | "kimi_platform_cn"
  | "kimi_code_cn";
```

含义：

| Provider ID         | 用途                                             | 默认 baseURL                     | 默认模型                               | 默认 key env                                 |
| ------------------- | ------------------------------------------------ | -------------------------------- | -------------------------------------- | -------------------------------------------- |
| `openai_compatible` | 完全自定义的 OpenAI-compatible 入口              | 无，必须由 `LLM_BASE_URL` 提供   | 无，必须由 `LLM_MODEL` 提供            | `LLM_API_KEY`                                |
| `minimax_cn`        | 当前项目已有 MiniMax CN 使用习惯的命名化 profile | `https://api.minimaxi.com/v1`    | 以实现时验证的 MiniMax chat model 为准 | `MINIMAX_CN_API_KEY`，fallback `LLM_API_KEY` |
| `kimi_platform_cn`  | 普通 Moonshot / Kimi 开放平台                    | `https://api.moonshot.cn/v1`     | `kimi-k2.6`，实现时再次核对            | `MOONSHOT_API_KEY`，fallback `LLM_API_KEY`   |
| `kimi_code_cn`      | Kimi Code CN / Coding Plan 第三方 agent 入口     | `https://api.kimi.com/coding/v1` | `kimi-for-coding`                      | `KIMI_CODE_API_KEY`，fallback `LLM_API_KEY`  |

`openai_compatible` 是逃生口，方便用户继续手动指定任何 OpenAI-compatible 服务。

## 配置解析规则

新增配置项：

```text
LLM_PROVIDER=kimi_code_cn
```

保留现有配置项：

```text
LLM_API_KEY=...
LLM_BASE_URL=...
LLM_MODEL=...
```

新增 provider 专用 key：

```text
KIMI_CODE_API_KEY=...
MOONSHOT_API_KEY=...
MINIMAX_CN_API_KEY=...
```

解析优先级：

```text
apiKey:
  1. LLM_API_KEY
  2. profile.apiKeyEnvNames 按顺序读取
  3. 缺失则报错，错误信息同时提示 LLM_PROVIDER 和候选 key env

baseURL:
  1. LLM_BASE_URL
  2. profile.defaultBaseURL
  3. 缺失则报错

model:
  1. LLM_MODEL
  2. profile.defaultModel
  3. 缺失则报错

provider:
  1. LLM_PROVIDER
  2. 默认 openai_compatible
```

这个优先级让老用户可以完全不理解 provider profile，只继续用三项通用变量；同时让新用户可以写更短的 Kimi Code 配置：

```env
LLM_PROVIDER=kimi_code_cn
KIMI_CODE_API_KEY=sk-kimi-...
```

如果用户显式写了：

```env
LLM_PROVIDER=kimi_code_cn
LLM_BASE_URL=https://some-proxy.example.com/v1
LLM_MODEL=my-kimi-alias
LLM_API_KEY=...
```

则应使用显式覆盖值。这样可以兼容公司内网代理或用户自建网关。

## 新增模块

### `src/llm-providers.ts`

新增一个集中 profile registry。建议类型如下：

```ts
export type LLMProviderId =
  | "openai_compatible"
  | "minimax_cn"
  | "kimi_platform_cn"
  | "kimi_code_cn";

export interface LLMProviderCapabilities {
  supportsTools: boolean;
  supportsToolChoiceRequired: boolean;
  prefersStreaming: boolean;
  supportsThinking: boolean;
}

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

export interface ResolvedLLMConfig {
  provider: LLMProviderId;
  displayName: string;
  apiKey: string;
  baseURL: string;
  model: string;
  capabilities: LLMProviderCapabilities;
}
```

导出函数：

```ts
export function resolveLLMProviderConfig(
  env?: NodeJS.ProcessEnv,
): ResolvedLLMConfig;
export function getLLMProviderProfile(id: string): LLMProviderProfile;
```

实现原则：

1. registry 是普通对象或 `Map`，启动后不变。
2. resolver 只读 env，不做网络请求。
3. 不把 apiKey 写进错误日志或普通日志。
4. provider id 不认识时，错误信息列出合法 id。
5. `openai_compatible` 没有默认 baseURL/model，迫使用户显式配置，避免误连。

### Profile 建议值

```ts
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
      // 官方文档提到 legacy OpenAI format；当前 OpenAI SDK
      // tools/tool_calls 路径已实测可用。
      supportsThinking: false,
    },
  },
};
```

注意：`defaultModel` 是实现时的当前默认建议，不应被写死成永远正确。实现 agent 应在编码前重新查 Kimi Code 文档。

## 修改 `src/config.ts`

`Config` 增加字段：

```ts
interface Config {
  provider: LLMProviderId;
  providerDisplayName: string;
  apiKey: string;
  baseURL: string;
  model: string;
  llmCapabilities: LLMProviderCapabilities;
  logLevel: string;
  compression: CompressionConfig;
}
```

`loadConfig()` 改为：

```text
1. 调用 resolveLLMProviderConfig(process.env)
2. 将解析结果展开到 Config
3. 保留原 compression / logLevel 逻辑
```

错误信息从：

```text
Missing required environment variable: LLM_API_KEY
```

升级为：

```text
Missing LLM API key for provider "kimi_code_cn".
Set one of: LLM_API_KEY, KIMI_CODE_API_KEY.
```

`recovery.ts` 中认证错误提示也应同步更新，不再只提示旧三项变量，而是提示检查 `LLM_PROVIDER`、API key、baseURL 和模型名。

## 修改 `src/llm.ts`

`createLLMClient()` 仍然只返回 `LLMClient`，但参数改为接收 `ResolvedLLMConfig` 或等价字段：

```ts
export function createLLMClient(
  config: ResolvedLLMConfig,
  llmLogger?: LLMLogger,
): LLMClient;
```

请求构造规则：

1. 基础参数仍是 `model`、`messages`。
2. 只有 `tools.length > 0` 时才传 `tools`。
3. 第一版不要传 `tool_choice`，因为 Kimi 兼容性存在差异，当前 Agent 也没有依赖强制 tool choice。
4. 不要把 `thinking` 默认打开。普通 Kimi Platform 支持 thinking，不代表所有 provider 或所有模型都适合默认启用。
5. 如果 `capabilities.prefersStreaming === false`，继续使用现有 non-streaming 路径。
6. 如果 `capabilities.prefersStreaming === true`，优先实现 streaming 聚合路径：
   - 请求参数增加 `stream: true`
   - 遍历 stream chunks
   - 聚合文本 delta
   - 聚合 tool_calls delta
   - 最终转换成现有 `LLMResponse`

Kimi Code CN 的 streaming 要求应被隐藏在 `llm.ts` 内。`agent.ts` 不应该知道当前请求是 streaming 还是 non-streaming。

### Streaming 聚合边界

如果 OpenAI SDK streaming chunk 的 tool call delta 聚合在第一版实现成本过高，允许采用两步策略：

1. 先对 `kimi_code_cn` 做 live smoke test，确认 non-streaming 是否也可用。
2. 如果 non-streaming 可用，第一版可以只设置 `prefersStreaming: false`，并在 profile 注释中保留文档提示。
3. 如果 non-streaming 不可用，则必须实现 streaming 聚合后再标记完成。

不要提交一个“标记 prefersStreaming=true 但 llm.ts 忽略它”的实现。

## 修改 `src/index.ts`

启动日志从：

```text
Agent started (model: MiniMax-M2.7)
```

改为：

```text
Agent started (provider: kimi_code_cn, model: kimi-for-coding)
```

`SessionManager.createMainSession()` 的 `model` 字段可以继续保存 `config.model`，但建议 title 或日志中包含 provider。若要最小改动，只改启动日志即可。

## 子智能体与 Async Run

SubAgent 和 Async Run 复用父级注入的 `llm` 实例。实现时不得在以下位置重新解析 provider 或重新创建 LLM client：

1. `src/tools/subagent.ts`
2. `src/async-runs.ts`
3. `src/tools/async-runs.ts`

这是为了保证“共享实例真的共享”。provider 是进程启动级配置，不是每个子智能体自行决定。

## Prompt Cache 与工具定义

Provider profile 不应进入 system prompt，也不应改变 tool definitions。

原因：

1. provider 信息是运行配置，不是任务语义。
2. 同一进程内工具列表应保持稳定，避免破坏当前已有的 cache-ready 请求布局。
3. Kimi、MiniMax、DeepSeek 等 provider 是否更擅长某种表达，不应该通过动态 system prompt 分支解决。

如果某 provider 需要特殊提示才能更稳定地调用工具，应先通过 tool description 的通用表达修正，而不是写：

```text
If provider is Kimi, do X.
```

## Kimi Code CN 接入策略

Kimi Code CN profile 的默认配置：

```env
LLM_PROVIDER=kimi_code_cn
KIMI_CODE_API_KEY=sk-kimi-...
```

解析后得到：

```text
provider = kimi_code_cn
baseURL  = https://api.kimi.com/coding/v1
model    = kimi-for-coding
```

实现 agent 必须验证：

1. 不带 tools 的普通聊天是否返回 `choices[0].message.content`。
2. 带 tools 的请求是否返回 OpenAI-compatible `tool_calls`。
3. tool call 的 `id`、`function.name`、`function.arguments` 是否和当前 `agent.ts` 工具执行逻辑兼容。
4. 如果 Kimi Code 只支持 streaming，streaming 聚合后的结果是否仍能产生当前 `LLMResponse`。
5. 如果 Kimi Code 返回的是 legacy OpenAI 格式，与当前 `openai` SDK 类型是否需要窄化或类型断言。

Kimi Code profile 完成的标准不是“请求能返回一句话”，而是“能完成至少一次工具调用闭环”：

```text
user query
  -> model returns tool_calls
  -> agent executes run_bash or run_read
  -> tool result appended
  -> model returns final content
```

## 普通 Kimi Platform CN 接入策略

普通 Kimi Platform CN profile 的默认配置：

```env
LLM_PROVIDER=kimi_platform_cn
MOONSHOT_API_KEY=...
```

解析后得到：

```text
provider = kimi_platform_cn
baseURL  = https://api.moonshot.cn/v1
model    = kimi-k2.6
```

该 profile 用于 Moonshot 开放平台，不等同于 Kimi Code Coding Plan。两者 key 来源、endpoint、模型名和产品语义都不同。

不要把 `MOONSHOT_API_KEY` 和 `KIMI_CODE_API_KEY` 混用成同一个默认名。允许 `LLM_API_KEY` 作为覆盖项，但 provider 专用 key 名要保留清晰边界。

## 测试计划

### 单元测试

新增 `src/llm-providers.test.ts`：

1. 默认 provider 是 `openai_compatible`。
2. `openai_compatible` 缺少 `LLM_BASE_URL` 或 `LLM_MODEL` 时失败。
3. `kimi_code_cn` 只设置 `KIMI_CODE_API_KEY` 时可解析成功。
4. `kimi_code_cn` 的默认 baseURL 是 `https://api.kimi.com/coding/v1`。
5. `kimi_code_cn` 的默认模型是 `kimi-for-coding`。
6. `LLM_API_KEY` 优先于 provider 专用 key。
7. `LLM_BASE_URL` 优先于 provider 默认 baseURL。
8. `LLM_MODEL` 优先于 provider 默认模型。
9. 未知 provider 报错，并列出合法 provider id。
10. `kimi_code_cn.capabilities.prefersStreaming` 与文档验证结论一致。

更新或新增 `src/config.test.ts`：

1. `loadConfig()` 能把 resolved provider 字段写入 Config。
2. compression 和 logLevel 默认值不受 provider 变更影响。
3. 认证错误信息不泄漏 key 值。

如实现 streaming 聚合，新增 `src/llm.test.ts`：

1. non-streaming 路径仍调用 `chat.completions.create()` 一次并解析 content/tool_calls。
2. streaming 路径能聚合多段 content。
3. streaming 路径能聚合 tool_calls arguments 分片。
4. streaming 结束后调用 `llmLogger.logResponse()`。

### Live smoke test

在有真实 key 的本地环境手动验证：

```bash
LLM_PROVIDER=kimi_code_cn KIMI_CODE_API_KEY=... npm run dev
```

测试提示词：

```text
请读取 package.json，告诉我项目名和 test 命令。只允许使用 run_read，不要修改文件。
```

通过标准：

1. 模型选择 `run_read`。
2. 工具执行成功。
3. 模型基于工具结果回答。
4. `llm.log` 中能看到完整请求和响应，但没有 API key。

## 实现清单

1. 新增 `src/llm-providers.ts`，实现 provider profile registry 和 resolver。
2. 新增 `src/llm-providers.test.ts`，覆盖解析规则。
3. 修改 `src/config.ts`，从 resolver 构造 Config。
4. 新增或修改 `src/config.test.ts`，覆盖 provider 字段和错误信息。
5. 修改 `src/llm.ts` 注释，将 MiniMax 专属表述改为 provider-neutral。
6. 修改 `src/llm.ts`，接收 resolved config 和 capabilities。
7. 根据 Kimi Code live 验证结果，决定是否实现 streaming 聚合。
8. 如实现 streaming，新增 `src/llm.test.ts` 覆盖聚合逻辑。
9. 修改 `src/recovery.ts` 的认证错误提示。
10. 修改 `src/index.ts` 启动日志，显示 provider 和 model。
11. 更新 `doc/summary.md`，说明 LLM 客户端已从单一 baseURL 配置升级为 provider profile 抽象。
12. 运行验证：
    - `npm run typecheck`
    - `npx vitest run src/llm-providers.test.ts`
    - `npx vitest run src/config.test.ts`，如果存在
    - `npx vitest run src/llm.test.ts`，如果新增
    - `npm test`，因为配置和 LLM 边界是共享路径
    - `npx eslint src/llm-providers.ts src/config.ts src/llm.ts src/recovery.ts src/index.ts`

## 风险与防线

### 风险 1：把 Kimi Code 和普通 Moonshot Kimi 混为一谈

防线：

1. 使用不同 provider id。
2. 使用不同 key env。
3. 文档和测试分别覆盖 `kimi_code_cn` 与 `kimi_platform_cn`。

### 风险 2：Provider 差异泄漏到 Agent 主循环

防线：

1. `agent.ts` 不新增 provider 分支。
2. `LLMClient.chat()` 接口不变。
3. streaming 聚合在 `llm.ts` 内部完成。

### 风险 3：为了 Kimi 特殊行为修改 system prompt

防线：

1. PDD1-2 明确 provider profile 不进入 system prompt。
2. 工具选择能力通过通用 tool description 和测试验证。
3. provider-specific prompt workaround 必须另开 PDD，不在本阶段顺手做。

### 风险 4：默认模型名过期

防线：

1. profile 默认值只作为当前实现建议。
2. 实现前必须重新查官方文档。
3. 用户可通过 `LLM_MODEL` 覆盖默认值。

### 风险 5：Kimi Code streaming 聚合不完整

防线：

1. 不允许忽略 `prefersStreaming`。
2. tool_calls 分片必须有测试。
3. live smoke test 必须跑完整工具调用闭环。

## 后续扩展方式

未来新增一个 OpenAI-compatible provider 时，只需要：

1. 在 `LLMProviderId` 中加一个 id。
2. 在 registry 中加一个 profile。
3. 为默认 baseURL、默认模型、key env 和 capabilities 加测试。
4. 如果它的响应结构仍是标准 OpenAI-compatible，不改 `agent.ts`，也不改工具系统。

只有当 provider 不是 OpenAI-compatible，或者它的 tool call 格式不是 `tool_calls[].function.arguments` JSON 字符串时，才需要新增 protocol 或 adapter。

## 给实现 agent 的注意事项

1. 先实现 `llm-providers.ts` 和解析测试，再改 `config.ts`。
2. 不要一开始就重构 `agent.ts`。
3. 不要删除旧的 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` 支持。
4. 不要把真实 API key 写进测试 fixture、日志或文档。
5. live smoke test 如果没有真实 key，可以跳过，但最终报告必须明确“未进行真实 Kimi Code 请求验证”。
6. 如果 repo-wide lint 有旧问题，至少保证本次改动文件 lint clean。
