# Contributing to Swoop Code

感谢你愿意参与 Swoop Code。这个项目是一个教学用途的 TypeScript Coding Agent，贡献时请优先保证代码、文档和测试都便于学习者理解。

## 适合贡献的方向

- 修复 bug 或补充缺失测试
- 改进中文教程、PDD 或 README
- 增加 deterministic / replay / live / judge eval case
- 完善模型适配、Runtime Policy 或 Provider Profile
- 推进 MCP Runtime、Agent Team、多 agent 协作等路线图能力
- 改善开发体验、CI、文档结构和开源协作流程

## 开发准备

```bash
npm install
cp .env.example .env
```

如果只运行确定性测试，不需要真实 LLM API key。Live eval 需要在 `.env` 中配置可用模型。

## 本地验证

提交 PR 前建议至少运行：

```bash
npm run typecheck
npm test
npm run lint
npm run format:check
npm run tutorial:check
npm run build
```

如果只改教程，可优先运行：

```bash
npm run tutorial:check
```

如果只改某个模块，可先运行相关测试文件，再根据影响范围补跑完整测试。

## 代码与文档约定

- 源码放在 `src/`，测试与源码 co-locate，命名为 `*.test.ts`。
- 这是教学项目，重要实现需要中文注释解释设计目的和原理。
- 保持改动聚焦，不做与当前问题无关的大重构。
- 如果功能状态变化，请同步更新 `doc/summary.md` 和相关 PDD。
- MCP、Agent Team 等 prototype 能力必须明确标注为 prototype/skipped，避免让读者误解为生产能力。
- 不要提交 `.env`、日志、临时 workspace、个人 memory 或真实 API key。

## Pull Request 建议

PR 描述请说明：

- 改了什么
- 为什么改
- 如何验证
- 是否影响教程、PDD、README 或 eval 状态

如果 PR 引入新能力，请优先补充测试或 eval case。对于会调用真实模型的测试，请保持默认 skipped，并用环境变量显式开启。
