# PDD-12: 持久化 Task 任务系统

## 审阅结论

本设计要实现的是一个跨会话、可恢复、可多人协作的长期任务系统。它不是 PDD3 中已经实现的 TODO manager。

需要先澄清几个边界，否则后续实现很容易和现有架构冲突：

1. **TODO 是当前 session 的短期执行步骤**，适合本轮对话内的“下一步、再下一步”。
2. **Task 是跨会话的长期工作计划**，适合需要重启后继续、需要分配 owner、需要表达依赖关系的目标。
3. Task Group ID 是持久化任务的主身份，也应该是存储目录名。project 只是 Task Group 的关联元数据和索引维度，不应该决定物理存储位置。
4. Task 属于 Agent 的运行数据，而不是用户项目源码。默认不写入被操作项目的 `.tasks/`，避免污染用户仓库或被误提交。
5. 依赖关系只存一份 `blockedBy`，`blocks` 由读取时计算，避免双向字段漂移。
6. “每次启动清理”不能删除已完成任务。启动时只扫描、校验、清理临时写入文件；完成任务应保留到显式 archive 或 delete。

## 背景

当前项目已经有三类相邻能力：

- `src/todo.ts`：当前 session 内的 TODO list，非持久化，主要帮助 LLM 管理本轮执行节奏。
- `src/session.ts` + `src/transcript.ts`：记录会话和原始事件，但当前仍是进程内能力，不负责跨进程恢复任务。
- `src/project-context.ts`：区分 `projectRoot` 和 `agentHome`，避免 Agent 自身数据散落到用户项目目录。

长期任务系统需要站在这些能力之上：它保存“要做什么、依赖谁、谁负责、现在到哪一步”，但不替代 history、transcript、memory 或 TODO。

## 设计目标

1. 提供持久化的 Task Group，用于跨多轮、跨重启追踪复杂目标。
2. 支持任务之间的前置依赖，禁止开始依赖未满足的任务。
3. 支持 owner 字段，表达主 Agent、子 Agent 或用户负责的任务。
4. 支持 LLM tool 创建、读取、更新、追加和归档任务。
5. 支持 REPL 命令直接查看任务状态，方便教学和调试。
6. 持久化格式使用可读 JSON 文件，不引入数据库或外部依赖。
7. 与 prompt cache 友好设计保持一致：不把动态任务状态塞进稳定 system prompt。
8. 读写规则对称：写入器禁止产生读取器会拒绝的格式。

## 非目标

1. 不实现完整项目管理系统，例如看板、甘特图、评论线程、通知系统。
2. 不实现云同步、多机器协同或权限 ACL。
3. 不实现复杂搜索、向量检索或数据库索引。
4. 不把 Task 自动注入每一轮 prompt。
5. 不让 Task 代替 memory。任务进度、临时计划、分支名不应写入长期 memory。
6. 不让 Task 代替 transcript。Task 只保存结构化进度，不保存完整对话回放。
7. 第一版不实现子 Agent 直接并发写同一个 Task Group。子 Agent 可通过 owner 字段被分配任务，最终由父 Agent 写回状态。

## 术语

| 术语              | 含义                                                            |
| ----------------- | --------------------------------------------------------------- |
| Task Group        | 一个长期目标对应的一组任务，以 group id 目录持久化              |
| Task              | Task Group 中的一条可执行任务                                   |
| owner             | 任务负责人，例如 `main`、`subagent:<sessionId>`、`user`         |
| blockedBy         | 当前任务依赖的前置 task id 列表                                 |
| projectRoots      | Task Group 关联的项目根目录列表，支持单项目和跨项目任务         |
| activeTaskGroupId | 当前 session 正在执行或刚刚读取的 Task Group ID                 |
| ready             | 计算状态，表示 task 自身是 `pending` 且所有依赖均已 `completed` |
| archived          | 已完成或取消后的隐藏状态，默认不在 active 列表展示              |

## 与 TODO manager 的关系

| 维度     | TODO manager                        | Task system                        |
| -------- | ----------------------------------- | ---------------------------------- |
| 生命周期 | 当前 agent session                  | 跨进程、跨重启                     |
| 存储     | 内存闭包                            | JSON 文件                          |
| 数量     | 一个 session 最多一个活跃 TODO list | 一个项目可有多个 Task Group        |
| 依赖关系 | 线性顺序为主                        | 支持任务图                         |
| owner    | 不需要                              | 需要                               |
| 典型用途 | 本轮实现步骤                        | 长期项目计划、多人协作、恢复上下文 |

推荐用法：

1. 用户提出一个需要多天或多次会话才能完成的目标时，LLM 创建 Task Group。
2. LLM 从 Task Group 中选择一个 ready task。
3. 执行该 task 时，可以再创建当前 session 的 TODO list，把细粒度步骤交给 TODO manager 管理。
4. 当前 task 验证通过后，LLM 更新持久化 task 状态。

## 存储位置

### 默认路径

Task 文件默认放在 Agent 全局运行目录下，并以 Task Group ID 作为 canonical 存储目录：

```text
<agentHome>/
└── tasks/
    ├── groups/
    │   └── tg_20260513_153000_task_system/
    │       ├── group.json
    │       └── .tmp/
    └── index.json
```

其中：

- `agentHome` 来自 `ProjectContext.agentHome`，默认是 `~/.learn-claude-code-ts`。
- `groups/<group_id>/group.json` 是 Task Group 的唯一真实数据源。
- `index.json` 是派生索引，用于快速回答“当前 project 相关的 group 有哪些”，可以从所有 `group.json` 重建。
- 每个 group 目录下的 `.tmp/` 仅用于该 group 的原子写入中转和启动清理。

这个布局的关键点是：**Task Group ID 决定物理位置，project 维度只做过滤和索引**。这样同一个 Task Group 可以自然关联多个 project，而不会被硬塞进某一个 `<projectKey>/` 目录。

### Project 关联索引

`projectKey` 仍然有价值，但只作为派生索引键，不作为存储路径主键。

`index.json` 可以维护类似结构：

```json
{
  "version": 1,
  "byProjectKey": {
    "p_abcd1234": ["tg_20260513_153000_task_system"]
  },
  "allGroups": ["tg_20260513_153000_task_system"]
}
```

规则：

- `projectKey` 由 `projectRoot` 规范化后生成稳定短 hash，避免路径字符进入索引键。
- `byProjectKey` 根据每个 Task Group 的 `projectRoots` 派生。
- 如果索引丢失或损坏，TaskStore 扫描 `groups/*/group.json` 后重建。
- 列出当前项目相关任务时使用索引过滤；列出全部长期任务时直接看 `allGroups`。

### 存储颗粒度

第一版采用“一个 Task Group 目录 + 一个 `group.json`”：

```text
groups/<group_id>/group.json
```

暂不采用“每个 task 一个文件”的原因：

1. Task 状态、依赖关系、group 自动完成和 event log 都是 group 级一致性问题，一个文件更容易保证原子写入。
2. 教学项目第一版更看重可读性和可测试性，避免过早引入多文件事务。
3. LLM tool 每次读取 group 时通常需要完整任务图，拆成多个 task 文件反而需要额外拼装。

保留 group 目录而不是直接用 `<group_id>.json`，是为了给未来扩展留位置。后续如果 task 内容变大或需要并发编辑，可以迁移为：

```text
groups/<group_id>/
├── group.json
├── tasks/
│   ├── task_1.json
│   └── task_2.json
└── events.jsonl
```

第一版不要先做这个拆分。

### 为什么不默认写入项目 `.tasks/`

Task 是 Agent 运行数据，不是用户项目源码。默认写入 projectRoot 下的 `.tasks/` 有三个问题：

1. 容易污染用户仓库。
2. 需要额外维护 `.gitignore`。
3. 当 Agent 同时操作多个项目时，运行数据边界不清晰。

如果未来确实需要项目内共享任务，可新增显式 export/import 命令，而不是第一版默认启用。

## 目录命名和身份校验

Task Group 目录名固定为：

```text
<group_id>/
```

目录内真实数据文件固定为：

```text
group.json
```

`group_id` 格式：

```text
^tg_[0-9]{8}_[0-9]{6}_[a-z0-9_-]{1,48}$
```

读取文件时必须校验：

- 目录名里的 id 和 `group.json` 内容里的 `id` 完全一致。
- `kind === "task_group"`。
- `version` 是当前支持的版本。
- task id 在 group 内唯一。
- `projectRoots` 至少包含一个绝对路径。
- 所有 `blockedBy` 引用的 task id 存在。
- 依赖图无环。

任一校验失败时，该文件不进入正常列表，返回错误或记录 warning。第一版不自动删除坏文件。

## 数据结构

### TaskGroupFile

```ts
export interface TaskGroupFile {
  version: 1;
  kind: "task_group";
  id: string;
  scope: TaskGroupScope;
  projectRoots: string[];
  primaryProjectRoot?: string;
  title: string;
  description?: string;
  status: TaskGroupStatus;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  tasks: TaskItem[];
  events: TaskEvent[];
}

export type TaskGroupScope = "project" | "multi_project";
export type TaskGroupStatus = "active" | "completed" | "cancelled" | "archived";
```

说明：

- `scope` 描述 Task Group 的关联范围，不参与物理目录分层。
- `projectRoots` 表示这个 Task Group 关联哪些项目。单项目任务通常只有一个 root，跨项目任务可以有多个 root。
- `primaryProjectRoot` 是可选的主项目，用于默认 cwd、展示排序或标题提示；它不能作为唯一归属依据。
- `events` 是简短审计日志，只记录结构化状态变化，不保存完整对话。
- `archived` 只影响展示，不删除文件。

### TaskItem

```ts
export interface TaskItem {
  id: string;
  subject: string;
  description?: string;
  status: TaskStatus;
  blockedBy: string[];
  owner: string;
  note?: string;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
}

export type TaskStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "failed"
  | "cancelled"
  | "deleted";
```

设计取舍：

- 不存 `blocks`。读取时根据其他任务的 `blockedBy` 反向计算。
- 不存 `ready`。读取时计算，避免状态漂移。
- `deleted` 是软删除状态，不直接从数组移除，避免破坏历史和依赖校验。
- `failed` 表示需要人工或 LLM 决策，不自动视为依赖满足。

### TaskEvent

```ts
export interface TaskEvent {
  id: string;
  timestamp: string;
  actor: string;
  type:
    | "group_created"
    | "task_added"
    | "task_updated"
    | "task_deleted"
    | "group_completed"
    | "group_cancelled"
    | "group_archived";
  taskId?: string;
  message: string;
}
```

事件日志只用于教学和调试。实现时应限制单条 message 长度，避免把大段模型输出写入任务文件。

## 状态机

### TaskGroup 状态

```text
active ──[all terminal]──→ completed ──[archive]──→ archived
   │
   └──[cancel]──────────→ cancelled ──[archive]──→ archived
```

规则：

- 新建 group 状态为 `active`。
- 所有非 `deleted` task 都是 `completed` 时，group 自动变为 `completed`。
- `cancelled` group 不允许继续修改 task，除非未来显式实现 reopen。
- `archived` group 默认不出现在 active 列表中，但仍可读取。

### Task 状态

```text
pending ──[start]──→ in_progress ──[complete]──→ completed
   │                    │
   │                    ├──[fail]──→ failed ──[restart]──→ in_progress
   │                    └──[cancel]→ cancelled
   │
   ├──[delete]──→ deleted
   └──[cancel]──→ cancelled
```

规则：

- 只有 `pending` 或 `failed` task 可以切到 `in_progress`。
- 切到 `in_progress` 前，所有 `blockedBy` task 必须是 `completed`。
- 同一个 group 第一版允许多个 `in_progress` task，但工具返回中必须清晰显示 owner，避免多人协作时混淆。
- `completed`、`cancelled`、`deleted` 是终态。
- 删除有被依赖者的 task 时必须拒绝，除非先调整依赖。

## 依赖关系

依赖关系只通过 `blockedBy` 表示：

```json
{
  "id": "task_3",
  "subject": "实现 TaskToolProvider",
  "blockedBy": ["task_1", "task_2"]
}
```

读取时派生：

- `ready`: `status === "pending"` 且所有 blockedBy 都 completed。
- `blocks`: 其他任务中包含当前 task id 的列表。
- `blockedReason`: 未完成依赖的简短说明。

依赖校验：

1. 禁止引用不存在的 task id。
2. 禁止自依赖。
3. 禁止循环依赖。
4. 禁止将依赖改为 `deleted` task。
5. 依赖只有在 `completed` 时才算满足。

## 核心模块设计

### 新增 `src/task-store.ts`

职责：纯文件读写和格式校验，不包含 LLM tool 逻辑。

```ts
export interface TaskStore {
  scan(): TaskGroupSummary[];
  list(query?: TaskListQuery): TaskGroupSummary[];
  read(groupId: string): TaskGroupFile | null;
  save(group: TaskGroupFile): void;
  archive(groupId: string): TaskGroupFile;
  rebuildIndex(): void;
  cleanupTempFiles(): void;
  getTasksDir(): string;
}
```

实现要求：

- 每个 group 的真实数据路径是 `groups/<group_id>/group.json`。
- 所有写入使用共享 `atomicWriteJsonFile()` 完成“同目录临时文件 -> JSON 语法校验 -> rename 覆盖”的原子写入模式。
- JSON 写入使用稳定缩进 `JSON.stringify(value, null, 2)`。
- `scan()` 只加载合法文件，非法文件不参与正常返回。
- `rebuildIndex()` 根据所有合法 group 的 `projectRoots` 重建根目录级 `index.json`。
- `cleanupTempFiles()` 只删除各 group `.tmp/` 下超过阈值的临时文件，不删除 task group。

实现备注（2026-05 Runtime Hardening Round A）：

- TaskStore 的 `group.json` 和派生 `index.json` 已接入共享原子写入工具。
- 本轮只加固写入路径，不改变 Task Group 的 archive/delete 语义，也不自动清理 completed group。

### 新增 `src/tasks.ts`

职责：封装 TaskManager 的业务规则。

```ts
export interface TaskManager {
  createGroup(input: CreateTaskGroupInput): TaskGroupFile;
  listGroups(query?: TaskListQuery): TaskGroupSummary[];
  readGroup(groupId: string): TaskGroupView | null;
  addTask(groupId: string, input: AddTaskInput): TaskGroupView;
  updateTask(
    groupId: string,
    taskId: string,
    patch: UpdateTaskPatch,
  ): TaskGroupView;
  deleteTask(groupId: string, taskId: string, reason?: string): TaskGroupView;
  archiveGroup(groupId: string): TaskGroupView;
  getActiveGroupId(): string | null;
  setActiveGroupId(groupId: string | null): void;
}
```

业务规则：

- `createGroup()` 至少需要一个 task。
- `subject` 必须是单行短文本，`description` 可多行。
- `owner` 缺省为 `main`。
- 每次变更必须更新 group 和 task 的 `updatedAt`。
- 每次变更必须追加一条 `TaskEvent`。
- 每次保存前重新运行完整校验，确保 writer 不会写出 reader 拒绝的文件。
- `activeTaskGroupId` 是 session 级内存状态，不写入 `group.json`，用于提醒 LLM 当前正在围绕哪个 group 工作。
- `createGroup()`、`readGroup()`、`updateTask()` 成功后可以把对应 `groupId` 设为 active。

### 修改 `src/project-context.ts`

新增路径字段：

```ts
tasksDir: string;
```

派生规则：

```ts
tasksDir = resolve(agentHome, "tasks");
```

TaskStore 在该目录下创建固定子目录：

```text
resolve(tasksDir, "groups")
```

`projectKey` 只在 `tasksDir/index.json` 中出现，不再用于决定 group 文件位置。

### 新增 `src/tools/tasks.ts`

职责：把 TaskManager 包装成 LLM function calling tools。

第一版提供 6 个工具：

| 工具                    | 说明                               |
| ----------------------- | ---------------------------------- |
| `run_task_group_create` | 创建新的 Task Group                |
| `run_task_group_list`   | 列出当前项目的 Task Group 摘要     |
| `run_task_group_read`   | 读取一个 Task Group 的完整状态     |
| `run_task_add`          | 给 group 追加一个 task             |
| `run_task_update`       | 更新 task 状态、owner、note 或依赖 |
| `run_task_delete`       | 软删除一个 task                    |

工具命名说明：

- 使用 `run_task_` 前缀，符合现有工具命名规范。
- 不复用 `run_todo_`，避免模型混淆短期 TODO 和长期 Task。
- 工具定义在启动时注册，普通运行中不增删工具，保持 prompt cache 前缀稳定。

### Tool 参数草案

#### `run_task_group_create`

```json
{
  "title": "实现持久化 Task 系统",
  "description": "可选的长期目标说明",
  "project_roots": ["/Users/lebingxie/AI/AI_Worspace2026/learn-claude-code-ts"],
  "primary_project_root": "/Users/lebingxie/AI/AI_Worspace2026/learn-claude-code-ts",
  "tasks": [
    {
      "subject": "设计 TaskStore",
      "description": "定义文件格式、原子写入和读取校验",
      "owner": "main",
      "blocked_by": []
    }
  ]
}
```

说明：

- `project_roots` 可选。不提供时默认使用当前 `projectRoot`。
- 当 `project_roots` 包含多个项目时，manager 自动把 `scope` 设为 `multi_project`。
- `primary_project_root` 可选，但如果提供，必须属于 `project_roots`。

#### `run_task_group_list`

```json
{
  "status": "active",
  "include_archived": false,
  "current_project_only": true
}
```

说明：

- `current_project_only` 默认为 `true`，只列出 `projectRoots` 包含当前 `projectRoot` 的 group。
- 设置为 `false` 时列出所有 Task Group，用于跨项目总览。

#### `run_task_group_read`

```json
{
  "group_id": "tg_20260513_153000_task_system"
}
```

#### `run_task_add`

```json
{
  "group_id": "tg_20260513_153000_task_system",
  "subject": "接入 CLI 命令",
  "description": "实现 /task list 和 /task show",
  "owner": "main",
  "blocked_by": ["task_1"]
}
```

#### `run_task_update`

```json
{
  "group_id": "tg_20260513_153000_task_system",
  "task_id": "task_2",
  "status": "in_progress",
  "owner": "subagent:abc123",
  "note": "已经完成接口草案",
  "blocked_by": ["task_1"]
}
```

说明：

- 所有字段除 `group_id`、`task_id` 外均可选。
- 如果提供 `status`，必须符合状态机。
- 如果提供 `blocked_by`，会整体替换依赖列表，并重新检查无环。

#### `run_task_delete`

```json
{
  "group_id": "tg_20260513_153000_task_system",
  "task_id": "task_4",
  "reason": "需求收敛后不再需要"
}
```

## 格式化输出

所有 task tool 返回同一套可读格式。

Task Group 摘要：

```text
Task Groups for current project:

[active] tg_20260513_153000_task_system: 实现持久化 Task 系统
  progress: 1/5 completed, 1 in_progress, 2 ready, 1 blocked
  updated: 2026-05-13T15:45:00.000Z
```

Task Group 详情：

```text
[active] tg_20260513_153000_task_system: 实现持久化 Task 系统

[x] task_1: 设计 TaskStore
    owner: main
    note: 文件格式和校验规则已确定

[>] task_2: 实现 TaskManager
    owner: main
    blockedBy: -

[ ] task_3: 接入工具注册表
    owner: main
    blockedBy: task_2
    blocked: waiting for task_2

progress: 1/3 completed, 1 in_progress, 1 blocked
```

符号：

| 状态          | 符号  |
| ------------- | ----- |
| `pending`     | `[ ]` |
| ready pending | `[?]` |
| `in_progress` | `[>]` |
| `completed`   | `[x]` |
| `failed`      | `[!]` |
| `cancelled`   | `[_]` |
| `deleted`     | `[-]` |

说明：

- `ready pending` 不是存储状态，只是展示符号。
- 输出必须包含 group id 和 task id，避免 LLM 猜测 id。
- blocked task 必须显示未完成依赖。

## REPL 命令

新增 `/task` 命令，直接操作 TaskManager，不经过 LLM。

第一版命令：

```text
/task list
/task list --all
/task list --all-projects
/task show <group_id>
/task archive <group_id>
```

可选后续命令：

```text
/task ready <group_id>
/task cleanup
```

命令语义：

- `/task list` 默认只展示当前项目未 archived 的 group。
- `/task list --all` 包含 archived group。
- `/task list --all-projects` 展示所有项目相关的 group，不按当前 project 过滤。
- `/task show` 展示完整任务和依赖。
- `/task archive` 只允许归档 `completed` 或 `cancelled` group。

## 权限设计

新增权限分类：

```ts
type ToolCategory = ... | "task";
```

分类规则：

```ts
if (toolName.startsWith("run_task_")) return "task";
```

权限建议：

- `run_task_group_list`、`run_task_group_read`：所有模式允许。
- `run_task_group_create`、`run_task_add`、`run_task_update`、`run_task_delete`：所有模式允许。

理由：

- Task 写入的是 Agent 自身运行目录，不是用户项目源码。
- Plan 模式下创建和维护计划是合理行为。
- 真正危险的文件写入仍由 file tools 和 bash tools 管控。

如果未来支持项目内 `.tasks/`，则需要重新评估权限，至少在 default 模式下确认写入。

## 与 Agent 主流程的集成

第一版采用纯 tool 驱动，不改 Agent 主循环：

```text
用户复杂目标
  → LLM 视情况调用 run_task_group_create
  → LLM 调用 run_task_group_read 选择 ready task
  → LLM 用 TODO manager 管理本轮细步骤
  → LLM 完成后调用 run_task_update
```

### 当前 Task Group ID 的上下文维护

LLM 确实需要知道当前正在运行的 Task Group ID，但这个信息不应该写入稳定 system prompt。

第一版采用四层机制：

1. 所有 task tool 的输出必须明确包含 `group_id`。
2. `TaskManager` 在当前进程内维护一个 session 级 `activeTaskGroupId`。
3. 下一轮需要提醒时，通过 `SessionEventBuffer` 注入短 `<system-reminder>`。
4. 所有会修改数据的 task tool 仍要求显式传入 `group_id`。

示例 reminder：

```xml
<system-reminder source="task">
Current active task group: tg_20260513_153000_task_system. Pass this group_id explicitly when updating tasks.
</system-reminder>
```

这样模型能延续当前任务上下文，但工具执行仍然是显式、安全、可测试的。`activeTaskGroupId` 只能作为提醒和默认建议，不能让 `run_task_update` 在缺少 `group_id` 时隐式更新某个 group。

启动时集成：

1. `index.ts` 创建 `TaskStore` 和 `TaskManager`。
2. TaskStore 扫描 `tasks/groups/*/group.json`，并根据 `projectRoots` 重建索引。
3. 注册 TaskToolProvider 到 ToolRegistry。
4. 注册 `/task` CLI 命令。
5. 如当前 project 相关的 active group 存在，可向 `SessionEventBuffer` 推送一条短 reminder：

```xml
<system-reminder source="task">
Current project has 2 active task groups. Use run_task_group_list/read if the user wants to continue previous work.
</system-reminder>
```

注意：这条 reminder 是动态消息，不修改稳定 system prompt。

## 子智能体协作

第一版采用父 Agent 写回策略：

1. 父 Agent 读取 Task Group。
2. 父 Agent 将某个 ready task 的上下文交给子智能体。
3. 子智能体完成探索或实现后返回结果。
4. 父 Agent 根据结果调用 `run_task_update` 写回状态、owner 和 note。

这样可以避免多个 Agent 同时写同一个 JSON 文件。

未来如果允许子智能体直接调用 task tools，需要补充：

- 文件锁或乐观并发版本号。
- 冲突检测和重试。
- event actor 使用子 session id。

## 读写校验

Reader 和 writer 必须对称：

| 校验项               | 创建/更新时      | 读取时         |
| -------------------- | ---------------- | -------------- |
| group id 格式        | 拒绝             | 拒绝           |
| 目录名和内容 id 一致 | 保证             | 拒绝           |
| task id 唯一         | 保证             | 拒绝           |
| status 合法          | 拒绝             | 拒绝           |
| blockedBy 引用存在   | 拒绝             | 拒绝           |
| 依赖无环             | 拒绝             | 拒绝           |
| projectRoots 合法    | 至少一个绝对路径 | 不合法则不加载 |
| project 索引         | 从 group 派生    | 可重建         |
| JSON 可解析          | 写入格式化 JSON  | 解析失败不加载 |

## 测试计划

新增测试建议：

1. `src/task-store.test.ts`
   - 创建 `tasks/groups/<group_id>/group.json`。
   - 原子写入成功后文件可读。
   - 目录名和内容 id 不一致时拒绝加载。
   - 非法 JSON 不影响其他合法 group。
   - `index.json` 可以根据 `projectRoots` 重建。
   - 启动清理只删除 `.tmp/` 下过期文件。

2. `src/tasks.test.ts`
   - 创建 group 至少需要一个 task。
   - task id 稳定递增。
   - blockedBy 引用不存在时报错。
   - 循环依赖时报错。
   - 依赖未完成时禁止开始任务。
   - 所有任务完成后 group 自动 completed。
   - 删除被其他任务依赖的 task 会被拒绝。

3. `src/tools/tasks.test.ts`
   - tool 参数缺失时返回 `ToolResult.error`。
   - 所有 tool 输出包含 group id 和 task id。
   - `run_task_update` 能更新 status、owner、note、blocked_by。

4. `src/permission.test.ts`
   - `run_task_` 工具被归类为 task。
   - plan/default/auto 模式下 task 工具允许。

5. `src/cli-commands.test.ts`
   - `/task list`、`/task list --all-projects`、`/task show`、`/task archive` 分发正确。

6. `src/project-context.test.ts`
   - `tasksDir` 从 `agentHome` 派生，不依赖 `projectRoot`。

7. `src/tools/registry.test.ts`
   - Task tools 注册顺序稳定。
   - 重复注册同名工具仍会抛错。

## 实施顺序

1. 扩展 `ProjectContext`，加入 `tasksDir`。
2. 实现 `TaskStore`，完成 group 目录格式、project 索引、原子写入和校验。
3. 实现 `TaskManager`，封装状态机、依赖校验和事件记录。
4. 实现 `TaskToolProvider`，注册 6 个 `run_task_` 工具。
5. 扩展 `PermissionManager`，允许 task 工具。
6. 扩展 `ToolRegistry` 和 `index.ts`，接入 task provider。
7. 扩展 `cli-commands.ts`，加入 `/task` 命令。
8. 补充单元测试和必要的集成测试。
9. 实现完成后更新 `doc/summary.md`。

## 完成标准

本 PDD 对应实现完成时，应满足：

- 当前项目可以创建、读取、更新、归档持久化 Task Group。
- 跨项目 Task Group 可以通过 `projectRoots` 关联多个项目，并能在相关项目和全局列表中被找到。
- 重启进程后仍能列出之前未归档的 Task Group。
- 依赖未完成的 task 不能被标记为 in_progress。
- 所有 task 完成后 group 自动 completed。
- task 数据不写入被操作项目目录。
- tool 输出足够清晰，LLM 不需要猜测 id。
- `npm run typecheck` 通过。
- 相关 vitest 测试通过。
- 如果改动触及共享行为，`npm test` 通过。
