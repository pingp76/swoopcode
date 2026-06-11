# PDD-09: Memory 长期记忆

## 审阅结论

本阶段实现一个教学目的的长期记忆系统，用来保存对未来多轮会话仍然有价值的信息。

这里的 memory 是 **Agent 实例级全局记忆**，不是用户当前正在操作的业务项目目录下的项目文件。它属于这个 TypeScript 教学 Agent 自身，默认存放在 Agent 源代码仓库下的 `memory/` 目录，并且不提交到 Git。

为了避免长期记忆污染，本阶段不允许模型在没有用户确认的情况下自动落盘。自动触发只产生“候选记忆”，最终写入仍需要用户确认。用户明确要求“记住”“写入长期 memory”时，可以通过 memory 工具创建记忆，但权限层仍会对写入和删除做确认。

## 目标

Memory 的目标是让 Agent 在跨会话、跨任务时记住少量长期稳定的信息。

典型用途：

- 记住用户长期偏好的回答方式或代码风格。
- 记住用户明确纠正过 Agent 的行为。
- 记住不容易从代码直接看出来的长期约定。
- 记住外部资料入口，例如固定文档、看板、监控面板 URL。

设计原则：

- 少而精：只记录未来很多会话可能仍有价值的信息。
- 可验证：memory 只是方向提示，不能压过当前读到的真实文件和配置。
- 可删除：用户必须能查看和删除记忆。
- 可解释：每条 memory 都是普通 Markdown 文件，便于教学和调试。
- 默认安全：写入和删除长期记忆必须经过确认。

## 非目标

本阶段不实现：

- 不实现向量数据库、embedding 检索或语义搜索。
- 不实现复杂 YAML 解析器。
- 不实现多用户隔离。
- 不实现云同步。
- 不实现自动后台总结所有会话。
- 不把 memory 当成 TODO、计划或任务进度系统。
- 不把 memory 当成安全策略来源。

如果未来要做更接近生产系统的全局用户记忆，可以把 `memory/` 迁移到用户 home 目录，例如 `~/.learn-claude-code/memory/`。本阶段为了教学直观，默认放在 Agent 仓库内。

## 目录语义

需要明确区分三个目录概念：

| 名称            | 含义                               | 本阶段默认值                      |
| --------------- | ---------------------------------- | --------------------------------- |
| `agentRoot`     | 这个教学 Agent 的源码根目录        | `process.cwd()`                   |
| `workspaceRoot` | Agent 工具读写用户项目文件的根目录 | 当前实现仍以 `process.cwd()` 为准 |
| `memoryDir`     | Agent 实例级全局记忆目录           | `${agentRoot}/memory`             |

当前项目本身既是 Agent 源码仓库，也是运行目录，因此 `agentRoot` 和 `workspaceRoot` 暂时相同。但设计文档必须保留这两个概念，避免以后支持“Agent 在 A 目录运行、操作 B 项目”时混淆。

配置建议：

```env
MEMORY_DIR=memory
```

规则：

- 如果 `MEMORY_DIR` 是相对路径，则相对 `agentRoot` 解析。
- 如果 `MEMORY_DIR` 未设置，则使用 `${agentRoot}/memory`。
- `memory/` 必须加入 `.gitignore`，避免把私人长期记忆提交到仓库。

## 存储边界

### 应该保存

Memory 只保存跨会话、跨任务、短期不会轻易变化，而且不能轻易从当前代码状态直接推出来的信息。

支持四种类型：

| 类型        | 含义                             | 示例                           |
| ----------- | -------------------------------- | ------------------------------ |
| `user`      | 用户长期偏好                     | 用户喜欢简洁回答、喜欢先写测试 |
| `feedback`  | 用户对 Agent 的长期纠正          | 以后修改代码前先读设计文档     |
| `project`   | 不容易从代码直接看出来的长期约定 | 某目录虽然旧但短期内不能动     |
| `reference` | 外部长期资料入口                 | 固定看板 URL、资料库 URL       |

### 不应该保存

不要保存这些内容：

- 可以通过重新读代码直接知道的信息，例如文件结构、函数签名、目录布局。
- 可以从 Git 提交记录知道的信息，例如某次 bug 修复细节。
- 当前任务计划、TODO、进度、临时分支名、PR 名。
- 很快会过期的信息，例如临时调试 URL。
- 密码、密钥、token、cookie、私钥、个人身份敏感信息。
- 用户没有明确确认的推测性偏好。

判断方法：

| 信息类型               | 应放位置                  |
| ---------------------- | ------------------------- |
| 只对当前任务有用       | 当前对话或 TODO           |
| 未来很多会话仍可能有用 | memory                    |
| 长期项目级固定说明     | `CLAUDE.md`               |
| 当前代码事实           | 重新读取代码，不写 memory |

如果 memory 内容和当前观察到的真实状态冲突，以当前真实状态为准。Memory 只能提示“去哪里验证”，不能替代验证。

## 存储结构

### 单条 memory 文件

每条 memory 是一个独立 Markdown 文件：

```text
memory/
├── MEMORY.md
├── prefer_concise_answers.md
└── verify_before_conclusion.md
```

文件格式：

```markdown
---
name: prefer_concise_answers
description: User prefers concise answers
type: user
createdAt: 2026-04-30T12:00:00.000Z
updatedAt: 2026-04-30T12:00:00.000Z
---

The user explicitly prefers concise answers unless they ask for a detailed explanation.
```

字段说明：

| 字段          | 必填 | 说明                                           |
| ------------- | ---- | ---------------------------------------------- |
| `name`        | 是   | 唯一标识，只允许小写字母、数字、下划线、短横线 |
| `description` | 是   | 一句话摘要，用于索引和 system prompt           |
| `type`        | 是   | `user`、`feedback`、`project`、`reference`     |
| `createdAt`   | 是   | ISO 时间字符串                                 |
| `updatedAt`   | 是   | ISO 时间字符串                                 |

正文使用普通 Markdown。正文应该短小明确，不写长篇日志。

### 命名安全

`name` 必须满足：

```text
^[a-z0-9_-]+$
```

文件名固定为：

```text
${name}.md
```

禁止从用户输入直接拼接任意路径。这样可以避免路径穿越、隐藏文件写入和奇怪字符导致的覆盖问题。

### MEMORY.md 索引

`MEMORY.md` 是自动生成索引，不手写维护：

```markdown
# Memory Index

- prefer_concise_answers: User prefers concise answers [user]
- verify_before_conclusion: User wants observed facts verified before conclusions [feedback]
```

规则：

- 每次 create/delete 后由 `MemoryManager` 重建。
- `MEMORY.md` 不作为真实数据源。
- 如果索引丢失，可以通过扫描单条 memory 文件重新生成。

## Frontmatter 解析策略

本阶段不引入 YAML 依赖，实现教学用极简 frontmatter parser。

只支持这种格式：

```markdown
---
key: value
key2: value2
---

body
```

限制：

- 只解析第一段 `---` 到第二段 `---` 之间的内容。
- 每行只支持 `key: value`。
- 不支持数组、嵌套对象、多行字符串、引号转义。
- 未知字段可以忽略。
- 必填字段缺失时，该 memory 文件视为无效。

这样代码更容易教学，也避免为了一个简单功能引入 YAML 依赖。

## 核心模块设计

新增模块：`src/memory.ts`

### 类型定义

```typescript
export type MemoryType = "user" | "feedback" | "project" | "reference";

export interface MemoryMeta {
  name: string;
  description: string;
  type: MemoryType;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryEntry {
  meta: MemoryMeta;
  body: string;
}

export interface CreateMemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

export interface MemoryManager {
  scan(): MemoryEntry[];
  list(): MemoryMeta[];
  read(name: string): MemoryEntry | null;
  create(input: CreateMemoryInput): MemoryEntry;
  delete(name: string): boolean;
  buildPromptSection(): string | null;
  rebuildIndex(): void;
  getMemoryDir(): string;
}
```

### 工厂函数

```typescript
export function createMemoryManager(options: {
  memoryDir: string;
  logger: Logger;
}): MemoryManager {
  ...
}
```

设计要点：

- `scan()` 从磁盘读取所有 memory 文件，跳过 `MEMORY.md`。
- 无效文件不应让程序崩溃，只记录 warn 并跳过。
- `list()` 返回按 `type`、`name` 稳定排序的 meta。
- `create()` 会校验 name/type/body，写入文件后重建索引。
- `delete()` 删除对应 `${name}.md` 后重建索引。
- `buildPromptSection()` 生成注入 system prompt 的短文本。

### system prompt 片段

`buildPromptSection()` 输出示例：

```text
Long-term memory:
- [user] prefer_concise_answers: User prefers concise answers
- [feedback] verify_before_conclusion: User wants observed facts verified before conclusions

Use memory as a hint, not as proof. If memory conflicts with current files or observed facts, trust the current observation.
```

为了控制上下文长度，system prompt 默认只注入 `description`，不注入完整正文。需要完整内容时，LLM 可以调用 `run_memory_read`。

## System Prompt 组合

当前项目已经使用 `history.setSystemPrompt()` 注入 Skill 提示。Memory 不能直接覆盖 system prompt。

新增模块或函数：`src/system-prompt.ts`

```typescript
export interface SystemPromptParts {
  skillHint?: string | null;
  memoryHint?: string | null;
}

export function buildSystemPrompt(parts: SystemPromptParts): string | null {
  ...
}
```

组合规则：

1. 没有任何片段时返回 `null`。
2. 有多个片段时用空行分隔。
3. Skill hint 在前，Memory hint 在后。
4. `history.setSystemPrompt()` 只在 `index.ts` 中调用一次组合后的结果。

示例：

```typescript
const systemPrompt = buildSystemPrompt({
  skillHint:
    skillManager.listMeta().length > 0 ? SKILL_SYSTEM_PROMPT_HINT : null,
  memoryHint: memoryManager.buildPromptSection(),
});

if (systemPrompt) {
  history.setSystemPrompt(systemPrompt);
}
```

### 本轮忽略 memory

用户可以说：

- `这次忽略 memory`
- `本轮不要使用 memory`
- `ignore memory for this turn`

本阶段建议在 `agent.ts` 的 `prepareMessages()` 中处理，而不是启动时写死 system prompt。

做法：

- `history` 仍保存基础 system prompt 组合能力。
- `Agent` 在每轮准备消息时，根据当前用户输入判断是否注入 memory 片段。
- 如果本轮忽略 memory，则只注入非 memory 的 system prompt 片段。

为了实现更简单，也可以先在 `index.ts` 中构造一个 `SystemPromptProvider`：

```typescript
export interface SystemPromptProvider {
  build(query: string): string | null;
}
```

`Agent` 每次 `run(query)` 时调用 provider，并更新本轮 system prompt。这样比在 `history` 中长期存一份静态 system prompt 更适合 memory。

本阶段推荐使用 `SystemPromptProvider`，因为 memory 文件可能在运行过程中新增、删除、reload。

## Memory 工具设计

新增工具提供者：`src/tools/memory.ts`

工具命名继续遵守项目约定：所有工具以 `run_` 开头。

### run_memory_create

用于创建或更新一条长期记忆。

参数：

```typescript
{
  name: string;
  description: string;
  type: "user" | "feedback" | "project" | "reference";
  body: string;
}
```

行为：

- 校验 `name` 安全格式。
- 校验 `type` 合法。
- 如果同名 memory 已存在，本阶段允许覆盖，但必须更新 `updatedAt`，保留原 `createdAt`。
- 写入成功后重建 `MEMORY.md`。
- 返回创建后的摘要。

何时使用：

- 用户明确说“记住……”
- 用户明确说“写入长期 memory……”
- Agent 发现候选记忆，并向用户确认后再调用。

### run_memory_list

列出所有 memory meta。

参数：

```typescript
{
}
```

行为：

- 返回 `MEMORY.md` 风格的列表。
- 不返回完整正文。

### run_memory_read

读取单条 memory 的完整内容。

参数：

```typescript
{
  name: string;
}
```

行为：

- 找不到返回明确错误。
- 返回 meta 和 body。

### run_memory_delete

删除一条 memory。

参数：

```typescript
{
  name: string;
}
```

行为：

- 删除 `${name}.md`。
- 重建 `MEMORY.md`。
- 找不到返回未删除。

## 自动候选记忆

本阶段不实现“无确认自动落盘”。

自动触发规则：

- 当用户表达长期偏好、长期纠正或固定外部资源时，LLM 可以提出候选记忆。
- LLM 必须先用自然语言询问用户是否写入 memory。
- 用户确认后，LLM 才能调用 `run_memory_create`。

示例交互：

```text
用户：以后回答都先给结论，再给细节。
Agent：这看起来像一个长期偏好。要写入 memory 吗？
用户：可以。
Agent 调用 run_memory_create(...)
```

禁止：

- 不因为用户一次性的临时指令直接写 memory。
- 不因为模型推测用户喜欢某种风格就写 memory。
- 不保存敏感信息。

## CLI 命令设计

新增 `/memory` 命令，通过 `cli-commands.ts` 注册。

### /memory list

显示所有 memory：

```text
/memory list
```

输出：

```text
Memory:
  - prefer_concise_answers: User prefers concise answers [user]
```

### /memory show <name>

显示单条 memory 的完整内容：

```text
/memory show prefer_concise_answers
```

### /memory remove <name>

删除一条 memory：

```text
/memory remove prefer_concise_answers
```

CLI 命令是用户直接操作，不经过 LLM，因此可以直接删除，但删除前建议打印确认提示。如果要保持代码简单，也可以先直接删除并输出结果。

### /memory reload

重新扫描 `memory/` 目录并重建索引：

```text
/memory reload
```

用途：

- 用户手动编辑了 memory 文件。
- `MEMORY.md` 丢失或过期。

### 为什么暂不做 /memory add

`/memory add` 需要处理 `name`、`type`、`description`、`body` 多字段输入，命令行解析会让教学代码变复杂。本阶段新增记忆主要通过自然语言 + `run_memory_create` 完成。

未来如果要补，可以设计为：

```text
/memory add <name> <type> <description>
```

然后进入多行正文输入模式。但这不属于本阶段。

## 权限规则

当前 `permission.ts` 中 `memory` 类别实际指的是 `run_todo_*`，新增 memory 工具后需要避免命名冲突。

建议调整工具分类：

| 类别     | 工具           |
| -------- | -------------- |
| `todo`   | `run_todo_*`   |
| `memory` | `run_memory_*` |

权限规则：

| 工具                | plan  | default | auto  |
| ------------------- | ----- | ------- | ----- |
| `run_memory_list`   | allow | allow   | allow |
| `run_memory_read`   | allow | allow   | allow |
| `run_memory_create` | ask   | ask     | ask   |
| `run_memory_delete` | ask   | ask     | ask   |

长期记忆写入和删除即使在 `auto` 模式也必须确认。原因是 memory 会影响未来会话，风险比普通当前任务操作更持久。

权限提示示例：

```text
Allow memory create: prefer_concise_answers
Allow memory delete: prefer_concise_answers
```

## 与 Git 的关系

需要在 `.gitignore` 加入：

```gitignore
memory/
```

原因：

- Memory 可能包含用户偏好、内部约定、外部链接。
- 这些内容属于运行时私人状态，不应提交。

设计文档可以提交，但实际 `memory/` 目录不提交。

## 与子智能体的关系

子智能体默认可以读取 memory，但写入和删除仍然走同一个权限管理器。

建议：

- 父智能体和子智能体共享同一个 `MemoryManager`。
- 子智能体工具注册表可以包含 `run_memory_list`、`run_memory_read`。
- 是否允许子智能体调用 `run_memory_create/delete` 需要谨慎。本阶段建议允许注册，但权限层 ask；由于子智能体没有用户确认回调时 ask 会降级为 deny，因此子智能体实际不能写入或删除 memory。

这样可以保证：

- 子智能体能利用长期提示。
- 子智能体不会在隔离上下文中偷偷污染长期记忆。

## 与 Hook 的关系

本阶段不通过 Hook 自动写 memory。

可以在未来扩展：

- `SessionStart`：记录 memory 加载数量。
- `PostToolUse`：发现某些长期候选信息。

但本阶段为了保持教学清晰，memory 通过：

- system prompt 注入摘要。
- memory 工具读写。
- `/memory` CLI 命令管理。

## 实现步骤

建议按以下顺序实现：

1. 新增 `.gitignore` 规则，忽略 `memory/`。
2. 新增 `src/memory.ts`，实现类型、parser、serializer、`MemoryManager`。
3. 新增 `src/memory.test.ts`，覆盖 parser、name 校验、create/list/read/delete、索引重建。
4. 新增 `src/system-prompt.ts`，实现 system prompt 组合器或 provider。
5. 修改 `index.ts`，创建 `MemoryManager`，组合 Skill hint 和 Memory hint。
6. 新增 `src/tools/memory.ts`，实现四个 memory 工具。
7. 修改 `src/tools/registry.ts`，注册 memory 工具。
8. 修改 `permission.ts`，区分 `todo` 和 `memory` 工具类别，并增加 memory 权限规则。
9. 修改 `cli-commands.ts`，新增 `/memory list|show|remove|reload`。
10. 修改 `index.ts`，注册 `/memory` 命令。
11. 修改或新增 Agent/system prompt 测试，验证 Skill hint 不被 memory 覆盖。
12. 更新 `doc/summary.md`，记录 Memory 功能。

## 测试清单

### MemoryManager 测试

- 能解析合法 frontmatter。
- 缺少必填字段时跳过无效文件。
- 非法 `name` 被拒绝。
- 非法 `type` 被拒绝。
- `create()` 能创建文件并生成 `MEMORY.md`。
- 同名 `create()` 能更新正文和 `updatedAt`，保留 `createdAt`。
- `list()` 按稳定顺序返回 meta。
- `read()` 找不到时返回 `null`。
- `delete()` 删除文件并重建索引。
- `scan()` 跳过 `MEMORY.md`。

### 工具测试

- `run_memory_create` 参数缺失时报错。
- `run_memory_list` 返回摘要，不返回完整正文。
- `run_memory_read` 返回完整正文。
- `run_memory_delete` 能删除存在的 memory。
- 工具不允许通过 name 路径穿越。

### 权限测试

- `run_memory_list/read` 在三种模式下 allow。
- `run_memory_create/delete` 在三种模式下 ask。
- `run_todo_*` 不再被分类为 memory，避免语义冲突。
- 子智能体无 `askUserFn` 时，memory create/delete 的 ask 降级为 deny。

### System Prompt 测试

- 只有 Skill hint 时能正常注入。
- 只有 Memory hint 时能正常注入。
- Skill hint 和 Memory hint 同时存在时不会互相覆盖。
- Memory hint 为空时不产生多余空白。
- 用户要求本轮忽略 memory 时，不注入 Memory hint。

### CLI 测试

- `/memory list` 能显示列表。
- `/memory show <name>` 能显示单条内容。
- `/memory remove <name>` 能删除。
- `/memory reload` 能重建索引。
- 未知子命令显示 usage。

## 文档更新要求

实现完成后更新 `doc/summary.md`：

- 当前状态增加 Memory 功能。
- 源码结构增加 `memory.ts`、`tools/memory.ts`、`system-prompt.ts`。
- 已实现功能增加 Memory 章节。
- 测试覆盖表增加 memory 相关测试。
- 配置项增加 `MEMORY_DIR`。

## 设计取舍

### 为什么 memory 放在 Agent 仓库下

这个项目是教学用 Agent，读者需要直观看到 memory 如何落盘、如何索引、如何注入 prompt。放在 `agentRoot/memory/` 最容易理解和调试。

生产系统更适合放在用户 home 或应用数据目录。本设计通过 `MEMORY_DIR` 保留迁移空间。

### 为什么不自动无确认写入

长期记忆会影响未来会话。一次错误写入可能长期污染上下文，因此本阶段只允许：

- 用户显式要求后写入。
- Agent 提出候选，用户确认后写入。

### 为什么索引自动生成

索引是派生数据。如果手写维护，很容易和真实 memory 文件漂移。自动生成能保持实现简单，也更适合教学展示。

### 为什么 prompt 默认只注入 description

完整 memory 正文可能变长，长期注入会污染上下文。默认注入摘要，让 LLM 知道有哪些记忆；需要细节时再调用 `run_memory_read`。
