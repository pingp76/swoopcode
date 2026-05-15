# 项目状态总览

这是 learning-claude-code-ts 项目的持久化状态文档。每次新增功能模块后更新此文件。

## 项目简介

教学用途的 TypeScript Coding Agent，递进式构建，每一步都能独立运行。

GitHub: https://github.com/pingp76/learning-claude-code-ts

## 当前状态

**已完成阶段**: 基础 REPL + LLM 对话 + bash 工具调用 + 文件操作工具 + 消息标准化 + TODO 任务管理 + 子智能体（SubAgent）+ Skill（技能）系统 + LLM 通信日志 + 上下文压缩 + 权限管理 + Hook 机制 + Memory（长期记忆）+ **Prompt Cache 友好的请求布局** + LLM 错误恢复 + ProjectContext + Session/Transcript 原始事件流 + 持久化 Task 任务系统

## 源码结构

```
src/
├── index.ts            # 组装根（Composition Root）：组件初始化和接线
├── repl.ts             # REPL 交互层：readline 循环 + Agent/命令分发
├── cli-commands.ts     # CLI 命令注册与分发（/skill、/mode 等斜杠命令）
├── config.ts           # 从 .env 加载配置（含压缩配置）
├── project-context.ts  # 项目上下文：集中解析 projectRoot、AGENTS.md、agentHome 与运行数据路径
├── logger.ts           # 分级日志（debug/info/warn/error）+ util.format 占位符替换
├── llm.ts              # LLM 客户端（OpenAI SDK + MiniMax baseURL）+ LLM 日志记录
├── llm-logger.ts       # LLM 通信日志：完整记录请求/响应到 logs/llm.log，超 1MB 清空重写
├── normalize.ts        # 消息标准化：过滤元数据、补全 tool_result、合并同角色消息
├── history.ts          # 对话历史管理（messages + rounds 统一存储 + HistoryEntry + system prompt 支持）
├── message-block.ts    # 消息块：压缩的原子单位，groupToBlocks/flattenToMessages + token 估算
├── compressor.ts       # 上下文压缩器：三层压缩（衰减 + 即时 + 全量）+ compressibleTools 配置
├── agent.ts            # Agent 主循环：think → act → observe + 内部步骤函数 + 权限检查拦截
├── todo.ts             # TODO 管理器：session 级别任务列表（工厂函数 + 6 个工具）
├── skills.ts           # Skill 管理器：按需加载的 prompt 扩展（scan/invoke/remove）+ SkillToolProvider
├── permission.ts       # 权限管理器：三种模式（plan/auto/default）+ 黑白名单 + 路径边界 + ask 降级
├── hooks.ts            # Hook 系统：轻量进程内 Hook（SessionStart / PreToolUse / PostToolUse）+ HookRunner 工厂
├── memory.ts           # Memory 管理器：跨会话长期记忆（scan/list/read/create/delete/buildPromptSection）
├── system-prompt.ts    # System Prompt 组合器：稳定 snapshot + turn reminder（cache-ready）
├── session-events.ts   # 会话事件缓冲区：收集 out-of-band 状态变化，注入为 system-reminder
├── session.ts          # Session 管理器：main/subagent sessionId + parentSessionId + 项目元信息
├── transcript.ts       # Transcript 原始事件流：append-only 记录 user/assistant/tool/reminder/recovery 事件
├── task-store.ts       # 持久化 Task 存储层：groups/<group_id>/group.json + project 索引 + 读写校验
├── tasks.ts            # Task 业务层：Task Group 状态机、依赖校验、activeTaskGroupId、格式化输出
├── cache-debug.ts      # Prompt Cache 调试：system/tools/prefix hash + 稳定性追踪
├── recovery.ts         # LLM 错误分类与恢复决策：backoff/compact/continue/fail
├── terminal.ts         # 终端输入输出封装：共享 readline（REPL + 权限确认共用）
├── debug-e2e.ts        # 端到端调试脚本（Skill+TODO+SubAgent 协作验证）
├── message-block.test.ts # 消息块测试（24 个测试用例）
├── compressor.test.ts    # 压缩器测试（21 个测试用例）
├── permission.test.ts   # 权限管理器测试（47 个测试用例）
├── hooks.test.ts        # Hook Runner 单元测试（11 个测试用例）
├── agent.test.ts        # Agent Hook 集成测试（7 个测试用例）
├── memory.test.ts       # Memory 管理器测试（40 个测试用例）
├── todo.test.ts        # TODO 管理器测试（33 个测试用例）
├── skills.test.ts      # Skill 管理器测试（25 个测试用例）
├── normalize.test.ts   # 消息标准化测试
├── system-prompt.test.ts # System Prompt 测试（17 个测试用例）
├── session-events.test.ts # Session Event Buffer 测试（5 个测试用例）
├── cache-debug.test.ts  # Cache Debug 测试（7 个测试用例）
├── project-context.test.ts # ProjectContext 路径派生测试
├── recovery.test.ts    # LLM 错误恢复决策测试
├── session.test.ts     # Session 管理器测试
├── transcript.test.ts  # Transcript 原始事件流测试
├── task-store.test.ts  # TaskStore 持久化、索引和清理测试
├── tasks.test.ts       # TaskManager 状态机和依赖测试
├── cli-commands.test.ts # CLI 命令测试（含 /task）
├── index.test.ts       # 占位测试
├── history.test.ts     # history 模块测试（13 个测试用例）
├── logger.test.ts      # logger 模块测试
└── tools/
    ├── types.ts        # 共享类型：ToolResult 接口
    ├── bash.ts         # bash 工具：执行 shell 命令 + 危险命令过滤（工具名: run_bash）
    ├── bash.test.ts    # bash 工具测试
    ├── files.ts        # 文件操作工具：run_read、run_write、run_edit（限工作目录）
    ├── files.test.ts   # 文件操作工具测试
    ├── subagent.ts     # 子智能体工具：run_subagent（复用父级 stable prompt + 独立上下文）
    ├── subagent.test.ts # 子智能体工具测试（13 个测试用例）
    ├── memory.ts       # Memory 工具提供者：run_memory_create/list/read/delete（4 个工具）
    ├── memory.test.ts  # Memory 工具测试（2 个测试用例）
    ├── tasks.ts        # Task 工具提供者：run_task_group_create/list/read + run_task_add/update/delete
    ├── tasks.test.ts   # Task 工具测试
    ├── registry.ts     # 工具注册表（顺序稳定 + 重复注册报错）
    └── registry.test.ts # 工具注册表测试（4 个测试用例）
skills/
├── code-review/
│   └── SKILL.md        # 代码审查 skill（示例）
└── explain-code/
    └── SKILL.md        # 代码解释 skill（示例）
```

## 已实现功能

### ProjectContext (`project-context.ts`)

- **项目根目录抽象**：启动时集中解析 `projectRoot`，默认仍为 `process.cwd()`，后续可通过 `AGENT_PROJECT_ROOT` 扩展
- **Agent 全局运行根目录**：启动时集中解析 `agentHome`，默认 `~/.learn-claude-code-ts`，可通过 `AGENT_HOME` 扩展
- **项目级指令路径**：统一派生 `agentsFile = <projectRoot>/AGENTS.md`，存在时进入稳定 system prompt 头部
- **路径集中管理**：`skillsDir`、`memoryDir`、`logsDir`、`taskOutputsDir`、`tasksDir` 全部从 `agentHome` 派生，不写入被操作项目目录
- **组装根负责注入**：`index.ts` 创建一次 ProjectContext，再传给权限、工具注册表、压缩器、日志器、Memory/Skill 管理器
- **进程级上下文**：projectRoot 在启动时确定，当前不支持运行中切换项目，也不按 conversation 切换 tools/skills
- **项目目录边界**：只有 `AGENTS.md` 和工具执行/权限边界属于 `projectRoot`；Skill、Memory、LLM 日志和大工具输出都是 Agent 全局数据
- **不落 agent 数据库**：当前不创建 `.agent-data/`，session/transcript 仍是内存能力，不实现磁盘持久化或 resume

### Session 与 Transcript (`session.ts` + `transcript.ts`)

- **SessionManager**：为主 Agent 创建 `main` session，为每次 `run_subagent` 创建 `subagent` child session
- **SessionRecord 元信息**：记录 `id`、`kind`、`parentSessionId`、`startedAt`、`endedAt`、`projectRoot`、`cwd`、`model`、`title`
- **TranscriptStore**：append-only 原始事件流，不参与 prompt 构建，不会因为 context compact 被改写
- **暂不持久化**：当前 transcript/session 只保存在进程内，不实现新建 conversation、resume conversation 或磁盘快照恢复
- **事件分类**：
  - `user_message`：用户真实输入
  - `assistant_message`：模型原始回复
  - `tool_result`：工具结果消息
  - `system_reminder`：memory/session/recovery 等系统提醒
  - `hook_message`：Hook 注入消息
  - `history_replaced`：强制 compact 写回 history 的结构化记录
  - `recovery_event`：LLM 错误恢复行为记录
- **双写边界**：`History` 继续作为 prompt working context；`TranscriptStore` 保存原始事件，未来用于搜索、回放、统计分析
- **子智能体隔离**：子智能体仍使用独立 `History`，但 transcript 写入 child session，并通过 `parentSessionId` 关联父会话

### 持久化 Task 任务系统 (`task-store.ts` + `tasks.ts` + `tools/tasks.ts`)

- **长期任务边界**：Task system 用于跨会话、跨重启的长期工作计划；`todo.ts` 仍负责当前 session 的短期执行步骤
- **Agent 全局存储**：Task 数据位于 `ProjectContext.tasksDir`，默认 `<agentHome>/tasks`，不写入被操作项目目录
- **Task Group 主身份**：每个 Task Group 使用 `groups/<group_id>/group.json` 作为唯一真实数据源，`group_id` 同时是目录名和内容身份
- **Project 派生索引**：`index.json` 从所有合法 `group.json` 的 `projectRoots` 重建，支持当前项目过滤和跨项目总览
- **跨项目支持**：Task Group 保存 `scope`、`projectRoots`、`primaryProjectRoot` 元数据；物理目录不按 projectKey 分层
- **读写对称校验**：读取和保存都校验 group id 格式、目录名与内容 id 一致、task id 唯一、依赖引用存在、依赖图无环、projectRoots 为绝对路径
- **状态机**：Task 支持 `pending/in_progress/completed/failed/cancelled/deleted`；依赖未完成时不能进入 `in_progress`；所有非 deleted task 完成后 group 自动 `completed`
- **依赖派生状态**：`ready`、`blocks`、`blockedReason` 只在读取时计算，不写入文件，避免状态漂移
- **activeTaskGroupId**：TaskManager 维护 session 级内存状态，tool 输出和 `<system-reminder>` 提醒模型当前 group；修改工具仍必须显式传 `group_id`
- **LLM 工具**：新增 6 个工具：`run_task_group_create`、`run_task_group_list`、`run_task_group_read`、`run_task_add`、`run_task_update`、`run_task_delete`
- **与 TODO 的选择边界**：稳定 system prompt 和 tool description 都明确提示：TODO 用于当前 session 临时执行步骤，Task 用于跨会话/跨项目/多 owner/有依赖图的持久化计划
- **REPL 命令**：新增 `/task list`、`/task list --all`、`/task list --all-projects`、`/task show <group_id>`、`/task archive <group_id>`
- **权限策略**：`run_task_*` 属于 Agent 运行数据操作，plan/default/auto 模式均允许；文件和 bash 仍由原权限边界控制

### Agent 核心循环 (`agent.ts`)

- 接收用户 query，存入 history
- **主循环骨架**（六步）：轮次上限检测 → TODO 中断注入 → 消息处理管道 → 调用 LLM → 处理工具调用 → 返回最终回复
- **内部步骤函数**（从 `run()` 提取的闭包函数，职责明确）：
  - `appendMessage()`：向 history 添加消息（round 元信息由 history 统一管理）
  - `annotateEntries()`：将 HistoryEntry[] 转换为带 `_round` 的消息列表（替代原 annotateWithRounds）
  - `prepareMessages(roundCount)`：消息处理管道（getEntries → annotate → normalize → group → decay → [compact] → flatten），含降级容错
  - `handleToolCalls(toolCalls, roundCount)`：工具调用循环（解析参数 → 权限检查 → PreToolUse Hook → 执行 → P1 压缩 → 回写历史 → PostToolUse Hook → 延迟注入补充消息）
  - `buildRoundLimitResponse(roundCount)`：子智能体轮次上限检测与截断响应
- **轮次追踪**：round 元信息存储在 history 内部（`HistoryEntry`），agent 不再维护平行数组
- **P1 即时压缩**：run_bash 工具的大输出自动存文件，只返回 preview
- **P0 衰减压缩**：每轮自动截断旧的工具结果
- **P2 全量压缩**：上下文超过阈值时，将历史压缩为摘要
- **Cache Debug 追踪**：每轮调用 LLM 前计算 system prompt / tools / prefix hash，监控前缀稳定性
- **Reminder 注入**：`systemPromptProvider.buildTurnReminders()` + `sessionEventBuffer.drain()` 以 user message 形式注入，不修改 system prompt
- JSON 解析失败的容错处理（将错误告知 LLM 让其自行修正）
- **maxRounds 支持**：可选的最大循环轮数（子智能体使用），超过时强制截断并返回摘要
- **todoManager 可选**：子智能体不传 todoManager，父智能体行为不变
- **compressor 必需**：上下文压缩器通过依赖注入传入
- **systemPromptProvider 可选**：用于生成 turn reminders（如"本轮忽略 memory"），不用于每轮重建 system prompt
- **sessionEventBuffer 可选**：收集 out-of-band 状态变化（mode 切换、memory reload 等），下一轮注入为 `<system-reminder>`
- **Transcript 旁路记录**：可选注入 `transcriptStore + sessionId`，每次 `appendMessage()` 同步记录原始事件，不影响 prompt 构建
- **错误恢复事件记录**：backoff、compact、continue、fail 等恢复动作写入 transcript 的 `recovery_event`
- **强制 compact 写回记录**：context window 超限恢复时，`history.replaceEntries()` 改写 working context，同时 transcript 追加 `history_replaced` 事件保留审计线索

### LLM 错误恢复 (`recovery.ts` + `agent.ts`)

- **错误分类**：network、rate_limit、credential、quota、context_length、output_interrupted、unknown
- **恢复动作**：backoff、compact、continue、fail
- **状态上限**：API 重试默认最多 5 次，compact 默认最多 1 次，输出续写默认最多 2 次
- **输出中断续写**：`finishReason === "length"` 且无 tool calls 时，保存部分输出，追加 continuation reminder，再请求模型从断点继续
- **上下文超限恢复**：API 报 context length 时触发强制 P2 compact 并写回 `History`
- **不可恢复错误**：credential/quota/unknown 直接返回中文失败提示

### 消息块 (`message-block.ts`)

- **消息块是压缩操作的原子单位**：保证 tool_use/tool_result 配对不被拆分
- **三种类型**：
  - `text`：纯文本对话（user + assistant 无工具调用）
  - `tool_use`：工具调用轮次（assistant 含 tool_calls + 所有对应的 tool 消息）
  - `summary`：全量压缩产生的摘要消息
- `groupToBlocks()`：将扁平消息列表分组为消息块数组
- `flattenToMessages()`：将消息块数组还原为扁平列表（清除 `_round` 元数据）
- `estimateTokens()`：基于字符数的 token 估算（中文×1.5，英文×0.25，取较大值）
- `truncateToTokens()`：按 token 估算截断文本

### 上下文压缩 (`compressor.ts`)

- **三层压缩机制**（按优先级）：
  - **P0 衰减压缩**：`decayOldBlocks()` — 超过轮次阈值的 tool_use 块，截断 tool result content
  - **P1 即时压缩**：`compressToolResult(toolName, toolCallId, output)` — 压缩器内部根据 `compressibleTools` 配置列表和输出大小决策是否压缩（默认只压缩 `run_bash`），大输出存入 Agent 全局 `.task_outputs/`，返回 preview
  - **P2 全量压缩**：`compactHistory()` — 纯规则压缩，保留 recent K 块，其余压缩为摘要
- **消息块约束**：不拆分块、不孤立配对、不破坏 ID 关联
- **状态管理**：hasCompacted、lastSummary、recentFiles（闭包保护）
- **连续压缩**：后续压缩复用上一次 summary，避免信息退化
- **降级策略**：文件写入失败跳过压缩、全量压缩后仍超限保留最精简上下文
- **cleanup()**：清空 Agent 全局 `.task_outputs/` 目录
- **输出目录可注入**：大工具输出目录由 `ProjectContext.taskOutputsDir` 注入，默认位于 `agentHome/.task_outputs/`

### LLM 客户端 (`llm.ts`)

- 使用 OpenAI SDK，通过 baseURL 接入 MiniMax API
- 支持 function calling（工具调用）
- 接口抽象：`LLMClient { chat(messages, tools?, cacheDebug?) }`
- **消息由调用方标准化**：normalize 移至 agent.ts，llm.chat() 接收已处理的消息
- **LLM 通信日志**：可选的 `LLMLogger` 参数，记录完整请求/响应到本地文件
- **Cache Debug 透传**：可选的 `cacheDebug` 参数透传至 LLMLogger，用于日志中记录前缀 hash

### LLM 通信日志 (`llm-logger.ts`)

- **完整记录原始通信**：请求（消息列表 + 工具定义 + cache debug）和响应（内容 + 工具调用 + 耗时）
- **不做任何截断**：消息内容、工具参数、tool_call arguments 全部完整保留
- **新增 Cache Debug 记录**：systemPromptHash、toolsHash、stablePrefixHash、变化标记
- **格式化为易读结构**：角色标签对齐、JSON 美化、缩进
- **文件策略**：固定 `logs/llm.log`，每次启动清空，超过 1MB 清空重写
- **请求-响应成对**：每组用空行 + 分隔线隔开

### 消息标准化 (`normalize.ts`)

- **过滤元数据字段**：清理 content 数组中 `_` 开头的键（如 `_timestamp`、`_id`）
- **补全缺失 tool_result**：每个 assistant 的 tool_call 都必须有对应的 tool 消息，缺失则插入占位消息
- **合并连续同角色消息**：将 user+user 或 assistant+assistant 合并为一条（OpenAI API 要求角色严格交替）

### 工具系统 (`tools/`)

- **命名规范**：所有工具名称以 `run_` 开头、全小写
- **参数类型**：工具执行函数统一使用 `Record<string, unknown>`（与 LLM 返回的 JSON 类型一致）
- **run_bash 工具**：通过 `child_process.exec` 执行 shell 命令
  - 危险命令过滤（rm -rf、mkfs、dd、fork bomb、shutdown 等）
  - 超时 30s，最大输出 1MB
  - 支持由工具注册表注入 `projectRoot` 作为执行 cwd
- **run_read 工具**：读取文件内容
  - 路径安全检查：限制在工作目录内，防止路径穿越
- **run_write 工具**：写入文件（覆盖），自动创建父目录
  - 路径安全检查同上
- **run_edit 工具**：编辑文件（查找全部替换）
  - `replaceAll` 行为：所有匹配项都会被替换
  - old_string 未找到时返回错误
  - 路径安全检查同上
- **注册表模式**：`ToolRegistry` 统一管理工具定义与执行函数（含 bash、files、todo、subagent、skill、memory、task 七类工具）
- **工具定义全局稳定**：当前进程内只有一套工具定义列表，不随 conversation/session 改变；projectRoot 只作为 bash/file 工具的执行 cwd 与路径边界
- **项目根目录注入**：`createToolRegistry(..., { projectRoot })` 将同一个 projectRoot 传给 bash 和文件工具，避免散落使用 `process.cwd()`
- **工具定义顺序稳定**：`orderedEntries` 数组保证 `getToolDefinitions()` 多次调用顺序一致
- **重复注册报错**：同名工具重复注册抛出错误，防止意外覆盖
- **不因 mode 删减工具**：`/mode` 切换只改变权限策略，不改变工具定义列表

### 子智能体 / SubAgent (`tools/subagent.ts`)

- **工具定义**：`run_subagent`，参数 `task`（必填）+ `max_rounds`（可选，默认 20）
- **核心设计**：子智能体是一个独立的 Agent 实例，拥有自己的对话历史
- **上下文隔离**：子智能体执行过程中产生的所有中间消息对父智能体不可见
- **Session 隔离**：每次 `run_subagent` 创建 child session，transcript 事件写入子 session，通过 `parentSessionId` 与父 session 关联
- **工具集**：子智能体可使用 run_bash、run_read、run_write、run_edit、**run_skill**
  - 排除 run_subagent（防止无限递归）
  - 排除 `run_todo_*`（隔离上下文中用户看不到进度，maxRounds 已够用）
- **复用父级 stable system prompt**：通过 `getStableSystemPrompt` 注入，子智能体使用与父级相同的 system prompt 快照，保证 cache 前缀一致（阶段 A）
- **skill 支持**：子智能体加载 system prompt hint，可自主调用 run_skill 获取专业指示
- **独立压缩器**：通过 `createCompressorFn` 注入，子智能体使用独立的压缩器实例
- **循环依赖解决**：通过依赖注入 `createAgentFn` + `createCompressorFn` 打破循环
- **停止条件**：任务完成（LLM 返回文本） / 轮数上限（强制截断） / LLM 错误（返回错误信息）

### TODO 任务管理 (`todo.ts`)

- **纯 tool 驱动**：通过 6 个工具（run_todo_create、run_todo_update、run_todo_add、run_todo_remove、run_todo_list、run_todo_cancel）管理任务列表
- **session 级别**：一个 session 最多一个活跃 todo list，新建时自动取消旧的
- **状态机**：
  - TodoList：idle → active → completed/cancelled/interrupted
  - Task：pending → in_progress → completed/skipped/cancelled/interrupted
- **轮次上限**：每个 task 有 roundCount 计数器，agent 循环每次迭代 +1，达到上限（默认 10）自动中断
- **中断与恢复**：中断后 LLM 可通过 run_todo_update 恢复执行、跳过、或取消
- **自动完成检测**：所有 task 处于终态时，list 自动变为 completed
- **agent 集成**：agent.ts 在每次 LLM 调用前调用 `todoManager.tickRound()`，中断信息注入对话历史
- **格式化输出**：统一格式展示任务状态（`[ ]` `[>]` `[x]` `[-]` `[_]` `[!]`）+ task_id + 统计摘要

### Skill 技能系统 (`skills.ts`)

- **按需加载的 prompt 扩展**：Skill 不是新工具或子进程，而是通过 `run_skill` 工具注入的执行指示
- **三阶段生命周期**：发现（启动时解析 SKILL.md frontmatter）→ 注册（嵌入 run_skill description）→ 触发（LLM function call 读取 body）
- **SKILL.md 格式**：YAML frontmatter（name + description 必填）+ Markdown body（执行指示）
- **双保险策略**：增强 tool description（触发规则 + 示例）+ system prompt hint，帮助 weaker model 正确使用
- **SkillManager**：scan()、listMeta()、invoke()、remove() 四个核心方法
- **SkillToolProvider**：遵循 TodoToolProvider/SubagentToolProvider 模式，提供 run_skill 工具
- **REPL 命令**：`/skill list`（列出）、`/skill load`（重新扫描）、`/skill remove <name>`（删除）
- **懒加载**：启动时只解析 frontmatter（name + description），触发时才读取 body
- **当前进程级 catalog**：当前只在启动时扫描一套 Agent 全局 `skills/` 目录，不做 conversation/session 级别的 skill catalog 切换
- **参考规范**：Anthropic 官方 Skill 系统（github.com/anthropics/skills）

### 权限管理 (`permission.ts`)

- **三种运行模式**：
  - `plan`：只读模式，bash 禁止，写操作仅限 `.claude/plans/`
  - `auto`：自动模式，黑名单过滤后的操作直接放行
  - `default`：默认模式，敏感操作（bash/write/edit/subagent）需用户确认
- **权限检查流程**（短路返回）：工具分类 → 黑名单 → 路径边界 → 白名单 → 模式规则 → 敏感确认
- **复用现有安全机制**：`bash.ts` 的 `isDangerousCommand()`、`files.ts` 的 `isPathSafe()`
- **子智能体继承**：共享同一个 `PermissionManager` 实例，不传 `askUserFn`（ask 降级为 deny）
- **`/mode` CLI 命令**：通过 `cli-commands.ts` 注册，切换运行模式

### Hook 机制 (`hooks.ts`)

- **轻量进程内 Hook 系统**：在 Agent 主流程的固定时机发出事件，让外部逻辑观察或干预
- **三种事件**：SessionStart（会话开始）、PreToolUse（工具执行前）、PostToolUse（工具执行后）
- **三种返回语义**：exitCode 0（继续）、1（阻止）、2（注入补充消息后继续）
- **延迟注入规则**：exitCode 2 的消息在所有 tool_result 写完后统一追加为 user 消息，避免破坏 tool_call/tool_result 配对
- **HookRunner 串行执行**：同一事件多个 handler 按注册顺序执行，block 短路，inject 消息累积
- **异常容错**：handler 抛异常只记录 warn，不影响主流程
- **Agent 集成**：hookRunner 通过依赖注入传入，不传时使用 noop runner
- **子智能体继承**：子智能体共享父级 hookRunner 实例
- **PreToolUse 在权限检查之后触发**：Hook 不负责安全逻辑，权限系统仍然是独立的安全门卫

### Memory 长期记忆 (`memory.ts` + `tools/memory.ts`)

- **跨会话持久化**：每条 memory 是独立 Markdown 文件，存放在 Agent 全局 `memory/` 目录（frontmatter + body）
- **四种类型**：user（偏好）、feedback（纠正）、project（约定）、reference（外部资源）
- **MemoryManager**：scan/list/read/create/findSimilar/delete/buildPromptSection/rebuildIndex
- **4 个工具**：run_memory_create、run_memory_list、run_memory_read、run_memory_delete
- **权限规则**：list/read 无需确认；create/delete 所有模式都需用户确认（长期记忆影响未来会话）
- **自动索引**：MEMORY.md 由 create/delete 自动重建，不手写维护
- **教学版去重**：run_memory_create 写入前调用 findSimilar；不同名但疑似重复时默认拒绝新建，提示复用旧 name、询问用户是否删除旧 memory，或在用户明确要求保留两条时使用 `allow_duplicate: true`
- **Stable Snapshot 语义**：会话启动时的 memory 摘要固定在 system prompt 中；运行时 create/delete/reload 不自动刷新快照
- **Cache 语义输出**：memory create/delete 成功后提示"stable system prompt snapshot 未自动更新"
- **Reminder 推送**：create/delete/reload 成功后向 sessionEventBuffer 推送 reminder，下一轮以 user message 形式通知模型
- **复用 parseFrontmatter**：直接复用 skills.ts 的 frontmatter 解析器
- **REPL 命令**：`/memory list`（列出）、`/memory show <name>`（查看）、`/memory remove <name>`（删除）、`/memory reload`（重载）
- **子智能体隔离**：子智能体不包含 memory 工具，不能直接操作长期记忆

### System Prompt 组合器（Cache-Ready）(`system-prompt.ts`)

- **三层设计**：Project Instructions（`AGENTS.md`，进程固定）+ Session Snapshot（Skill/Memory，会话固定）+ Turn Reminder（单轮动态）
- **AGENTS.md 头部注入**：启动时读取 `<projectRoot>/AGENTS.md`（如果存在），放入稳定 system prompt 最前面
- **TODO vs Task 固定提示**：稳定 system prompt 内包含固定的 TODO/Task 选择规则，降低 `run_todo_*` 与 `run_task_*` 的误用概率；该提示不含动态状态，不破坏 prompt cache 前缀
- **创建时生成快照**：`createSystemPromptProvider()` 立即调用 `getProjectInstructions()`、`getSkillHint()` 和 `getMemoryHint()` 生成稳定快照
- **`getSnapshot()`**：返回缓存的快照，不重新读取底层数据
- **`refreshSnapshot()`**：显式刷新快照，重新读取 AGENTS.md/Skill/Memory 提供者（会破坏 cache 前缀，需谨慎使用）
- **`buildTurnReminders({ query })`**：只处理本轮动态要求（如"忽略 memory"），返回 `SessionReminder[]`
- **忽略 memory 新语义**：不再从 system prompt 中删除 memory hint，而是追加 `<system-reminder source="memory">` user message

### 会话事件缓冲区 (`session-events.ts`)

- **职责**：收集 out-of-band 状态变化（mode 切换、memory reload、skill re-scan），下次用户请求时注入为 `<system-reminder>`
- **轻量设计**：`push()` / `drain()` / `peek()` 三个方法，内部用数组保证顺序
- **一次性消费**：`drain()` 返回并清空，避免重复注入
- **格式统一**：各模块只提供纯文本，Agent 负责包装 XML

### Prompt Cache 调试 (`cache-debug.ts`)

- **职责**：计算 system prompt、tools、stable prefix 的 SHA256 hash，帮助观察请求前缀稳定性
- **教学版语义**：不声称是底层 API 的真实 cache hit rate，只显示"前缀是否发生变化"
- **稳定序列化**：`stableStringify()` 对对象 key 排序，保证相同内容产生相同 hash
- **inspect()**：对比当前与上一次快照，标记 systemPrompt / tools / stablePrefix 是否变化
- **formatCacheDebugLog()**：格式化为单行日志，便于阅读
- **集成位置**：Agent 每轮调用 LLM 前执行 inspect，结果通过 `logger.info()` 输出，同时透传给 LLMLogger

### 终端封装 (`terminal.ts`)

- **统一 readline 接口**：REPL 读取和权限确认共享同一个 `readline.Interface`
- `question(prompt)`：用于 REPL 输入
- `askUser(message)`：用于权限确认（接受 y/yes，其他视为拒绝）
- `close()`：关闭 readline

### 基础设施

- **配置** (config.ts)：从 .env 加载 API key、baseURL、模型名
- **日志** (logger.ts)：四级日志，通过 LOG_LEVEL 控制，使用 `util.format` 替换 %s/%d 占位符
- **对话历史** (history.ts)：messages + rounds 统一存储，支持 add/getMessages/getEntries/clear/setSystemPrompt/getSystemPrompt
  - `add(message, meta?)`：添加消息，可选附带 round 元信息（向后兼容）
  - `getMessages()`：返回纯消息列表（含 system prompt），用于 LLM API
  - `getEntries()`：返回带 round 元信息的条目列表（不含 system prompt），用于压缩管道
  - `getSystemPrompt()`：返回当前 system prompt
  - `setSystemPrompt()`：独立存储 system prompt，`getMessages()` 时自动插入头部
  - round 元信息封装在闭包内，不可能失同步

## 依赖

| 包                             | 用途                              |
| ------------------------------ | --------------------------------- |
| `openai`                       | LLM API 客户端（OpenAI 兼容格式） |
| `dotenv`                       | 从 .env 加载环境变量              |
| `typescript`                   | 类型检查和编译                    |
| `tsx`                          | 直接运行 TS 文件（开发用）        |
| `vitest`                       | 测试框架                          |
| `eslint` + `typescript-eslint` | 代码检查                          |
| `prettier`                     | 代码格式化                        |

## 配置项（.env）

| 变量                       | 说明                                | 示例                          |
| -------------------------- | ----------------------------------- | ----------------------------- |
| `LLM_API_KEY`              | API 密钥                            | `sk-cp-...`                   |
| `LLM_BASE_URL`             | API 基础 URL                        | `https://api.minimaxi.com/v1` |
| `LLM_MODEL`                | 模型名称                            | `MiniMax-M2.5`                |
| `LOG_LEVEL`                | 日志级别                            | `info`                        |
| `COMPRESS_TOOL_OUTPUT`     | 即时压缩 token 阈值                 | `2000`                        |
| `COMPRESS_DECAY_THRESHOLD` | 衰减压缩轮次阈值                    | `3`                           |
| `COMPRESS_DECAY_PREVIEW`   | 衰减后保留 token 数                 | `100`                         |
| `COMPRESS_MAX_CONTEXT`     | 全量压缩 token 阈值                 | `80000`                       |
| `COMPACT_KEEP_RECENT`      | 全量压缩保留消息块数                | `4`                           |
| `AGENT_PROJECT_ROOT`       | 被操作项目根目录                    | 当前启动目录                  |
| `AGENT_HOME`               | Agent 全局运行根目录                | `~/.learn-claude-code-ts`     |
| `MEMORY_DIR`               | Memory 文件目录名（相对 agentHome） | `memory`                      |

## 测试覆盖

| 测试文件                     | 测试数 | 覆盖内容                                                                                                        |
| ---------------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `src/tools/bash.test.ts`     | 9      | 危险命令拦截、正常执行、错误处理                                                                                |
| `src/tools/files.test.ts`    | 17     | 路径安全检查、读写文件、编辑替换                                                                                |
| `src/normalize.test.ts`      | 10     | 元数据过滤、tool_result 补全、消息合并                                                                          |
| `src/history.test.ts`        | 13     | 增删、返回副本、清空、add 带 meta、getEntries、getSystemPrompt                                                  |
| `src/logger.test.ts`         | 1      | 日志级别过滤                                                                                                    |
| `src/todo.test.ts`           | 33     | 创建/更新/添加/删除/取消、轮次中断与恢复、格式化输出、完整流程                                                  |
| `src/tools/subagent.test.ts` | 13     | 工具定义、参数校验、成功/失败路径、max_rounds、轮数上限、过滤注册表                                             |
| `src/skills.test.ts`         | 25     | frontmatter 解析、目录扫描、skill 触发/删除、工具描述构建、provider、system prompt 常量                         |
| `src/message-block.test.ts`  | 24     | 消息块分组、还原、\_round 传递与清除、round-trip 一致性、token 估算                                             |
| `src/compressor.test.ts`     | 21     | 衰减压缩、即时压缩（含非压缩工具通过）、全量压缩、状态管理、cleanup                                             |
| `src/permission.test.ts`     | 47     | 模式管理、bash 黑名单、路径黑名单、路径越界、白名单、plan/auto/default 模式决策、子智能体继承、memory 工具权限  |
| `src/hooks.test.ts`          | 11     | HookRunner 串行执行、block 短路、inject 累积、异常容错、noop runner                                             |
| `src/agent.test.ts`          | 7      | SessionStart 注入/单次触发、PreToolUse 阻止/注入、PostToolUse 注入、多 tool call 消息顺序                       |
| `src/memory.test.ts`         | 40     | name 校验、type 校验、frontmatter 解析/序列化、scan/list/read/delete、索引重建、buildPromptSection、findSimilar |
| `src/tools/memory.test.ts`   | 2      | run_memory_create 默认阻止疑似重复、allow_duplicate 显式允许重复                                                |
| `src/tools/registry.test.ts` | 4      | 重复注册报错、工具定义顺序稳定性、完整 registry 创建                                                            |
| `src/system-prompt.test.ts`  | 17     | buildSystemPrompt 组合、AGENTS.md 项目指令头、snapshot 稳定性、refreshSnapshot、ignore memory reminder          |
| `src/session-events.test.ts` | 5      | drain 清空、peek 不清空、顺序保持                                                                               |
| `src/cache-debug.test.ts`    | 7      | inspect 变化检测、system prompt 不变性、formatCacheDebugLog                                                     |
| `src/index.test.ts`          | 1      | 占位                                                                                                            |

## 设计模式

- **工厂函数 + 闭包**：所有模块通过 `createXxx()` 创建，内部状态闭包保护
- **依赖注入**：Agent 通过参数接收所有依赖（llm, history, tools, logger）
- **接口驱动**：LLMClient、Logger、History、ToolRegistry 均通过 interface 定义
- **工具注册表**：新增工具只需 register()，无需修改 agent 代码
- **命名规范**：所有工具名以 `run_` 前缀、全小写
- **元信息内聚**：round 等消息元信息由 history 统一管理，消除外部平行数组
- **统一门卫模式**：权限层在 Agent 循环中、工具执行前统一拦截，复用工具内部的安全检查函数
- **Hook 扩展点**：Agent 主流程在固定时机发出事件（SessionStart/PreToolUse/PostToolUse），Hook 负责外部扩展逻辑，不替代权限管理
- **延迟注入**：Hook 的 exitCode 2 消息在所有 tool_result 写完后统一追加为 user 消息，避免破坏 tool_call/tool_result 配对
- **权限继承**：子智能体共享父级 PermissionManager 实例，ask 决策因无回调降级为 deny
- **终端共享**：REPL 和权限确认通过 Terminal 共享同一个 readline 实例，避免 stdin 冲突
- **System Prompt 动静分离**：`SystemPromptProvider` 将 prompt 分为 Static + Session Snapshot + Turn Reminder 三层；snapshot 在启动或显式 refresh 时生成，不每轮重建
- **动态状态变化走消息**：mode 切换、memory reload、skill re-scan 等变化通过 `sessionEventBuffer` 以 user message 形式注入，不修改 system prompt
- **工具定义稳定性**：`ToolRegistry` 通过 `orderedEntries` 保证顺序稳定，重复注册报错，不因 mode 动态删减工具
- **Cache-safe fork**：子智能体复用父级 stable system prompt，工具定义保持稳定，执行层限制能力而非删除工具定义

## 重构经验

以下是重构过程中积累的经验，供后续生成代码时参考：

### 平行数组是隐式耦合的高风险点

当两个数组必须一一对应（如 messages 和 messageRounds），任何绕过同步函数的直接操作都会破坏对齐。解决方案：将元信息封装到统一存储中（如 history 内部的 rounds 数组），只暴露单一写入路径（`add()`），从接口层面消除失同步可能。

### 向后兼容的接口扩展

扩展接口时，新参数用可选类型（`meta?: { round?: number }`）。这样所有现有调用无需修改，新功能按需启用。`exactOptionalPropertyTypes` 严格模式下，返回的对象不能包含值为 undefined 的可选字段，需要条件赋值。

### 压缩管道的注释解耦

`prepareMessages()` 通过 `_round` 元数据与 `message-block.ts` 的 `groupToBlocks()` 通信。这个"协议"是松耦合的：`_round` 作为临时元数据，在 `flattenToMessages()` 中被清除，不会发送给 LLM API。只要 `_round` 的注入格式不变，下游模块（normalize、groupToBlocks、compressor）无需任何修改。

### getEntries() 不含 system prompt 的设计

`getEntries()` 有意不返回 system prompt 条目，而是通过独立的 `getSystemPrompt()` 方法获取。这样设计是因为 system prompt 不参与压缩管道，调用方可按需组装。这避免了 `annotateWithRounds()` 之前的索引偏移计算。

### Record<string, unknown> 的类型转换策略

将 `ToolExecutor` 从 `Record<string, string>` 升级为 `Record<string, unknown>` 时，所有工具实现需要用 `String()`/`Number()` 显式转换。`String(x ?? "")` 比 `x as string` 更安全，因为它处理了 `undefined`/`null`/`number` 等情况。对于数组参数（如 `args["tasks"]`），`as string[]` 断言是合理的，因为 JSON.parse 已经保证了类型。

### 压缩器统一决策 vs Agent 硬编码

将"哪些工具需要即时压缩"的决策权从 agent 移到 compressor，通过 `compressibleTools` 配置列表实现。这样新增大输出工具时只需修改配置，不碰 agent 代码。关键接口变更：`compressToolResult(toolName, toolCallId, output)` 新增 `toolName` 参数。

### 组装根、应用服务、适配层的分离

将 `index.ts` 拆成三层：`index.ts`（组装根 — 只做组件创建和接线）、`repl.ts`（应用服务 — REPL 交互循环）、`cli-commands.ts`（适配层 — CLI 斜杠命令注册和分发）。命令注册表模式让新命令只需 `register()`，不修改 REPL 代码。

### 副作用不能隐式替代返回值

当一个函数同时产生返回值和副作用（修改状态、写入历史、记录日志）时，两者是独立的输出通道。调用方只读取返回值，不会从副作用中推断结果。如果结果由多轮产生，必须在返回值层面显式拼接，不能假设"写入了状态就等于输出了"。设计多轮恢复、流式处理、分页加载等场景时，接口契约必须明确：返回值是否包含全过程的累积结果。

### 往返转换必须保留原始粒度

数据从细粒度聚合为粗粒度，再还原为细粒度时，还原步骤必须优先使用原始元素自带的元数据，不能把聚合值当作原始值的替代品。`groupToBlocks` 用 `minRound` 给 block 打聚合标签，但块内各条消息仍保留各自的 `_round`；`blocksToEntries` 还原时若统一使用 `block.round`，就会丢失原始粒度。任何"分组 → 处理 → 还原"的管道，在还原阶段都要问自己：原始元素上是否还有比分组键更细的信息需要保留。

### 状态变更后显式刷新所有派生值

修改一个核心状态后，必须在其作用域内列出所有直接和间接消费者（日志、缓存 key、调试信息、派生状态、校验和等），逐一确认是否同步重建。当修改发生在循环或条件分支内部时，这个检查尤其容易遗漏，因为人眼会默认"外面那行初始化就够了"。建立一个简单的自检习惯：写完状态修改语句后，回头扫一遍同作用域内所有引用过该状态的变量。

### 跨模块状态对象必须显式约定时态

当多个模块共享一个可变状态对象时，接口必须声明该状态在调用前后的预期形态。是"调用前已由调用方递增"，还是"调用后由本函数递增"？是"传入原始值，函数内部负责计数"，还是"传入已计数状态，函数只负责读取"？不能让调用方和实现方各自猜测。最安全的做法是：纯函数只读状态并返回文案，状态修改完全由调用方控制；如果纯函数需要展示"第 N 次"，则让它接收一个已经计算好的序号，而不是在内部对状态做算术。

## 待实现 / 未来方向

（按需在后续 lesson 中实现，完成后更新此列表）

- 流式输出（streaming response）
- 更丰富的工具集（grep、glob、web fetch 等）
- Skill 脚本执行支持（dependencies 字段、base path 引用脚本）
- 用户级 skill 目录（`~/.claude/skills/`）
- 对话创建 skill（LLM 自动在 skills/ 下创建目录和 SKILL.md）
