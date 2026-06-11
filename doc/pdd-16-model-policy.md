# PDD-16: 模型适配、Provider Profile 与 Runtime Policy

## 对应教程

专题 A：不同大模型不是只换模型名。

## 设计目的

不同模型和 provider 的差异不只在 `model` 字符串。工具调用、并行 tool call、reasoning/thinking 参数、context window、cache telemetry、streaming delta 格式都会影响 Agent 行为。

本 PDD 合并旧版 Provider Profile 工作稿，以及后续 Foundation Model Profile / Runtime Policy 设计。

## 当前实现

核心源码：

| 文件                          | 职责                                                |
| ----------------------------- | --------------------------------------------------- |
| `src/llm-providers.ts`        | Provider Profile registry 与解析                    |
| `src/foundation-models.ts`    | 基座模型能力画像                                    |
| `src/runtime-policy.ts`       | profile -> runtime policy 解析                      |
| `src/runtime-policy-store.ts` | session-local policy override                       |
| `src/context-budget.ts`       | 按 policy 分配上下文预算                            |
| `src/llm-adapter.ts`          | OpenAI Chat Completions 请求构建与响应解析          |
| `src/stable-context.ts`       | stable context pack                                 |
| `src/context-ranking.ts`      | RepoClassifier、TaskIntentClassifier、ContextRanker |
| `src/config.ts`               | provider/model/policy 环境变量解析                  |
| `src/cli-commands.ts`         | `/m`、`/t` 等短命令                                 |

## 分层设计

| 层                       | 负责什么                                      | 不负责什么            |
| ------------------------ | --------------------------------------------- | --------------------- |
| Provider Profile         | baseURL、API key env、OpenAI-compatible 方言  | 不决定任务策略        |
| Foundation Model Profile | context window、tool/reasoning/cache 能力事实 | 不直接修改 prompt     |
| Runtime Policy           | 根据能力事实和用户 override 做运行决策        | 不重新实现 agent loop |
| LLM Adapter              | 把统一请求翻译成当前 provider 请求            | 不承担业务流程        |

## 当前 Provider Profile

当前实现支持 OpenAI-compatible 风格 provider profile，包括 Kimi Code CN、Kimi Platform CN、MiniMax CN 等。具体默认模型名可能随 provider 更新而变化，因此 profile 默认值只作为当前实现建议，不能当作长期事实。

## Runtime Policy 当前能力

Runtime Policy 控制：

- context budget。
- compression threshold。
- reasoning effort / thinking budget。
- tool call 策略。
- streaming 偏好。
- cache telemetry 记录边界。
- SubAgent / Async Run / Schedule 的 policy snapshot。

Policy 变更是 session-local override，不 retroactively 改写已启动 Async Run 或已经 fork 的 child agent。

## Stable Context 与 Ranking

模型适配阶段后新增稳定上下文装载：

- repo map。
- pinned files。
- stable pack。
- working set pack。
- evidence pack。

`ContextRanker` 不是固定惩罚测试文件，而是根据 task intent 动态调整。比如 debug/testing 场景下，测试文件可能比 README 更重要。

## 测试入口

- `src/llm-providers.test.ts`
- `src/foundation-models.test.ts`
- `src/runtime-policy.test.ts`
- `src/runtime-policy-store.test.ts`
- `src/context-budget.test.ts`
- `src/llm-adapter.test.ts`
- `src/stable-context.test.ts`
- `src/context-ranking.test.ts`
- `src/config.test.ts`

## 常见错误

1. 在 `agent.ts` 里写 provider 分支。
2. 通过 prompt hack 处理模型能力差异。
3. 只保存 assistant `content`，丢掉 reasoning/tool_calls 等 provider 字段。
4. 把官方最大 context window 当作默认可用预算。
5. 混淆本地 prefix hash 和真实 provider cache telemetry。

## 非目标

当前项目不实现多模型路由、自动 fallback、投票、ensemble、完整成本账单系统或 LiteLLM/OpenRouter 等外部网关。
