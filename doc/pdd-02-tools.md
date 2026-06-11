# PDD-02: 工具调用与核心工具

## 对应教程

第 02 章：给 Agent 一双手。

## 设计目的

LLM 不能直接读文件、写文件或执行 shell。工具系统把模型的“动作意图”转换成受控的本地函数调用。

核心原则：

```text
模型只提出 tool call
  -> Agent 校验 tool name 与 arguments
  -> PermissionManager 先检查权限
  -> ToolRegistry 找到实现并执行
  -> tool result 写回 History
  -> 下一轮 LLM 基于观察结果继续
```

## 当前实现

核心源码：

| 文件                    | 职责                                                  |
| ----------------------- | ----------------------------------------------------- |
| `src/tools/types.ts`    | `ToolResult` 等共享类型                               |
| `src/tools/registry.ts` | 工具注册表、定义导出、重复注册保护                    |
| `src/tools/bash.ts`     | `run_bash`，执行 shell 命令并应用硬安全规则           |
| `src/tools/files.ts`    | `run_read`、`run_write`、`run_edit`、`run_edit_exact` |
| `src/tools/output.ts`   | `run_output_read`，读取 OutputStore 登记的大输出      |
| `src/agent.ts`          | 解析 tool call、权限检查、执行工具、回写 tool result  |
| `src/command-safety.ts` | shell 命令硬黑名单                                    |

## 当前工具列表

| 工具              | 当前语义                                      |
| ----------------- | --------------------------------------------- |
| `run_bash`        | 在项目边界内执行命令，拒绝危险命令形态        |
| `run_read`        | 读取 workspace 内文本文件                     |
| `run_write`       | 写入 workspace 内文件                         |
| `run_edit`        | 早期教学用字符串替换工具，保留语义兼容        |
| `run_edit_exact`  | 更安全的精确编辑工具，要求匹配唯一片段        |
| `run_output_read` | 用 `output_id` 读取大输出，不暴露内部绝对路径 |

后续章节注册的 TODO、SubAgent、Skill、Memory、Task、Async Run、Schedule 等工具也统一通过 `ToolRegistry` 暴露。

## 工具调用不变量

1. tool name 必须存在于 registry。
2. arguments 必须能被解析并通过工具自身校验。
3. 权限检查发生在执行前。
4. 每个 assistant tool call 必须有对应 tool result。
5. tool result 必须写回 History，下一轮 LLM 才能观察到执行结果。
6. 大输出优先登记到 OutputStore，再以 `output_id` 形式暴露给模型。

## 文件工具边界

文件工具只允许访问项目根目录内路径。路径必须解析为绝对路径后再校验，不能只做字符串前缀判断。

`run_edit_exact` 是当前推荐编辑工具：

- 要求 old text 唯一匹配。
- 不做模糊 patch 解析。
- 不自动猜测用户想改的位置。
- 失败时返回清晰错误，让模型重新读取文件后再尝试。

## Bash 工具边界

`run_bash` 先走 `command-safety.ts` 的硬拒绝规则，再由权限系统决定是否允许执行。危险删除、重置、越界写入等命令不能靠模型自觉避免。

## 测试入口

- `src/tools/registry.test.ts`
- `src/tools/bash.test.ts`
- `src/tools/files.test.ts`
- `src/tools/output.test.ts`
- `src/agent.test.ts`
- `src/permission.test.ts`

## 常见错误

1. 让模型输出自由文本命令，然后直接执行。
2. 工具执行后只打印结果，不把 tool result 写回 History。
3. 工具定义顺序不稳定，破坏 prompt cache 友好布局。
4. 把本地绝对路径暴露给 LLM，而不是使用 `output_id`。
5. 在工具内部绕过 PermissionManager。

## 非目标

当前项目不实现完整 patch parser，不实现远程工具市场，也不把 MCP 作为生产工具运行时。MCP 相关内容只在 Eval 原型 PDD 中出现。
