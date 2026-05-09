# Future TODO

本文件记录已经讨论过、但当前阶段没有实现的后续功能。它只作为未来选题池，不代表当前任务范围。

## Prompt Cache 后续优化

### 完整 cache-safe subagent fork

当前子智能体只完成了 Phase A：复用父级 stable system prompt。未来可以继续实现 Phase B：

- 父 Agent 在每次 LLM 调用前保存 `AgentForkContext`，包含最终 messages 和稳定 tools。
- 子智能体基于父级 fork context 追加子任务消息，而不是只创建空 history。
- 子智能体使用与父级一致的工具定义，避免工具前缀变化。
- 能力限制放在执行层，而不是通过删除工具定义实现。

### ToolExecutionPolicy 执行策略层

为了让不同运行场景保持工具定义稳定，同时限制实际能力，可以新增 `ToolExecutionPolicy`：

- 子智能体禁止执行 `run_subagent`，避免递归。
- 子智能体禁止执行 `run_memory_create` 和 `run_memory_delete`，避免长期记忆写入失控。
- plan/auto/default mode 继续通过权限层限制实际执行。
- 工具 schema 不因 mode 或 subagent 场景动态变化。

### `/prompt refresh` 命令

当前 system prompt snapshot 在会话启动时固定。未来可以新增显式刷新命令：

```text
/prompt refresh
```

预期行为：

- 调用 `systemPromptProvider.refreshSnapshot()`。
- 更新 `history.setSystemPrompt()`。
- 在终端明确提示：刷新 snapshot 会破坏当前会话后续 prompt cache 前缀。

### 真实 prompt cache usage 解析

当前 `cache-debug.ts` 只记录本地 hash 稳定性，不声称是真实 cache hit rate。未来如果底层模型 API 返回缓存 usage，可以在 `llm.ts` / `llm-logger.ts` 中兼容解析：

- `usage.prompt_tokens_details.cached_tokens`
- `usage.cache_read_input_tokens`
- `usage.cache_creation_input_tokens`

要求：

- 字段必须按 provider 可选处理。
- 没有 usage 字段时不能伪造命中率。
- 日志中区分“本地 prefix 稳定性”和“服务端真实 cache usage”。

### Cache debug 配置项

PDD10 中设计过可选配置，但当前实现主要通过日志固定记录。未来可以补：

| 变量 | 默认值 | 含义 |
|------|--------|------|
| `CACHE_DEBUG` | `true` | 是否记录 cache debug hash |
| `CACHE_DEBUG_PRINT` | `false` | 是否在终端每轮显示 cache debug 简报 |

终端显示示例：

```text
[cache] prefix stable, tools stable, system stable
```

### Reminder 主流程集成测试

当前已有 `session-events`、`system-prompt`、`cache-debug` 等单元测试。未来建议补更硬的 Agent 集成测试：

- `sessionEventBuffer.push()` 后，下一轮 LLM messages 包含 `<system-reminder>`。
- reminder 被 `drain()` 一次性消费，下一轮不重复注入。
- “本轮不要使用 memory”通过 reminder 注入，并且 system prompt hash 不变。
- reminder 不破坏 tool_call/tool_result 配对。

### LLM compaction cache-safe fork

当前 P2 压缩是本地规则摘要，不额外调用 LLM。未来如果改成 LLM 摘要，必须保持 cache-safe fork：

- 使用同一个 stable system prompt。
- 使用同一个稳定工具定义。
- 复用父级历史前缀。
- 只在末尾追加 compaction instruction。
- 预留 compaction buffer，不能等上下文完全满了才压缩。

### 更细粒度 prefix 观测

当前 stable prefix hash 定义为 system prompt + tools。未来可以新增更多教学观测指标：

- `sessionSnapshotHash`
- `firstUserContextHash`
- `recentHistoryHash`
- `toolSchemaHash`

这些指标只用于诊断，不参与业务逻辑。

### Skill 和 Memory snapshot 管理体验

当前 Skill/Memory 变更后通过 reminder 告诉模型，stable prompt snapshot 不自动刷新。未来可以补更完整的用户体验：

- `/prompt show`：查看当前 stable system prompt snapshot 摘要。
- `/prompt diff`：比较当前 snapshot 和最新 Skill/Memory 本地状态。
- `/memory reload --refresh-prompt`：显式选择刷新 prompt，终端提示 cache 代价。

### Deferred tools / 按需工具定义

当前工具数量较少，保持全量稳定工具定义更适合教学。未来工具数量明显增长后，可以研究 deferred tools：

- 保持核心工具定义稳定。
- 大型或低频工具通过稳定的 loader 工具按需发现。
- 避免在会话中途直接增删 tools 数组。

## Memory 后续优化

### 用户级 memory 存储目录

PDD9 当前为了教学直观，把 memory 默认放在 Agent 源码仓库下的 `memory/`，并通过 `.gitignore` 避免提交。未来如果要更接近真实全局用户记忆，可以迁移到用户 home 或应用数据目录：

- 默认目录改为 `~/.learn-claude-code/memory/` 或平台应用数据目录。
- 保留 `MEMORY_DIR` 覆盖能力，支持教学仓库目录和用户级目录两种模式。
- 启动时打印当前 memoryDir，避免用户误以为 memory 在业务项目目录下。
- 提供一次性迁移提示或迁移命令，把旧的 `agentRoot/memory/` 移到新目录。

### `/memory add` 交互式命令

当前 CLI 已有 `/memory list`、`/memory show`、`/memory remove`、`/memory reload`，但 PDD9 明确把 `/memory add` 放到了未来范围。后续可以补一个教学版交互式新增命令：

- 命令形式：`/memory add <name> <type> <description>`。
- 进入多行正文输入模式，用户结束输入后再写入。
- 写入前复用现有 name、type、frontmatter 单行字段、疑似重复校验。
- 写入成功后重建 `MEMORY.md`，并推送 session reminder。
- 终端提示 stable system prompt snapshot 不会自动刷新。

### 自动候选记忆提示

PDD9 设计了“自动触发只产生候选记忆，最终写入仍需用户确认”。当前主要依赖工具描述约束 LLM 行为，未来可以补更显式的候选流程：

- 在 Agent 主循环或 Hook 中识别长期偏好、长期纠正、固定外部资源等候选信息。
- 只向用户提出候选，不自动调用 `run_memory_create`。
- 用户确认后才写入 memory。
- 候选提示必须包含建议的 `name`、`type`、`description` 和正文草案。
- 候选被拒绝时不落盘，也不在后续轮次反复询问。

### Memory Hook 观察点

PDD9 提到 Hook 可以作为未来扩展点。后续可以增加轻量 Hook 集成，但仍不通过 Hook 自动无确认写 memory：

- `SessionStart`：记录 memory 加载数量、无效 memory 文件数量。
- `PostToolUse`：观察长期候选信息，例如用户纠正、固定外部链接、稳定项目约定。
- Hook 只负责生成候选或日志，不绕过权限层和用户确认。
- Hook 注入消息必须延迟到 tool_result 配对之后，沿用现有 Hook 安全规则。

### 子智能体只读 memory 工具

PDD9 的原始设想是子智能体可以读取 memory，但写入和删除因没有用户确认回调而降级为 deny。当前实现更保守：子智能体复用父级 stable system prompt 快照，但不注册 memory 工具。未来可以补成只读能力：

- 子智能体工具注册表包含 `run_memory_list` 和 `run_memory_read`。
- 子智能体不注册或执行层拒绝 `run_memory_create`、`run_memory_delete`。
- 工具定义稳定性优先，若与 Prompt Cache 设计冲突，使用执行策略层限制能力。
- 测试覆盖子智能体能读 memory 摘要和正文，但不能污染长期记忆。

### Memory 管理体验增强

当前 memory 是普通 Markdown 文件，适合教学和调试。未来可以补更完整的用户体验：

- `/memory edit <name>`：用安全的交互流程修改 description、type 或 body。
- `/memory validate`：扫描并报告无效 frontmatter、文件名不匹配、重复或疑似重复 memory。
- `/memory prune`：列出可能过期或重复的 memory，由用户逐条确认删除。
- `/memory export` / `/memory import`：用于迁移或备份，但默认不包含敏感信息。

### 更强的敏感信息过滤

PDD9 要求不保存密码、密钥、token、cookie、私钥、个人身份敏感信息。当前主要靠工具描述和用户确认约束，未来可以补教学版规则过滤：

- 写入前用正则拦截常见 API key、token、私钥块、cookie 字段。
- 对疑似个人身份信息给出二次确认提示。
- 拒绝把 `.env`、日志中的密钥片段写入 memory。
- 测试覆盖敏感内容被拒绝或要求显式确认的路径。
