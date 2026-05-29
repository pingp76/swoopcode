# 2026-05 第三轮重构方案：ExecutionPolicy 执行边界统一

本文是 `doc/refactor-2026-05-project-review.md` 中“第三轮：权限策略统一”的精确执行计划。它面向后续真正编码的 coding agent，要求先按本文输出本轮 checklist，再实施。

前两轮已经分别修复 Schedule / Async Run / Permission 交叉边界，以及消息管线 tool_call / tool_result 不变量。第三轮开始处理 P1-1：把分散在 `permission.ts`、`tools/bash.ts`、`async-runs.ts`、`schedules.ts`、`tools/registry.ts` 的非交互执行边界收束到一个轻量 `ExecutionPolicy` 模块中。

## 实施状态（2026-05）

本轮已经按本文范围完成一次代码重构：

- 新增 `src/execution-policy.ts`，集中提供 `readonly` / `ci` / reserved `workspace_write` profile 的 command/resource 校验。
- 新增 `src/command-safety.ts`，把普通 `run_bash` 和 `ExecutionPolicy` 共用的危险命令黑名单从 bash tool 中拆出。
- `tools/bash.ts` 保留 `AsyncCommandPolicy` / `createDefaultAsyncCommandPolicy()` 兼容导出，但内部委托给 `execution-policy.ts`。
- `index.ts` 创建一个共享 `executionPolicy` 和一个 readonly command adapter，并注入 Async Run、Schedule、async subagent filtered registry、async run tool provider、subagent tool provider。
- `AsyncRunManager.start()` 已在 runtime 启动路径校验 resources 和 command；Schedule create/trigger 已按共享 policy 校验 resources/command。
- `permission.ts` 保持交互模式职责，scoped subagent bash 使用注入的 readonly command policy；不再在 PermissionManager 内复制非交互命令白名单。
- 已补 `execution-policy.test.ts`，并扩展 `async-runs.test.ts`、`schedules.test.ts`、`permission.test.ts`、`tools/bash.test.ts` 覆盖 readonly/ci/--fix/tsc/workspace_write 边界。

## 一、本轮目标

本轮只处理“执行能力边界”的集中表达：

1. 新增 `src/execution-policy.ts`，集中定义 readonly / ci / future workspace_write 的语义。
2. 把 `AsyncCommandPolicy` 从 `tools/bash.ts` 迁移到 `execution-policy.ts`，保留兼容导出，避免一次性大改 import。
3. 用 argv 级别的命令解析替代纯字符串前缀判断，修复 `npm run lint -- --fix`、`npx eslint --fix`、`npx tsc` 默认 emit 等风险。
4. Async Run `command` executor、Schedule trigger command preflight、subagent scoped bash、filtered registry commandPolicy 共用同一个 policy 实例。
5. `permission.ts` 继续负责交互模式（plan / default / auto）和 ask/deny/allow 决策；`ExecutionPolicy` 负责非交互能力边界。
6. `index.ts` 只创建一次 shared execution policy，并把同一个实例传给 Async/Schedule/Subagent/Registry。

## 二、本轮不做

以下事项明确不纳入第三轮：

1. 不实现 `workspace_write` schedule 或 async run。
2. 不允许 async run 写项目文件；`write_paths` 仍保持第一版空数组约束。
3. 不改变普通前台 `run_bash` 的 default/auto/plan 交互模式。
4. 不新增新的工具 schema 字段。
5. 不实现 linked Task 自动更新，也不实现 OutputStore。
6. 不重构 `PermissionManager` 成框架或容器；只让它调用或依赖新的 policy 类型。
7. 不删除旧教学章节里的简单 bash 安全黑名单；它仍是普通 `run_bash` 的最后防线。

## 三、当前问题定位

### 1. Command policy 放错层

当前 `AsyncCommandPolicy` 和 `createDefaultAsyncCommandPolicy()` 定义在 `src/tools/bash.ts`。这导致一个概念混乱：

```text
tools/bash.ts
  -> 普通前台 run_bash 工具
  -> async/schedule/subagent 的非交互命令策略
```

普通 bash 工具是用户显式执行能力，受 `PermissionManager` 的模式和 ask 控制；而 async/schedule/subagent 是“确认一次后内部不再 ask”的非交互执行能力。两者应该共享危险命令黑名单，但不应该把策略主身份放在 bash tool 模块里。

### 2. 策略实例被重复创建

`index.ts` 当前多处调用 `createDefaultAsyncCommandPolicy()`：

- `createAsyncRunManager({ commandPolicy })`
- async subagent readonly registry 的 `commandPolicy`
- `createScheduleManager({ commandPolicy })`
- `createAsyncRunToolProvider(asyncRunManager, commandPolicy)`
- `createSubagentToolProvider({ commandPolicy })`

这些实例参数相同，但物理上不是同一个 shared dependency。教学项目的组装根约定是“共享实例必须真的共享”，第三轮需要把它收束为：

```ts
const executionPolicy = createExecutionPolicy();
```

然后把同一个对象注入所有需要非交互执行边界的模块。

### 3. Prefix whitelist 太粗

当前 `createDefaultAsyncCommandPolicy().validate(command)` 主要靠：

```ts
trimmed.startsWith("npm run lint")
trimmed.startsWith("npx eslint")
trimmed.startsWith("npx tsc")
```

这会把以下命令误判为允许或语义不清：

```text
npm run lint -- --fix
npx eslint src --fix
npx tsc
npx tsc --outDir dist
npm run build
```

其中 `--fix` 会写文件，`tsc` 不带 `--noEmit` 或项目配置时可能写产物，`build` 属于 CI profile 而非 readonly profile。

## 四、目标设计

### 1. 新模块形状

新增 `src/execution-policy.ts`：

```ts
export type ExecutionProfile = "readonly" | "ci" | "workspace_write";

export interface CommandValidationInput {
  command: string;
  profile?: ExecutionProfile;
}

export interface ResourceValidationInput {
  projectRoot: string;
  readPaths: string[];
  writePaths: string[];
  profile?: ExecutionProfile;
}

export interface ExecutionPolicy {
  maxTimeoutMs: number;
  validateCommand(input: CommandValidationInput): PolicyValidation;
  validateResources(input: ResourceValidationInput): PolicyValidation;
}

export interface PolicyValidation {
  allowed: boolean;
  reason?: string;
}
```

兼容层：

```ts
export interface AsyncCommandPolicy {
  maxTimeoutMs: number;
  validate(command: string): PolicyValidation;
}
```

`AsyncCommandPolicy` 可以先保留为 `ExecutionPolicy` 的 readonly command adapter，避免一次重写所有调用点。

### 2. readonly profile

readonly 只允许不会写项目文件和不会修改 git 状态的诊断命令：

允许：

- `pwd`
- `ls`
- `rg ...`
- `cat ...`
- `head ...`
- `tail ...`
- `sed -n ...`
- `git status`
- `git diff`
- `git log`
- `git show`
- `npm run typecheck`
- `npm run lint`，但不允许 `-- --fix`
- `npm run format:check`
- `npm test`
- `npx vitest run ...`
- `npx eslint ...`，但不允许 `--fix`
- `npx tsc --noEmit`

拒绝：

- shell control operators：`;`、`&&`、`||`、`|`、重定向、反引号、`$()`。
- 写入命令：`git add/commit/push/reset/checkout/switch/restore/clean`。
- 格式化或修复命令：`npm run format`、`npx eslint --fix`、`npm run lint -- --fix`。
- 可能 emit 的 TypeScript 命令：`npx tsc`、`npx tsc -p tsconfig.json`。
- 裸 `find`，尤其 `-delete` / `-exec`。
- 未列入 allowlist 的任意命令。

### 3. ci profile

ci profile 用于未来 Schedule 的 CI/构建场景，但本轮只在 policy 层定义并测试，不向 LLM 暴露新的 schedule profile。

允许 readonly 全部命令，额外允许：

- `npm run build`
- `npm run test`
- `npm run test:coverage`
- `npm run lint`
- `npm run typecheck`
- `npx vitest run ...`
- `npx eslint ...`，仍不允许 `--fix`
- `npx tsc --noEmit`

仍拒绝：

- `--fix`
- git 写操作
- shell control operators
- 任意源码写入或删除命令

注意：ci profile 可能产生 `dist/coverage/cache` 等工具产物。第三轮只定义命令层语义，不打开 Schedule tool schema；后续若开放 `ci` schedule，必须在 PDD14 或新 PDD 中说明产物目录边界。

### 4. workspace_write profile

本轮只保留类型和明确拒绝：

```text
workspace_write is reserved for a later lesson.
```

任何 `validateResources({ profile: "workspace_write" })` 或 `validateCommand(..., "workspace_write")` 在第三轮可以返回 deny，除非调用者是纯类型兼容读旧文件。不要在第三轮尝试实现 patch/write 权限。

### 5. resources policy

`validateResources()` 集中处理：

- `readPaths` 必须是 string array。
- `writePaths` 必须是 string array。
- 每个 read path 必须在 projectRoot 内。
- readonly / ci 下 `writePaths` 必须为空。
- workspace_write 暂时 deny 或仅返回“reserved”。

当前 Async Run `start()` 仍可以保留用户友好的字段错误，但路径和 write_paths 语义应委托给 `ExecutionPolicy`，避免同一规则散在多处。

## 五、改动清单

### A. 新增 ExecutionPolicy 模块

文件：

- `src/execution-policy.ts`
- `src/execution-policy.test.ts`
- `src/tools/bash.ts`
- `src/tools/bash.test.ts`

Checklist：

- [ ] 新增 `ExecutionProfile`、`PolicyValidation`、`ExecutionPolicy`、`AsyncCommandPolicy` 类型。
- [ ] 实现 `createExecutionPolicy()`；`projectRoot` 由每次 `validateResources()` 调用显式传入。
- [ ] 实现 `createReadonlyCommandPolicy(policy?)` 或 `toAsyncCommandPolicy(policy, "readonly")` 兼容 adapter。
- [ ] 从 `tools/bash.ts` 重新导出 `AsyncCommandPolicy` 和 `createDefaultAsyncCommandPolicy()`，保持旧 import 暂时可用。
- [ ] `createDefaultAsyncCommandPolicy()` 内部委托给 `execution-policy.ts`，避免双实现。
- [ ] 命令解析先做 shell operator 检查，再做简单 argv tokenization。
- [ ] tokenization 不需要支持完整 shell 语法；遇到复杂引号/转义无法可靠解析时宁可 deny。
- [ ] `src/tools/bash.test.ts` 中 command policy 测试迁移或复制到 `src/execution-policy.test.ts`。

必补测试：

- [ ] readonly 允许 `git status`、`npm run typecheck`、`npx vitest run src/foo.test.ts`。
- [ ] readonly 允许 `npx tsc --noEmit`。
- [ ] readonly 拒绝 `npx tsc`。
- [ ] readonly 拒绝 `npx eslint --fix`。
- [ ] readonly 拒绝 `npm run lint -- --fix`。
- [ ] readonly 拒绝 `npm run build`。
- [ ] ci 允许 `npm run build`。
- [ ] ci 仍拒绝 `npx eslint --fix`。
- [ ] shell operators 全部拒绝。
- [ ] `validateResources()` 拒绝越界 read path。
- [ ] readonly / ci 拒绝非空 writePaths。

### B. Async Run 接入 ExecutionPolicy

文件：

- `src/async-runs.ts`
- `src/tools/async-runs.ts`
- `src/async-runs.test.ts`
- `src/tools/async-runs.test.ts`

Checklist：

- [ ] `createAsyncRunManager` 依赖从 `commandPolicy: AsyncCommandPolicy` 升级为 `executionPolicy` 或保持兼容命名但类型来自新模块。
- [ ] `start()` 中 resources 验证调用 `executionPolicy.validateResources({ profile: "readonly" })`。
- [ ] `command` executor 在启动前调用 `executionPolicy.validateCommand({ command, profile: "readonly" })`，不能只依赖 tool provider 或 registry。
- [ ] 前台冲突检查中 `run_bash` 的 strict read-only 校验使用同一个 execution policy。
- [ ] async subagent scoped permission 使用同一个 policy adapter。
- [ ] 保持 Async Run 第一版 write_paths 必须为空。

必补测试：

- [ ] `run_async_start` command 拒绝 `npx eslint --fix`。
- [ ] `run_async_start` command 拒绝 `npx tsc`。
- [ ] `run_async_start` command 允许 `npx tsc --noEmit`。
- [ ] `checkForegroundToolConflict()` 在有 running async run 时拒绝前台 `run_bash` 写命令。
- [ ] async subagent 内 `run_bash` 使用相同 readonly policy。

### C. Schedule 接入 ExecutionPolicy

文件：

- `src/schedules.ts`
- `src/tools/schedules.ts`
- `src/schedules.test.ts`
- `src/tools/schedules.test.ts`
- `doc/pdd14.md`

Checklist：

- [ ] `ScheduleExecution.permissionProfile` 类型暂时保留 `readonly | ci | workspace_write`，兼容旧文件和 PDD14 预留。
- [ ] `run_schedule_create` 仍只公开 `readonly`；第三轮不重新开放 `ci`。
- [ ] `ScheduleManager.create()` 或 tool provider 创建前调用 `validateResources(profile="readonly")`。
- [ ] Schedule trigger command preflight 使用 `validateCommand({ profile: schedule.execution.permissionProfile })`。
- [ ] 如果读到旧文件中 profile 是 `ci`，第三轮 policy 可以按 ci 验证 command，但 tool schema 仍不暴露创建入口。
- [ ] 如果读到旧文件中 profile 是 `workspace_write`，触发时必须 fail occurrence，并通知 reserved/unsupported。

必补测试：

- [ ] readonly schedule command 拒绝 `npm run lint -- --fix`。
- [ ] readonly schedule command 允许 `npm run typecheck`。
- [ ] 旧 `ci` schedule command 可允许 `npm run build`（仅旧文件兼容路径）。
- [ ] 旧 `workspace_write` schedule 触发时 fail，并说明未实现。
- [ ] tool schema 仍只暴露 readonly。

### D. PermissionManager 职责收敛

文件：

- `src/permission.ts`
- `src/permission.test.ts`

Checklist：

- [ ] `permission.ts` 从 `execution-policy.ts` import `AsyncCommandPolicy`，不再从 `tools/bash.ts` import 该类型。
- [ ] `PermissionManager` 不负责判断命令是否 readonly；它只负责模式决策和 hard deny。
- [ ] `createScopedSubagentPermissionManager()` 中的 `run_bash` 校验调用 injected command policy adapter。
- [ ] 清理重复代码块：当前 `permission.ts` 中 plan/auto/default 分支存在重复片段，第三轮可以在不改变行为的前提下去重。
- [ ] 保持 memory、task、schedule、async-run 的 mode 语义不变。

必补测试：

- [ ] 现有 permission 测试行为不退化。
- [ ] scoped subagent 对 `npx eslint --fix` deny。
- [ ] scoped subagent 对 `npx tsc --noEmit` allow。
- [ ] schedule create/cancel/delete 在 auto 仍 ask。

### E. Wiring 单实例化

文件：

- `src/index.ts`
- `src/index.test.ts`，如需要
- `doc/summary.md`

Checklist：

- [ ] 在 composition root 创建一次 `executionPolicy`。
- [ ] 使用 adapter 或同一实例传给 AsyncRunManager、ScheduleManager、AsyncRunToolProvider、SubagentToolProvider、filtered readonly registry。
- [ ] 不在 lambda 或 provider 创建时重复调用 `createExecutionPolicy()`。
- [ ] 更新 `doc/summary.md`：新增 ExecutionPolicy 小节或在 Async/Schedule/Permission 段落说明共享执行边界。

## 六、建议 PR / Commit 切分

### PR 1：新增 ExecutionPolicy 并迁移 command policy

目标：

- 完成 A。
- 不接入 Async/Schedule。

建议文件：

- `src/execution-policy.ts`
- `src/execution-policy.test.ts`
- `src/tools/bash.ts`
- `src/tools/bash.test.ts`

验证：

```bash
npm run typecheck
npx vitest run src/execution-policy.test.ts src/tools/bash.test.ts
npx eslint src/execution-policy.ts src/execution-policy.test.ts src/tools/bash.ts src/tools/bash.test.ts
```

### PR 2：Async Run 接入 ExecutionPolicy

目标：

- 完成 B。
- Async Run command/subagent/foreground conflict 共用同一策略。

建议文件：

- `src/async-runs.ts`
- `src/tools/async-runs.ts`
- `src/async-runs.test.ts`
- `src/tools/async-runs.test.ts`
- `src/permission.ts`
- `src/permission.test.ts`

验证：

```bash
npm run typecheck
npx vitest run src/async-runs.test.ts src/tools/async-runs.test.ts src/permission.test.ts
```

### PR 3：Schedule 接入 ExecutionPolicy

目标：

- 完成 C。
- 保持 tool schema 裁剪，不重新开放 ci/workspace_write 创建入口。

建议文件：

- `src/schedules.ts`
- `src/tools/schedules.ts`
- `src/schedules.test.ts`
- `src/tools/schedules.test.ts`
- `doc/pdd14.md`

验证：

```bash
npm run typecheck
npx vitest run src/schedules.test.ts src/tools/schedules.test.ts src/execution-policy.test.ts
```

### PR 4：composition root 单实例化与文档收尾

目标：

- 完成 D、E。
- 清理重复 mode 分支和重复 policy 实例。
- 更新 summary。

建议文件：

- `src/index.ts`
- `src/permission.ts`
- `src/permission.test.ts`
- `doc/summary.md`
- `doc/refactor-2026-05-round3-execution-policy-plan.md`

验证：

```bash
npm run typecheck
npx vitest run src/permission.test.ts src/tools/registry.test.ts src/async-runs.test.ts src/schedules.test.ts
npm run lint
```

如果本地 Vitest 因 Rollup native optional dependency 或 macOS code signature 问题无法启动，需要在最终回复中明确说明这是环境问题，不是测试断言失败。

## 七、实施顺序

1. 先写 `src/execution-policy.test.ts`，覆盖 readonly / ci / resources 的边界。
2. 新增 `src/execution-policy.ts`，让测试通过。
3. 让 `tools/bash.ts` 的旧 `createDefaultAsyncCommandPolicy()` 委托新模块，保留旧测试。
4. 接入 Async Run，确保 runtime start 路径也强制校验 command/resources。
5. 接入 Schedule，确保 persisted 旧 profile 的触发行为清楚。
6. 清理 `permission.ts` 重复分支，只保留交互模式决策。
7. 修改 `index.ts`，保证 policy 单实例共享。
8. 更新 `doc/summary.md` 和 `doc/pdd14.md` 实现备注。

## 八、验收标准

本轮完成后必须满足：

1. readonly / ci 的命令语义只在 `execution-policy.ts` 定义。
2. Async Run、Schedule、subagent scoped permission、filtered registry 使用同一套 command/resource policy。
3. `npx eslint --fix`、`npm run lint -- --fix`、`npx tsc` 明确 deny。
4. `npx tsc --noEmit` 明确 allow。
5. `npm run build` 在 readonly deny，在 ci allow。
6. `write_paths` 在 readonly/ci 下仍 deny。
7. Schedule tool schema 仍只暴露 readonly，避免把未来能力提前交给 LLM。
8. `index.ts` 不再重复创建多个等价 command policy 实例。
9. `permission.ts` 不再承担 readonly command 白名单语义，只保留 mode / ask / hard deny。
10. 相关 docs 与 tests 同步。

## 九、风险提示

1. 不要为了统一策略而把普通前台 `run_bash` 也强行套 readonly policy；前台 bash 的能力仍由 PermissionManager 的交互模式控制。
2. 不要在第三轮打开 `workspace_write`，否则会跨到文件写入和 patch 工具设计。
3. 不要把 parser 做成完整 shell 解释器。教学项目只需要保守解析；看不懂就拒绝。
4. 不要让 Schedule 的 `ci` 在 tool schema 重新出现。第三轮只处理旧文件兼容和 policy 定义。
5. 不要删除 `tools/bash.ts` 的危险命令黑名单。ExecutionPolicy 是非交互边界，bash 工具内部安全检查仍是最后防线。
