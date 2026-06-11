# PDD-05: Skill 技能系统

## 概述

Skill 是**按需加载的 prompt 扩展机制**——LLM 根据用户任务自动选择并加载相关技能，获取详细的执行指示，再用已有的工具完成任务。

核心价值：避免将所有知识一次性塞入 system prompt，只在需要时才扩展上下文。

本设计参考 [Anthropic 官方 Skill 规范](https://github.com/anthropics/skills)，做了教学简化。

## Skill 与 Tool 的区别

| 维度       | Tool（工具）             | Skill（技能）                      |
| ---------- | ------------------------ | ---------------------------------- |
| 本质       | 原子操作（单次函数调用） | 任务模板（步骤指示 + 资源）        |
| 例子       | `run_bash`、`run_read`   | `code-review`、`explain-code`      |
| 注册方式   | 硬编码到 `registry.ts`   | 扫描 `skills/` 目录动态发现        |
| 加载时机   | 启动时全部加载           | 仅加载元数据；触发时才加载完整内容 |
| 上下文占用 | 工具定义始终存在         | 触发后才注入，不触发不占用         |

**关键洞察**：Skill 不是新工具、不是子进程——它是通过 `run_skill` 工具注入的 prompt 扩展。触发后 LLM 拿到详细指示，继续用 `run_bash`、`run_read` 等现有工具执行。

## SKILL.md 格式

每个 skill 是 `skills/` 下的一个子目录，必须包含 `SKILL.md`。

`SKILL.md` 由两部分组成：YAML frontmatter（元数据）+ Markdown body（执行指示）。

```markdown
---
name: code-review
description: Review code for quality issues, bugs, and style violations. Use when user asks to review code.
dependencies:
  - node
---

# Code Review Skill

## Steps

1. Use `run_read` to read the target file(s)
2. Check for common issues:
   - Unused variables/imports
   - Missing error handling
   - Security vulnerabilities
3. Report findings with file:line references

## Output Format

- Severity: 🔴 Critical / 🟡 Warning / 🔵 Info
- Location: file:line
- Suggestion: how to fix
```

### frontmatter 字段

| 字段           | 必填 | 说明                                                   |
| -------------- | ---- | ------------------------------------------------------ |
| `name`         | 是   | 唯一标识，小写字母 + 连字符，最长 64 字符              |
| `description`  | 是   | 单行描述，告诉 LLM 何时使用此 skill                    |
| `dependencies` | 否   | 运行时依赖（如 `python3`、`node`），本版本仅声明不安装 |

### body 部分

Markdown 格式的执行指示。本版本只支持纯文本指示，LLM 读取后按步骤执行。未来版本可引用 skill 目录下的脚本文件。

## 目录结构

```
skills/                      # skill 根目录（项目级）
├── code-review/
│   └── SKILL.md             # 必需：元数据 + 执行指示
├── explain-code/
│   └── SKILL.md
└── test-writer/
    ├── SKILL.md
    └── templates/           # 可选：资源目录（本版本不读取）
        └── test-template.ts
```

## 触发方式：LLM 自动调用，无需用户显式指定

Skill 的触发方式与 `run_bash`、`run_read` 完全相同——**由 LLM 通过 function call 自动触发**，用户不需要说出 skill 名称。

用户只说需求（如"帮我审查代码"），LLM 自主判断是否需要调用 skill。这个过程对用户完全透明。

### 帮助 LLM 理解 skill 的双保险策略

LLM 要正确使用 skill，需要完成两步推理：

1. **判断**：用户的需求是否匹配某个 skill
2. **执行**：调用 `run_skill` 后，理解返回的是"执行指示"而非"最终结果"，需要按指示继续用其他工具完成任务

这对 weaker model 是有难度的。采用双保险策略：

**策略 1：增强 `run_skill` 的 tool description**

不是简单列出 skill 名称和描述，而是加入触发规则和示例，让 LLM 更容易匹配：

```json
{
  "name": "run_skill",
  "description": "Load a skill to get specialized instructions for a task.

Available skills:
- code-review: Review code for quality issues, bugs, and style violations
- explain-code: Explain code functionality in detail with Chinese comments

When to use:
- When user asks to review/audit code → call run_skill({ name: \"code-review\" })
- When user asks to explain/understand code → call run_skill({ name: \"explain-code\" })

What happens:
- You will receive detailed step-by-step instructions
- Then follow those instructions using other tools (run_read, run_bash, etc.)
- Do NOT try to complete the task directly — load the skill first

Examples:
- User: \"审查一下代码\" → run_skill({ name: \"code-review\" })
- User: \"解释这个函数\" → run_skill({ name: \"explain-code\" })"
}
```

**策略 2：在 system message 中加入 skill 提示**

在 agent 发送给 LLM 的 system message 中加入简短的 skill 使用提示，作为全局上下文补充：

```
You have access to skills via the run_skill tool. Skills provide specialized
instructions for certain tasks. When a user's request matches an available skill,
call run_skill first to load detailed instructions, then follow those instructions
using other tools.
```

这个 system message 很短（约 40 词），不会显著增加上下文，但能让 LLM 在看到工具列表之前就理解 skill 的存在和用途。

```
用户输入: "审查一下 agent.ts 的代码质量"
                    │
                    ▼
        ┌─── Agent 主循环 ───┐
        │                     │
        │  LLM 看到工具列表：  │
        │  - run_bash         │
        │  - run_read         │
        │  - run_write        │
        │  - run_edit         │
        │  - run_skill        │  ← 也是一个普通工具
        │    description 中列出了:
        │    - code-review: Review code for quality...
        │    - explain-code: Explain code in detail...
        │                     │
        │  LLM 判断:          │
        │  "审查代码" 匹配     │
        │  code-review skill  │
        │                     │
        │  → tool_call:       │
        │    run_skill({      │
        │      name:          │
        │      "code-review"  │
        │    })               │
        │         │           │
        │         ▼           │
        │  SkillManager       │
        │  .invoke()          │
        │  返回 SKILL.md body │
        │  + base path        │
        │         │           │
        │         ▼           │
        │  tool_result 注入   │
        │  上下文，LLM 拿到   │
        │  详细审查步骤，      │
        │  继续用 run_read    │
        │  等工具执行          │
        └─────────────────────┘
```

## 三阶段生命周期

```
┌─────────────────────────────────────────────────────────┐
│ 1. 发现（启动时）                                        │
│    扫描 skills/*/SKILL.md                                │
│    只解析 YAML frontmatter → 缓存 { name, description } │
├─────────────────────────────────────────────────────────┤
│ 2. 注册                                                  │
│    run_skill 注册到 ToolRegistry（与 run_bash 等并列）    │
│    description 中嵌入可用 skill 列表 → LLM 据此自主选择   │
├─────────────────────────────────────────────────────────┤
│ 3. 触发（LLM function call）                             │
│    LLM → tool_call: run_skill({ name: "xxx" })           │
│    → 读取 SKILL.md body + base path                      │
│    → 作为 tool_result 注入上下文                          │
│    → LLM 按指示继续用 run_bash 等工具执行                 │
└─────────────────────────────────────────────────────────┘
```

### 端到端示例

用户输入和 LLM 的完整交互过程：

```
┌─ 用户 ───────────────────────────────────────────────────┐
│ "帮我审查 agent.ts 的代码质量"                             │
└──────────────────────────────────────────────────────────┘

┌─ 第 1 轮 LLM 调用 ──────────────────────────────────────┐
│                                                           │
│  LLM 看到工具列表中的 run_skill，其 description 包含：     │
│    - code-review: Review code for quality issues...       │
│    - explain-code: Explain code in detail...              │
│                                                           │
│  LLM 判断："审查代码质量" 匹配 code-review skill           │
│                                                           │
│  返回: tool_call: run_skill({ name: "code-review" })      │
└──────────────────────────────────────────────────────────┘

┌─ 系统执行 run_skill ────────────────────────────────────┐
│                                                           │
│  SkillManager.invoke("code-review")                       │
│  → 读取 skills/code-review/SKILL.md 的 body 部分          │
│  → 返回 ToolResult:                                       │
│                                                           │
│    "Base Path: /path/to/skills/code-review/               │
│                                                           │
│     # Code Review Skill                                   │
│     ## Steps                                              │
│     1. Use run_read to read the target file(s)            │
│     2. Analyze for:                                       │
│        - Unused variables/imports                         │
│        - Missing error handling                           │
│     3. Report findings with file:line references"         │
└──────────────────────────────────────────────────────────┘

┌─ 第 2 轮 LLM 调用 ──────────────────────────────────────┐
│                                                           │
│  LLM 现在拿到了 code-review skill 的详细指示              │
│  按步骤执行：先读文件                                      │
│                                                           │
│  返回: tool_call: run_read({ path: "src/agent.ts" })       │
└──────────────────────────────────────────────────────────┘

┌─ 第 3 轮 LLM 调用 ──────────────────────────────────────┐
│                                                           │
│  LLM 看到文件内容，按 skill 指示进行分析                   │
│  生成最终的代码审查报告（文本回复，不再调用工具）            │
│                                                           │
│  返回: "审查报告：发现 3 个问题..."                         │
└──────────────────────────────────────────────────────────┘
```

## 接口设计

### src/skills.ts

```typescript
/** SKILL.md frontmatter 元数据 */
interface SkillMeta {
  name: string; // 唯一标识
  description: string; // 单行描述
}

/** 已发现的 Skill 条目 */
interface SkillEntry {
  meta: SkillMeta;
  skillFilePath: string; // SKILL.md 绝对路径
  basePath: string; // skill 目录的绝对路径
}

/** Skill 管理器接口 */
interface SkillManager {
  /** 扫描 skills/ 目录，解析所有 SKILL.md 的 frontmatter */
  scan(): void;
  /** 获取所有已发现的 skill 元数据（用于构建 run_skill 工具描述） */
  listMeta(): SkillMeta[];
  /** 触发指定 skill：读取 SKILL.md body，返回 body + base path */
  invoke(name: string): string;
  /** 删除指定 skill（删除整个目录） */
  remove(name: string): boolean;
}
```

## 与现有模块的集成

### 改动范围

| 文件                    | 改动类型 | 说明                                               |
| ----------------------- | -------- | -------------------------------------------------- |
| `src/skills.ts`         | **新增** | SkillManager 工厂函数 + SkillToolProvider          |
| `src/tools/registry.ts` | **修改** | 接收 `skillProvider` 参数，注册 `run_skill` 工具   |
| `src/cli-commands.ts`   | **新增** | `/skill` CLI 命令注册与分发                        |
| `src/index.ts`          | **修改** | 创建 SkillManager，注入到 ToolRegistry 和 CLI 命令 |
| `src/history.ts`        | **修改** | `setSystemPrompt()` 管理技能提示                   |

### 依赖关系

```
index.ts（组装根）
  ├── createSkillManager("skills/")
  ├── createSkillToolProvider(skillManager)  ← 生成 run_skill 定义 + 执行函数
  ├── createToolRegistry(
  │     todoManager,
  │     subagentProvider,
  │     skillProvider                         ← 注入 SkillToolProvider
  │   )
  ├── history.setSystemPrompt(SKILL_SYSTEM_PROMPT_HINT)  ← 通过 history 管理 system prompt
  ├── createSkillCliCommand(skillManager, logger)         ← CLI 命令
  └── createRepl({ agent, logger, commands, terminal })
```

### system prompt 管理方式

system prompt 通过 `history.setSystemPrompt()` 管理（不是 agent.ts 注入）：

```typescript
// index.ts 中：有 skill 时才注入 system prompt
if (skillManager.listMeta().length > 0) {
  history.setSystemPrompt(SKILL_SYSTEM_PROMPT_HINT);
}
```

好处：system prompt 独立存储在 history 闭包内，不进入 messages 数组，不干扰消息标准化。

### SkillToolProvider 模式

与 TodoToolProvider、SubagentToolProvider 模式一致，通过 provider 接口注册：

```typescript
interface SkillToolProvider {
  toolEntries: Array<{
    definition: ChatCompletionTool;
    execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  }>;
}
```

`run_skill` 的工具定义（description 动态生成，嵌入可用 skill 列表）：

```json
{
  "type": "function",
  "function": {
    "name": "run_skill",
    "description": "Load a skill to get specialized instructions for a task.\n\nAvailable skills:\n- code-review: Review code for quality issues, bugs, and style violations\n- explain-code: Explain code functionality in detail with Chinese comments\n\nWhen to use:\n- When user asks to review/audit code → call run_skill({ name: \"code-review\" })\n- When user asks to explain/understand code → call run_skill({ name: \"explain-code\" })\n\nWhat happens:\n- You will receive detailed step-by-step instructions\n- Then follow those instructions using other tools (run_read, run_bash, etc.)\n- Do NOT try to complete the task directly — load the skill first",
    "parameters": {
      "type": "object",
      "properties": {
        "name": {
          "type": "string",
          "description": "The skill name to invoke"
        }
      },
      "required": ["name"]
    }
  }
}
```

### CLI 命令（静态快照语义）

`/skill` 命令在 `cli-commands.ts` 中注册，不经过 LLM：

```
/skill load           → 重新扫描 skills/ 目录，更新本地缓存
/skill list           → 显示已安装的 skill 列表（name + description）
/skill remove <name>  → 删除指定 skill 目录
```

**静态快照语义**：`run_skill` 的 tool description 是启动时的静态快照。`/skill load` 和 `/skill remove` 只影响本地缓存，不更新 LLM 可见的工具定义。要让 LLM 看到新的 skill 列表，需要重启 agent。

## frontmatter 解析

使用简单的正则解析（不需要引入 YAML 库）：

```
---\n               ← frontmatter 起始标记
name: code-review   ← 逐行解析 key: value
description: ...
---\n               ← frontmatter 结束标记
\n                  ← 空行
(body content)      ← 之后的全部内容作为 body
```

解析规则：

1. 文件必须以 `---\n` 开头
2. 到第二个 `---` 之间的内容是 frontmatter
3. 每行格式为 `key: value`，忽略空行和 `#` 开头的注释行
4. 第二个 `---` 之后的内容全部作为 body

## 示例 Skill

提供 2 个开箱即用的示例，全部只用 markdown 指示，不涉及脚本执行：

### code-review

```markdown
---
name: code-review
description: Review code for quality issues, bugs, and style violations. Use when user asks to review code.
---

# Code Review Skill

## Steps

1. Use `run_read` to read the target file(s)
2. Analyze for:
   - Unused variables/imports
   - Missing error handling
   - Security vulnerabilities
   - Style inconsistencies
3. Report findings with file:line references

## Output Format

For each finding:

- Severity: 🔴 Critical / 🟡 Warning / 🔵 Info
- Location: file:line
- Issue: description
- Suggestion: how to fix
```

### explain-code

```markdown
---
name: explain-code
description: Explain code functionality in detail with Chinese comments. Use when user asks to understand code.
---

# Code Explain Skill

## Steps

1. Use `run_read` to read the target file(s)
2. For each file, explain:
   - Overall purpose and architecture
   - Key functions and their roles
   - Important design patterns used
   - Data flow between modules
3. Use analogies to help understanding
4. Explain in Chinese with technical terms in English

## Output Format

- Start with a one-sentence summary
- Then detailed explanation with code references
- End with a mental model diagram if helpful
```

## 测试策略

| 测试文件             | 用例数 | 覆盖内容                                                                                                        |
| -------------------- | ------ | --------------------------------------------------------------------------------------------------------------- |
| `src/skills.test.ts` | ~12    | frontmatter 解析、目录扫描、skill 触发（返回 body）、skill 删除、错误处理（不存在/格式错误/缺少字段）、刷新重载 |

### 关键测试场景

- 正常解析：包含 name + description 的合法 frontmatter
- 缺少必填字段：只有 name 没有 description → 报错并跳过
- 格式错误：没有 `---` 分隔符 → 报错并跳过
- skill 不存在：invoke("nonexistent") → 返回错误 ToolResult
- 空目录：skills/ 目录不存在或为空 → scan() 不报错，listMeta() 返回 []
- 多 skill：扫描多个子目录，全部正确解析
- body 分离：frontmatter 和 body 正确分离，invoke 只返回 body 部分

## 未来扩展（本版本不实现）

以下能力在设计中已留出空间，但本版本不实现：

1. **脚本执行**：`dependencies` 字段声明依赖，触发时检查/安装，通过 base path 引用脚本
2. **用户级 skill**：`~/.claude/skills/` 全局目录，与项目级 `skills/` 合并（同名时项目级优先）
3. **资源文件加载**：SKILL.md body 中可引用同目录下的其他文件（如模板）
4. **对话创建 skill**：用户通过对话描述需求，LLM 在 `skills/` 下创建目录和 SKILL.md

这些扩展的关键预留：

- `SkillEntry.basePath` 已设计，脚本执行只需在 body 中引用相对路径
- `scan()` 可扩展为扫描多个目录（项目级 + 用户级）
- `dependencies` 字段已定义，未来添加安装逻辑即可

## 限制

- 本版本 skill 只包含纯文本指示，不执行外部脚本
- skill 目录下的非 SKILL.md 文件本版本不会被读取
- 所有 skill 在单次会话中共享同一个上下文窗口
- skill 列表在启动时静态加载，运行时 `/skill load` 只更新本地缓存，不更新 LLM 看到的工具定义
