# PDD-08: Hook 机制

## 审阅结论

当前草案已经抓住了 Hook 的核心：在 Agent 主流程的固定时机发出事件，让外部逻辑观察或干预主流程。但要真正落地到当前 TypeScript 教学项目，还需要补齐四点：

1. Hook 不能破坏现有 OpenAI tool_call / tool_result 配对规则。
2. Hook 不能替代 `permission.ts`，权限管理仍然是安全边界。
3. HookRunner 需要清晰的顺序、短路、错误处理规则。
4. 文档需要明确要改哪些文件、在哪些位置插入 Hook、如何测试。

本阶段建议实现一个轻量的“进程内 Hook 系统”：Hook 是 TypeScript 函数，不引入脚本执行、配置文件热加载、并发调度等复杂能力。这样最适合教学项目，也能保持主流程可读。

## 目标

Hook 机制的目的，是让 Agent 主流程更容易扩展。

主流程只负责两件事：

- 在固定时机发出事件，附带当前上下文。
- 根据 Hook 返回结果决定继续、阻止或补充上下文。

Hook 负责外部扩展逻辑，例如：

- 会话开始时注入提示。
- 工具执行前记录审计信息。
- 工具执行前阻止某些自定义规则。
- 工具执行后追加提醒或观察结果。

## 非目标

本阶段不实现：

- 不执行外部 shell hook 脚本。
- 不读取 `.claude/hooks.json` 一类配置文件。
- 不做 Hook 并发执行。
- 不做复杂优先级系统。
- 不把 Hook 作为安全机制。

安全相关的强制规则仍然由 `permission.ts` 负责。Hook 可以做教学用途的扩展和提醒，但不能替代权限门卫。

## 事件范围

因为这是教学代码，本阶段只实现三处 Hook：

| 事件           | 触发时机                                             | 用途                             |
| -------------- | ---------------------------------------------------- | -------------------------------- |
| `SessionStart` | 每个 Agent 实例第一次 `run()` 时，进入 LLM 主循环前  | 注入会话级提示或做初始化记录     |
| `PreToolUse`   | 工具参数解析成功、权限检查通过之后、工具真正执行之前 | 审计、提醒、按自定义规则阻止工具 |
| `PostToolUse`  | 工具执行、P1 压缩、tool_result 写入之后              | 记录结果、追加观察、提醒后续动作 |

### 为什么放在权限检查之后？

`PreToolUse` 建议放在权限检查之后：

```
解析参数
  ↓
permissionManager.check()
  ↓
runHook("PreToolUse")
  ↓
executor(args)
```

原因：

- 权限管理是更底层的安全门卫，应先拦截危险操作。
- Hook 是扩展点，不应负责复制黑名单、路径边界等安全逻辑。
- Hook 看到的是“已经被系统允许、即将执行”的工具调用，更容易教学理解。

如果未来需要观察被权限拒绝的工具，可以新增 `ToolDenied` 事件；本阶段不做。

## Hook 返回语义

Hook 返回三种结果：

| exit_code | 名称     | 含义                       |
| --------- | -------- | -------------------------- |
| `0`       | continue | 继续当前动作               |
| `1`       | block    | 阻止当前动作               |
| `2`       | inject   | 注入一条补充消息，然后继续 |

TypeScript 表示：

```typescript
export type HookExitCode = 0 | 1 | 2;

export interface HookResult {
  /** 0=继续，1=阻止，2=注入补充消息后继续 */
  exitCode: HookExitCode;
  /** 给用户、LLM 或日志看的说明文本 */
  message?: string;
}
```

注意命名使用 `exitCode`，保持 TypeScript 项目中的 camelCase 风格。文档中可以解释为 exit code，但代码里不要使用 `exit_code`。

## 重要约束：不能打断 tool_call / tool_result 配对

当前项目使用 OpenAI 兼容的 function calling。只要 assistant 消息里有 `tool_calls`，后面就必须给每个 `tool_call_id` 补一条 `role: "tool"` 消息。

因此，`PreToolUse` 的 `exitCode: 2` 不能真的在工具执行前插入一条 `user` 消息。否则历史会变成：

```
assistant(tool_calls)
user(补充消息)      // 错误：中间插入了非 tool 消息
tool(tool_result)
```

这会破坏消息格式。

本设计采用“延迟注入”规则：

- `PreToolUse` 返回 `2`：先记录待注入消息，工具照常执行。
- 当前 assistant 的所有 tool_result 都写入 history 后，再追加 hook 补充消息。
- 补充消息使用 `role: "user"`，让下一轮 LLM 能看到。

也就是说，真实历史顺序是：

```
assistant(tool_calls)
tool(tool_result)
user([Hook: PreToolUse] 补充消息)
```

`PostToolUse` 的 `exitCode: 2` 也使用同样规则：先保证 tool_result 写入，再追加补充消息。

## 事件 payload 设计

统一事件结构：

```typescript
export type HookEventName = "SessionStart" | "PreToolUse" | "PostToolUse";

export type HookEvent =
  | {
      name: "SessionStart";
      payload: {
        query: string;
      };
    }
  | {
      name: "PreToolUse";
      payload: {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        round: number;
      };
    }
  | {
      name: "PostToolUse";
      payload: {
        toolCallId: string;
        toolName: string;
        args: Record<string, unknown>;
        round: number;
        output: string;
        error: boolean;
      };
    };
```

设计说明：

- `SessionStart` 只放 `query`，保持简单。
- `PreToolUse` 放解析后的 `args`，不放原始 JSON 字符串。
- `PostToolUse` 的 `output` 使用“已经经过 P1 即时压缩后的内容”，与最终写入 history 的 tool result 一致。
- `round` 使用 `agent.ts` 当前的 `roundCount`。

## HookRunner 接口

新增模块：`src/hooks.ts`

```typescript
export type HookHandler<T extends HookEvent = HookEvent> = (
  event: T,
) => Promise<HookResult> | HookResult;

export interface HookRunner {
  run(event: HookEvent): Promise<HookResult>;
}
```

工厂函数：

```typescript
export function createHookRunner(
  handlers: Partial<Record<HookEventName, HookHandler[]>>,
  logger: Logger,
): HookRunner {
  ...
}
```

### 多个 Hook 的执行规则

同一个事件可以注册多个 handler，按注册顺序串行执行。

聚合规则：

1. 初始结果为 `{ exitCode: 0 }`。
2. 某个 handler 返回 `0`：继续执行下一个 handler。
3. 某个 handler 返回 `2`：收集 `message`，继续执行下一个 handler。
4. 某个 handler 返回 `1`：立即短路，返回 block。
5. 如果多个 handler 返回 `2`，将 message 用空行拼接。

也就是：

- `1` 的优先级最高。
- `2` 可以累积。
- 没有 handler 时等价于 `0`。

伪代码：

```typescript
async function run(event: HookEvent): Promise<HookResult> {
  const list = handlers[event.name] ?? [];
  const injected: string[] = [];

  for (const handler of list) {
    try {
      const result = await handler(event);
      if (result.exitCode === 1) return result;
      if (result.exitCode === 2 && result.message) {
        injected.push(result.message);
      }
    } catch (error) {
      logger.warn("Hook %s failed: %s", event.name, formatError(error));
    }
  }

  if (injected.length > 0) {
    return { exitCode: 2, message: injected.join("\n\n") };
  }
  return { exitCode: 0 };
}
```

Hook 抛异常时只记录 warn，然后继续。原因是本阶段 Hook 是扩展机制，不是安全机制；不能因为一个扩展逻辑异常就让 Agent 主流程不可用。

## Agent 集成方案

### createAgent 新增依赖

`agent.ts` 的 `createAgent()` 依赖中增加可选 `hookRunner`：

```typescript
hookRunner?: HookRunner;
```

没有传入时使用空实现，避免所有测试都必须手动构造 HookRunner。

```typescript
const hooks = hookRunner ?? createNoopHookRunner();
```

也可以直接在调用处判断 `if (hookRunner)`，但空实现更利于保持主流程直线阅读。

### SessionStart 集成

在 `run(query)` 中，用户消息加入 history 后、主循环开始前触发一次。

每个 Agent 实例只触发一次：

```typescript
let sessionStarted = false;

async run(query) {
  appendMessage({ role: "user", content: query }, 0);

  if (!sessionStarted) {
    sessionStarted = true;
    const result = await hooks.run({
      name: "SessionStart",
      payload: { query },
    });

    if (result.exitCode === 1) {
      return result.message ?? "Session blocked by hook.";
    }

    if (result.exitCode === 2 && result.message) {
      appendMessage(
        { role: "user", content: `[Hook: SessionStart]\n${result.message}` },
        0,
      );
    }
  }

  ...
}
```

### PreToolUse 集成

在 `handleToolCalls()` 内部：

1. 找到 executor。
2. 解析 JSON 参数。
3. 执行权限检查。
4. 触发 `PreToolUse`。
5. 根据 Hook 结果决定是否执行工具。

`PreToolUse` 返回 `1` 时，必须写入一条 `role: "tool"` 消息来满足 tool_call 配对：

```typescript
const pre = await hooks.run({
  name: "PreToolUse",
  payload: {
    toolCallId: toolCall.id,
    toolName: fnName,
    args,
    round: roundCount,
  },
});

if (pre.exitCode === 1) {
  appendMessage(
    {
      role: "tool",
      tool_call_id: toolCall.id,
      content: `Blocked by PreToolUse hook: ${pre.message ?? "no reason"}`,
    } as ChatCompletionMessageParam,
    roundCount,
  );
  continue;
}

if (pre.exitCode === 2 && pre.message) {
  pendingHookMessages.push(`[Hook: PreToolUse]\n${pre.message}`);
}
```

这里的 `pendingHookMessages` 是当前 `handleToolCalls()` 内部的数组。等当前 assistant 的所有工具结果都写完，再统一追加为 `user` 消息，避免破坏 tool_result 顺序。

### PostToolUse 集成

工具执行和 P1 压缩完成后，先写入 tool result，再运行 `PostToolUse`：

```typescript
const result = await executor(args);
const compressed = compressor.compressToolResult(
  fnName,
  toolCall.id,
  result.output,
);
const toolOutput = compressed.content;

appendMessage(
  {
    role: "tool",
    tool_call_id: toolCall.id,
    content: toolOutput,
  } as ChatCompletionMessageParam,
  roundCount,
);

const post = await hooks.run({
  name: "PostToolUse",
  payload: {
    toolCallId: toolCall.id,
    toolName: fnName,
    args,
    round: roundCount,
    output: toolOutput,
    error: result.error,
  },
});

if (post.exitCode === 1) {
  pendingHookMessages.push(
    `[Hook: PostToolUse]\nPostToolUse requested block after tool execution: ${
      post.message ?? "no reason"
    }`,
  );
}

if (post.exitCode === 2 && post.message) {
  pendingHookMessages.push(`[Hook: PostToolUse]\n${post.message}`);
}
```

`PostToolUse` 发生在工具已经执行之后，因此 `exitCode: 1` 不能“阻止已经发生的工具执行”。本阶段将它解释为“阻止后续静默继续”，也就是向下一轮 LLM 注入提醒消息，让模型知道 Hook 对结果提出了阻断/警告。

为了避免语义混乱，也可以在实现中限制 `PostToolUse` 只支持 `0` 和 `2`。但为了保持统一 HookResult，本设计保留 `1`，并明确其含义。

### 追加 pendingHookMessages

`handleToolCalls()` 处理完当前 assistant 返回的所有 tool call 后，再追加补充消息：

```typescript
for (const message of pendingHookMessages) {
  appendMessage({ role: "user", content: message }, roundCount);
}
```

这样能保证：

- 每个 tool_call 都有对应 tool_result。
- Hook 补充内容能被下一轮 LLM 看到。
- 多工具调用时，不会在多个 tool_result 中间插入 user 消息。

## 与现有模块的关系

| 模块                           | 改动                                                                   |
| ------------------------------ | ---------------------------------------------------------------------- |
| `src/hooks.ts`                 | 新增 Hook 类型、HookRunner、noop runner、createHookRunner              |
| `src/agent.ts`                 | 注入 `hookRunner`，在 SessionStart / PreToolUse / PostToolUse 三处触发 |
| `src/index.ts`                 | 创建默认 HookRunner 并传给父 Agent；初始可不注册任何 Hook              |
| `src/tools/subagent.ts`        | 子智能体可选择继承父级 hookRunner，或默认不传                          |
| `src/hooks.test.ts`            | 新增 HookRunner 单元测试                                               |
| `src/agent.test.ts` 或新增测试 | 覆盖 Agent 与 Hook 的集成行为                                          |
| `doc/summary.md`               | 功能实现后更新项目状态                                                 |

子智能体建议默认继承父级 hookRunner。这样“工具执行前后可观察”在父子 Agent 中表现一致。若未来需要区分父子智能体，可以在 payload 中增加 `agentScope: "parent" | "subagent"`，本阶段不加。

## 实现步骤

### 第一步：新增 `src/hooks.ts`

实现内容：

- `HookExitCode`
- `HookEventName`
- `HookEvent`
- `HookResult`
- `HookHandler`
- `HookRunner`
- `createHookRunner()`
- `createNoopHookRunner()`

保持工厂函数 + 闭包风格，符合当前项目模式。

### 第二步：编写 `src/hooks.test.ts`

至少覆盖：

1. 没有 handler 时返回 `exitCode: 0`。
2. 单个 handler 返回 `0`。
3. 单个 handler 返回 `1` 时短路。
4. 多个 handler 返回 `2` 时消息拼接。
5. 前一个 handler 返回 `1` 时后续 handler 不执行。
6. handler 抛异常时记录 warn，runner 继续执行后续 handler。

### 第三步：修改 `src/agent.ts`

改动点：

1. 引入 `HookRunner` / `createNoopHookRunner` 类型和函数。
2. `createAgent()` deps 增加 `hookRunner?: HookRunner`。
3. 增加 `sessionStarted` 闭包状态。
4. 在 `run(query)` 开头触发 `SessionStart`。
5. 在 `handleToolCalls()` 权限检查之后触发 `PreToolUse`。
6. 在工具结果写入后触发 `PostToolUse`。
7. 使用 `pendingHookMessages` 延迟追加补充消息。

注意：所有新增逻辑都应有中文注释，解释为什么延迟注入，避免破坏 tool_call/tool_result 配对。

### 第四步：修改 `src/index.ts`

先创建一个空 HookRunner：

```typescript
const hookRunner = createHookRunner({}, logger);
```

然后传入父 Agent。

如果子智能体需要继承，`SubagentToolProvider` 的依赖也要补充 `hookRunner`，并在创建子 Agent 时传入。

### 第五步：补充 Agent 集成测试

建议用 fake LLM / fake ToolRegistry 做最小测试，不需要调用真实模型。

至少覆盖：

1. `SessionStart` 返回 `2` 时，会在第一次 LLM 调用前注入消息。
2. `SessionStart` 每个 Agent 实例只触发一次。
3. `PreToolUse` 返回 `1` 时，不执行工具，但会写入 tool result。
4. `PreToolUse` 返回 `2` 时，工具照常执行，并在所有 tool result 后追加 user 补充消息。
5. `PostToolUse` 返回 `2` 时，追加 user 补充消息。
6. 多 tool call 场景中，补充消息不会插入到 tool result 中间。

### 第六步：实现后更新 `doc/summary.md`

代码完成后，在 `doc/summary.md` 中补充：

- 当前状态新增 Hook 机制。
- 源码结构新增 `hooks.ts` 和 `hooks.test.ts`。
- Agent 核心循环新增三处 Hook 触发点。
- 测试覆盖表新增 Hook 测试。

## 推荐文件结构

```
src/
├── hooks.ts
├── hooks.test.ts
├── agent.ts
└── index.ts
```

`hooks.ts` 不依赖 `agent.ts`，只依赖 `logger.ts` 的 `Logger` 类型。这样可以避免循环依赖。

## 示例 Hook

教学用途可以先在测试或 debug 文件中演示，而不是默认启用。

```typescript
const hookRunner = createHookRunner(
  {
    PreToolUse: [
      (event) => {
        if (
          event.name === "PreToolUse" &&
          event.payload.toolName === "run_bash"
        ) {
          return {
            exitCode: 2,
            message: "即将执行 bash 命令，请在下一轮回复中简要说明执行结果。",
          };
        }
        return { exitCode: 0 };
      },
    ],
  },
  logger,
);
```

## 最终流程

```
用户消息写入 history
  |
  v
SessionStart
  |
  v
LLM 发起 tool_use
  |
  v
权限检查 permissionManager.check()
  |
  v
runHook("PreToolUse")
  |
  +-- exit 1 -> 写入 blocked tool_result，跳过工具执行
  +-- exit 2 -> 记录 pending hook message，继续执行工具
  +-- exit 0 -> 继续执行工具
  |
  v
执行工具
  |
  v
P1 即时压缩工具输出
  |
  v
写入 tool_result
  |
  v
runHook("PostToolUse")
  |
  +-- exit 2 -> 记录 pending hook message
  +-- exit 1 -> 记录 warning hook message
  +-- exit 0 -> 正常结束
  |
  v
当前 assistant 的所有 tool_result 写完后
  |
  v
追加 pending hook messages
  |
  v
下一轮 LLM
```

这个版本的 Hook 机制足够小，但关键边界清楚：主循环可扩展、消息格式不被破坏、权限系统仍然独立可靠。
