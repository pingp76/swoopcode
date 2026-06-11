# PDD-04: SubAgent 工具

## 动机

父智能体在执行旁支任务（如搜索代码、分析文件、跑测试）时，中间过程会产生大量
工具调用消息，污染主对话上下文。SubAgent 将这些中间过程隔离到独立的上下文中，
只将最终结果返回给父智能体。

## 核心设计

SubAgent 本质是一个名为 `run_subagent` 的工具，其执行函数内部创建一个新的
Agent 实例来独立运行任务。

## 数据流

```
父智能体 LLM 决定调用 run_subagent(task, max_rounds)
     │
     ▼
run_subagent 工具执行函数：
  1. 创建独立的 History（设置 system prompt hint，帮助子智能体使用 skill）
  2. 创建过滤后的 ToolRegistry（保留 bash + files + skill，排除 run_subagent 和 run_todo_*）
  3. 创建独立的 ContextCompressor 实例（隔离压缩状态）
  4. 创建子 Agent 实例（复用父级的 llm、logger、permissionManager）
  5. 将 task 作为 query 传给子 Agent
     │
     ▼
子 Agent 独立运行 think → act → observe 循环
  - 有自己的轮数上限（默认 20，由参数覆盖）
  - 共享父级 PermissionManager（子智能体内 ask 决策降级为 deny）
  - LLM 调用失败 → 将错误信息作为 tool_result 返回
  - 达到轮数上限 → 将已有中间结果总结后返回
     │
     ▼
子 Agent 返回最终文本 → 作为 run_subagent 工具的 ToolResult
     │
     ▼
父智能体在 history 中看到 tool_result，继续后续推理
```

## 接口设计

### run_subagent 工具参数

- task (string, 必填)：子智能体需要完成的具体任务描述
- max_rounds (number, 可选, 默认 20)：子智能体最大循环轮数

### 子智能体的依赖

- LLM Client：复用父级的（共享连接和配置）
- Logger：复用父级的（子智能体日志带 `[SubAgent]` 前缀）
- History：独立新建（设置 system prompt hint，不与父级共享引用）
- ToolRegistry：过滤后新建（通过 `createFilteredRegistry()` 工厂函数，排除递归风险工具）
- ContextCompressor：独立新建（隔离压缩状态，不与父级共享）
- PermissionManager：共享父级的（子智能体继承同一权限模式，不传 `askUserFn`，ask 降级为 deny）

### 工具过滤规则

- 保留：run_bash、run_read、run_write、run_edit、run_skill
- 排除：run*subagent（防止无限递归）、run_todo*\* 全部（防止干扰父级任务状态）

## 停止条件

- 任务完成：子 Agent 的 run() 返回文本回复（LLM 不再请求工具调用）
- 轮数上限：达到 max_rounds 时，强制截断并总结已有结果
- LLM 错误：连续 LLM 调用失败时，返回最后一次的错误信息

## 限制

- 子智能体只能返回 ToolResult（output + error），不能修改父智能体的上下文
- 子智能体不能创建其他子智能体（通过工具过滤保证）
- 父智能体在子智能体运行期间处于阻塞状态（同步等待结果）
- 父智能体应避免并行创建多个修改同一文件的子智能体（资源冲突由调用者负责）
- 子智能体内的权限 `ask` 决策降级为 `deny`（无 `askUserFn` 回调）

## 循环依赖的解决

`subagent.ts` 不直接 `import createAgent`，而是通过参数注入 `createAgentFn`：

```
agent.ts → registry.ts → subagent.ts —如果 import createAgent→ agent.ts  ← 循环！
                                      —通过注入 createAgentFn→ 打破循环
```

实际的依赖组装在 `index.ts`（组装根）中完成：

```typescript
const subagentProvider = createSubagentToolProvider({
  llm,
  logger,
  createFilteredRegistry: () =>
    createToolRegistry(undefined, undefined, skillProvider),
  createAgentFn: createAgent,
  createCompressorFn: () => createContextCompressor(config.compression),
  permissionManager,
});
```

## 与现有架构的集成

- 通过 `SubagentToolProvider` 接口注册到 `tools/registry.ts`
- 子智能体复用 `createAgent()` 工厂函数，传入过滤后的依赖
- 实现在 `src/tools/subagent.ts`，包含工具定义和执行逻辑
