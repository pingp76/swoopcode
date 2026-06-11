# 设计文档索引

本目录保存公开版设计文档。文档按教程章节组织，文件名使用 `pdd-序号-主题.md`，方便学生在阅读网页版教程时回到对应的工程设计。

这些文档描述的是当前代码已经实现或明确保留的设计边界。早期重构计划、阶段 checklist、实现过程中产生的内部工作记录已经合并回对应 PDD，不再作为独立公开文档维护。

## 主线章节

| 教程章节 | 设计文档                      | 主题                        |
| -------- | ----------------------------- | --------------------------- |
| 01       | `pdd-01-agent-loop.md`        | 最小 Agent Loop             |
| 02       | `pdd-02-tools.md`             | 工具调用与核心文件/命令工具 |
| 03       | `pdd-03-todo.md`              | Session TODO                |
| 04       | `pdd-04-subagent.md`          | SubAgent 工具               |
| 05       | `pdd-05-skill.md`             | Skill 系统                  |
| 06       | `pdd-06-compression.md`       | 上下文压缩                  |
| 07       | `pdd-07-permission.md`        | 权限管理                    |
| 08       | `pdd-08-hooks.md`             | Hook 机制                   |
| 09       | `pdd-09-memory.md`            | 长期记忆                    |
| 10       | `pdd-10-cache.md`             | Prompt Cache 友好请求布局   |
| 11       | `pdd-11-recovery.md`          | LLM 错误恢复                |
| 12       | `pdd-12-tasks.md`             | 持久化 Task                 |
| 13       | `pdd-13-async-run.md`         | Async Run                   |
| 14       | `pdd-14-schedule.md`          | Schedule 定时运行           |
| 15       | `pdd-15-runtime-hardening.md` | 运行时鲁棒性                |

## 专题章节

| 教程专题  | 设计文档                  | 主题                                                         |
| --------- | ------------------------- | ------------------------------------------------------------ |
| 模型适配  | `pdd-16-model-policy.md`  | Provider Profile + Foundation Model Profile + Runtime Policy |
| Eval      | `pdd-17-eval-harness.md`  | Eval Core、Deterministic、Replay、Live、Judge、Full-tools    |
| Eval 原型 | `pdd-18-eval-mcp-team.md` | MCP 与 Agent Team Eval Harness Prototype                     |

## 维护规则

1. 如果代码实现发生变化，优先更新对应主题 PDD，再更新 `summary.md`。
2. 不再新增 `refactor-*` 工作记录文档；重构结论应合并到对应 PDD 的“当前实现”或“设计取舍”小节。
3. 如果新增教程章节，先新增对应 `pdd-xx-topic.md`，再让教程引用它。
4. PDD 可以保留未来扩展方向，但必须明确区分“当前已实现”和“未来可扩展”。
