# PDD-18: MCP 与 Agent Team Eval Harness Prototype

## 对应教程

专题 B 的高级原型部分：MCP 与 Agent Team 的测试边界。

## 设计目的

本 PDD 对应旧版 MCP / Agent Team Eval 工作稿。它不是生产级 MCP runtime 或真实 Agent Team runtime 的设计，而是 Eval Harness 中的原型层，用于提前定义未来能力的测试形状。

## 当前实现状态

当前代码已实现原型 scaffolding：

| 目录                                                | 当前状态                                                 |
| --------------------------------------------------- | -------------------------------------------------------- |
| `src/eval/mcp/`                                     | MCP fixture server、MCP trace/assertions、MCP suite 草案 |
| `src/eval/drivers/learn-claude-code/mcp-runtime.ts` | 当前项目 eval driver 中的 MCP runtime adapter 原型       |
| `src/eval/team/`                                    | Team schema、trace、assertions、suite 草案               |
| `src/eval/drivers/learn-claude-code/team-driver.ts` | 顺序 supervisor Team driver 原型                         |
| `src/eval/live/live-mcp-suite.test.ts`              | live MCP suite 原型                                      |
| `src/eval/live/live-team-suite.test.ts`             | live Team suite 原型                                     |

重要边界：由于项目尚未实现生产级 MCP runtime 或真实 Agent Team runtime，相关 MCP/Team 测试当前使用 `describe.skip`，避免被误读为真实功能已完成。

## MCP Eval 原型

目标：

- 用 fixture server 提供可控 MCP tool/resource。
- 记录协议级 MCP event。
- 断言模型是否调用了预期 MCP tool 或读取 resource。
- 不依赖真实外部 GitHub/Slack/数据库 MCP server。

当前原型服务 Eval，不代表主 Agent 已经支持生产 MCP 工具运行。

## Agent Team Eval 原型

目标：

- 定义 team case、member、handoff、trace、assertion 的测试形状。
- 用顺序 supervisor driver 模拟未来 team runtime。
- 验证角色隔离、工具边界、失败恢复和最终汇总的设计方向。

当前原型不代表项目已有真实多 Agent 调度器。

## 测试入口

这些测试文件存在，但默认跳过相关 suite：

- `src/eval/mcp/mcp-suite.test.ts`
- `src/eval/mcp/fixture-server.test.ts`
- `src/eval/team/team-suite.test.ts`
- `src/eval/team/team-assertions.test.ts`
- `src/eval/live/live-mcp-suite.test.ts`
- `src/eval/live/live-team-suite.test.ts`

## 文档边界

公开文档必须明确：

1. MCP/Team 是 Eval Harness prototype。
2. 默认 CI 不跑真实 MCP/live/team case。
3. fixture server first，不接真实第三方服务。
4. Team driver 是测试原型，不是生产调度器。

## 常见错误

1. 把 skipped prototype 测试宣传成生产能力。
2. 直接连接真实外部 MCP server 做默认测试。
3. 在 team eval 中绕过权限和工具边界。
4. 用自然语言日志替代结构化 trace。

## 非目标

当前项目不实现生产级 MCP server manager，不实现真实分布式 Agent Team，不实现跨进程 team scheduler，也不实现外部服务凭据管理。
