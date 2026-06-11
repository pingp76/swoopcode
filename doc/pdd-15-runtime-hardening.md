# PDD-15: Runtime Hardening 与长期运行鲁棒性

## 对应教程

第 15 章：教学项目也不能运行一段时间后把自己弄坏。

## 设计目的

随着 Task、Async Run、Schedule、OutputStore、LLM 日志和 Eval trace 增加，agentHome 会持续产生运行态数据。Runtime Hardening 的目标是建立长期运行底线：

1. 写入不能留下半截 JSON。
2. 日志不能无限增长。
3. 输出引用不能轻易悬挂。
4. running 状态不能永远卡住。
5. 清理策略必须先可预览、可解释，再允许 apply。

## 当前实现状态

当前代码已经完成 Round A：

| 能力                  | 当前状态                                            |
| --------------------- | --------------------------------------------------- |
| 原子写入              | 已实现 `src/atomic-write.ts`                        |
| TaskStore 原子写      | 已接入                                              |
| ScheduleStore 原子写  | 已接入                                              |
| OutputStore 原子写    | 已接入                                              |
| LLM 日志轮转          | 已实现 `src/log-rotation.ts` 并接入 `llm-logger.ts` |
| Startup health check  | 未实现                                              |
| Cleanup dry-run/apply | 未实现                                              |
| Occurrence retention  | 未实现                                              |
| Output retention      | 未实现                                              |

## 当前源码

| 文件                    | 职责                                     |
| ----------------------- | ---------------------------------------- |
| `src/atomic-write.ts`   | 同目录临时文件 + rename 覆盖 + JSON 校验 |
| `src/log-rotation.ts`   | 单文件大小上限 + 固定历史份数            |
| `src/task-store.ts`     | Task 写入使用原子写                      |
| `src/schedule-store.ts` | Schedule/Occurrence/Index 写入使用原子写 |
| `src/output-store.ts`   | Output record 与 index 写入使用原子写    |
| `src/llm-logger.ts`     | LLM 日志 BOOT marker 和轮转              |

## 清理原则

虽然 cleanup 还没有实现，但设计边界已经确定：

- 用户资产不自动清理：Memory、Skill、AGENTS.md。
- 用户意图默认保留：Task Group、Schedule rule。
- 执行产物可按 TTL/大小/引用关系清理：logs、tool output、async legacy output、old occurrence。
- 任何清理都必须先 dry-run 生成候选和理由。
- 不确定是否安全删除时默认保留。

## 引用安全

OutputStore record 可能被 Schedule occurrence 或当前 session Async Run 引用。清理 output 前必须确认没有 durable 引用，不能留下“index 还在但内容读不了”的 handle。

## 测试入口

- `src/atomic-write.test.ts`
- `src/llm-logger.test.ts`
- `src/task-store.test.ts`
- `src/schedule-store.test.ts`
- `src/output-store.test.ts`

## 常见错误

1. 用普通写文件覆盖 JSON，进程崩溃后留下半截文件。
2. cleanup apply 不提供预览。
3. 删除 completed Task Group。
4. 删除 active Schedule 或最近失败 occurrence。
5. 清理 OutputStore 时不维护 index 和引用关系。

## 未来扩展

后续可按顺序实现：

1. Runtime health check。
2. Startup recovery。
3. Cleanup dry-run。
4. Cleanup apply。

这些能力尚未在当前代码中完成，公开文档和教程中不能把它们描述为已实现功能。
