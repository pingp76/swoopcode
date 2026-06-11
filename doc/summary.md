# 项目状态总览

这是 swoopcode 项目的持久化状态文档。每次新增功能模块后更新此文件。

## 项目简介

教学用途的 TypeScript Coding Agent，递进式构建，每一步都能独立运行。

GitHub: https://github.com/pingp76/swoopcode

## 当前状态

**已完成阶段**: 基础 REPL + LLM 对话 + bash 工具调用 + 文件操作工具 + 消息标准化 + TODO 任务管理 + 子智能体（SubAgent）+ Skill（技能）系统 + LLM 通信日志 + 上下文压缩 + 权限管理 + Hook 机制 + Memory（长期记忆）+ **Prompt Cache 友好的请求布局** + LLM 错误恢复 + ProjectContext + Session/Transcript 原始事件流 + 持久化 Task 任务系统 + Async Run 非阻塞运行实例 + **Schedule 定时运行系统** + OutputStore 输出句柄 + 安全精确编辑 + 时间语义收口 + Runtime Hardening Round A（原子写与日志轮转）+ 教学注释增强（实现路径注释补齐）+ **PDD-16：模型适配与 Agent Runtime Policy 抽象层**（Provider Profile + Foundation Model Profile + Runtime Policy + LLM Adapter + Context Budget + Stable Context Manager + ContextRanker + RepoClassifier + TaskIntentClassifier）+ **PDD-17：Eval Harness 基础框架**（Eval Core、deterministic suite、real core tools、CLI driver）+ **PDD-18：Replay/Live/Judge/Full-tools Eval**（replay、live smoke、judge/report、live regression、full-tools live E2E）+ **PDD-19：MCP 与 Agent Team Eval Harness Prototype**（prototype suites 默认 skipped，避免误读为生产能力）+ **网页版教程雏形**（`tutorial/` 静态站点 + 第 00/01 章 + `web/temp/2/` 风格三栏阅读布局）+ **公开版 PDD 整理**（`doc/pdd-01-*.md` 到 `doc/pdd-19-*.md`，保留原始 PDD 深度，旧 refactor 工作记录已合并回对应 PDD）

- **PDD-17 Eval Harness 基础能力**：Eval Core + Deterministic Suite + Real Core Tools + CLI Driver。
- **PDD-18 Eval 回归能力**：Replay + Live Smoke + Judge/Report；Live Regression — Core Tools；Full-tools Live E2E。
- **PDD-19 Eval Prototype 边界**：MCP fixture server + MCP runtime adapter + MCP trace/assertions；顺序 supervisor Team driver + Team trace/assertions；由于项目尚未实现生产级 MCP runtime / 真实 Agent Team runtime，相关 MCP/Team 测试当前全部 `describe.skip`。

## 网页版教程站点雏形

- **位置**：`tutorial/`
- **目标**：把内部 PDD 逐步改写成面向中文新手的网页教程，让学生沿着 agent loop 理解并最终能写 prompt 重建一个类似 coding agent harness
- **当前章节**：已实现第 00-15 章主线教程、专题 A“不同大模型不是只换模型名”、专题 B“如何测试一个不确定的 Coding Agent”和 Reference 查阅页
- **教学叙事**：章节统一按“真实场景 → 朴素方案 → 失败原因 → loop 位置与图示 → 原理/推荐方案 → 实现落点 → Prompt Card/验证”展开；第 10 章已强化 prompt cache 原理、量化影响、请求栈图、provider 差异和稳定 prefix / 动态 tail 设计
- **视觉与交互**：以 `web/temp/2/` dummy 页为基准，采用暖米白学术风、固定顶部 header、三栏独立滚动、左侧章节导航、右侧页内目录、左右侧栏可收起，章节末尾自动生成“上一章 / 下一章”翻页导航
- **内容结构**：章节正文放在 `tutorial/chapters/*.html`，站点元数据放在 `tutorial/assets/content.js`，主题 token 和组件样式集中在 `tutorial/assets/styles.css`
- **本地运行**：仓库根目录运行 `npm run tutorial:dev`，默认访问 `http://127.0.0.1:5173`
- **验证入口**：`npm run tutorial:check` 做 JavaScript 语法检查；`npm run tutorial:format` 格式化教程站点文件

## 教学注释增强

- **目标**：补足代码实现内部的中文解释，让学生阅读时不仅知道“函数做什么”，也能理解关键分支为什么这样写
- **范围**：主循环、消息标准化与分块、消息压缩、权限/执行边界、工具 provider、Task/Schedule/Async Run/OutputStore 持久化与运行态路径、LLM streaming 聚合、原子写与日志轮转
- **行为边界**：本轮只补充解释性注释，不改变工具 schema、模块接口、运行时状态机或持久化格式
- **注释风格**：从普通提示型注释升级为讲义型注释；在关键函数开头增加“教学导读”，在状态机、跨模块边界、幂等收敛、数据格式转换、防御性校验旁解释设计原因
- **自学目标**：学生可以按注释顺序理解“LLM 消息如何整理成合法上下文”、“工具参数如何进入业务层”、“后台任务如何从 running 收敛为终态”、“持久化文件如何保持读写对称”
- **架构意识补充**：注释显式标出 composition root 共享实例、稳定 prompt 与动态 reminder、History 与 Transcript 分离、ToolResult 与 throw 的边界、Provider Profile 方言收敛、Schedule 与 Async Run 生命周期分离等可迁移设计套路
- **坑点覆盖**：重点说明 prompt cache 被动态 system prompt 破坏、tool_call/tool_result 配对被插入消息破坏、output path 直接暴露给 LLM、subagent 继承过大权限、Schedule 自己实现执行生命周期、派生状态落盘、错误恢复重试预算跨 turn 复用等常见错误

## 源码结构

```
src/
├── index.ts            # 组装根（Composition Root）：组件初始化和接线
├── repl.ts             # REPL 交互层：readline 循环 + Agent/命令分发
├── cli-commands.ts     # CLI 命令注册与分发（/skill、/mode、/m、/t、/c 等斜杠命令）
├── config.ts           # 从 .env 加载配置（含压缩配置 + provider 解析 + policy 解析链）
├── llm-providers.ts    # LLM Provider Profile 抽象层：registry + resolver
├── foundation-models.ts # 基座模型能力画像：registry + resolveFoundationModelProfile()
├── runtime-policy.ts   # Runtime Policy 解析器：profile → policy + 环境变量覆盖
├── runtime-policy-store.ts # Session-local 运行时策略可变存储 + CLI override
├── context-budget.ts   # 上下文预算分配器：按压缩模式分配子预算
├── llm-adapter.ts      # LLM 协议适配器：OpenAI Chat Completions 请求构建 + 响应解析
├── stable-context.ts   # 稳定上下文管理器：repo map + pinned files + context pack 构建 + ContextRanker 集成
├── context-ranking.ts  # 通用内容重要性排序器：FileInventory + RepoClassifier + TaskIntentClassifier + 多维度评分
├── context-ranking.test.ts # ContextRanker 测试（82 个测试用例，覆盖 7 种项目 fixture）
├── project-context.ts  # 项目上下文：集中解析 projectRoot、AGENTS.md、agentHome 与运行数据路径
├── logger.ts           # 分级日志（debug/info/warn/error）+ util.format 占位符替换
├── log-rotation.ts     # 日志轮转工具：单文件大小上限 + 固定历史份数
├── atomic-write.ts     # 原子写入工具：同目录临时文件 + rename 覆盖 + JSON 语法校验
├── llm.ts              # LLM 客户端（OpenAI SDK + streaming 聚合 + adapter 驱动）
├── llm-logger.ts       # LLM 通信日志：完整记录请求/响应到 <agentHome>/logs/llm.log，超限轮转保留
├── command-safety.ts   # shell 命令硬性安全黑名单：普通 bash 与 ExecutionPolicy 共享
├── execution-policy.ts # 非交互执行边界：readonly/ci/workspace_write profile + command/resource 校验
├── output-store.ts     # Agent 大输出登记与读取：output_id + index.json + run_output_read 边界
├── timeline.ts         # 时间语义类型：turnIndex / loopRound / loopIndex / messageSequence
├── normalize.ts        # 消息标准化：纯函数清理元数据、补全/移动 tool_result、合并普通同角色消息
├── history.ts          # 对话历史管理（messages + timing metadata 统一存储 + HistoryEntry + system prompt 支持）
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
├── transcript.ts       # Transcript 原始事件流：append-only 记录事件 sequence + historySequence
├── task-store.ts       # 持久化 Task 存储层：groups/<group_id>/group.json + project 索引 + 读写校验
├── tasks.ts            # Task 业务层：Task Group 状态机、依赖校验、activeTaskGroupId、格式化输出
├── async-runs.ts       # Async Run 核心：start/check/list/readOutput/drainNotifications/冲突检测
├── async-runs.test.ts  # Async Run 测试（32 个测试用例）
├── schedule-store.ts   # Schedule 持久化存储层：schedulesDir 布局 + JSON 校验 + 索引重建
├── schedules.ts        # Schedule 业务层：tick 调度 + occurrence 管理 + Async Run 触发 + 通知队列
├── schedules.test.ts   # Schedule 管理器测试（28 个测试用例）
├── cache-debug.ts      # Prompt Cache 调试：system/tools/prefix hash + 稳定性追踪
├── recovery.ts         # LLM 错误分类与恢复决策：backoff/compact/continue/fail
├── terminal.ts         # 终端输入输出封装：共享 readline（REPL + 权限确认共用）
├── debug-e2e.ts        # 端到端调试脚本（Skill+TODO+SubAgent 协作验证）
├── foundation-models.test.ts # Profile 注册表、匹配、fallback 测试（14 个测试用例）
├── runtime-policy.test.ts # Policy 解析、env 覆盖、非法值报错测试（19 个测试用例）
├── runtime-policy-store.test.ts # Override 合并、reset、snapshot 测试（15 个测试用例）
├── context-budget.test.ts # 预算分配公式、总和约束、override 裁剪测试（9 个测试用例）
├── llm-adapter.test.ts # Adapter 请求构建、reasoning 回放、streaming 聚合测试（15 个测试用例）
├── stable-context.test.ts # Repo map、pin/unpin、预算裁剪、hash 稳定性测试（13 个测试用例）
├── message-block.test.ts # 消息块测试（32 个测试用例）
├── compressor.test.ts    # 压缩器测试（26 个测试用例）
├── execution-policy.test.ts # ExecutionPolicy 测试（12 个测试用例）
├── atomic-write.test.ts # 原子写入测试（3 个测试用例）
├── llm-logger.test.ts # LLMLogger 日志轮转测试（1 个测试用例）
├── output-store.test.ts # OutputStore 测试（7 个测试用例）
├── permission.test.ts   # 权限管理器测试（74 个测试用例）
├── hooks.test.ts        # Hook Runner 单元测试（11 个测试用例）
├── agent.test.ts        # Agent Hook/错误恢复/Transcript/Reasoning 集成测试（25 个测试用例）
├── memory.test.ts       # Memory 管理器测试（40 个测试用例）
├── todo.test.ts        # TODO 管理器测试（34 个测试用例）
├── skills.test.ts      # Skill 管理器测试（25 个测试用例）
├── normalize.test.ts   # 消息标准化测试（20 个测试用例）
├── system-prompt.test.ts # System Prompt 测试（20 个测试用例）
├── session-events.test.ts # Session Event Buffer 测试（5 个测试用例）
├── cache-debug.test.ts  # Cache Debug 测试（7 个测试用例）
├── project-context.test.ts # ProjectContext 路径派生测试
├── recovery.test.ts    # LLM 错误恢复决策测试
├── session.test.ts     # Session 管理器测试
├── transcript.test.ts  # Transcript 原始事件流测试（6 个测试用例）
├── task-store.test.ts  # TaskStore 持久化、索引和清理测试
├── tasks.test.ts       # TaskManager 状态机和依赖测试
├── cli-commands.test.ts # CLI 命令测试（含 /task、/m、/t）（16 个测试用例）
├── config.test.ts      # Config 加载与 policy 解析链测试（5 个测试用例）
├── index.test.ts       # 占位测试
├── history.test.ts     # history 模块测试（22 个测试用例）
├── logger.test.ts      # logger 模块测试
└── tools/
    ├── types.ts        # 共享类型：ToolResult 接口
    ├── bash.ts         # bash 工具：执行 shell 命令 + 危险命令过滤（工具名: run_bash）
    ├── bash.test.ts    # bash 工具测试（24 个测试用例）
    ├── files.ts        # 文件操作工具：run_read、run_write、run_edit、run_edit_exact（限工作目录）
    ├── files.test.ts   # 文件操作工具测试（23 个测试用例）
    ├── subagent.ts     # 子智能体工具：run_subagent（复用父级 stable prompt + 独立上下文）
    ├── subagent.test.ts # 子智能体工具测试（17 个测试用例）
    ├── memory.ts       # Memory 工具提供者：run_memory_create/list/read/delete（4 个工具）
    ├── memory.test.ts  # Memory 工具测试（2 个测试用例）
    ├── tasks.ts        # Task 工具提供者：run_task_group_create/list/read + run_task_add/update/delete
    ├── tasks.test.ts   # Task 工具测试
    ├── async-runs.ts   # Async Run 工具提供者：run_async_start/check/list/output_read（4 个工具）
    ├── async-runs.test.ts # Async Run 工具测试（16 个测试用例）
    ├── output.ts       # OutputStore 工具提供者：run_output_read
    ├── output.test.ts  # Output 工具测试（4 个测试用例）
    ├── schedules.ts    # Schedule 工具提供者：create/list/read/cancel/delete/occurrence_list（6 个工具）
    ├── schedules.test.ts # Schedule 工具测试（4 个测试用例）
    ├── registry.ts     # 工具注册表（顺序稳定 + 重复注册报错 + 过滤选项）
    └── registry.test.ts # 工具注册表测试（11 个测试用例）
├── eval/
│   ├── core/
│   │   ├── case-schema.ts    # EvalCase、EvalStep、EvalAssertion、EvalRunResult 类型
│   │   ├── driver.ts         # CodingAgentDriver 中立接口
│   │   ├── workspace.ts      # 临时 workspace 与路径边界
│   │   ├── trace.ts          # TraceRecorder、RuntimeEvent
│   │   ├── assertions.ts     # portable + instrumented assertion 执行器
│   │   ├── runner.ts         # runEvalCase/runEvalSuite 核心 runner
│   │   └── trace-writer.ts   # JSON trace 输出
│   ├── drivers/
│   │   ├── learn-claude-code/
│   │   │   ├── in-process-driver.ts       # 当前项目 createAgent() driver
│   │   │   ├── core-tool-runtime.ts       # 真实核心工具注册表（bash/read/write/edit/editExact）
│   │   │   ├── full-tool-runtime.ts       # 临时 agentHome 下组装完整工具系统
│   │   │   ├── full-tool-runtime.test.ts  # full runtime 确定性测试
│   │   │   ├── mcp-runtime.ts             # Eval MCP fixture adapter + ToolRegistry 合并
│   │   │   ├── team-driver.ts             # 顺序 supervisor Agent Team eval driver
│   │   │   ├── scripted-llm.ts            # ScriptedLLMClient
│   │   │   ├── scripted-terminal.ts       # ScriptedTerminal（支持 permission 事件记录）
│   │   │   └── tool-trace.ts              # ToolRegistry tracing wrapper
│   │   └── cli/
│   │       └── cli-driver.ts         # CLI 黑盒 driver（spawn + stdin/stdout）
│   ├── cases/
│   │   ├── fixtures/
│   │   │   ├── replay-read.json      # Replay fixture: read file
│   │   │   └── replay-write.json     # Replay fixture: write file
│   │   ├── deterministic.test.ts     # Deterministic suite（≥5 个 core tool + CLI smoke case）
│   │   └── replay-suite.test.ts      # Replay suite
│   ├── live/
│   │   ├── _driver-factory.ts              # Live suite 共享 driver + judge LLM 工厂
│   │   ├── live-llm.ts                     # Live LLM wrapper
│   │   ├── live-suite.test.ts              # Live smoke suite（需 `EVAL_LIVE=1`）
│   │   ├── live-regression-suite.test.ts   # Live regression suite（core tools，需 `EVAL_LIVE_REGRESSION=1`）
│   │   ├── live-full-suite.test.ts         # Live full-system regression suite（需 `EVAL_LIVE_FULL=1`）
│   │   ├── live-mcp-suite.test.ts          # Live MCP suite（需 `EVAL_LIVE_MCP=1`）
│   │   └── live-team-suite.test.ts         # Live Team / Team+MCP suite（需 `EVAL_LIVE_TEAM=1`）
│   ├── mcp/
│   │   ├── fixture-server.ts               # MCP JSON-RPC fixture server
│   │   ├── fixture-server.test.ts          # MCP fixture protocol tests
│   │   ├── mcp-trace.ts                    # MCP runtime event helper
│   │   └── mcp-suite.test.ts               # MCP deterministic harness tests
│   ├── team/
│   │   ├── team-schema.ts                  # Team judge input type entry
│   │   ├── team-trace.ts                   # Team event grouping + judge summary builder
│   │   ├── team-assertions.ts              # Team event helper utilities
│   │   ├── team-assertions.test.ts         # Team assertion helper tests
│   │   └── team-suite.test.ts              # Team deterministic harness tests
│   ├── judge/
│   │   ├── judge.ts                  # LLM judge 实现
│   │   └── judge-suite.test.ts       # Judge 集成测试
│   ├── replay/
│   │   └── replay-llm.ts             # Replay LLM client
│   ├── runner.test.ts        # core + in-process driver 集成测试
│   └── README.md             # Eval 系统使用文档
skills/
├── code-review/
│   └── SKILL.md        # 代码审查 skill（示例）
└── explain-code/
    └── SKILL.md        # 代码解释 skill（示例）
```

## 已实现功能

### ProjectContext (`project-context.ts`)

- **项目根目录抽象**：启动时集中解析 `projectRoot`，默认仍为 `process.cwd()`，后续可通过 `AGENT_PROJECT_ROOT` 扩展
- **Agent 全局运行根目录**：启动时集中解析 `agentHome`，默认 `~/.swoopcode`，可通过 `AGENT_HOME` 扩展
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
- **事件序列**：`TranscriptEvent.sequence` 是 append-only 事件流顺序；如果事件对应 History 消息，额外记录 `historySequence`

### 时间语义 (`timeline.ts` + `history.ts` + `transcript.ts`)

- **`turnIndex`**：第几次外部用户输入触发 `agent.run()`，同一个 Agent 实例内单调递增
- **`loopRound`**：当前 user turn 内第几次 LLM 调用，每次 `agent.run()` 从 1 重新开始；子智能体 `maxRounds` 使用这个局部计数
- **`loopIndex`**：当前 Agent 实例内第几次 LLM 调用，跨 user turn 单调递增；P0 衰减压缩使用它判断工具结果年龄
- **`messageSequence`**：History 中普通对话消息的单调递增序号；用于 compact round-trip 和 debug，不等同于压缩年龄
- **`TranscriptEvent.sequence`**：Transcript append-only 事件序列；它记录审计流顺序，不等同于 `messageSequence`
- **兼容字段 `round`**：短期保留为 `loopRound` 的兼容别名，旧测试和旧调用点仍可读；新代码应优先使用 `loopRound` / `loopIndex`
- **内部字段清理**：`_turnIndex`、`_loopRound`、`_loopIndex`、`_messageSequence`、`_round` 只在 prepare/group/compact 管线内部流转，`flattenToMessages()` 会全部清除，不发送给 LLM

### 持久化 Task 任务系统 (`task-store.ts` + `tasks.ts` + `tools/tasks.ts`)

- **长期任务边界**：Task system 用于跨会话、跨重启的长期工作计划；`todo.ts` 仍负责当前 session 的短期执行步骤
- **Agent 全局存储**：Task 数据位于 `ProjectContext.tasksDir`，默认 `<agentHome>/tasks`，不写入被操作项目目录
- **Task Group 主身份**：每个 Task Group 使用 `groups/<group_id>/group.json` 作为唯一真实数据源，`group_id` 同时是目录名和内容身份
- **Project 派生索引**：`index.json` 从所有合法 `group.json` 的 `projectRoots` 重建，支持当前项目过滤和跨项目总览
- **原子写入**：`group.json` 与派生 `index.json` 都通过 `atomicWriteJsonFile()` 写入，避免进程中断留下半截 JSON
- **跨项目支持**：Task Group 保存 `scope`、`projectRoots`、`primaryProjectRoot` 元数据；物理目录不按 projectKey 分层
- **读写对称校验**：读取和保存都校验 group id 格式、目录名与内容 id 一致、task id 唯一、依赖引用存在、依赖图无环、projectRoots 为绝对路径
- **状态机**：Task 支持 `pending/in_progress/completed/failed/cancelled/deleted`；依赖未完成时不能进入 `in_progress`；所有非 deleted task 完成后 group 自动 `completed`
- **依赖派生状态**：`ready`、`blocks`、`blockedReason` 只在读取时计算，不写入文件，避免状态漂移
- **activeTaskGroupId**：TaskManager 维护 session 级内存状态，tool 输出和 `<system-reminder>` 提醒模型当前 group；修改工具仍必须显式传 `group_id`
- **LLM 工具**：新增 6 个工具：`run_task_group_create`、`run_task_group_list`、`run_task_group_read`、`run_task_add`、`run_task_update`、`run_task_delete`
- **与 TODO 的选择边界**：稳定 system prompt 和 tool description 都明确提示：TODO 用于当前 session 临时执行步骤，Task 用于跨会话/跨项目/多 owner/有依赖图的持久化计划
- **REPL 命令**：新增 `/task list`、`/task list --all`、`/task list --all-projects`、`/task show <group_id>`、`/task archive <group_id>`
- **权限策略**：`run_task_*` 属于 Agent 运行数据操作，plan/default/auto 模式均允许；文件和 bash 仍由原权限边界控制

### ExecutionPolicy 非交互执行边界 (`execution-policy.ts` + `command-safety.ts`)

- **职责边界**：`PermissionManager` 继续负责 plan/default/auto 与 ask/deny/allow；`ExecutionPolicy` 负责已经获得授权后的非交互子流程能否执行某条命令、声明哪些资源
- **共享实例**：`index.ts` 创建一个 `executionPolicy` 和一个 readonly `AsyncCommandPolicy` adapter，并注入 Async Run、Schedule、子智能体工具和 filtered registry
- **Profile 语义**：`readonly` 只允许诊断命令；`ci` 允许 build/test/coverage 等 CI 命令但仍禁止修复和 git 写操作；`workspace_write` 目前只是类型预留，所有 command/resource 校验都会拒绝
- **命令校验**：先拒绝明显危险命令和 shell control operators，再用保守 argv 解析匹配 allowlist；复杂 shell 语法解析不可靠时宁可拒绝
- **readonly allowlist**：允许 `pwd/ls/rg/cat/head/tail/sed -n`、`git status/diff/log/show`、`npm run typecheck/lint/format:check`、`npm test`、`npx vitest run`、`npx eslint`、`npx tsc --noEmit`
- **写入风险拦截**：`npm run lint -- --fix`、`npx eslint --fix`、`npx tsc` 不带 `--noEmit`、`npm run build` 在 readonly profile 下会被拒绝；`npm run build` 只在 `ci` profile 下允许
- **资源校验**：`readPaths` 必须在 `projectRoot` 内；`readonly` 和 `ci` 都拒绝非空 `writePaths`；`workspace_write` 在当前阶段统一返回 reserved
- **兼容层**：`tools/bash.ts` 仍重新导出 `AsyncCommandPolicy` 和 `createDefaultAsyncCommandPolicy()`，旧调用点可以逐步迁移到新模块
- **安全黑名单共享**：`command-safety.ts` 保存普通 `run_bash` 和 `ExecutionPolicy` 都要使用的硬性危险命令黑名单，避免两处实现漂移

### OutputStore 输出句柄 (`output-store.ts` + `tools/output.ts`)

- **Agent 输出边界**：OutputStore 管理的是 Agent 自身保存的大输出，不是用户项目文件；默认位于 `<agentHome>/.task_outputs`
- **稳定 handle**：每个输出使用 `out_YYYYMMDD_HHMMSS_xxxxxx` 形式的 `output_id`，LLM 不需要也不应该读取裸文件路径
- **登记索引**：`index.json` 保存 `OutputRecord`，包括 source kind、source id、relativePath、byteLength、contentType 等元数据
- **原子写入**：输出正文通过 `atomicWriteTextFile()` 写入，`index.json` 通过 `atomicWriteJsonFile()` 写入，减少半写入导致的 index 损坏
- **读取工具**：新增 `run_output_read`，只接受 `output_id`、`max_bytes`、`start_byte`，只能读取 OutputStore index 中登记过的输出
- **路径防线**：读取时先查 index，再确认 `relativePath` 解析后仍在 output root 内，不能借 output 工具读取任意 `agentHome` 或 `projectRoot` 文件
- **分片读取**：`run_output_read` 支持 `max_bytes/start_byte`，避免一次性把超大输出重新塞回上下文
- **注册边界**：主 Agent 注册 `run_output_read`；async/subagent 的 readonly filtered registry 默认不注册该工具，避免跨上下文输出泄露

### Async Run 非阻塞运行实例 (`async-runs.ts` + `tools/async-runs.ts`)

- **Session-local 异步执行层**：允许 LLM 启动非阻塞的 command 或 subagent 运行，然后继续其他工作，完成后通过 notification 告知
- **与 Task 的边界**：Task 是持久化长期计划（跨会话、跨重启）；Async Run 是 session 内的一次性异步执行单元，不持久化、不 resume
- **命名区分**：不使用 "background task"，避免与 PDD12 Task 混淆；使用 `run_async_*` 工具名和 `ar_` 前缀的 run_id
- **四种工具**：`run_async_start`（启动）、`run_async_check`（查询单个状态）、`run_async_list`（列表过滤）、`run_async_output_read`（读取输出）
- **两种执行器**：`command`（shell 命令，白名单策略）和 `subagent`（委托 AI 任务，独立 history/compressor/session）
- **并发限制**：最多 3 个同时 running 的 async run，超限拒绝启动
- **只读约束**：第一版通过 `ExecutionPolicy.validateResources({ profile: "readonly" })` 拒绝 `write_paths` 非空，并要求 `read_paths` 在 projectRoot 内
- **超时机制**：默认 120s，最大 300s；超时后状态变为 `timeout`，通过 `setTimeout` deadline 监控
- **核心正确性 `finishRun()`**：只有 `status === "running"` 时允许进入终态；使用 `Set<string>` 防止 late result 覆盖 timeout；第一个进入终态的路径负责写 output、计算 duration、递减计数、推送 notification
- **深拷贝**：`check()` 和 `list()` 返回 `JSON.parse(JSON.stringify(record))`，防止外部修改内部状态
- **前台冲突检测**：`checkForegroundToolConflict()` 在 Agent 工具执行前拦截——running async run 的 readPaths 与前台 `run_write`/`run_edit` 目标路径重叠时 block；存在 running runs 时前台 `run_bash` 只允许 strict read-only command policy 通过的命令
- **Notification 注入**：Agent 每轮 LLM 调用前 `drainNotifications()`，以 `<system-reminder source="async-run">` 形式注入；新输出优先提示 `run_output_read(output_id)`，旧输出 fallback 到 `run_async_output_read(run_id)`
- **权限策略**：`run_async_check/list/output_read` 所有模式 allow；`run_async_start + command` 在 plan 模式 deny、auto 模式 allow、default 模式 ask；`run_async_start + subagent` 在 plan 模式 allow、auto 模式 allow、default 模式 ask
- **ExecutionPolicy 验证**：`executor: "command"` 在 `AsyncRunManager.start()` 路径中使用共享 readonly policy 校验，拒绝 shell control operators、git 写命令、`--fix`、`npx tsc` 默认 emit 和 readonly profile 下的 build；允许 `npx tsc --noEmit`、`npm run typecheck/lint/format:check`、`npm test`、`npx vitest run` 等诊断命令
- **输出隔离**：async run 完成后会登记到 OutputStore 并得到 `outputId`；同时保留 `<taskOutputsDir>/async-runs/<run_id>/output.txt` 与 `run_async_output_read` 作为 PDD13 兼容路径
- **子智能体 registry 过滤**：async subagent 获得只读 registry（无 write/edit、无 subagent 嵌套、无 async-run 嵌套），通过 `ToolRegistryOptions` 的 `includeFileWrite`/`includeFileEdit`/`commandPolicy` 控制

### Schedule 定时运行系统 (`schedule-store.ts` + `schedules.ts` + `tools/schedules.ts`)

- **长期定时边界**：Schedule 用于跨 session / 跨重启保存时间触发规则；真正执行仍交给 Async Run，Schedule 不实现第二套执行生命周期
- **Agent 全局存储**：Schedule 数据位于 `ProjectContext.schedulesDir`，默认 `<agentHome>/schedules`，不写入被操作项目目录
- **当前项目默认视图**：物理存储是全局的，但 `ScheduleStore.list()`、`ScheduleManager.list()`、`/schedule list`、`run_schedule_list` 默认只返回当前 `projectRoot` 的 schedule；跨项目 summary 必须显式使用 `currentProjectOnly: false` 或 `/schedule list --all-projects`
- **跨项目写保护**：`read/cancel/delete/listOccurrences` 不跨项目操作；当前项目 manager 不会触发、取消或删除其他项目的 schedule
- **Occurrence 审计**：每次 due/triggered/running/completed/failed/timeout/missed/skipped/orphaned 都通过 occurrence 文件记录
- **原子写入**：`schedule.json`、occurrence 文件和派生 `index.json` 都通过共享原子写工具写入
- **重启收敛**：Async Run 是 session-local，进程重启后不能恢复旧 run；启动扫描时如果发现 persisted `running` occurrence，会收敛为 `orphaned` 并按 `notifyLlm` 生成 schedule notification
- **触发流程**：`ScheduleManager.tick()` 只从当前项目 active schedules 中发现 due occurrence，创建 occurrence 后调用 `AsyncRunManager.start()`，并通过 async finish callback 回写 occurrence 终态
- **Overlap 策略**：当前支持 `allow` 与 `skip`；`skip` 依赖当前进程内 running set，重启后的旧 running 会先收敛为 `orphaned`
- **LLM 工具**：新增 6 个工具：`run_schedule_create`、`run_schedule_list`、`run_schedule_read`、`run_schedule_cancel`、`run_schedule_delete`、`run_schedule_occurrence_list`
- **当前实现裁剪**：`run_schedule_create` 当前只暴露已实现能力；`saveRawOutput` 固定为 `true`，`linkedTaskUpdate` 固定为 `"never"`，`permissionProfile` 默认 `readonly`，`ci/workspace_write/linked Task 自动更新` 留给后续 ExecutionPolicy/Task 集成章节
- **ExecutionPolicy 触发校验**：Schedule trigger 的 command preflight 使用共享 `ExecutionPolicy.validateCommand({ profile: schedule.execution.permissionProfile })`；新建 schedule 同时通过 `validateResources()` 校验资源边界
- **Profile 当前边界**：tool schema 仍只公开 `readonly`；旧文件中的 `ci` command 可按 ci profile 校验；`workspace_write` 仍是 reserved，创建或触发都会失败
- **输出引用**：Schedule occurrence 保存 `outputId` 与旧 `outputRef`；工具展示和 notification 优先提示 `run_output_read(output_id)`，旧 occurrence 只有 `outputRef` 时仍可展示但不会自动变成可读 handle
- **REPL 命令**：`/schedule list [--all] [--all-projects]`、`/schedule show <id>`、`/schedule cancel <id>`、`/schedule delete <id>`、`/schedule occurrences <id>`

### Eval Core 与 In-process Driver (`src/eval/`)

- **Eval Core 设计原则**：中立 runner + driver 边界抽象，Eval Core 不直接依赖当前项目内部模块（agent.ts、llm.ts、ToolRegistry 等），只认识 `CodingAgentDriver` 接口
- **CodingAgentDriver 接口**：`startCase` → `send` → `readEvents` → `close` 生命周期；同一 case 内多 step 复用同一 driver 实例
- **EvalCase / EvalStep / EvalAssertion 类型**：TypeScript 对象描述 case，不引入 YAML/JSON schema 解析依赖；断言分 portable（finalOutputContains、fileExists、fileContains 等）和 instrumented（toolCalled、transcriptEventTypes 等）两类
- **临时 workspace**：`createEvalWorkspace()` 在 OS tmp 目录创建独立目录，支持 `initialFiles`、路径边界检查（拒绝 `..` 和绝对路径）、自动清理（`keepOnFailure` 可选保留）
- **TraceRecorder / writeEvalTrace**：结构化事件收集 + JSON 输出；支持 `EVAL_TRACE_DIR` 环境变量覆盖输出目录
- **runEvalCase() 生命周期**：validate → create workspace → create driver → step loop → collect events → run assertions → write trace → cleanup
- **当前项目 in-process driver**：内部组装 `createAgent()`，注入 ScriptedLLMClient、ScriptedTerminal、Fake Tool Registry、静音 Logger、新建 History/Compressor/PermissionManager/TranscriptStore；支持 scripted/replay/live 三种 LLM kind
- **Full-tools in-process driver**：`tools.kind="full"` 在临时 `agentHome` 下复用真实 TODO/Task/Memory/Skill/SubAgent/Async/Schedule/Output provider；Eval Core 不直接 import 当前项目业务模块，项目耦合集中在 `drivers/learn-claude-code/`
- **ScriptedLLMClient**：按顺序消耗预设 response，每次 `chat()` 自动序列化 tool args 并发射 `llm_call`/`llm_response` 事件；response 耗尽时抛错
- **ReplayLLMClient**：读取 JSON fixture（`version: 1`），校验 `caseId` 匹配后，转换为 `ScriptedLLMResponse[]` 复用 scripted 路径；fixture 含 `provider/model/recordedAt/responses`
- **LiveEvalLLMClient**：包装真实 `createLLMClient()`，发射 `llm_call`/`llm_response` 事件，支持 `maxCalls` 限制防止无限循环
- **ScriptedTerminal**：自动消耗 `permissionAnswers` 和 `questions` 队列，支持 `defaultPermissionAnswer` 默认值
- **Fake Tool Registry**：第一批只支持 fake tools，不接入真实 bash/files；工具定义和 executor 由 case 注入，执行时发射标准化 tool_call/tool_result 事件（含 stepId）
- **断言执行器**：`runAssertions()` 遍历断言列表，返回结构化 `EvalAssertionResult`（passed + message + evidence）；instrumented 断言基于 `runtimeEvents` 判断，已支持 `fileNotExists`、`toolCalledOneOf`、`toolResultContains`、`stepToolCalled`、`stepToolNotCalled`
- **Judge 评估**：`runJudge()` 构建含 rubric + trace summary 的 prompt，调用独立 LLM 做开放式质量评价；输出 `EvalJudgeResult`（passed/score/summary/strengths/problems/evidence/needsHumanReview）；hard assertions 始终优先，judge 失败也导致 case `status = "failed"`
- **Judge JSON 解析鲁棒性**：三层降级——直接 `JSON.parse()` → 正则提取 markdown code block → 括号深度计数器提取嵌套 JSON → 返回 `judge_failed` fallback（score=0, passed=false, 不影响 hard result）；`VALID_EVIDENCE_KINDS` Set 过滤非法 evidence kind
- **Suite Report**：`runEvalSuite()` 顺序运行多个 case，聚合 `EvalSuiteReport`（version/total/passed/failed/skipped/mode/cases[]）；`writeJsonReport()` 输出机器可读 JSON，`writeMarkdownReport()` 输出人读 Markdown（分 Passed/Failed 章节）；passed case 含 judge 失败时附加 ` (judge failed)`
- **Live Regression Suite**：6 个 core-tools-only case 覆盖真实 LLM 下的读/写/编辑/bash/权限/多轮能力；每个 case 限制 `maxCalls`/`maxRounds`，Vitest timeout 30-60s；启用开关 `EVAL_LIVE_REGRESSION=1`；`EVAL_LIVE=1` 只启用 smoke suite；`EVAL_JUDGE=1` 启用 LLM judge 评价，`JUDGE_MODEL` 环境变量可覆盖 judge 模型（默认和 Agent 同模型）
- **Live Full Suite**：4 个 release case 覆盖 TODO、confirmed Memory、seed Skill、readonly SubAgent；3 个 nightly case 预留 Task/Async/Schedule，默认 `describe.skip`；启用开关 `EVAL_LIVE_FULL=1`，所有 case 都使用临时 workspace + 临时 `agentHome`

### PDD-18 Full-tools Live E2E (`src/eval/drivers/learn-claude-code/full-tool-runtime.ts` + `src/eval/live/live-full-suite.test.ts`)

- **临时 agentHome 隔离**：full-tools eval runtime 使用 `createProjectContext({ projectRoot: workspaceRoot, agentHome })` 组装真实工具 provider，skills、memory、logs、task outputs、tasks、schedules 都写入 case 专属临时 `agentHome`，不读取用户真实 `~/.swoopcode`
- **完整工具组装**：`tools.kind="full"` 复用当前项目真实 TODO/Task/Memory/Skill/SubAgent/Async/Schedule/Output provider；Eval Core 仍保持中立，不直接 import 当前项目业务模块
- **Seed 数据**：`seedSkills` 在创建 SkillManager 前写入临时 skills 目录；`seedMemories` 通过 MemoryManager 写入临时 memory 目录；release skill case 使用 `SKILL_USED_22` 作为技能行为标记，便于失败 trace 快速识别
- **Async cleanup**：full runtime cleanup 会先 `scheduleManager.stop()`，再调用 `asyncRunManager.shutdown()` 将仍在 running 的 async run 收敛为 `abandoned`，最后按 `keepAgentHome` 决定是否删除临时 `agentHome`
- **新增断言语义**：`fileNotExists` 验证拒绝写入或越界写入不会产生文件；`toolCalledOneOf` 允许模型通过多个等价查询工具达成目标；`toolResultContains` 校验工具结果本身含目标内容；`stepToolCalled` / `stepToolNotCalled` 基于 tool event 的 `stepId` 校验多轮 case 中单步工具行为
- **RuntimePathEvent**：driver 在 trace 中发射 `runtime_path` 事件，记录 `workspaceRoot` 与 `agentHome`，失败且 `keepOnFailure` 时可直接定位临时目录
- **Live full release cases**：`live-full-todo-guided-file-change`、`live-full-memory-confirmed-create-and-read`、`live-full-skill-guided-output`、`live-full-subagent-readonly-analysis`
- **Live full nightly cases**：Task Group durable plan、Async Run output handle、Schedule create/read/cancel 三个 case 已预留为 `describe.skip`，每个 case 配置 120s timeout，便于后续夜间或人工触发
- **Judge 成本**：Release 组 4 个 case 均内置 judge rubric；`EVAL_LIVE_FULL=1 EVAL_JUDGE=1` 会额外产生 4 次 judge LLM 调用

### PDD-19 MCP 与 Agent Team Eval Harness Prototype (`src/eval/mcp/` + `src/eval/team/` + live suites)

- **MCP fixture server**：新增 `src/eval/mcp/fixture-server.ts`，实现 MCP 2025-06-18 最小 JSON-RPC 子集：`initialize`、`notifications/initialized`、`tools/list`、`tools/call`、`resources/list`、`resources/read`、JSON-RPC error；支持 fixture tool/resource、tool-call delay timeout、initialize failure、server crash 注入
- **MCP runtime adapter**：`mcp-runtime.ts` 在 learn-claude-code driver 层把 fixture MCP tool 暴露为 `run_mcp_<server>_<tool>`，把 resource 暴露为 `run_mcp_resource_read`；Eval Core 不依赖当前项目 ToolRegistry，MCP adapter 通过 `combineToolRegistries()` 与真实工具链合并；in-process driver 同时支持 spec 风格的顶层 `driver.mcpServers` 和兼容路径 `tools.full.mcpServers`
- **MCP trace/assertions**：新增 `mcp_server_start`、`mcp_initialize`、`mcp_tools_list`、`mcp_tool_call`、`mcp_tool_result`、`mcp_resource_read`、`mcp_error`、`mcp_server_stop` 事件；新增 `mcpServerStarted`、`mcpToolListed`、`mcpToolCalled`、`mcpToolResultContains`、`mcpResourceRead`、`mcpErrorCode` 断言
- **MCP cases 当前状态**：fixture protocol、deterministic MCP suite、live MCP suite 的 case 已保留在代码中，但全部 `describe.skip`；原因是项目还没有生产级 MCP runtime / 第三方 MCP server 接入，当前 case 只能证明 eval fixture harness，不应被 CI/report 误读为真实 MCP 功能
- **Team driver**：新增 `learn-claude-code-team` driver，第一版实现顺序 supervisor 拓扑；每个成员都是真实 Agent 实例，拥有独立 history/compressor、共享 LLM client、共享临时 workspace，并按 member tools 组装受限 registry
- **Team 权限边界**：planner/reviewer/researcher 默认只拿到显式声明的 read/bash/todo/mcp 等能力；implementer 可通过 `tools: ["core"]` 获得写工具，但仍受 workspace 路径边界和 `PermissionManager` 模式约束；permission denial 会通过现有 ScriptedTerminal 事件进入 trace
- **Team trace/assertions**：新增 `team_start`、`agent_spawned`、`agent_message`、`agent_tool_call`、`handoff`、`artifact_produced`、`agent_completed`、`agent_failed`、`team_completed` 事件；`run_write`/`run_edit`/`run_edit_exact` 成功后发射 `artifact_produced`；新增 `teamAgentSpawned`、`teamRoleUsed`、`teamHandoffOccurred`、`teamAgentToolCalled`、`teamAgentToolNotCalled`、`teamAgentFailed`、`teamArtifactContains`、`teamAllAgentsCompleted`、`teamNoUnauthorizedWrites` 断言
- **Team cases 当前状态**：deterministic Team suite、Team assertion helper、live Team suite 和 Team+MCP mixed case 已保留在代码中，但全部 `describe.skip`；原因是项目还没有生产级 Agent Team runtime，当前 case 只能证明 eval harness 原型
- **脚本开关**：新增 `test:eval:live:mcp`、`test:eval:live:team`、`test:eval:live:team:mcp`；这些脚本当前也只会看到 skipped suite，待真实 MCP / Team runtime 落地后再恢复 opt-in 运行

### Agent 核心循环 (`agent.ts`)

- 接收用户 query，存入 history
- **主循环骨架**（六步）：轮次上限检测 → TODO 中断注入 → 消息处理管道 → 调用 LLM → 处理工具调用 → 返回最终回复
- **内部步骤函数**（从 `run()` 提取的闭包函数，职责明确）：
  - `appendMessage()`：向 history 添加消息（timing 元信息由 history 统一管理）
  - `annotateEntries()`：将 HistoryEntry[] 转换为带内部 timing 字段的消息列表（替代原 annotateWithRounds）
  - `prepareMessages(loopIndex)`：消息处理管道（getEntries → annotate → normalize → group → decay → [compact] → flatten），含降级容错
  - `handleToolCalls(toolCalls, timing)`：工具调用循环（解析参数 → 权限检查 → PreToolUse Hook → 执行 → P1 压缩 → 回写历史 → PostToolUse Hook → 延迟注入补充消息）
  - `buildLoopRoundLimitResponse(loopRound)`：子智能体当前 turn 内轮次上限检测与截断响应
- **时间追踪**：`turnIndex` / `loopRound` / `loopIndex` / `messageSequence` 元信息存储在 history 内部（`HistoryEntry`），agent 不再维护平行数组
- **P1 即时压缩**：run_bash 工具的大输出自动存文件，只返回 preview
- **P0 衰减压缩**：每次 LLM loop 前按全局 `loopIndex` 自动截断旧的工具结果
- **P2 全量压缩**：上下文超过阈值时，将历史压缩为摘要
- **Stable Context 插入**：`prepareMessages()` 在 system prompt 之后插入 `StableContextManager.buildMessages()` 的结果
- **文件活动追踪**：`trackFileActivity()` 在 `handleToolCalls` 中记录 `run_read`/`run_write`/`run_edit`/`run_edit_exact` 触达的文件路径，作为 evidence 信号传给 ContextRanker；写/编辑工具成功后调用 `stableContextManager.notifyFileChanged()` 使 pinned 文件的 stable snapshot 失效
- **Cache Debug 追踪**：每轮调用 LLM 前计算 system prompt / tools / prefix hash，监控前缀稳定性
- **Reminder 注入**：`systemPromptProvider.buildTurnReminders()` + `sessionEventBuffer.drain()` 以 user message 形式注入，不修改 system prompt
- **Assistant Message 优先保存**：写入 history 时优先使用 `response.assistantMessage`（含 reasoning_content），fallback 到手工构造
- **Reasoning 回放**：adapter 构造的 assistant message 保留 reasoning 字段，下一轮请求自动带回
- JSON 解析失败的容错处理（将错误告知 LLM 让其自行修正）
- **maxRounds 支持**：可选的最大循环轮数（子智能体使用），超过时强制截断并返回摘要
- **todoManager 可选**：子智能体不传 todoManager，父智能体行为不变
- **compressor 必需**：上下文压缩器通过依赖注入传入
- **systemPromptProvider 可选**：用于生成 turn reminders（如"本轮忽略 memory"），不用于每轮重建 system prompt
- **sessionEventBuffer 可选**：收集 out-of-band 状态变化（mode 切换、memory reload 等），下一轮注入为 `<system-reminder>`
- **Transcript 旁路记录**：可选注入 `transcriptStore + sessionId`，每次 `appendMessage()` 同步记录原始事件、timing 和 `historySequence`，不影响 prompt 构建
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
- `flattenToMessages()`：将消息块数组还原为扁平列表（清除内部 timing 元数据）
- `estimateTokens()`：基于字符数的 token 估算（中文×1.5，英文×0.25，取较大值）
- `truncateToTokens()`：按 token 估算截断文本

### 上下文压缩 (`compressor.ts`)

- **三层压缩机制**（按优先级）：
  - **P0 衰减压缩**：`decayOldBlocks()` — 超过 `decayAfterRounds` 对应的全局 LLM loop 数后，截断 tool result content
  - **P1 即时压缩**：`compressToolResult(toolName, toolCallId, output)` — 压缩器内部根据 `compressibleTools` 配置列表和输出大小决策是否压缩（默认只压缩 `run_bash`），大输出优先登记到 OutputStore，返回 `output_id` 与 preview
  - **P2 全量压缩**：`compactHistory()` — 纯规则压缩，保留 recent K 块，其余压缩为摘要
- **消息块约束**：不拆分块、不孤立配对、不破坏 ID 关联
- **状态管理**：hasCompacted、lastSummary、recentFiles（闭包保护）
- **连续压缩**：后续压缩复用上一次 summary，避免信息退化
- **降级策略**：文件写入失败跳过压缩、全量压缩后仍超限保留最精简上下文
- **cleanup()**：未注入 OutputStore 时清空临时 `.task_outputs/` 目录；注入 OutputStore 后不删除已登记输出
- **输出目录可注入**：大工具输出目录由 `ProjectContext.taskOutputsDir` 注入，默认位于 `agentHome/.task_outputs/`

### Foundation Model Profile 基座模型画像 (`foundation-models.ts`)

- **能力驱动而非模型名驱动**：`agent.ts` 不出现 `kimi`/`deepseek` 等具体模型分支，业务层只看 `RuntimePolicy` 中的策略字段
- **Profile Registry**：含 `generic-openai-compatible`、`kimi-k2.6`、`kimi-code`、`deepseek-v4`、`minimax-m2.7`、`minimax-m3`、`mimo-v2.5-pro`、`qwen3.7-max`、`glm-5.1` 等画像
- **匹配优先级**：`LLM_MODEL_PROFILE` 显式指定 > exact model id > prefix > provider default > generic fallback
- **硬协议字段 vs 优化提示分离**：maxTokensField、thinking requestShape、reasoning responseFields 等硬字段必须保守；context budget、compression mode 等优化提示允许合理默认
- **Profile 分级**：`verified` / `experimental` / `needs_review`，stale/high-risk profile 启动时产生 warning 但不阻断
- **文档元数据**：每个 profile 包含 `sourceUrls`、`verifiedAt`、`updateRisk`、`status`，支持审计和后续核对

### Runtime Policy 解析器 (`runtime-policy.ts`)

- **三层抽象**：`FoundationModelProfile`（事实） → `RuntimePolicy`（决策） → `LLMRequestAdapter`（协议适配）
- **策略解析**：从 profile 派生 context/thinking/request/reasoning/tools/cache/telemetry 策略
- **环境变量覆盖**：支持 `LLM_CONTEXT_BUDGET`、`LLM_THINKING`、`LLM_REASONING_EFFORT`、`LLM_MAX_OUTPUT_TOKENS`、`LLM_PROTOCOL` 覆盖
- **覆盖校验**：budget 不超窗、thinking 被模型支持、effort 合法、protocol 已实现
- **压缩默认值派生**：`aggressive` / `balanced` / `long_context` 三种模式自动派生阈值
- **Context Budget 分配**：调用 `resolveContextBudgets()` 自动分配 stable/working/evidence/conversation/output/headroom 子预算

### Runtime Policy Store (`runtime-policy-store.ts`)

- **Session-local 可变状态**：合并 base policy + CLI override，为 SubAgent/Async Run 提供 snapshot
- **Mid-session 可调字段**：thinkingMode、reasoningEffort、contextBudgetTokens、maxOutputTokens、compressionMode
- **禁止运行中修改的字段**：protocol、tools、cache、reasoning responseFields 等协议正确性字段
- **Snapshot 规则**：已启动的 async run 使用创建时的 policy snapshot，不受后续 CLI 变更影响

### LLM 协议适配器 (`llm-adapter.ts`)

- **接口抽象**：`LLMRequestAdapter` 统一处理消息准备、请求构建、响应解析、streaming 聚合
- **OpenAI Chat Completions Adapter**：`createOpenAIChatCompletionsAdapter(policy)` 实现第一版完整适配
- **消息准备**：`prepareMessages()` 补充 reasoning_content 占位（Kimi 等模型需要）
- **请求构建**：`buildRequest()` 处理 max_tokens vs max_completion_tokens 字段差异、extraBody 注入
- **响应解析**：`parseNonStreamingResponse()` 提取 assistantMessage / reasoning / usage
- **Streaming 聚合**：`parseStreamingChunk()` / `finishStreaming()` 聚合 content + tool_calls + reasoning delta
- **Anthropic Adapter 占位**：未实现时返回 unsupported guard，不阻断启动

### 稳定上下文管理器 (`stable-context.ts`)

- **Stable Snapshot 缓存**：stable pack 在首次 `buildMessages()` 时构建一次并缓存渲染后的字符串；后续调用直接复用缓存，确保 prompt cache 前缀字节级稳定
- **显式失效机制**：`pinPath()`、`unpinPath()`、`rebuildRepoMap()`、`invalidateStableSnapshot()` 触发重建；`notifyFileChanged()` 在文件工具写/编辑成功后检查是否命中 pinned path，命中则 invalidate；`currentQuery`、`recentFiles`、`failingFiles`、`mtime`、`git diff` 永远不进入 stable
- **预算锁定**：stable 预算在 snapshot 创建时锁定；如果用户调小预算导致放不下，触发重建而非静默裁剪
- **Working Set Pack**：每轮重新构建，使用 ContextRanker + 动态信号（query/evidence）选择文件
- **Evidence Pack**：动态证据（diff、test failure、tool output），靠近 current query，不污染稳定前缀
- **Repo Map**：目录结构 + 关键配置文件列表，排除 `node_modules`、`.git`、二进制和敏感文件
- **Pin 文件管理**：`/c 加 <path>` / `/c 删 <path>`，按路径排序保证确定性顺序；pin/unpin 自动失效 stable snapshot
- **预算裁剪**：working set 先预估 token 再读取，超预算时截断而非整体丢弃；stable pack 不与 working set 重复装载
- **Hash 稳定性**：文件未变化时 content hash 不变，cache key 稳定
- **安全边界**：只读取 projectRoot 内文件，不暴露 agentHome 内部路径
- **通用排序增强**：集成 ContextRanker，working set 使用 ranker 选择而非硬编码；stable pack 不使用动态信号；manifest 输出 rank reasons
- **CLI 增强**：`/c 刷` 显式失效 stable snapshot；`/c 排` 显示 top ranked files；`/c why <path>` / `/c 因 <path>` 显示文件评分和原因

### 通用内容重要性排序器 (`context-ranking.ts`)

- **四层分离设计**：FileInventory（文件事实）→ RepoClassifier（生态分类）→ TaskIntentClassifier（任务意图）→ ContextRanker（多维度评分）
- **FileInventory**：递归扫描项目目录，收集路径/大小/mtime/扩展名/角色/生态；排除 node_modules/.git/dist/build/coverage/binary/secret/.env/doc/todo.md/symlink
- **文件角色识别**：通用角色（project_instruction/readme/project_summary/design_doc/manifest/build_config/entrypoint/source/test/schema/infra/ci_config/generated/secret），不依赖特定生态
- **RepoClassifier**：manifest + 文件分布 + 目录结构组合判断；支持 typescript/javascript/python/rust/go/java/kotlin/cpp/infra/docs/mixed/unknown；mixed repo 识别 package roots
- **TaskIntentClassifier**：关键词匹配 + evidence 信号推断；支持 orientation/implementation/debug/review/testing/documentation/refactor/unknown；提取 mentioned paths/terms/design doc IDs
- **多维度评分**：8 个独立评分函数，每个分数都有 ScoreReason 解释
  - roleScore (0..500)：通用角色基线
  - ecosystemScore (0..350)：生态 profile 加分（只在 repo classifier 匹配后生效）
  - taskRelevanceScore (0..700)：query 命中、路径/术语/设计文档 ID 匹配
  - evidenceScore (0..900)：stack trace/failing test/git modified/recent read/open file
  - graphScore (0..400)：import graph、test/source 配对、中心 config
  - recencyScore (0..250)：mtime 衰减（不影响 stable pack）
  - userSignalScore (0..1000)：用户显式 pin/open/query 提到
  - noisePenalty (0..-1200)：generated/minified/binary/secret/large file/forbidden path
- **轻量 import graph**：TS/JS/Python/Rust 简单字符串匹配；处理 TypeScript ESM `.js` → `.ts` 扩展名映射；test/source 配对
- **Deterministic 排序**：score desc → normalized path asc
- **安全边界**：`.env`/密钥/二进制永不自动读；doc/todo.md 永不自动读；symlink 跳过；projectRoot 外路径拒绝
- **与 StableContextManager 集成**：`createStableContextManager` 接受可选 `ContextRanker` 参数；`buildMessages` 升级为接收 `BuildMessagesInput` 对象（兼容旧 string API）；新增 `getRankedFiles()`/`getRepoClassification()`/`explainFile()` 方法
- **CLI 增强**：`/c 排` 显示 top ranked files；`/c why <path>` / `/c 因 <path>` 显示文件评分和原因

### LLM Provider Profile 抽象层 (`llm-providers.ts`)

- **集中 profile 表**：声明 4 个 provider（`openai_compatible`、`minimax_cn`、`kimi_platform_cn`、`kimi_code_cn`）的默认 endpoint、默认模型、key 环境变量和能力标记
- **解析优先级**：`LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` 优先于 provider 默认值，兼容现有使用方式
- **启动时解析**：`resolveLLMProviderConfig()` 只读 env，不做网络请求，返回 `ResolvedLLMConfig`
- **厂商差异不泄漏到 Agent 循环**：Agent、SubAgent、Async Run 只依赖 `LLMClient.chat()`
- **真实验证**：`kimi_code_cn` 已实测通过普通聊天和 tool call 闭环（含 streaming 聚合、User-Agent 注入、thinking/reasoning_content 兼容）

### LLM 客户端 (`llm.ts`)

- 使用 OpenAI SDK，通过 `ResolvedLLMConfig` 的 `baseURL` 接入任意 OpenAI-compatible provider
- 支持 function calling（工具调用）
- **streaming 聚合**：若 `capabilities.prefersStreaming === true`，自动启用 `stream: true`，聚合 content delta 和 tool_calls delta，最终返回统一的 `LLMResponse`
- 接口抽象：`LLMClient { chat(messages, tools?, cacheDebug?) }`
- **消息由调用方标准化**：normalize 移至 agent.ts，llm.chat() 接收已处理的消息
- **LLM 通信日志**：可选的 `LLMLogger` 参数，记录完整请求/响应到本地文件
- **Cache Debug 透传**：可选的 `cacheDebug` 参数透传至 LLMLogger，用于日志中记录前缀 hash

### LLM 通信日志 (`llm-logger.ts`)

- **完整记录原始通信**：请求（消息列表 + 工具定义 + cache debug）和响应（内容 + 工具调用 + 耗时）
- **不做任何截断**：消息内容、工具参数、tool_call arguments 全部完整保留
- **新增 Cache Debug 记录**：systemPromptHash、toolsHash、stablePrefixHash、变化标记
- **格式化为易读结构**：角色标签对齐、JSON 美化、缩进
- **文件策略**：固定写入 `<agentHome>/logs/llm.log`，每次启动追加 BOOT 标记；默认单文件超过 5MB 时轮转为 `llm.log.1`、`llm.log.2` 等，默认保留 5 份；默认路径是 `~/.swoopcode/logs/llm.log`，不是项目根目录的 `logs/llm.log`
- **请求-响应成对**：每组用空行 + 分隔线隔开
- **Usage 记录**：响应日志中记录 prompt/completion/total/reasoning/cache hit/cache miss 等字段
- **Reasoning 截断**：reasoning_content 日志默认只显示前 200 字符

### 消息标准化 (`normalize.ts`)

- **纯函数转换**：不修改输入数组或输入 message 对象；输出消息使用 clone，避免 prepareMessages 污染 History 引用
- **过滤元数据字段**：清理 content 数组中 `_` 开头的键（如 `_timestamp`、`_id`），但保留顶层 `_turnIndex/_loopRound/_loopIndex/_messageSequence/_round` 给 message-block 读取
- **补全/移动 tool_result**：每个 assistant 的 tool_call 都必须有对应 tool 消息；缺失则在该 assistant 后插入占位消息，位置错误的 tool_result 会被移动回对应 tool block
- **丢弃孤立 tool_result**：没有任何 assistant tool_call 引用的 role=tool 消息不会进入最终 LLM 输入
- **合并连续同角色消息**：将 user+user 或普通 assistant+assistant 合并为一条；带 `tool_calls` 的 assistant 不参与合并
- **保留 provider 字段**：`reasoning_content`、`reasoning_details` 等 provider-specific 顶层字段不会被误删
- **内部字段仍清理**：`_turnIndex/_loopRound/_loopIndex/_messageSequence/_round` 在 `flattenToMessages()` 中清除，不发给 LLM

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
- **run_edit_exact 工具**：安全精确编辑文件
  - `old_string` 必须非空，`expected_occurrences` 必须是正整数
  - 只有实际匹配次数等于 `expected_occurrences` 才写文件
  - 零匹配、多匹配或上下文漂移时不写文件，返回错误
- **run_output_read 工具**：按 `output_id` 读取 OutputStore 登记输出，不接受文件路径
- **注册表模式**：`ToolRegistry` 统一管理工具定义与执行函数（含 bash、files、output、todo、subagent、skill、memory、task、async、schedule 等工具）
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
- **复用现有安全机制**：普通 bash 与非交互执行边界共享 `command-safety.ts` 的危险命令黑名单；文件路径仍使用 `files.ts` 的 `isPathSafe()`
- **Output 读取权限**：`run_output_read` 属于 Agent 运行数据读取，plan/default/auto 均允许；它不走 projectRoot 文件读取边界，而是由 OutputStore index 和 output root 校验
- **安全编辑权限**：`run_edit_exact` 与 `run_edit` 一样归类为 file-write，default 模式 ask，auto 模式 allow，plan 模式只允许 `.claude/plans/`
- **子智能体继承**：同步子智能体共享父级 `PermissionManager` 实例；async/scoped 子智能体通过注入的 readonly `AsyncCommandPolicy` 校验内部 `run_bash`，内部 ask 降级为 deny
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
- **日志** (logger.ts)：四级日志，通过 LOG_LEVEL 控制，使用 `util.format` 替换 %s/%d 占位符；写入 `agent.log` 时默认单文件 5MB、保留 5 份轮转历史
- **原子写入** (atomic-write.ts)：持久化 store 共用的文本/JSON 原子写入工具，JSON 写入前会在临时文件上做一次语法 parse 校验
- **对话历史** (history.ts)：messages + timing metadata 统一存储，支持 add/getMessages/getEntries/clear/setSystemPrompt/getSystemPrompt
  - `add(message, meta?)`：添加消息，可选附带 turnIndex / loopRound / loopIndex / round 元信息（向后兼容），返回写入后的 HistoryEntry
  - `getMessages()`：返回纯消息列表（含 system prompt），用于 LLM API
  - `getEntries()`：返回带 timing 元信息和 messageSequence 的条目列表（不含 system prompt），用于压缩管道
  - `getSystemPrompt()`：返回当前 system prompt
  - `setSystemPrompt()`：独立存储 system prompt，`getMessages()` 时自动插入头部
  - timing 元信息封装在闭包内，不可能失同步

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
| `LLM_PROVIDER`             | Provider 标识（可选）               | `kimi_code_cn`                |
| `LLM_API_KEY`              | 通用 API 密钥（覆盖 provider 默认） | `sk-cp-...`                   |
| `LLM_BASE_URL`             | API 基础 URL（覆盖 provider 默认）  | `https://api.minimaxi.com/v1` |
| `LLM_MODEL`                | 模型名称（覆盖 provider 默认）      | `MiniMax-M2.5`                |
| `KIMI_CODE_API_KEY`        | Kimi Code CN 专用 key               | `sk-kimi-...`                 |
| `MOONSHOT_API_KEY`         | Kimi Platform CN 专用 key           | `sk-moonshot-...`             |
| `MINIMAX_CN_API_KEY`       | MiniMax CN 专用 key                 | `sk-minimax-...`              |
| `LOG_LEVEL`                | 日志级别                            | `info`                        |
| `COMPRESS_TOOL_OUTPUT`     | 即时压缩 token 阈值                 | `2000`                        |
| `COMPRESS_DECAY_THRESHOLD` | 衰减压缩轮次阈值                    | `3`                           |
| `COMPRESS_DECAY_PREVIEW`   | 衰减后保留 token 数                 | `100`                         |
| `COMPRESS_MAX_CONTEXT`     | 全量压缩 token 阈值                 | `80000`                       |
| `COMPACT_KEEP_RECENT`      | 全量压缩保留消息块数                | `4`                           |
| `AGENT_PROJECT_ROOT`       | 被操作项目根目录                    | 当前启动目录                  |
| `AGENT_HOME`               | Agent 全局运行根目录                | `~/.swoopcode`                |
| `MEMORY_DIR`               | Memory 文件目录名（相对 agentHome） | `memory`                      |
| `LLM_MODEL_PROFILE`        | 显式指定模型 profile                | `kimi-k2.6`                   |
| `LLM_CONTEXT_BUDGET`       | 上下文预算覆盖（token 数）          | `180000`                      |
| `LLM_THINKING`             | Thinking 模式覆盖                   | `enabled/disabled/adaptive`   |
| `LLM_REASONING_EFFORT`     | Reasoning effort 覆盖               | `high/max/default`            |
| `LLM_MAX_OUTPUT_TOKENS`    | 最大输出 token 覆盖                 | `32768`                       |
| `LLM_PROTOCOL`             | 协议选择覆盖                        | `openai-chat-completions`     |

## 测试覆盖

| 测试文件                                                       | 测试数                        | 覆盖内容                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/tools/bash.test.ts`                                       | 24                            | 危险命令拦截、正常执行、错误处理、非交互命令策略                                                                                                                                                                           |
| `src/tools/files.test.ts`                                      | 23                            | 路径安全检查、读写文件、编辑替换、精确编辑                                                                                                                                                                                 |
| `src/normalize.test.ts`                                        | 17                            | 纯函数转换、元数据过滤、tool_result 邻接补全/移动、孤立 tool_result 丢弃、assistant tool_call 合并边界                                                                                                                     |
| `src/history.test.ts`                                          | 22                            | 增删、返回副本、清空、add 带 timing meta、messageSequence、getEntries、getSystemPrompt                                                                                                                                     |
| `src/logger.test.ts`                                           | 2                             | 日志级别过滤、agent.log 轮转                                                                                                                                                                                               |
| `src/llm-logger.test.ts`                                       | 1                             | llm.log 轮转且保留 BOOT 历史                                                                                                                                                                                               |
| `src/atomic-write.test.ts`                                     | 3                             | 文本/JSON 原子写入、JSON 序列化失败不破坏旧文件                                                                                                                                                                            |
| `src/todo.test.ts`                                             | 34                            | 创建/更新/添加/删除/取消、轮次中断与恢复、格式化输出、完整流程                                                                                                                                                             |
| `src/tools/subagent.test.ts`                                   | 17                            | 工具定义、参数校验、成功/失败路径、max_rounds、轮数上限、过滤注册表、async run 提示                                                                                                                                        |
| `src/skills.test.ts`                                           | 25                            | frontmatter 解析、目录扫描、skill 触发/删除、工具描述构建、provider、system prompt 常量                                                                                                                                    |
| `src/message-block.test.ts`                                    | 29                            | 消息块分组、normalized tool block、还原、内部 timing 字段传递与清除、round-trip 一致性、token 估算                                                                                                                         |
| `src/compressor.test.ts`                                       | 26                            | 衰减压缩、loopIndex 年龄判断、即时压缩（含非压缩工具通过）、OutputStore 输出句柄、全量压缩、状态管理、cleanup                                                                                                              |
| `src/permission.test.ts`                                       | 74                            | 模式管理、bash 黑名单、路径黑名单、路径越界、白名单、plan/auto/default 模式决策、子智能体继承、memory/async-run 权限                                                                                                       |
| `src/hooks.test.ts`                                            | 11                            | HookRunner 串行执行、block 短路、inject 累积、异常容错、noop runner                                                                                                                                                        |
| `src/agent.test.ts`                                            | 22                            | SessionStart 注入/单次触发、时间语义、PreToolUse 阻止/注入、PostToolUse 注入、多 tool call LLM 输入顺序、错误恢复、Transcript                                                                                              |
| `src/memory.test.ts`                                           | 40                            | name 校验、type 校验、frontmatter 解析/序列化、scan/list/read/delete、索引重建、buildPromptSection、findSimilar                                                                                                            |
| `src/tools/memory.test.ts`                                     | 2                             | run_memory_create 默认阻止疑似重复、allow_duplicate 显式允许重复                                                                                                                                                           |
| `src/tools/registry.test.ts`                                   | 11                            | 重复注册报错、工具定义顺序稳定性、完整 registry 创建、过滤选项、OutputStore 注册                                                                                                                                           |
| `src/async-runs.test.ts`                                       | 32                            | start 校验、finishRun 生命周期、timeout、深拷贝、冲突检测、notification drain、readOutput、OutputStore 输出登记                                                                                                            |
| `src/tools/async-runs.test.ts`                                 | 16                            | 4 个工具定义、参数校验、JSON 输出格式、错误传播、output_id 展示                                                                                                                                                            |
| `src/eval/runner.test.ts`                                      | 9                             | fake driver 无工具 case、in-process driver 无工具 case、fake tool call case、多 query history 复用、断言失败、workspace initial files、case id 校验、judge 集成（result + trace）、full-tools keepOnFailure 保留 agentHome |
| `src/eval/cases/replay-suite.test.ts`                          | 2                             | replay fixture 读取、caseId 校验、ScriptedLLM 路径复用                                                                                                                                                                     |
| `src/eval/replay/replay-llm.test.ts`                           | 4                             | fixture version mismatch、caseId mismatch、文件不存在、JSON 解析失败                                                                                                                                                       |
| `src/eval/judge/judge-suite.test.ts`                           | 6                             | judge 正常评分通过、JSON 解析失败 fallback、hard assertions 失败时 judge 仍运行、rubric 传入、score 边界                                                                                                                   |
| `src/eval/drivers/learn-claude-code/full-tool-runtime.test.ts` | 6                             | full runtime 临时 agentHome 目录、enabledTools 过滤、完整工具注册、seed skill、seed memory、cleanup 放弃 running async run                                                                                                 |
| `src/eval/mcp/fixture-server.test.ts`                          | 3 skipped                     | MCP fixture protocol harness 草案（当前 skip，避免误读为真实 MCP runtime 已完成）                                                                                                                                          |
| `src/eval/mcp/mcp-suite.test.ts`                               | 5 skipped                     | fixture tool call、resource read、error recovery、tool timeout、server crash 草案（当前 skip，避免误读为真实 MCP 功能）                                                                                                    |
| `src/eval/team/team-assertions.test.ts`                        | 1 skipped                     | Team 事件筛选与按 agent 分组工具调用 helper 草案（当前 skip，避免误读为真实 Team runtime 已完成）                                                                                                                          |
| `src/eval/team/team-suite.test.ts`                             | 5 skipped                     | review-and-fix、readonly analysis、member failure、permission inheritance、Team MCP delegation 草案（当前 skip，避免误读为真实 Team 功能）                                                                                 |
| `src/eval/live/live-suite.test.ts`                             | 2                             | live LLM wrapper 事件发射、maxCalls 限制（默认 skip，需 `EVAL_LIVE=1`）                                                                                                                                                    |
| `src/eval/live/live-regression-suite.test.ts`                  | 6                             | 读结构化文件、写入 sentinel 报告、编辑保留内容、只读 bash、权限拒绝、多轮上下文共享（默认 skip，需 `EVAL_LIVE_REGRESSION=1`）；5 个 case 内置 judge rubric，`EVAL_JUDGE=1` 启用                                            |
| `src/eval/live/live-full-suite.test.ts`                        | 4 release + 3 nightly skipped | TODO 文件修改、confirmed Memory 创建/读回、seed Skill 输出、SubAgent 只读分析（默认 skip，需 `EVAL_LIVE_FULL=1`）；Nightly 预留 Task/Async/Schedule                                                                        |
| `src/eval/live/live-mcp-suite.test.ts`                         | 3 skipped                     | 真实 LLM + MCP fixture harness 草案（当前无条件 skip，待真实 MCP runtime 后恢复）                                                                                                                                          |
| `src/eval/live/live-team-suite.test.ts`                        | 2 skipped                     | 真实 LLM + Team harness / Team+MCP mixed 草案（当前无条件 skip，待真实 Team runtime 后恢复）                                                                                                                               |
| `src/execution-policy.test.ts`                                 | 12                            | readonly/ci/workspace_write profile、命令白名单、资源边界                                                                                                                                                                  |
| `src/output-store.test.ts`                                     | 7                             | output_id 生成、index 校验、分片读取、路径边界                                                                                                                                                                             |
| `src/tools/output.test.ts`                                     | 4                             | run_output_read 参数校验、分片读取、错误传播                                                                                                                                                                               |
| `src/schedule-store.test.ts`                                   | 33                            | Schedule 文件/occurrence 校验、当前项目默认过滤、跨项目显式列表、索引重建、occurrence 排序和 limit                                                                                                                         |
| `src/schedules.test.ts`                                        | 28                            | ScheduleManager 创建/触发/取消/删除、当前项目触发边界、orphaned 重启收敛、orphaned 后 overlap 不阻塞、async finish 回写、nextRunAt 计算                                                                                    |
| `src/tools/schedules.test.ts`                                  | 4                             | 6 个 Schedule 工具定义、未实现字段不暴露、current_project_only 透传、创建时固定当前实现策略默认值                                                                                                                          |
| `src/system-prompt.test.ts`                                    | 20                            | buildSystemPrompt 组合、AGENTS.md 项目指令头、snapshot 稳定性、refreshSnapshot、ignore memory reminder                                                                                                                     |
| `src/session-events.test.ts`                                   | 5                             | drain 清空、peek 不清空、顺序保持                                                                                                                                                                                          |
| `src/transcript.test.ts`                                       | 6                             | 消息分类、事件 sequence、historySequence、timing 元信息、搜索                                                                                                                                                              |
| `src/cache-debug.test.ts`                                      | 7                             | inspect 变化检测、system prompt 不变性、formatCacheDebugLog                                                                                                                                                                |
| `src/llm-providers.test.ts`                                    | 26                            | provider 解析、默认值、覆盖优先级、错误提示、能力标记                                                                                                                                                                      |
| `src/config.test.ts`                                           | 5                             | loadConfig 解析 provider 字段、compression/logLevel 默认值、错误信息不泄漏 key                                                                                                                                             |
| `src/llm.test.ts`                                              | 10                            | non-streaming 路径、streaming content/tool_calls 聚合、llmLogger 调用                                                                                                                                                      |
| `src/foundation-models.test.ts`                                | 14                            | Profile 注册表、exact/prefix/fallback 匹配、provider 兼容校验、显式 profile、stale warning                                                                                                                                 |
| `src/runtime-policy.test.ts`                                   | 19                            | Policy 默认值、env 覆盖、非法覆盖报错、协议 fallback、compression 派生                                                                                                                                                     |
| `src/context-budget.test.ts`                                   | 9                             | 三种模式预算分配、总和约束、override 处理、裁剪优先级、极小预算边界                                                                                                                                                        |
| `src/runtime-policy-store.test.ts`                             | 15                            | Override 合并、reset、snapshot、非法更新报错                                                                                                                                                                               |
| `src/llm-adapter.test.ts`                                      | 15                            | 请求构建、reasoning 占位、streaming 聚合、max token 字段、usage 解析                                                                                                                                                       |
| `src/stable-context.test.ts`                                   | 36                            | Repo map、pin/unpin、buildMessages、预算裁剪、hash 稳定性、安全边界、ContextRanker 集成、stable pack 隔离、stable snapshot 缓存、notifyFileChanged                                                                         |
| `src/context-ranking.test.ts`                                  | 82                            | 文件角色识别、生态识别、Repo 分类（TS/Python/Rust/Go/docs/infra/mixed）、任务意图、多维度评分、排序、文件扫描、import graph、完整 fixture                                                                                  |
| `src/cli-commands.test.ts`                                     | 22                            | /task /schedule /m /t /c 命令分发、中文参数、非法值报错、/c 排 /c why 排序命令                                                                                                                                             |
| `src/config.test.ts`                                           | 5                             | loadConfig 解析 provider 字段、policy 解析链、compression/logLevel 默认值                                                                                                                                                  |
| `src/index.test.ts`                                            | 1                             | 占位                                                                                                                                                                                                                       |

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
- **Stable Snapshot 缓存**：`StableContextManager` 将 stable pack 渲染后的字符串缓存为会话级快照，只在 pin/unpin/rebuild/invalidate 时失效重建；`currentQuery`、`recentFiles`、`mtime`、`git diff` 等动态信号永远不进入 stable，确保 prompt cache 前缀字节级稳定

## 重构经验

以下是重构过程中积累的经验，供后续生成代码时参考：

### 平行数组是隐式耦合的高风险点

当两个数组必须一一对应（如 messages 和 messageRounds），任何绕过同步函数的直接操作都会破坏对齐。解决方案：将元信息封装到统一存储中（如 history 内部的 rounds 数组），只暴露单一写入路径（`add()`），从接口层面消除失同步可能。

### 向后兼容的接口扩展

扩展接口时，新参数用可选类型（`meta?: { round?: number }`）。这样所有现有调用无需修改，新功能按需启用。`exactOptionalPropertyTypes` 严格模式下，返回的对象不能包含值为 undefined 的可选字段，需要条件赋值。

### 压缩管道的注释解耦

`prepareMessages()` 通过内部 timing 元数据与 `message-block.ts` 的 `groupToBlocks()` 通信。这个"协议"是松耦合的：`_turnIndex/_loopRound/_loopIndex/_messageSequence/_round` 作为临时元数据，在 `flattenToMessages()` 中被清除，不会发送给 LLM API。只要内部字段的注入格式不变，下游模块（normalize、groupToBlocks、compressor）无需知道 History 的内部数组结构。

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

数据从细粒度聚合为粗粒度，再还原为细粒度时，还原步骤必须优先使用原始元素自带的元数据，不能把聚合值当作原始值的替代品。`groupToBlocks` 会给 block 打聚合 timing 标签，但块内各条消息仍保留各自的内部 timing 字段；`blocksToEntries` 还原时若统一使用 block 聚合值，就会丢失原始粒度。任何"分组 → 处理 → 还原"的管道，在还原阶段都要问自己：原始元素上是否还有比分组键更细的信息需要保留。

### 状态变更后显式刷新所有派生值

修改一个核心状态后，必须在其作用域内列出所有直接和间接消费者（日志、缓存 key、调试信息、派生状态、校验和等），逐一确认是否同步重建。当修改发生在循环或条件分支内部时，这个检查尤其容易遗漏，因为人眼会默认"外面那行初始化就够了"。建立一个简单的自检习惯：写完状态修改语句后，回头扫一遍同作用域内所有引用过该状态的变量。

### 跨模块状态对象必须显式约定时态

当多个模块共享一个可变状态对象时，接口必须声明该状态在调用前后的预期形态。是"调用前已由调用方递增"，还是"调用后由本函数递增"？是"传入原始值，函数内部负责计数"，还是"传入已计数状态，函数只负责读取"？不能让调用方和实现方各自猜测。最安全的做法是：纯函数只读状态并返回文案，状态修改完全由调用方控制；如果纯函数需要展示"第 N 次"，则让它接收一个已经计算好的序号，而不是在内部对状态做算术。

### 概括性 Review 描述必须拆解为枚举检查清单

当 reviewer 给出概括性反馈（如"所有 interval 规则都要锚定 startsAt"）时，不能凭直觉选择性修复。必须先将该描述拆解为**穷举清单**（每种 rule.kind × 每个关键参数），然后逐条验证。人脑对"所有"的理解会自动过滤掉边缘分支，而边缘分支恰恰是 bug 藏身之处。检查清单应包含：每个分支是否都处理、每个新增参数是否在所有消费者中传递、每个修改的函数是否所有调用点都已同步。

### 接口-实现-测试三角必须同步验证

任何对外暴露的可配置参数（schema 声明、函数签名、CLI 参数），必须在三个层面同时存在且语义一致：1）接口契约层（schema/type/doc），2）实现逻辑层（代码中真正读取并使用该参数），3）测试覆盖层（至少包含默认值、边界值、非默认值三种情况）。三者中任何一处缺失都会导致"接口承诺了但实现忽略"的隐蔽缺陷。修复时应先找到该参数的所有消费点，确认每一处都使用，而不是只改最明显的那个。

### 反复出现的症状必须追溯到根因代码

清理现场（删除错误文件、修正数据）而不追溯到"哪一行代码在持续产生这个结果"，等于给问题装上自动续期。当同一症状第二次出现时，应立即停止"再删一次"的冲动，转而执行根因分析：搜索项目中产生该文件/状态/副作用的所有代码路径，确认源头后修复。对于测试生成的副作用，应检查测试中的 mock 和工厂函数调用，确认参数传递是否符合预期。

### 文档同步是完成定义（Definition of Done）的硬性条目

代码能跑、测试通过只是"技术完成"，不是"项目完成"。架构文档（如本 summary）是下一个 agent/开发者的入口，如果它停留在旧状态，后续工作会基于过时假设展开。把"更新 summary.md"写入 DoD 并与测试、lint 放在同一优先级：代码合并前必须确认文档已同步。文档更新不是"有空再做"，而是防止知识流失的保险。

### 计算类功能的测试矩阵必须覆盖分支 × 参数边界

实现调度、时间计算、状态转换等规则引擎时，测试不能仅覆盖"主流程通得过"。必须构建**分支 × 参数**的测试矩阵：每种规则类型（once/recurring 的每个子类型）× 每个可变参数的最小值、典型值、边界值 × startsAt 与 after 的相对位置关系（startsAt > after、startsAt < after < next、after > next）。没有矩阵覆盖的计算逻辑，其正确性只能依赖"开发者当时想对了"。

### Review 修复的完整性需要在下一轮重新验证

第一轮 review 修复后，第二轮 review 常常会发现第一轮修复的遗漏或新问题。这不是 reviewer"故意找茬"，而是第一轮修复改变了代码路径，暴露了之前被隐藏的问题。因此，上一轮 review 中所有概括性描述的修复项，在下一轮应**重新转化为检查清单**，逐一验证是否真正完整。不能把"上一轮修过了"当作免审金牌。

## 待实现 / 未来方向

（按需在后续 lesson 中实现，完成后更新此列表）

- 更丰富的工具集（grep、glob、web fetch 等）
- Skill 脚本执行支持（dependencies 字段、base path 引用脚本）
- 用户级 skill 目录（`~/.claude/skills/`）
- 对话创建 skill（LLM 自动在 skills/ 下创建目录和 SKILL.md）
- Anthropic Messages Adapter（MiniMax M3 / Qwen3.7 等模型的 Anthropic-compatible 入口）
- Task Shape Classifier（按请求类型自动调整 thinking 与 context budget）
- 多模型路由（主模型、cheap subagent、verifier 分开配置）
- 多模态 Tool Result（text/image/video blocks）
- 成本感知调度（根据 usage 做预算提示）
