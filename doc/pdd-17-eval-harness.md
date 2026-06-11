# PDD-17: Eval Harness 与当前单 Agent E2E

## 对应教程

专题 B：如何测试一个不确定的 Coding Agent。

## 设计目的

Agent 行为不能只靠人工跑一次观察。Eval Harness 的目标是用结构化 case、driver、trace 和 assertion 验证 harness 行为。

本 PDD 合并旧版 Eval Core 工作稿和 Full-tools Live E2E 工作稿：

- Eval Core：Deterministic、Replay、Live、Judge/Report。
- Full-tools Live E2E：当前复杂功能回归。

## 当前实现

核心源码：

| 文件/目录                             | 职责                                                                      |
| ------------------------------------- | ------------------------------------------------------------------------- |
| `src/eval/core/`                      | EvalCase、Driver、Runner、Trace、Assertion、Report                        |
| `src/eval/drivers/learn-claude-code/` | 当前项目 in-process driver、scripted LLM、scripted terminal、tool tracing |
| `src/eval/drivers/cli/cli-driver.ts`  | CLI 黑盒 driver                                                           |
| `src/eval/cases/`                     | deterministic suite 与 replay suite                                       |
| `src/eval/replay/`                    | replay LLM fixture                                                        |
| `src/eval/live/`                      | opt-in live smoke/regression/full suite                                   |
| `src/eval/judge/`                     | LLM judge 与鲁棒 JSON parser                                              |
| `src/eval/core/report.ts`             | JSON/Markdown report 聚合                                                 |

## 分层策略

1. Deterministic first：默认 CI 先跑 scripted LLM + fake/core tools。
2. Trace first：用结构化事件证明发生了什么，而不是只看最终文本。
3. Hard assertions before judge：文件、工具、权限等事实先机器断言，judge 只补语义判断。
4. Live opt-in：真实模型测试默认 skip，需要环境变量显式启用。
5. Temporary workspace：真实工具 eval 必须使用临时 workspace 和临时 agentHome，不能污染用户真实数据。

## 当前 case 能力

已实现能力包括：

- Eval Core runner。
- 当前项目 in-process driver。
- ScriptedLLM、ScriptedTerminal。
- Fake Tool Registry。
- 真实核心工具 registry。
- CLI driver。
- deterministic suite。
- replay fixture。
- live smoke。
- live regression。
- full-tool runtime。
- full-system live release/nightly case。
- judge suite。
- report 聚合。

## 启用边界

普通测试不调用真实 LLM：

```bash
npm run test:eval
```

真实模型相关 suite 需要 opt-in，例如：

```bash
EVAL_LIVE=1 npm run test:eval:live
EVAL_JUDGE=1 npm run test:eval:judge
```

具体脚本以 `package.json` 和 `src/eval/README.md` 为准。

## 测试入口

- `src/eval/runner.test.ts`
- `src/eval/cases/deterministic.test.ts`
- `src/eval/cases/replay-suite.test.ts`
- `src/eval/live/live-suite.test.ts`
- `src/eval/live/live-regression-suite.test.ts`
- `src/eval/live/live-full-suite.test.ts`
- `src/eval/judge/judge-suite.test.ts`
- `src/eval/drivers/learn-claude-code/full-tool-runtime.test.ts`

## 常见错误

1. 一开始就依赖真实 LLM，导致测试不稳定。
2. 只断言最终文本，不记录工具调用和权限事件。
3. 把 judge 当唯一真相。
4. 真实工具 eval 写入当前仓库或真实 agentHome。
5. 把 live suite 当默认 CI 硬门禁。

## 非目标

当前 Eval Harness 不做完整 dashboard，不做自动录制真实 LLM response，不对真实模型输出做完整 golden snapshot。
