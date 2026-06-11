# 设计文档索引

本目录保存公开版 PDD 设计文档。文件名统一使用 `pdd-序号-主题.md`，但正文尽量保留原始 PDD 的完整内容，方便学生在读完网页版教程后继续深入理解，甚至按设计文档完整复现工程。

整理原则：

1. 保留原始 PDD 的推导、设计目标、非目标、接口草案、实现步骤和验收标准。
2. 文件名和公开索引使用新的稳定命名，便于和教程章节互相引用。
3. 早期独立的 `refactor-*` 工作记录不再作为公开文档保留；已经落地的重构结论合并到相关模块 PDD 的“重构后实现对齐说明”中。
4. Eval 相关三份 PDD 保持独立，避免把基础 harness、live/replay/judge、MCP/Team prototype 混成一篇难以复现的大文档。
5. PDD 可以讨论未来扩展，但必须明确区分“当前已实现”“prototype/skipped”“未来可扩展”。

## 主线章节

| 教程章节 | 设计文档                      | 主题                        |
| -------- | ----------------------------- | --------------------------- |
| 01       | `pdd-01-agent-loop.md`        | 最小 Agent Loop             |
| 02       | `pdd-02-tools.md`             | 工具调用与核心文件/命令工具 |
| 03       | `pdd-03-todo.md`              | Session TODO                |
| 04       | `pdd-04-subagent.md`          | SubAgent 工具               |
| 05       | `pdd-05-skill.md`             | Skill 系统                  |
| 06       | `pdd-06-compression.md`       | 上下文压缩与消息管线        |
| 07       | `pdd-07-permission.md`        | 权限管理与执行边界          |
| 08       | `pdd-08-hooks.md`             | Hook 机制                   |
| 09       | `pdd-09-memory.md`            | 长期记忆                    |
| 10       | `pdd-10-cache.md`             | Prompt Cache 友好请求布局   |
| 11       | `pdd-11-recovery.md`          | LLM 错误恢复                |
| 12       | `pdd-12-tasks.md`             | 持久化 Task                 |
| 13       | `pdd-13-async-run.md`         | Async Run                   |
| 14       | `pdd-14-schedule.md`          | Schedule 定时运行           |
| 15       | `pdd-15-runtime-hardening.md` | 运行时鲁棒性                |

## 专题章节

| 教程专题 | 设计文档                           | 主题                                                         |
| -------- | ---------------------------------- | ------------------------------------------------------------ |
| 模型适配 | `pdd-16-model-policy.md`           | Provider Profile + Foundation Model Profile + Runtime Policy |
| Eval 1   | `pdd-17-eval-harness.md`           | Eval Core、Deterministic、真实 core tools、CLI driver        |
| Eval 2   | `pdd-18-eval-replay-live-judge.md` | Replay、Live Smoke、Judge/Report、Full-tools Live E2E        |
| Eval 3   | `pdd-19-eval-mcp-team.md`          | MCP 与 Agent Team Eval Harness Prototype                     |

## 维护规则

1. 如果代码实现发生变化，优先更新对应主题 PDD，再更新 `summary.md`。
2. 不新增 `refactor-*` 工作记录文档；重构结论应写入对应 PDD 的实现对齐、设计取舍或验收标准小节。
3. 如果新增教程章节，先新增对应 `pdd-xx-topic.md`，再让教程引用它。
4. 如果某个 PDD 是 prototype 或 skipped suite，标题和实现状态都要明确说明，避免学生误以为项目已经具备生产级能力。
5. 如果某个历史 PDD 与当前代码已有差异，保留历史推导，但在文末补充“当前实现边界”。
