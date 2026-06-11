# Swoop Code

## 致谢

首先感谢 [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)。Swoop Code 最初是作者对该项目做的一版 TypeScript 实现，随后在这个基础上继续扩展、重构和教学化，逐步加入更完整的 agent runtime、上下文管理、权限边界、评测体系和网页教程。

## 项目简介

Swoop Code 的仓库名和包名是 `swoopcode`。项目中的所有代码和大部分文档都由 Codex、Kimi、GLM 协作完成。它是一个教学用途的 TypeScript Coding Agent。它不是把生产级 agent 框架藏在抽象后面，而是用尽量清晰、可阅读、可测试的代码，展示一个 coding agent 从最小 loop 到完整 harness 的逐步构建过程。

`Swoop` 的灵感来自跳伞运动中的“拉飘”：降落前从高速俯冲转为拉平滑翔，再把速度和方向收束到一个精准落点。这个名字也对应本项目想表达的 coding agent harness：让模型从自由生成的“自由落体”，进入有工具、有权限、有上下文、有验证的受控执行过程，最后把任务稳稳落到代码和结果上。

项目仍在持续推进中。当前版本已经覆盖单 Agent runtime 的大部分教学主线，后续还会继续补充 MCP runtime、Agent Team、多 agent 协作、更多真实模型适配和更系统的端到端评测。欢迎对 coding agent 感兴趣的朋友一起贡献设计、实现、测试、教程和案例。

项目适合：

- 想理解 coding agent 内部工作机制的开发者
- 想学习 tool calling、上下文压缩、权限控制、subagent、memory、async run、schedule 等模块如何接入 agent loop 的同学
- 想通过 TypeScript 代码和中文设计文档复现一个教学型 agent runtime 的读者
- 想研究如何为不确定的 agent 行为建立 deterministic / replay / live / judge eval 的工程实践者

## 功能特性

- **Agent Loop**：围绕 `think -> act -> observe` 构建主循环。
- **工具系统**：支持 bash、文件读写、精确编辑、任务管理、输出读取等工具。
- **权限管理**：在工具执行前统一检查路径、命令和运行模式边界。
- **上下文管理**：包含消息标准化、消息块、压缩、稳定上下文、prompt cache 友好布局。
- **SubAgent**：支持子智能体复用父级依赖，并保持独立上下文。
- **Skill 系统**：按需加载技能说明，避免把所有能力塞进稳定 prompt。
- **Memory**：提供跨会话长期记忆的扫描、读取、创建和删除能力。
- **Task / Async Run / Schedule**：支持持久化任务、非阻塞运行实例和定时触发。
- **LLM 适配层**：包含 Provider Profile、Foundation Model Profile、Runtime Policy 和 OpenAI Chat Completions 兼容协议适配。
- **Eval Harness**：覆盖 deterministic、replay、live smoke、judge/report、full-tools live E2E 等测试形态。
- **中文教程与 PDD**：`tutorial/` 提供网页教程，`doc/` 保存公开版设计文档。

> 说明：MCP 与 Agent Team 相关 eval 当前是 prototype/skipped 边界，用于展示评测 harness 的设计方向，并不表示项目已经具备生产级 MCP runtime 或真实 Agent Team runtime。

## 技术栈

- TypeScript
- Node.js >= 20
- ESM / NodeNext
- Vitest
- ESLint
- Prettier
- OpenAI SDK 兼容接口

## 快速开始

### 1. 克隆仓库

```bash
git clone https://github.com/pingp76/swoopcode.git
cd swoopcode
```

### 2. 安装依赖

```bash
npm install
```

### 3. 配置环境变量

复制环境变量示例：

```bash
cp .env.example .env
```

至少需要配置：

```bash
LLM_API_KEY=your-api-key-here
LLM_BASE_URL=https://api.moonshot.cn/v1
LLM_MODEL=kimi-k2.6
```

项目会根据 `LLM_BASE_URL` 和 `LLM_MODEL` 自动推断 provider 与模型画像；如果你使用代理、网关或自定义 OpenAI-compatible 服务，可以在 `.env` 中显式设置 `LLM_PROVIDER`、`LLM_MODEL_PROFILE`、`LLM_CONTEXT_BUDGET` 等配置。

### 4. 启动本地 Agent

```bash
npm run dev
```

## 常用命令

```bash
npm run build          # 编译 TypeScript 到 dist/
npm run dev            # 使用 tsx 运行本地 agent
npm test               # 运行全部测试
npm run test:watch     # watch 模式运行测试
npm run test:coverage  # 运行测试并生成覆盖率
npm run typecheck      # 只做类型检查
npm run lint           # 运行 ESLint
npm run format         # 格式化源码
npm run format:check   # 检查格式
```

运行单个测试文件：

```bash
npx vitest run src/path/to/file.test.ts
```

## 端到端集成测试

`swoopcode` 不只依赖普通单元测试，也内置了面向 coding agent 的 Eval Harness，用来验证一次完整任务从用户输入、LLM 决策、工具调用、权限处理、文件副作用到最终回复的端到端行为。

### 默认可运行的确定性 Eval

确定性 suite 使用 scripted LLM，不依赖真实模型，适合本地开发和 CI：

```bash
npm run test:eval
```

运行全部 eval 相关测试：

```bash
npx vitest run src/eval/
```

Replay suite 会从 fixture 读取录制好的 LLM 响应，复用同一套 agent driver：

```bash
npx vitest run src/eval/cases/replay-suite.test.ts
```

### 真实模型端到端测试

Live 测试默认不会运行，需要显式设置环境变量，并且需要 `.env` 中已有可用的 LLM 配置。

```bash
# Live smoke：少量真实模型冒烟 case
EVAL_LIVE=1 npm run test:eval:live

# Live regression：覆盖 read/write/edit/bash/permission/multi-turn 等 core tools
EVAL_LIVE_REGRESSION=1 npm run test:eval:live:regression

# Live full regression：覆盖 TODO、Memory、Skill、SubAgent 等完整工具链
EVAL_LIVE_FULL=1 npm run test:eval:live:full
```

其中 `EVAL_LIVE_FULL=1 npm run test:eval:live:full` 是当前主要的 full-tools 端到端集成测试入口。它会为每个 case 创建临时 workspace 和临时 `agentHome`，验证完整工具系统的协作，同时避免读写用户真实的 `~/.swoopcode`。

### Judge 评价

部分 live regression 和 full regression case 内置了 judge rubric。启用后会额外调用 LLM，对开放式输出做质量评价：

```bash
EVAL_LIVE_REGRESSION=1 EVAL_JUDGE=1 npm run test:eval:live:regression
EVAL_LIVE_FULL=1 EVAL_JUDGE=1 npm run test:eval:live:full
```

也可以指定单独的 judge 模型：

```bash
EVAL_LIVE_REGRESSION=1 EVAL_JUDGE=1 JUDGE_MODEL=gpt-4o-mini npm run test:eval:live:regression
```

### Prototype 边界

MCP 与 Agent Team 相关 suite 当前保留为 harness prototype，测试文件存在但默认 `describe.skip`，不代表项目已经实现生产级 MCP runtime 或真实 Agent Team runtime。相关脚本待这些运行时能力正式落地后再恢复为有效验收入口：

```bash
EVAL_LIVE_MCP=1 npm run test:eval:live:mcp
EVAL_LIVE_TEAM=1 npm run test:eval:live:team
EVAL_LIVE_TEAM=1 EVAL_LIVE_MCP=1 npm run test:eval:live:team:mcp
```

更完整的 case 说明、trace 输出和 driver 设计请阅读 [src/eval/README.md](./src/eval/README.md)。

## 文档与教程

- [项目状态总览](./doc/summary.md)：当前已实现模块和架构状态。
- [设计文档索引](./doc/README.md)：公开版 PDD 文档入口。
- [网页教程](./tutorial/README.md)：面向中文新手的 coding agent 教程。
- [Eval 系统说明](./src/eval/README.md)：评测 harness 的使用说明。
- [贡献指南](./CONTRIBUTING.md)：参与开发、文档和 eval 贡献前建议先读。
- [安全策略](./SECURITY.md)：安全问题报告方式和敏感数据处理建议。

启动网页教程：

```bash
npm run tutorial:dev
```

默认访问：

```text
http://127.0.0.1:5173
```

## 目录结构

```text
src/
  index.ts              # 组装根：创建共享实例并接线
  agent.ts              # Agent 主循环
  llm.ts                # LLM 客户端
  llm-adapter.ts        # 协议适配层
  system-prompt.ts      # 稳定 prompt 与动态 reminder 组合
  stable-context.ts     # 稳定上下文管理
  permission.ts         # 权限管理
  tasks.ts              # 持久化 Task 业务层
  async-runs.ts         # 非阻塞运行实例
  schedules.ts          # 定时运行系统
  tools/                # 工具实现与注册表
  eval/                 # Eval harness
doc/                    # 设计文档与项目状态
tutorial/               # 中文网页教程
skills/                 # 示例 Skill
```

更完整的模块说明请阅读 [doc/summary.md](./doc/summary.md)。

## 设计原则

- **教学优先**：代码强调可读性、解释性和阶段性演进，而不是追求最短实现。
- **Loop 优先**：每个功能都围绕 agent loop 的位置说明它为什么存在。
- **边界清晰**：权限、工具、上下文、长期状态、运行时策略各自有明确职责。
- **稳定前缀**：尽量保持 system prompt 和 tool definition 稳定，把动态状态放到 reminder 或消息尾部。
- **验证可见**：重要模块配套单元测试或 eval case，避免只凭一次 demo 判断 agent 能力。

## 路线图

Swoop Code 仍处于持续演进阶段，当前重点方向包括：

- **MCP Runtime**：从 eval fixture prototype 走向真实 MCP server 接入与工具/resource 调用。
- **Agent Team**：补齐真实多 agent runtime，让 planner、implementer、reviewer 等角色可以围绕同一 workspace 协作。
- **多模型适配**：继续完善不同 provider、不同模型能力画像和 runtime policy 的差异处理。
- **Eval 扩展**：增加更多 live/full-tools E2E case，让复杂 agent 行为有更稳定的回归验证。
- **教程完善**：继续把 PDD 和源码实现整理成更容易跟读、复现和二次开发的中文教程。

## 贡献

欢迎提交 issue、PR、设计讨论、测试用例、教程修订或真实使用反馈。尤其欢迎围绕 MCP、Agent Team、端到端 eval、模型适配和教学文档的贡献。

由于这是教学项目，贡献时请尽量保持：

- 代码路径和模块职责清楚
- 新增逻辑配套中文注释，解释“为什么这样设计”
- 重要行为有测试或 eval 覆盖
- 不把 prototype 能力写成已经生产可用的功能
- 修改实现后同步更新相关 PDD 或 `doc/summary.md`

## 许可

本项目采用 [MIT License](./LICENSE)。

本项目最初参考并改写自 [shareAI-lab/learn-claude-code](https://github.com/shareAI-lab/learn-claude-code)，感谢原项目作者。原项目同样采用 MIT License。
