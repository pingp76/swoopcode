# PDD-07: 权限管理

## 对应教程

第 07 章：工具执行前的安全边界。

## 设计目的

LLM 可能提出有副作用或危险的工具调用。权限系统负责在执行前做明确决策：允许、拒绝或询问用户。

## 当前实现

核心源码：

| 文件                      | 职责                                          |
| ------------------------- | --------------------------------------------- |
| `src/permission.ts`       | 权限模式、黑白名单、路径边界、ask 降级        |
| `src/command-safety.ts`   | shell 命令硬拒绝规则                          |
| `src/execution-policy.ts` | 非交互执行边界，供 Async Run 和 Schedule 共享 |
| `src/agent.ts`            | 工具执行前调用 PermissionManager              |
| `src/cli-commands.ts`     | `/mode`、`/m`、`/t` 等命令入口                |

## 权限模式

| 模式      | 语义                                   |
| --------- | -------------------------------------- |
| `plan`    | 尽量不执行有副作用动作，用于规划和审阅 |
| `default` | 低风险操作可执行，敏感操作询问用户     |
| `auto`    | 更主动执行，但仍不能绕过硬拒绝规则     |

工具执行前必须先走权限检查。权限系统不是事后审计，也不是只靠 system prompt 约束模型。

## ExecutionPolicy

后续重构把非交互执行边界收口到 `src/execution-policy.ts`：

- `readonly`
- `ci`
- `workspace_write`

Async Run、Schedule、子智能体命令路径复用同一套 command/resource 校验，避免每个模块维护一套不同白名单。

## 路径边界

所有路径必须解析到项目根目录内。不能只用字符串前缀判断，也不能允许模型通过 `../`、symlink 或 shell 拼接绕过边界。

## 测试入口

- `src/permission.test.ts`
- `src/execution-policy.test.ts`
- `src/tools/bash.test.ts`
- `src/tools/files.test.ts`
- `src/agent.test.ts`

## 常见错误

1. 先执行工具，再询问用户。
2. 子智能体或 Async Run 重新实现一套权限规则。
3. 在 system prompt 里说“不要做危险事”，但代码没有硬拦截。
4. ask 在非交互路径中静默通过，而不是降级为 deny。

## 非目标

当前项目不实现多用户 ACL、企业策略中心、完整沙箱容器或远程审批流。
