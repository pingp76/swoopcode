# PDD-03: Session TODO 管理器

## 概述

为 Agent 的当前对话 session 实现一个任务级别的 todo list 管理功能。
LLM 通过 tool 调用创建和管理任务列表，自主控制执行节奏。

## 核心约束

- **session 级别**：只针对当前对话 session，不考虑 subagent 的任务管理，也不是项目级别的持久化
- **一个 session 最多一个活跃的 todo list**：新建时如果已有 list，LLM 需要先 cancel 旧的
- **LLM 自主决策**：LLM 可以决定不使用 todo list、创建新的、或取消已有的
- **纯 tool 驱动**：通过 tool registry 注册 todo 相关工具，agent 循环不需要改动

## 集成方式

采用**纯 tool 驱动**方式，与现有的 bash/files 工具完全一致：

- TODO manager 作为一个独立模块（`src/todo.ts`）
- 通过 `createTodoManager()` 工厂函数创建，内部状态通过闭包保护
- 将 todo 操作注册为 tool 到 registry（`run_todo_create`、`run_todo_update` 等）
- agent.ts 的 `for(;;)` 循环不需要任何改动

```
用户输入 → agent.run() → LLM → 调用 run_todo_create tool → 返回列表
                        → LLM → 调用 run_bash tool → 执行命令
                        → LLM → 调用 run_todo_update tool → 标记完成
                        → LLM → 文本回复给用户
```

## 状态机设计

### TodoList 状态

```
idle ──[create]──→ active ──[all completed]──→ completed
                  │                          ↑
                  ├──[cancel]──→ cancelled    │
                  │                          │
                  └──[interrupt]──→ interrupted ──[resume]──→ active
```

| 状态          | 说明                                           |
| ------------- | ---------------------------------------------- |
| `idle`        | 初始状态，没有 todo list                       |
| `active`      | 任务列表正在执行中                             |
| `completed`   | 所有任务已完成                                 |
| `cancelled`   | 用户或 LLM 取消了列表                          |
| `interrupted` | 执行被中断（用户中断、轮次上限、错误），可恢复 |

### Task 状态

```
pending ──[start]──→ in_progress ──[complete]──→ completed
                     │              ↑
                     ├──[skip]──→ skipped      │
                     │                          │
                     ├──[cancel]──→ cancelled   │
                     │                          │
                     └──[interrupt]──→ interrupted ──[resume]──→ in_progress
```

| 状态          | 说明             | 符号  |
| ------------- | ---------------- | ----- |
| `pending`     | 等待执行         | `[ ]` |
| `in_progress` | 正在执行         | `[>]` |
| `completed`   | 已完成           | `[x]` |
| `skipped`     | 被跳过           | `[-]` |
| `cancelled`   | 被取消           | `[_]` |
| `interrupted` | 执行中断，可恢复 | `[!]` |

### 状态转换规则

- `run_todo_create`：创建 list（状态 → active），所有 task 初始为 pending
- `run_todo_update(task_id, "in_progress")`：标记 task 为 in_progress
  - 自动将之前 in_progress 的 task 设为 interrupted
- `run_todo_update(task_id, "completed")`：标记 task 为 completed
  - 不自动推进到下一个 task，由 LLM 决定下一步
- `run_todo_update(task_id, "skipped")`：跳过当前 task
- `run_todo_cancel`：取消整个 list，所有非 completed 的 task 设为 cancelled
- 当所有 task 都处于终态（completed/skipped/cancelled）时，list 自动变为 completed

## Tool 定义

### `run_todo_create`

创建新的 todo list。如果已有活跃的 list，自动取消旧的。

```json
{
  "name": "run_todo_create",
  "parameters": {
    "tasks": {
      "type": "array",
      "items": { "type": "string" },
      "description": "任务描述列表，按执行顺序排列"
    }
  }
}
```

返回格式化的 todo list。

### `run_todo_update`

更新单个任务的状态，可选附带备注。

```json
{
  "name": "run_todo_update",
  "parameters": {
    "task_id": {
      "type": "string",
      "description": "任务 ID（从 run_todo_create 或 run_todo_list 获取）"
    },
    "status": {
      "type": "string",
      "enum": ["in_progress", "completed", "skipped"],
      "description": "目标状态"
    },
    "note": {
      "type": "string",
      "description": "可选的备注，记录当前进展或中断原因"
    }
  }
}
```

### `run_todo_add`

在列表中插入新任务。

```json
{
  "name": "run_todo_add",
  "parameters": {
    "task": {
      "type": "string",
      "description": "任务描述"
    },
    "after_task_id": {
      "type": "string",
      "description": "可选：插入到指定 task 之后。不提供则追加到末尾"
    }
  }
}
```

### `run_todo_remove`

从列表中删除任务。只能删除 pending 状态的 task。

```json
{
  "name": "run_todo_remove",
  "parameters": {
    "task_id": {
      "type": "string",
      "description": "要删除的任务 ID"
    }
  }
}
```

### `run_todo_list`

读取当前 todo list 的完整状态。

无参数。返回格式化的任务列表。

### `run_todo_cancel`

取消当前 todo list。

无参数。所有未完成的 task 标记为 cancelled，list 状态变为 cancelled。

## 格式化输出

所有返回 todo list 的 tool（create、list、update、add、remove、cancel）都使用统一格式：

```
[ ] 分析需求文档
[>] 编写数据库模型 (正在设计ER图)
[ ] 实现API接口
[-] 编写文档（已跳过）

(1/4 completed, 1 skipped)
```

规则：

- 每个 task 一行：`[符号] 任务描述`
- in_progress 的 task 如果有 note，追加 `(note内容)`
- 最后一行统计：`(N/M completed`，如有 skipped/cancelled 则追加

## 轮次上限

### 定义

**一轮** = agent loop 的一次完整迭代（一次 `llm.chat()` 调用 + 处理其响应）。

每个 task 有一个 `roundCount` 计数器，每次 agent loop 迭代时，如果当前有 in_progress 的 task，计数器 +1。

### 默认上限

`maxRounds = 10`（通过 config 可配置）

### 达到上限后的行为

1. 当前 task 状态设为 `interrupted`
2. note 自动设为 `"达到轮次上限 (10)"`
3. list 状态设为 `interrupted`
4. 向 LLM 返回提示信息：

```
任务 "编写数据库模型" 已达到轮次上限 (10/10)，执行被中断。

你可以选择：
- 调用 run_todo_update(task_id, "in_progress") 继续执行此任务
- 调用 run_todo_update(task_id, "skipped") 跳过此任务
- 调用 run_todo_update(task_id, "completed") 如果认为任务已完成
- 调用 run_todo_cancel 取消整个列表
```

## 中断与恢复

### 中断触发条件

| 触发条件       | list 状态           | task 状态                | 恢复方式                        |
| -------------- | ------------------- | ------------------------ | ------------------------------- |
| 轮次上限       | interrupted         | interrupted              | LLM 调用 `run_todo_update` 继续 |
| tool 执行错误  | 不变（保持 active） | 不变（保持 in_progress） | LLM 自行决定重试或跳过          |
| 用户发送新消息 | 不变（保持 active） | 不变                     | LLM 自行决定继续或取消          |

**说明**：用户发送新消息不会自动中断 todo list。LLM 在下一次被调用时能看到完整的 todo 状态，自行决定如何处理。

### 恢复流程

1. LLM 调用 `run_todo_list` 查看当前状态
2. LLM 决定：
   - `run_todo_update(task_id, "in_progress")` → 恢复执行（roundCount 重置为 0）
   - `run_todo_update(task_id, "skipped")` → 跳过，推进到下一个
   - `run_todo_cancel` → 放弃整个列表

### Task 上下文记录

每个 task 有一个 `note: string` 字段，由 LLM 在 `run_todo_update` 时可选填写。
恢复时，`run_todo_list` 返回每个 task 的 note，让 LLM 了解之前的进展。

```
[!] 编写数据库模型 (达到轮次上限，已完成 ER 图设计，待实现 SQL)
[ ] 实现API接口

(0/2 completed)
```

## 数据结构

```typescript
interface Task {
  id: string; // 唯一标识，格式 "task_1", "task_2", ...
  description: string; // 任务描述
  status: TaskStatus; // 任务状态
  note?: string; // LLM 附带的备注
  roundCount: number; // 当前已执行轮次
}

type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "skipped"
  | "cancelled"
  | "interrupted";

type TodoListStatus =
  | "idle"
  | "active"
  | "completed"
  | "cancelled"
  | "interrupted";

interface TodoList {
  status: TodoListStatus;
  tasks: Task[];
}
```

## 模块设计

### `src/todo.ts` — TODO manager 模块

工厂函数 `createTodoManager()`，返回以下方法：

| 方法                            | 说明                                                       |
| ------------------------------- | ---------------------------------------------------------- |
| `create(tasks)`                 | 创建 todo list                                             |
| `update(taskId, status, note?)` | 更新 task 状态                                             |
| `add(task, afterTaskId?)`       | 插入新 task                                                |
| `remove(taskId)`                | 删除 pending task                                          |
| `list()`                        | 获取格式化的 todo list                                     |
| `cancel()`                      | 取消整个 list                                              |
| `getActiveTask()`               | 获取当前 in_progress 的 task（供轮次计数用）               |
| `tickRound()`                   | 当前 in_progress task 的 roundCount +1，达到上限时自动中断 |

### 与 agent.ts 的集成点

在 agent loop 的重构版本中，`todoManager` 通过依赖注入传入 `createAgent()`，在 `run()` 主循环中调用 `tickRound()`：

```typescript
// agent.ts 的 run() 主循环中，调用 LLM 之前
if (todoManager) {
  const interruptMsg = todoManager.tickRound();
  if (interruptMsg) {
    appendMessage({ role: "user", content: interruptMsg }, roundCount);
  }
}
const finalMsgs = prepareMessages(roundCount);
```

`tickRound()` 内部逻辑：

- 如果没有 active list → 无操作，返回 null
- 如果没有 in_progress 的 task → 无操作，返回 null
- 否则 roundCount +1，检查是否超限
- 达到上限时返回中断消息（作为 user 消息注入上下文），未超限返回 null

### Tool 注册

在 `registry.ts` 中通过 `TodoToolProvider` 注册 6 个 todo tool，与 bash/files 工具完全一致的模式。

工具执行函数的参数类型为 `Record<string, unknown>`（与 `ToolExecutor` 签名一致），`args["tasks"]` 经 `JSON.parse` 后实际为数组，无需类型断言。

## 运行流程示例

```
用户: "帮我实现一个用户注册功能"

→ LLM: 分析需求，决定创建 todo list
→ LLM 调用 run_todo_create(["分析需求", "设计数据模型", "实现 API", "编写测试"])
← Tool 返回格式化列表

→ LLM 调用 run_todo_update("task_1", "in_progress", "开始分析需求文档")
→ LLM 调用 run_read(...) 读取相关文件
← Tool 返回文件内容

→ LLM 调用 run_todo_update("task_1", "completed", "需求分析完成")
→ LLM 调用 run_todo_update("task_2", "in_progress", "设计 user 表结构")
→ LLM 调用 run_write(...) 创建 migration 文件
← Tool 返回成功

→ LLM 调用 run_todo_update("task_2", "completed")
→ ... 继续后续任务 ...

→ 所有任务完成
→ LLM: "用户注册功能已实现，包含数据模型、API 接口和单元测试。"
```
