# PDD-01: Agent Loop 基础循环

## 目标

实现一个最简的 Coding Agent REPL：用户从命令行输入 → 调用 LLM → 处理响应（包括工具调用）→ 循环直到输入 exit。

## 模型配置

通过 `.env` 文件管理，不硬编码在代码中。

```
LLM_API_KEY=your-api-key-here
LLM_BASE_URL=https://api.minimaxi.com/v1
LLM_MODEL=MiniMax-M2.5
LOG_LEVEL=info
```

- 使用 OpenAI 兼容格式的 API，通过 `openai` SDK + 自定义 baseURL 接入 MiniMax
- `.env` 已加入 `.gitignore`，不会泄露密钥

## 工作流程

```
┌─────────────────────────────────────────────┐
│  用户输入 query                              │
│       ↓                                     │
│  存入 history（role: user, round: 0）        │
│       ↓                                     │
│  ┌─→ 调用 LLM（传入 history + tools 定义）   │
│  │      ↓                                   │
│  │  将 LLM 响应存入 history（role: assistant）│
│  │      ↓                                   │
│  │  有工具调用？                              │
│  │  ├── 是 → 权限检查 → 执行工具 → 结果压缩  │
│  │  │        → 结果存入 history              │
│  │  │        （role: tool）→ 回到 ↑          │
│  │  └── 否 → 打印文本回复给用户              │
│       ↓                                     │
│  等待下一次用户输入（exit 退出）              │
└─────────────────────────────────────────────┘
```

## 项目结构

```
src/
├── index.ts            # 组装根（Composition Root）：初始化所有组件并接线
├── repl.ts             # REPL 交互层：处理用户输入循环
├── cli-commands.ts     # CLI 命令注册与分发（/skill、/mode 等）
├── config.ts           # 从 .env 加载配置（API key、baseURL、模型名）
├── logger.ts           # 可调级别的日志工具（debug/info/warn/error）
├── terminal.ts         # 终端接口：封装 readline，供 REPL 和权限确认共享
├── llm.ts              # LLM 客户端：封装 openai SDK，通过 baseURL 接入 MiniMax
├── llm-logger.ts       # LLM 通信日志器：记录请求/响应便于调试
├── history.ts          # 对话历史管理：维护消息 + 轮次元信息 + system prompt
├── agent.ts            # Agent 主循环：think → act → observe（含内部步骤函数）
├── normalize.ts        # 消息标准化：补全 tool_result、合并同角色消息
├── message-block.ts    # 消息块：压缩操作的原子单位（分组、估算、展平）
├── compressor.ts       # 上下文压缩器：P0 衰减 / P1 即时 / P2 全量
├── permission.ts       # 权限管理：工具执行前的统一拦截层
├── todo.ts             # TODO 任务管理器：session 级别的任务列表
├── skills.ts           # Skill 技能系统：按需加载的 prompt 扩展机制
└── tools/
    ├── types.ts        # 工具公共类型定义（ToolResult 等）
    ├── bash.ts         # bash 工具：执行 shell 命令 + 危险命令过滤
    ├── files.ts        # 文件工具：run_read / run_write / run_edit
    ├── registry.ts     # 工具注册表：统一管理工具定义与执行函数
    └── subagent.ts     # 子智能体工具：run_subagent
```

### 各模块职责

| 模块                | 职责                    | 关键接口                                                                                   |
| ------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| `config.ts`         | 从 .env 加载配置        | `loadConfig()` → `Config`                                                                  |
| `logger.ts`         | 分级日志输出            | `createLogger(level)` → `Logger`                                                           |
| `terminal.ts`       | 终端 readline 封装      | `createTerminal()` → `Terminal.question/close/askUser`                                     |
| `llm.ts`            | 封装 LLM API 调用       | `createLLMClient(config, logger)` → `LLMClient.chat()`                                     |
| `history.ts`        | 管理对话上下文 + 元信息 | `createHistory()` → `{ add(msg, meta?), getMessages, getEntries, setSystemPrompt, clear }` |
| `permission.ts`     | 工具执行前权限拦截      | `createPermissionManager(dir)` → `PermissionManager.check()`                               |
| `tools/bash.ts`     | 执行 shell 命令         | `executeBash(command)` → `ToolResult`                                                      |
| `tools/registry.ts` | 注册和查找工具          | `createToolRegistry(todo?, subagent?, skill?)` → `{ getToolDefinitions, getExecutor }`     |
| `agent.ts`          | Agent 主循环            | `createAgent(deps)` → `Agent.run(query)`                                                   |
| `repl.ts`           | REPL 交互循环           | `createRepl(deps)` → `Repl.start()`                                                        |
| `cli-commands.ts`   | CLI 斜杠命令            | `createCliCommandRegistry()` → `{ register, dispatch }`                                    |
| `index.ts`          | 组装根（纯接线）        | `main()` — 创建所有组件，注入依赖，启动 REPL                                               |

## 核心设计模式

### 1. 工厂函数 + 闭包

所有模块都使用 `createXxx()` 工厂函数创建实例，内部状态通过闭包保护：

```typescript
export function createHistory(): History {
  const messages: ChatCompletionMessageParam[] = []; // 闭包私有变量
  const rounds: (number | undefined)[] = []; // 轮次元信息（与 messages 一一对应）
  let systemPrompt: string | null = null; // system prompt 独立存储

  return {
    add(msg, meta?) {
      messages.push(msg);
      rounds.push(meta?.round); // round 元信息同步写入
    },
    getMessages() {
      const result = [...messages];
      if (systemPrompt)
        result.unshift({ role: "system", content: systemPrompt });
      return result;
    },
    getEntries() {
      /* 返回带 round 元信息的条目列表 */
    },
    setSystemPrompt(prompt: string) {
      systemPrompt = prompt;
    },
    clear() {
      messages.length = 0;
      rounds.length = 0;
    },
  };
}
```

好处：不需要 class，不需要 this，TypeScript 类型自动推导。

### 2. 依赖注入

Agent 通过参数注入所有依赖，而不是在内部创建：

```typescript
const agent = createAgent({
  llm,
  history,
  tools,
  logger,
  todoManager,
  compressor,
  permissionManager,
  askUserFn: terminal.askUser.bind(terminal),
});
```

好处：

- 测试时可以传入 mock 对象
- 替换组件不需要改 agent 代码

### 3. 接口定义行为

每个模块先定义 interface，再实现。调用者只依赖接口，不依赖实现：

```typescript
interface LLMClient {
  chat(messages, tools?): Promise<LLMResponse>;
}
```

### 4. 工具注册表模式

新工具只需要注册一个 ToolEntry，不需要修改 agent 代码：

```typescript
register({
  definition: bashToolDefinition,  // 告诉 LLM 工具的接口
  execute: async (args: Record<string, unknown>) => ...,  // 实际执行逻辑
});
```

工具参数类型为 `Record<string, unknown>`（而非 `Record<string, string>`），因为 LLM 返回的 JSON 经 `JSON.parse` 后值可以是 string、number、array 等。工具实现时需用 `String()` / `Number()` 做类型转换。

### 5. 组装根模式

`index.ts` 作为组装根（Composition Root），只做组件创建和依赖注入，不包含业务逻辑：

```typescript
async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const terminal = createTerminal();
  const llm = createLLMClient(config, llmLogger);
  const history = createHistory();
  // ... 创建所有组件 ...
  const repl = createRepl({ agent, logger, commands, terminal });
  repl.start();
}
```

REPL 交互、命令分发、错误显示属于"交互层"，拆分到独立的 `repl.ts` 和 `cli-commands.ts`。

## Agent 循环详解

Agent 的核心是一个无限循环，每轮做三件事：

1. **THINK**：把对话历史发给 LLM，让它思考下一步该做什么
2. **ACT**：LLM 可能返回文本回复，也可能请求调用工具
3. **OBSERVE**：
   - 如果是工具调用 → 权限检查 → 执行工具 → 结果压缩 → 把结果加入历史，回到 THINK
   - 如果是文本回复 → 返回给用户，循环结束

一个用户问题可能触发多轮 LLM 调用，例如：

- 第 1 轮：LLM 调用 bash 查看文件列表
- 第 2 轮：LLM 看到列表后，调用 bash 读取某个文件
- 第 3 轮：LLM 根据文件内容，生成最终的文字回复

### 内部步骤函数（重构后）

Agent 主循环从 `run()` 中提取了四个职责明确的内部函数：

| 函数                                     | 职责                                                                                |
| ---------------------------------------- | ----------------------------------------------------------------------------------- |
| `appendMessage(msg, round)`              | 向 history 添加消息（round 元信息由 history 统一管理）                              |
| `prepareMessages(roundCount)`            | 消息处理管道：getEntries → annotate → normalize → group → decay → compact → flatten |
| `handleToolCalls(toolCalls, roundCount)` | 工具调用循环：解析参数 → 权限检查 → 执行 → P1 压缩 → 回写历史                       |
| `buildRoundLimitResponse(roundCount)`    | 子智能体轮次上限检测与截断响应                                                      |

提取后主循环骨架约 40 行，读者仍能一眼看懂整体流程。

## 权限管理

工具执行前由 `permission.ts` 统一拦截，支持三种运行模式：

| 模式      | 说明                                               |
| --------- | -------------------------------------------------- |
| `default` | 敏感操作（bash、文件写入、子智能体）需用户确认     |
| `plan`    | 只读模式：禁止 bash，文件写入仅限 `.claude/plans/` |
| `auto`    | 通过黑名单和路径边界的操作直接放行                 |

权限检查流程：工具分类 → 黑名单 → 路径边界 → 白名单 → 模式规则 → 敏感确认。
子智能体共享父级的 PermissionManager 实例（无 `askUserFn` 时 ask 降级为 deny）。

## Bash 工具安全机制

使用正则表达式黑名单过滤危险命令：

- `rm -rf`、`mkfs`、`dd of=/dev/` 等破坏性操作
- `shutdown`、`reboot`、`poweroff` 等系统控制命令
- `iptables`、`ufw` 等防火墙操作
- fork bomb 等恶意模式

被拦截的命令会返回错误信息给 LLM，LLM 可以调整策略尝试其他方案。

## 测试

| 测试文件                 | 覆盖内容                                            |
| ------------------------ | --------------------------------------------------- |
| `src/history.test.ts`    | 历史增删、返回副本、清空、元信息管理、system prompt |
| `src/logger.test.ts`     | 日志级别过滤                                        |
| `src/permission.test.ts` | 三种模式的权限决策、黑名单、路径边界                |
| `src/tools/bash.test.ts` | 危险命令拦截、正常命令执行、错误处理                |

运行测试：`npm test`

## 重构后实现对齐说明

原始 PDD 仍保留最小 Agent Loop 的完整教学设计。当前代码在此基础上新增了时间语义收口：`agent.ts` 内部区分 `turnIndex`、`loopRound`、`loopIndex`，`history.ts` 为历史消息记录 `messageSequence`，`transcript.ts` 使用独立 event sequence。这样可以避免早期文档中 `round` 同时表示“用户轮次”“循环轮次”“消息年龄”的语义漂移。

当前实现还保留了“Agent Loop 不直接关心模型厂商、存储布局和权限细节”的教学边界：模型差异在 `llm-adapter.ts` / runtime policy 层收束，工具权限在 Permission/ExecutionPolicy 层收束，长期运行数据在 ProjectContext 派生出的 `agentHome` 下管理。
