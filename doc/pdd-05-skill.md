# PDD-05: Skill 系统

## 对应教程

第 05 章：给 Agent 可按需加载的能力说明。

## 设计目的

Skill 是可复用的提示和流程说明，不是本地可执行工具。它让模型在需要某类任务时读取专门指导，例如 code review、代码解释、测试策略。

## 当前实现

核心源码：

| 文件                    | 职责                                        |
| ----------------------- | ------------------------------------------- |
| `src/skills.ts`         | Skill 扫描、加载、调用、移除与工具 provider |
| `src/skills.test.ts`    | Skill manager 与工具行为测试                |
| `src/system-prompt.ts`  | 在稳定 prompt 中注入轻量 skill hint         |
| `src/session-events.ts` | Skill 变化通过动态 reminder 告知当前会话    |

## Skill 与 Tool 的区别

| 项             | Skill              | Tool             |
| -------------- | ------------------ | ---------------- |
| 本质           | 文档化能力说明     | 可执行本地动作   |
| 是否产生副作用 | 否                 | 可能             |
| 由谁执行       | LLM 阅读后改变策略 | harness 执行函数 |
| 典型文件       | `SKILL.md`         | `src/tools/*.ts` |

## 存储与格式

Skill 通常由一个目录和 `SKILL.md` 组成。`SKILL.md` 可包含 frontmatter 和正文：

- frontmatter 提供 name、description 等轻量索引。
- body 提供详细步骤、注意事项、输出格式。

当前实现不做复杂 YAML 语义，只保留教学项目需要的轻量解析。

## Prompt Cache 边界

Skill 列表的轻量 hint 可以进入稳定 prompt snapshot。Skill 内容的加载、移除或刷新不应在当前会话中重写完整 system prompt，而应通过 session reminder 通知模型。

## 测试入口

- `src/skills.test.ts`
- `src/system-prompt.test.ts`
- `src/session-events.test.ts`

## 常见错误

1. 把 Skill 当成本地工具执行。
2. 每轮自动把所有 Skill 全文塞进 system prompt。
3. Skill 文件变化后直接重写稳定 prompt。
4. 让 Skill 覆盖当前真实文件观察结果。

## 非目标

当前项目不实现 Skill marketplace、远程同步、复杂依赖解析或自动向量检索。
