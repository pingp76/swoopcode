# PDD-07: 权限管理与执行边界

## 目的

防止 Agent 执行危险操作，破坏系统安全。

因为这是教学版本，当前阶段不考虑用户角色（admin/guest 等），所有用户使用同一套权限规则。

本设计只实现一层轻量、可讲清楚的权限门卫，不追求沙箱级安全。真正的系统隔离仍应依赖操作系统、容器或外部 sandbox。

## 与现有安全机制的关系

项目中已有两层工具内部安全检查：

| 层级     | 位置                              | 机制                         | 说明                                           |
| -------- | --------------------------------- | ---------------------------- | ---------------------------------------------- |
| 工具内部 | `bash.ts` 的 `DANGEROUS_PATTERNS` | 危险命令正则匹配             | 在 bash 工具执行函数内部，作为最后防线         |
| 工具内部 | `files.ts` 的路径安全检查         | 限制在工作目录内，防路径穿越 | 在 `executeRead/executeWrite/executeEdit` 内部 |

**新权限管理层是统一的“门卫”**，在 Agent 循环中、工具执行**之前**拦截。

工具内部的检查保留，两层互不冲突：

- 权限层负责统一模式规则、确认流程、提前拒绝明显不允许的操作。
- 工具层负责最后防线，避免权限层遗漏或未来有其他调用路径绕过 Agent。

重要约束：当前 `files.ts` 的读写编辑都限制在 `process.cwd()` 下。因此本阶段设计也保持“文件工具仅能访问项目目录内路径”，不设计任意路径读取，避免文档行为和代码行为不一致。

## 模式

权限行为由当前运行模式决定。三种模式：

| 模式      | 说明                     | 读操作               | 写操作                           | bash                 |
| --------- | ------------------------ | -------------------- | -------------------------------- | -------------------- |
| `plan`    | 规划模式，只读为主       | 项目目录内，直接允许 | 仅 `.claude/plans/` 内，直接允许 | 禁止                 |
| `auto`    | 自动模式，可自主执行     | 项目目录内，直接允许 | 项目目录内，直接允许             | 允许（受黑名单约束） |
| `default` | 默认模式，敏感操作需确认 | 项目目录内，直接允许 | 项目目录内，需确认               | 需确认               |

模式通过 CLI 命令切换（如 `/mode auto`），默认启动时为 `default` 模式。
`/mode` 命令通过 `cli-commands.ts` 的命令注册表注册，与 `/skill` 命令模式一致。

## 权限数据结构

```typescript
/** Agent 的运行模式 */
type PermissionMode = "plan" | "auto" | "default";

/** 权限决策结果 */
type PermissionDecision =
  | { action: "allow" } // 直接放行
  | { action: "deny"; reason: string } // 直接拒绝
  | { action: "ask"; message: string }; // 需要用户确认

/** 权限上下文：权限检查器需要知道的信息 */
interface PermissionContext {
  toolName: string; // 工具名称（如 "run_bash"）
  args: Record<string, unknown>; // 工具参数（与 ToolExecutor 签名一致）
}

/** 权限管理器接口 */
interface PermissionManager {
  /** 检查权限，返回决策结果 */
  check(ctx: PermissionContext): PermissionDecision;
  /** 切换模式 */
  setMode(mode: PermissionMode): void;
  /** 获取当前模式 */
  getMode(): PermissionMode;
  /** 获取项目根目录 */
  getProjectDir(): string;
}
```

说明：

- `projectDir` 是 `PermissionManager` 的内部状态，由 `createPermissionManager(projectDir)` 传入，不需要每次 `check()` 都重复传入。
- `args` 类型为 `Record<string, unknown>`，与 `ToolExecutor` 签名一致。权限检查时用 `String(args["command"] ?? "")` 等方式提取值做匹配。
- `getMode()` 返回 `PermissionMode`，不要返回宽泛的 `string`，这样 `/mode`、Agent、子智能体之间能保持类型一致。

## 权限检查流程

统一在一个入口按顺序判断，短路返回：

```
check(ctx)
  │
  ├─ 1. 工具分类识别 ──→ 未知工具 → allow（交给 ToolRegistry 返回 Unknown tool）
  │
  ├─ 2. 黑名单检查 ──→ 命中 → deny
  │
  ├─ 3. 路径边界检查 ──→ 文件路径越界 → deny
  │
  ├─ 4. 白名单检查 ──→ 命中 → allow
  │
  ├─ 5. 模式权限检查 ──→ 模式不允许 → deny
  │
  └─ 6. 敏感操作确认 ──→ default 模式下敏感操作 → ask
                          其他 → allow
```

### 1. 工具分类识别

权限层只关心已知工具类型：

| 类型       | 工具                     |
| ---------- | ------------------------ |
| bash       | `run_bash`               |
| file-read  | `run_read`               |
| file-write | `run_write` / `run_edit` |
| memory     | `run_todo_*`             |
| skill      | `run_skill`              |
| subagent   | `run_subagent`           |

未知工具不在权限层拒绝，交给现有 `ToolRegistry.getExecutor()` 分支返回 `Error: Unknown tool`。这样权限层不会吞掉原有错误语义。

### 2. 黑名单（无条件拒绝）

无论什么模式，以下操作直接拒绝。

**bash 命令黑名单**：

权限层应复用 `bash.ts` 中同一套危险命令判断，避免两份正则漂移。实现方式：

- 将 `DANGEROUS_PATTERNS` 或 `isDangerousCommand()` 从 `bash.ts` 导出。
- `permission.ts` 对 `run_bash` 的 `command` 参数调用 `isDangerousCommand(command)`。
- 如果命中，返回 `deny`。

当前工具内部已覆盖的典型危险模式包括：

| 正则/模式                          | 说明               |
| ---------------------------------- | ------------------ |
| `rm -rf` / `--no-preserve-root`    | 递归强制删除       |
| `mkfs`                             | 格式化文件系统     |
| `dd ... of=/dev/`                  | 写入块设备         |
| fork bomb                          | 耗尽系统资源       |
| `chmod 000 /`                      | 锁死根目录权限     |
| `chown -R /`                       | 递归修改根目录归属 |
| 重定向到 `/dev/sda`                | 覆盖硬盘设备       |
| `shutdown` / `reboot` / `poweroff` | 系统电源操作       |
| `iptables` / `ufw`                 | 防火墙操作         |

**文件路径黑名单**：

对 `run_read` / `run_write` / `run_edit` 的 `path` 参数检查。路径黑名单不替代项目目录边界检查，只用于给出更明确的拒绝原因。

| 模式              | 说明     |
| ----------------- | -------- |
| `/etc/`           | 系统配置 |
| `/usr/`           | 系统程序 |
| `~/.ssh/`         | SSH 密钥 |
| `**/credentials*` | 凭证文件 |

路径匹配必须先做规范化：

- 用 `path.resolve(projectDir, rawPath)` 将相对路径解析到项目目录上下文。
- `~` 不会被 `path.resolve()` 自动展开，需单独判断原始字符串是否以 `~/.ssh` 或 `~/.ssh/` 开头。
- `credentials*` 可以用文件 basename 判断，例如 `basename(resolved).startsWith("credentials")`。

### 3. 路径边界检查

所有文件工具都必须限制在项目目录内：

| 工具        | 路径边界               |
| ----------- | ---------------------- |
| `run_read`  | 必须在 `projectDir` 内 |
| `run_write` | 必须在 `projectDir` 内 |
| `run_edit`  | 必须在 `projectDir` 内 |

判断逻辑与 `files.ts` 的 `isPathSafe()` 保持一致：

```typescript
function isInsideProject(rawPath: string, projectDir: string): boolean {
  const resolved = path.resolve(projectDir, rawPath);
  return resolved === projectDir || resolved.startsWith(projectDir + path.sep);
}
```

注意：实现时建议修正或复用 `files.ts` 的路径逻辑，让权限层和工具层都以同一个 `projectDir` 为基准。否则如果进程工作目录变化，权限层和工具层可能判断不一致。

### 4. 白名单（无需确认）

以下操作在通过黑名单和路径边界检查后直接放行：

| 工具         | 条件             |
| ------------ | ---------------- |
| `run_read`   | 路径在项目目录内 |
| `run_todo_*` | 纯内存操作       |
| `run_skill`  | 纯文本注入       |

`run_subagent` 不放入无条件白名单。它需要进入模式权限检查，避免在 `plan` 模式下通过子智能体间接执行 bash 或写项目文件。

### 5. 模式权限检查

根据当前模式判断操作的合法性。

**plan 模式**：

- `run_read`：路径在项目目录内则 allow。
- `run_write` / `run_edit`：路径必须在项目目录的 `.claude/plans/` 下，否则 deny。
- `run_bash`：deny。
- `run_subagent`：allow，但子智能体必须继承同一个 `PermissionManager` 或至少继承同一个 mode，因此它内部仍不能执行 bash，写操作也只能写 `.claude/plans/`。

**auto 模式**：

- `run_read`：路径在项目目录内则 allow。
- `run_write` / `run_edit`：路径在项目目录内则 allow。
- `run_bash`：allow（黑名单已在步骤 2 过滤）。
- `run_subagent`：allow，子智能体继承当前权限模式。

**default 模式**：

- `run_read`：路径在项目目录内则 allow。
- `run_write` / `run_edit`：进入步骤 6，请用户确认。
- `run_bash`：进入步骤 6，请用户确认。
- `run_subagent`：进入步骤 6，请用户确认，因为子智能体可能进一步调用 bash/write/edit。

### 6. 敏感操作确认

仅在 `default` 模式下生效，以下操作需要用户确认：

| 工具           | 需确认条件 |
| -------------- | ---------- |
| `run_bash`     | 始终确认   |
| `run_write`    | 始终确认   |
| `run_edit`     | 始终确认   |
| `run_subagent` | 始终确认   |

确认消息要包含工具名和关键参数，便于用户判断：

- `run_bash`：显示 command。
- `run_write` / `run_edit`：显示 path。
- `run_subagent`：显示 task 的前 120 个字符。

auto 和 plan 模式下不会走到这一步：auto 已按规则 allow，plan 中不允许的操作已 deny。

## 子智能体权限继承

子智能体不能绕过父智能体权限。实现规则：

- 父 Agent 和子 Agent 使用同一个 `PermissionManager` 实例。
- 子 Agent 不传 `askUserFn`。
- 如果当前 mode 是 `default`，子智能体内部遇到 `ask` 决策时降级为 `deny`，避免子智能体在后台反复打断用户交互。
- 父 Agent 调用 `run_subagent` 本身在 `default` 模式下需要用户确认。用户确认的是“允许启动这个子任务”，不是提前批准子任务内部所有敏感工具。

这样三种模式的语义保持一致：

| 父级模式  | 子智能体行为                                          |
| --------- | ----------------------------------------------------- |
| `plan`    | 可读项目文件，可写 `.claude/plans/`，不可 bash        |
| `auto`    | 可读写项目文件，可 bash（受黑名单约束）               |
| `default` | 可读项目文件；bash/write/edit 因无 `askUserFn` 被拒绝 |

## 拦截点：在 Agent 循环中的位置

权限检查统一插入 `agent.ts` 的 `handleToolCalls()` 内部，在工具执行前作为唯一拦截点：

```typescript
for (const toolCall of toolCalls) {
  const fnName = toolCall.function.name;
  const executor = tools.getExecutor(fnName);

  // ... executor 找不到 → 写错误 tool_result ...
  // ... JSON.parse 参数 ...

  const decision = permissionManager.check({
    toolName: fnName,
    args,
  });

  if (decision.action === "deny") {
    appendMessage(
      {
        role: "tool",
        tool_call_id: toolCall.id,
        content: `Permission denied: ${decision.reason}`,
      },
      roundCount,
    );
    continue;
  }

  if (decision.action === "ask") {
    // 如果没有确认回调（例如子智能体），ask 降级为 deny。
    if (!askUserFn) {
      appendMessage(
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: `Permission denied: confirmation is required but unavailable.`,
        },
        roundCount,
      );
      continue;
    }

    const approved = await askUserFn(decision.message);
    if (!approved) {
      appendMessage(
        {
          role: "tool",
          tool_call_id: toolCall.id,
          content: `User denied: ${decision.message}`,
        },
        roundCount,
      );
      continue;
    }
  }

  const result = await executor(args);
  // ... P1 压缩、回写历史 ...
}
```

## 用户确认机制

“询问用户”需要暂停 Agent 循环并等待外部输入。实现方式：

```typescript
/** 用户确认回调函数的类型 */
type AskUserFn = (message: string) => Promise<boolean>;
```

推荐接线方式：

1. 新增 `terminal.ts`，统一创建一个 `readline.Interface`。
2. `terminal.ts` 同时提供普通提问函数和权限确认函数，避免 REPL 和确认流程各自创建 readline，抢占同一个标准输入。
3. `index.ts` 先创建 terminal，再从 terminal 取出 `askUserFn` 注入根 Agent，最后把同一个 terminal 注入 REPL。
4. `repl.ts` 不再自己创建 `readline.Interface`，而是使用注入的 terminal 读取用户输入。

建议实现：

```typescript
// terminal.ts
interface Terminal {
  question(prompt: string): Promise<string>;
  askUser(message: string): Promise<boolean>;
  close(): void;
}

function createTerminal(): Terminal {
  // 内部只创建一个 readline.Interface。
  // question() 给 REPL 使用，askUser() 给权限确认使用。
}
```

交互规则：

- 接受 `y` / `yes` / `Y` / `YES` 表示同意。
- 其他输入都视为拒绝。
- 提示文案格式：`Allow tool call? <message> [y/N]`。
- 拒绝后不要抛异常，而是将 `User denied: ...` 作为 tool result 写回 history，让 LLM 能调整计划。

## `createAgent` 签名变更

```typescript
export function createAgent(deps: {
  llm: LLMClient;
  history: History;
  tools: ToolRegistry;
  logger: Logger;
  todoManager?: TodoManager;
  maxRounds?: number;
  compressor: ContextCompressor;
  maxContextTokens?: number;
  // 新增
  permissionManager: PermissionManager; // 权限管理器（必需）
  askUserFn?: AskUserFn; // 用户确认回调（可选，子智能体不传）
}): Agent;
```

子智能体相关类型也要同步更新：

```typescript
createAgentFn: (deps: {
  llm: LLMClient;
  history: History;
  tools: ToolRegistry;
  logger: Logger;
  maxRounds?: number;
  compressor: ContextCompressor;
  maxContextTokens?: number;
  permissionManager: PermissionManager;
  askUserFn?: AskUserFn;
}) => Agent;
```

创建子 Agent 时必须传入父级同一个 `permissionManager`，但不传 `askUserFn`。

## `/mode` CLI 命令

新增 `createModeCliCommand(permissionManager, logger)`，注册到 `cli-commands.ts`。

命令行为：

| 输入            | 行为                       |
| --------------- | -------------------------- |
| `/mode`         | 显示当前模式和用法         |
| `/mode plan`    | 切换到 plan                |
| `/mode auto`    | 切换到 auto                |
| `/mode default` | 切换到 default             |
| `/mode xxx`     | 提示合法值，不改变当前模式 |

输出示例：

```text
Current mode: default
Usage: /mode <plan|auto|default>
```

切换成功：

```text
Mode switched to auto.
```

## 模块结构

```
src/
├── permission.ts       # 权限管理模块
│                        #   createPermissionManager(projectDir) → PermissionManager
│                        #   - 黑名单/白名单/模式规则
│                        #   - 路径边界判断
│                        #   - check() 统一入口
│                        #   - setMode() / getMode() / getProjectDir()
├── terminal.ts         # 终端输入输出封装
│                        #   createTerminal() → Terminal
│                        #   - question() 给 REPL 使用
│                        #   - askUser() 给权限确认使用
```

其他文件的修改：

| 文件                    | 改动                                                                                                 |
| ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/agent.ts`          | `createAgent()` 新增 `permissionManager` 和 `askUserFn` 参数；`handleToolCalls()` 中增加权限检查拦截 |
| `src/tools/bash.ts`     | 导出 `isDangerousCommand()` 供权限层复用                                                             |
| `src/cli-commands.ts`   | 新增 `createModeCliCommand()`，注册 `/mode` 命令                                                     |
| `src/repl.ts`           | 改为使用注入的 `Terminal`，不再自行创建 readline                                                     |
| `src/index.ts`          | 创建 `Terminal`、`permissionManager`，将 `terminal.askUser` 注入根 agent；注册 `/mode`               |
| `src/tools/subagent.ts` | 子智能体创建 agent 时传入同一个 `permissionManager`，不传 `askUserFn`                                |
| `src/tools/files.ts`    | 确认路径判断与 `permission.ts` 以同一个 `projectDir` 为基准，必要时复用同一个 helper                 |

## 实现顺序

1. 新增 `permission.ts`，实现 `PermissionMode`、`PermissionDecision`、`PermissionManager`、`createPermissionManager()`。
2. 增加 `permission.test.ts`，先覆盖黑名单、路径边界、三种模式行为。
3. 在 `agent.ts` 注入权限检查，并增加 ask 降级 deny 的逻辑。
4. 增加 `agent` 相关测试，覆盖 allow / deny / ask approve / ask reject。
5. 新增 `/mode` 命令和测试。
6. 增加 `terminal.ts`，让 REPL 输入和权限确认共享同一个 readline。
7. 更新 `subagent.ts`，确保子智能体继承同一个 `permissionManager`。
8. 运行 `npm run typecheck` 和相关测试。
9. 按需更新 `doc/summary.md`。

## 测试计划

新增或更新以下测试：

| 测试文件                     | 覆盖点                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `src/permission.test.ts`     | 默认 mode、mode 切换、bash 黑名单、文件路径黑名单、路径越界、plan/auto/default 决策  |
| `src/agent.test.ts`          | deny 写入 tool result、ask 无回调降级 deny、ask 同意后执行工具、ask 拒绝后不执行工具 |
| `src/cli-commands.test.ts`   | `/mode` 查看、切换、非法参数                                                         |
| `src/tools/subagent.test.ts` | 子智能体创建时接收同一个 `permissionManager`，且不传 `askUserFn`                     |
| `src/tools/files.test.ts`    | 如调整路径 helper，补充 projectDir 边界一致性测试                                    |

关键用例：

- `plan` 下 `run_bash` 返回 deny。
- `plan` 下 `run_write` 写 `src/a.ts` 返回 deny，写 `.claude/plans/x.md` 返回 allow。
- `auto` 下 `run_write` 写项目内路径 allow，写 `../outside.txt` deny。
- `default` 下 `run_bash` 返回 ask。
- `default` 下无 `askUserFn` 时 Agent 将 ask 降级为 deny。
- `run_subagent` 在 `default` 下需要父级确认；子智能体内部敏感操作因无 `askUserFn` 被拒绝。

## 配置

无需额外 `.env` 配置。权限规则硬编码在 `permission.ts` 中（教学项目，保持简单）。

如果未来需要可配置化，可以将黑名单/白名单移到配置文件中。

## 重构后实现对齐说明

权限章节的原始设计主要处理前台工具的 plan/default/auto 三种交互模式。当前实现进一步把“交互权限”和“非交互执行边界”拆开：`permission.ts` 继续负责用户确认、路径边界和工具分类；`execution-policy.ts` 负责 Async Run、Schedule、只读子 agent 等非交互路径的 readonly/ci/workspace_write profile。

这样做的原因是：后台任务和定时任务不能在无人值守时弹出 ask，但也不能继承前台 auto 模式的全部写权限。因此它们必须使用一个可测试、可复用、默认收紧的 ExecutionPolicy。`command-safety.ts` 则把普通 bash 和 ExecutionPolicy 都需要的危险命令黑名单抽出来，避免两套规则漂移。
