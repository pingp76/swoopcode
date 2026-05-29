# 2026-05 第四轮重构方案：OutputStore 与安全编辑工具

本文是 `doc/refactor-2026-05-project-review.md` 中“第四轮：输出读取与安全编辑”的精确执行计划。它面向后续真正编码的 coding agent，要求先按本文输出本轮 checklist，再实施。

前三轮已经分别完成：

1. Schedule / Async Run / Permission 的 P0 交叉边界修复。
2. 消息管线 tool_call / tool_result 不变量修复。
3. 非交互执行边界 `ExecutionPolicy` 收敛。

第四轮处理两个 P1 问题：

1. P1-2：建立统一 Output Handle 与读取工具。
2. P1-4：增加比 `run_edit` 更安全的文件编辑工具。

这两个问题都和“工具执行后的可追踪性、可恢复性、安全写入”有关，但实现时必须拆成小 PR，避免一次性改动 compressor、async-run、schedule、files、registry、permission 后难以 review。

## 实施状态（2026-05）

本轮已经按本文范围完成一次集中重构：

- 新增 `src/output-store.ts` 与 `src/tools/output.ts`，主 Agent 现在注册 `run_output_read`。
- P1 即时压缩输出优先登记到 OutputStore，返回 `<persisted-output ... output-id="out_...">` 和 `run_output_read` 指引。
- Async Run 完成输出会登记到 OutputStore，并保留 `run_async_output_read(run_id)` 作为兼容入口。
- Schedule occurrence 保存 `outputId`，工具展示和 notification 优先提示 `run_output_read(output_id)`；旧 `outputRef` 保留兼容但不自动注册。
- 新增 `run_edit_exact`，并接入 registry、permission、async foreground conflict 检查。
- 已同步更新 `doc/summary.md`、`doc/pdd6.md`、`doc/pdd13.md`、`doc/pdd14.md`。

## 一、本轮目标

本轮目标是让 Agent 看到的“持久化输出”和“文件编辑”都有更清晰的物理边界：

1. 新增轻量 `OutputStore`，用稳定 `output_id` 管理 Agent 自身保存的大输出。
2. 新增 `run_output_read`，只能读取 OutputStore 登记过的输出，不能读取任意 `agentHome` 文件。
3. 让 P1 即时压缩输出从“裸 `.task_outputs/<toolCallId>.txt` 路径”升级为“可用工具读回的 output handle”。
4. 让 Async Run 输出也登记到 OutputStore；保留 `run_async_output_read` 兼容已有教学章节，但新输出引用优先给出 `run_output_read` 路径。
5. 让 Schedule occurrence 保存的 output reference 与 Async Run / compressor 使用同一套 handle 语义。
6. 新增 `run_edit_exact`，作为比 `run_edit` 更安全的精确替换工具。
7. 保留 `run_write` 和 `run_edit`，不破坏早期 lesson 的递进实现；tool description 中提示新编辑优先使用 `run_edit_exact`。
8. 更新 `doc/summary.md`、`doc/pdd6.md`、`doc/pdd13.md`、`doc/pdd14.md` 的实现备注。

## 二、本轮不做

以下事项明确不纳入第四轮：

1. 不实现完整 unified patch 解析器。第四轮只做 `run_edit_exact`，不做 `run_patch`。
2. 不删除 `run_write` 和 `run_edit`，也不改变它们的早期教学语义。
3. 不开放 `workspace_write` execution profile。
4. 不实现 Schedule 的 `linkedTaskUpdate` 自动写 Task。
5. 不实现 `saveRawOutput=false` 的完整输出抑制策略。
6. 不把 OutputStore 做成搜索系统、日志系统或 artifact 数据库。
7. 不实现跨机器、跨 agentHome 的输出迁移。
8. 不把 `run_output_read` 设计成任意文件读取后门；它只能读 OutputStore index 中登记的文件。
9. 不在本轮重构 round / turn / sequence 时间语义；那是 P1-3。
10. 不大拆 `index.ts` wiring；该项不属于第四轮，也不属于第五轮最终收口范围。

## 三、当前问题定位

### 1. P1 即时压缩输出不可直接读回

当前 `compressor.compressToolResult()` 会把过大的工具输出写到：

```text
<agentHome>/.task_outputs/<toolCallId>.txt
```

返回给 LLM 的内容类似：

```text
Full output saved to: .task_outputs/<toolCallId>.txt
```

但 `run_read` 被限制在 `projectRoot` 内，不能读取 `agentHome` 下的 `.task_outputs`。这导致 LLM 看到一个路径，却没有对应工具能稳定读回完整输出。

这不是权限小问题，而是抽象边界问题：

```text
projectRoot 文件读取 = 用户项目文件
agentHome output 读取 = Agent 自己登记过的大输出
```

两者需要不同工具。

### 2. Async Run 输出和普通大输出是两套引用语义

Async Run 当前有专用工具 `run_async_output_read`，通过 `run_id` 读取：

```text
<taskOutputsDir>/async-runs/<run_id>/output.txt
```

而 P1 即时压缩输出只有裸路径，没有统一 handle。Schedule occurrence 又把 Async Run 的 `outputPath` 保存为 `outputRef`，这会把底层绝对路径暴露到持久化 occurrence 中。

这造成三套语义：

```text
compressor output -> .task_outputs/<toolCallId>.txt
async output      -> run_async_output_read(run_id)
schedule output   -> occurrence.outputRef = absolute path
```

第四轮要把它们收束为：

```text
OutputStore output_id -> run_output_read(output_id)
```

Async Run 可以继续保留 `run_async_output_read` 作为 PDD13 兼容工具，但新输出引用应该同时带上 `output_id`。

### 3. `run_edit` 的 replaceAll 风险偏高

当前 `run_edit` 语义是：

```text
replace all occurrences of old_string with new_string
```

这在教学早期足够直观，但作为工作 agent 基座有明显风险：

1. `old_string` 匹配多处时会全部修改。
2. LLM 很容易低估重复片段。
3. 没有 expected occurrence，无法确认上下文是否漂移。
4. 出错后虽然可以 git diff，但工具本身缺少第一道安全阀。

第四轮不删除 `run_edit`，而是新增后续章节能力 `run_edit_exact`：

```text
只在 old_string 出现次数等于 expected_occurrences 时写入。
默认推荐 expected_occurrences = 1。
零匹配、多匹配、空 old_string 都拒绝。
```

## 四、目标设计

### 1. OutputStore 模块

新增文件：

- `src/output-store.ts`
- `src/output-store.test.ts`

建议接口：

```ts
export type OutputSourceKind =
  | "tool_result"
  | "async_run"
  | "schedule_occurrence";

export interface OutputRecord {
  version: 1;
  kind: "output_record";
  id: string;
  sourceKind: OutputSourceKind;
  sourceId: string;
  createdAt: string;
  relativePath: string;
  byteLength: number;
  contentType: "text/plain";
  projectRoot?: string;
  toolName?: string;
  runId?: string;
  scheduleId?: string;
  occurrenceId?: string;
}

export interface WriteTextOutputInput {
  sourceKind: OutputSourceKind;
  sourceId: string;
  content: string;
  projectRoot?: string;
  toolName?: string;
  runId?: string;
  scheduleId?: string;
  occurrenceId?: string;
}

export interface ReadOutputInput {
  outputId: string;
  maxBytes?: number;
  startByte?: number;
}

export interface ReadOutputResult {
  id: string;
  content: string;
  byteLength: number;
  startByte: number;
  returnedBytes: number;
  truncated: boolean;
}

export interface OutputStore {
  writeText(input: WriteTextOutputInput): OutputRecord;
  read(input: ReadOutputInput): ReadOutputResult;
  get(outputId: string): OutputRecord | null;
}
```

实现约束：

- Output root 使用 `ProjectContext.taskOutputsDir`，默认 `<agentHome>/.task_outputs`。
- 物理布局建议：

```text
<agentHome>/.task_outputs/
├── index.json
└── outputs/
    └── out_20260528_153000_ab12cd.txt
```

- `output_id` 格式建议：

```text
^out_[0-9]{8}_[0-9]{6}_[a-z0-9]{6}$
```

- `index.json` 是 OutputStore 的登记表，不是由目录扫描随意推断。
- `run_output_read` 只能读取 index 中存在的 `output_id`。
- 每个 record 的 `relativePath` 必须解析后仍在 output root 内。
- 写入 output 后再原子写 index；如果 index 写失败，本次写入应返回错误或清理孤儿文件，不要返回不可读 handle。
- 测试中注入 clock / idGenerator，避免 snapshot 受时间和随机数影响。

### 2. `run_output_read` 工具

新增文件：

- `src/tools/output.ts`
- `src/tools/output.test.ts`

工具定义建议：

```json
{
  "name": "run_output_read",
  "description": "Read a persisted agent output by output_id. Only outputs registered by OutputStore can be read.",
  "parameters": {
    "type": "object",
    "properties": {
      "output_id": {
        "type": "string",
        "description": "The output handle returned in a persisted-output block, such as out_20260528_153000_ab12cd."
      },
      "max_bytes": {
        "type": "number",
        "description": "Maximum bytes to return. Default 200000."
      },
      "start_byte": {
        "type": "number",
        "description": "Optional byte offset for reading later chunks of a large output."
      }
    },
    "required": ["output_id"]
  }
}
```

权限语义：

- `run_output_read` 是 Agent 运行数据读取，不是项目文件读取。
- `PermissionManager` 中应类似 `run_async_output_read`，在 plan/default/auto 下直接 allow。
- 它不能被 `run_read` 的 projectRoot 路径边界替代。

Registry 接入：

- 新增 `OutputToolProvider` 类型。
- `createToolRegistry()` 接受可选 `outputProvider`。
- 主 Agent 注册 `run_output_read`。
- async subagent readonly registry 第一版可以不注册 `run_output_read`，除非明确要让子智能体读取父 Agent output。建议第四轮先不注册给 async subagent，避免跨上下文输出泄露。

### 3. Compressor 接入 OutputStore

涉及文件：

- `src/compressor.ts`
- `src/compressor.test.ts`
- `src/agent.ts`（通常不需要改主逻辑，只要 compressor 返回内容格式变化）

建议改动：

1. `CompressionConfig` 增加可选 `outputStore?: OutputStore`，或给 `createContextCompressor()` 增加依赖参数。优先选择不破坏现有调用的轻量方式。
2. `compressToolResult()` 超阈值时调用 `outputStore.writeText()`。
3. `CompressedToolResult` 保留 `persistedPath?: string` 兼容旧测试，同时新增 `outputId?: string`。
4. 返回给 LLM 的内容改为：

```text
<persisted-output tool-call-id="call_x" output-id="out_20260528_153000_ab12cd">
Full output saved as output_id: out_20260528_153000_ab12cd
Read it with run_output_read({"output_id":"out_20260528_153000_ab12cd"})
Preview (first ~2000 tokens):
...
</persisted-output>
```

5. `decayOldBlocks()` 中追加的 full output 引用也使用 output_id，不再只写裸路径。
6. 如果未注入 OutputStore，保持当前文件写入 fallback，保证早期测试和单独使用 compressor 不被破坏。

### 4. Async Run 接入 OutputStore

涉及文件：

- `src/async-runs.ts`
- `src/tools/async-runs.ts`
- `src/async-runs.test.ts`
- `src/tools/async-runs.test.ts`

建议改动：

1. `AsyncRunRecord` 增加 `outputId?: string`，保留 `outputPath?: string` 兼容旧读取工具。
2. `AsyncRunNotification.outputRef` 增加结构化 handle：

```ts
outputRef?: {
  runId: string;
  outputId?: string;
  path?: string;
};
```

3. `finishRun()` 写输出时调用 `outputStore.writeText({ sourceKind: "async_run", sourceId: runId, runId })`。
4. `run_async_check` 和 `run_async_list` 输出中显示 `output_id`，但保留 `run_id`。
5. `run_async_output_read` 继续支持通过 `run_id` 读取，内部可以：
   - 优先用 `record.outputId` 委托 OutputStore；
   - fallback 到旧 `outputPath` 安全读取。
6. Agent async notification 文案从只提示：

```text
use run_async_output_read with run_id ...
```

升级为优先提示：

```text
use run_output_read with output_id ...
```

如果没有 `outputId`，才 fallback 到 `run_async_output_read`。

### 5. Schedule occurrence 接入 OutputStore handle

涉及文件：

- `src/schedule-store.ts`
- `src/schedules.ts`
- `src/tools/schedules.ts`
- `src/schedule-store.test.ts`
- `src/schedules.test.ts`

建议改动：

1. `ScheduleOccurrenceFile` 增加 `outputId?: string`，保留 `outputRef?: string` 兼容旧文件。
2. `onAsyncRunFinish()` 收到 `AsyncRunRecord.outputId` 时写入 occurrence。
3. `formatScheduleView()` / `formatOccurrenceList()` 展示 `output_id`。
4. Schedule notification 优先提示 `run_output_read(output_id)`。
5. 读取旧 occurrence 时，如果只有 `outputRef` 没有 `outputId`，不尝试自动登记；只按旧字段展示，避免隐式信任历史绝对路径。

### 6. 安全编辑工具 `run_edit_exact`

涉及文件：

- `src/tools/files.ts`
- `src/tools/files.test.ts`
- `src/tools/registry.ts`
- `src/tools/registry.test.ts`
- `src/permission.ts`
- `src/permission.test.ts`
- `src/async-runs.ts`
- `src/async-runs.test.ts`

建议工具定义：

```json
{
  "name": "run_edit_exact",
  "description": "Safely edit a file by replacing old_string only when the occurrence count matches expected_occurrences. Prefer this over run_edit for source changes.",
  "parameters": {
    "type": "object",
    "properties": {
      "path": {
        "type": "string",
        "description": "The file path to edit, relative to the current working directory."
      },
      "old_string": {
        "type": "string",
        "description": "The exact text to replace. Must be non-empty."
      },
      "new_string": {
        "type": "string",
        "description": "The replacement text."
      },
      "expected_occurrences": {
        "type": "number",
        "description": "Required expected occurrence count. Use 1 for an exact single edit."
      }
    },
    "required": ["path", "old_string", "new_string", "expected_occurrences"]
  }
}
```

执行规则：

1. 路径必须通过 `isPathSafe()`。
2. 文件必须存在。
3. `old_string` 必须非空。
4. `expected_occurrences` 必须是正整数。
5. 实际出现次数必须等于 `expected_occurrences`。
6. 不满足条件时不写文件，返回 error。
7. 满足条件时使用 `split(oldString).join(newString)` 写回。
8. 返回内容包含实际替换次数和字节/字符变化摘要。

权限与冲突：

- `PermissionManager` 把 `run_edit_exact` 归入 `file-write`。
- plan 模式下与 `run_edit` 一样，只允许 `.claude/plans/`。
- default 模式下需要 ask。
- auto 模式下通过路径边界后 allow。
- `AsyncRunManager.checkForegroundToolConflict()` 需要把 `run_edit_exact` 与 `run_write` / `run_edit` 一样处理，避免写入 running async run 声明读取的路径。
- filtered readonly registry 中 `includeFileEdit: false` 必须同时排除 `run_edit` 和 `run_edit_exact`。

## 五、改动 Checklist

### A. OutputStore 核心

文件：

- `src/output-store.ts`
- `src/output-store.test.ts`

Checklist：

- [ ] 定义 `OutputRecord`、`OutputStore`、`WriteTextOutputInput`、`ReadOutputInput`、`ReadOutputResult`。
- [ ] 实现 `createOutputStore({ outputDir, clock?, idGenerator? })`。
- [ ] 实现 output id 格式校验。
- [ ] 写入内容到 `outputs/<output_id>.txt`。
- [ ] 原子写 `index.json`。
- [ ] 读取时必须先查 index，再解析 path。
- [ ] 拒绝 index 中越界的 `relativePath`。
- [ ] 支持 `maxBytes` 和 `startByte`。
- [ ] `maxBytes` 设置硬上限，例如 1MB，避免一次性塞爆上下文。

必补测试：

- [ ] 写入后可以通过 `output_id` 读回。
- [ ] `maxBytes` 会截断并返回 `truncated: true`。
- [ ] `startByte` 可以读取后续片段。
- [ ] 非法 output id 拒绝。
- [ ] index 中越界 path 拒绝。
- [ ] 文件缺失返回明确错误。
- [ ] 写入后 index 中包含 source metadata。

### B. `run_output_read` 工具接入

文件：

- `src/tools/output.ts`
- `src/tools/output.test.ts`
- `src/tools/registry.ts`
- `src/tools/registry.test.ts`
- `src/permission.ts`
- `src/permission.test.ts`
- `src/index.ts`

Checklist：

- [ ] 新增 `OutputToolProvider`。
- [ ] 新增 `run_output_read` tool definition。
- [ ] 参数校验：`output_id` 必填，`max_bytes/start_byte` 可选且为非负数。
- [ ] 调用 `OutputStore.read()`。
- [ ] registry 注册 `outputProvider`。
- [ ] `PermissionManager` 允许 `run_output_read`。
- [ ] `index.ts` 创建一次共享 `outputStore`，注入工具 provider 和需要写输出的模块。
- [ ] async subagent readonly registry 第四轮先不注册 `run_output_read`，并在文档说明。

必补测试：

- [ ] registry 中包含 `run_output_read`。
- [ ] `run_output_read` 能读 OutputStore 登记输出。
- [ ] `run_output_read` 不能读非法 id。
- [ ] plan/default/auto 模式都 allow `run_output_read`。
- [ ] async subagent filtered registry 默认不包含 `run_output_read`。

### C. Compressor 接入 OutputStore

文件：

- `src/compressor.ts`
- `src/compressor.test.ts`
- `src/agent.test.ts`

Checklist：

- [ ] `CompressionConfig` 或 compressor factory 支持可选 `outputStore`。
- [ ] 大输出优先用 OutputStore 写入。
- [ ] `CompressedToolResult` 增加 `outputId?: string`。
- [ ] 返回给 LLM 的 `<persisted-output>` 包含 `output-id` 和 `run_output_read` 指引。
- [ ] `decayOldBlocks()` 追加 output id，而不是裸 `.task_outputs` 路径。
- [ ] 未注入 OutputStore 时 fallback 到旧行为，避免早期 lesson 断裂。
- [ ] `cleanup()` 不删除 OutputStore 已登记的输出，除非 OutputStore 显式提供 session cleanup。第四轮建议先不清理登记输出。

必补测试：

- [ ] 超阈值输出会调用 OutputStore 并返回 output id。
- [ ] preview 仍然存在。
- [ ] 衰减压缩保留 output id 引用。
- [ ] fallback 旧行为仍可用。
- [ ] Agent 写入 tool_result 时能看到 `run_output_read` 指引。

### D. Async Run 与 Schedule 输出 handle

文件：

- `src/async-runs.ts`
- `src/tools/async-runs.ts`
- `src/async-runs.test.ts`
- `src/tools/async-runs.test.ts`
- `src/schedule-store.ts`
- `src/schedules.ts`
- `src/tools/schedules.ts`
- `src/schedule-store.test.ts`
- `src/schedules.test.ts`

Checklist：

- [ ] `AsyncRunRecord` 增加 `outputId?: string`。
- [ ] `AsyncRunNotification.outputRef` 支持 `outputId`。
- [ ] `finishRun()` 写 output 时登记 OutputStore。
- [ ] `readOutput()` 优先按 `outputId` 读取，fallback 旧 `outputPath`。
- [ ] `run_async_check` 输出 `output_id`。
- [ ] `run_async_output_read` 兼容旧 `run_id` 入口。
- [ ] `ScheduleOccurrenceFile` 增加 `outputId?: string`。
- [ ] schedule finish callback 把 `record.outputId` 写入 occurrence。
- [ ] schedule view / occurrence list 展示 `output_id`。
- [ ] schedule notification 优先提示 `run_output_read`。

必补测试：

- [ ] async run 完成后 record 有 `outputId`。
- [ ] `run_async_output_read` 可通过 OutputStore fallback 读回。
- [ ] async notification 包含 output id。
- [ ] schedule occurrence 完成后保存 output id。
- [ ] 旧 occurrence 只有 `outputRef` 时仍可读取/展示，不触发校验失败。

### E. `run_edit_exact` 安全编辑

文件：

- `src/tools/files.ts`
- `src/tools/files.test.ts`
- `src/tools/registry.ts`
- `src/tools/registry.test.ts`
- `src/permission.ts`
- `src/permission.test.ts`
- `src/async-runs.ts`
- `src/async-runs.test.ts`

Checklist：

- [ ] 新增 `runEditExactToolDefinition`。
- [ ] 新增 `executeEditExact()`。
- [ ] 拒绝空 `old_string`。
- [ ] 拒绝非正整数 `expected_occurrences`。
- [ ] 零匹配时不写文件。
- [ ] 多匹配但 `expected_occurrences=1` 时不写文件。
- [ ] 实际次数等于 expected 时才写文件。
- [ ] `createToolRegistry()` 注册 `run_edit_exact`。
- [ ] `includeFileEdit: false` 同时排除 `run_edit` 和 `run_edit_exact`。
- [ ] `PermissionManager` 将 `run_edit_exact` 归入 file-write。
- [ ] `checkForegroundToolConflict()` 把 `run_edit_exact` 视为写操作。
- [ ] `run_edit` description 标注 legacy replace-all，推荐源码修改优先使用 `run_edit_exact`。

必补测试：

- [ ] 单处匹配成功。
- [ ] 多处匹配但 expected=1 拒绝且文件不变。
- [ ] expected=2 时两处匹配成功。
- [ ] 空 old_string 拒绝。
- [ ] 路径越界拒绝。
- [ ] registry 默认包含 `run_edit_exact`。
- [ ] readonly filtered registry 不包含 `run_edit_exact`。
- [ ] plan/default/auto 权限行为与 `run_edit` 一致。
- [ ] running async run 读取路径与 `run_edit_exact` 目标冲突时被 block。

### F. 文档同步

文件：

- `doc/summary.md`
- `doc/pdd6.md`
- `doc/pdd13.md`
- `doc/pdd14.md`
- `doc/refactor-2026-05-round4-output-and-safe-edit-plan.md`

Checklist：

- [ ] `doc/summary.md` 增加 OutputStore 段落。
- [ ] `doc/summary.md` 更新源码结构和测试数量。
- [ ] `doc/summary.md` 的 compressor 段落从裸 `.task_outputs` 路径改为 output handle。
- [ ] `doc/summary.md` 的 Async Run / Schedule 段落补充 `output_id`。
- [ ] `doc/summary.md` 的文件工具段落补充 `run_edit_exact` 与旧 `run_edit` 的差异。
- [ ] `doc/pdd6.md` 增加当前实现备注：P1 即时压缩输出通过 `run_output_read` 读回。
- [ ] `doc/pdd13.md` 增加当前实现备注：Async Run output 同时有 `run_id` 兼容读取和 OutputStore handle。
- [ ] `doc/pdd14.md` 增加当前实现备注：occurrence 保存 `output_id`，不再只暴露绝对路径。

## 六、建议 PR / Commit 拆分

### PR 1：OutputStore 与 `run_output_read`

范围：

- 新增 `output-store.ts` 和测试。
- 新增 `tools/output.ts` 和测试。
- 接入 registry、permission、index。
- 暂不改 compressor / async-run 的输出写入。

验收：

- `run_output_read` 只能读登记 output。
- 非法 id、越界 path、缺失文件都有测试。
- 主 registry 有工具，async readonly registry 暂不暴露。

建议验证：

```bash
npm run typecheck
npx vitest run src/output-store.test.ts src/tools/output.test.ts src/tools/registry.test.ts src/permission.test.ts
```

### PR 2：Compressor / Async Run / Schedule 接入 output handle

范围：

- compressor 超阈值输出写 OutputStore。
- Async Run finish 写 OutputStore。
- Schedule occurrence 保存 `outputId`。
- 更新通知和格式化输出。
- 更新 PDD6/PDD13/PDD14/summary。

验收：

- LLM 看到的 persisted output 都能用 `run_output_read` 读回。
- `run_async_output_read` 兼容旧入口。
- occurrence 不再只依赖绝对路径表达输出。

建议验证：

```bash
npm run typecheck
npx vitest run src/compressor.test.ts src/agent.test.ts src/async-runs.test.ts src/tools/async-runs.test.ts src/schedules.test.ts src/schedule-store.test.ts src/tools/schedules.test.ts
```

### PR 3：`run_edit_exact` 安全编辑工具

范围：

- 新增 `executeEditExact()` 和 tool definition。
- registry / permission / async conflict 接入。
- 更新文件工具说明和 summary。

验收：

- 多匹配默认不会误改。
- readonly registry 不暴露写工具。
- 权限模式与 `run_edit` 一致。

建议验证：

```bash
npm run typecheck
npx vitest run src/tools/files.test.ts src/tools/registry.test.ts src/permission.test.ts src/async-runs.test.ts
```

## 七、实施顺序

建议 coding agent 按以下顺序执行：

1. 读取 `AGENTS.md`、`doc/summary.md`、本文。
2. 读取 `doc/pdd6.md`、`doc/pdd13.md`、`doc/pdd14.md`。
3. 先实现 OutputStore，不接入任何现有模块。
4. 单独实现 `run_output_read` 并接入 registry/permission/index。
5. 跑 OutputStore 和工具 provider 测试。
6. 再改 compressor，让 P1 即时压缩返回 output id。
7. 再改 Async Run，让 completed output 登记 OutputStore。
8. 再改 Schedule occurrence，只保存和展示 output id，不自动信任旧绝对路径。
9. 跑 compressor/async/schedule 相关测试。
10. 最后实现 `run_edit_exact`，因为它会触碰 file-write 权限和 async conflict。
11. 更新 summary 和相关 PDD。
12. 跑完整 changed-file lint、`git diff --check`。

不要把 `run_edit_exact` 放在 OutputStore 之前做。输出读取是纯 agentHome 读取边界，风险低；安全编辑会触碰写操作权限，应该在输出通道稳定之后再做。

## 八、最终验收标准

第四轮全部完成后，必须满足：

- [ ] 每个 P1 即时压缩的 persisted output 都有 `output_id`。
- [ ] LLM 能通过 `run_output_read` 读回 OutputStore 登记输出。
- [ ] `run_output_read` 不能读取任意 projectRoot 文件，也不能读取任意 agentHome 文件。
- [ ] Async Run completed output 有 `outputId`，同时 `run_async_output_read` 兼容旧入口。
- [ ] Schedule occurrence 保存和展示 `output_id`，旧 `outputRef` 文件不导致读取失败。
- [ ] `run_edit_exact` 能拒绝零匹配、多匹配、空 old_string 和 expected count 不匹配。
- [ ] `run_write` / `run_edit` 旧语义和测试不被破坏。
- [ ] async readonly registry 不暴露 `run_write`、`run_edit`、`run_edit_exact`。
- [ ] PermissionManager 把 `run_edit_exact` 当作 file-write。
- [ ] Foreground conflict 检查覆盖 `run_edit_exact`。
- [ ] `doc/summary.md`、`doc/pdd6.md`、`doc/pdd13.md`、`doc/pdd14.md` 与实现一致。

## 九、风险提示

1. 不要把 OutputStore index 当成安全边界的唯一来源。读取时仍必须校验 `relativePath` 解析后在 output root 内。
2. 不要把 `output_id` 设计成用户可推断路径。handle 是能力引用，不是路径。
3. 不要让 `run_output_read` 接受 path 参数。
4. 不要在 schedule 读取旧 `outputRef` 时自动注册绝对路径；旧数据只能展示，不能默认变成可读 handle。
5. 不要把 `run_edit_exact` 做成 replaceAll 的另一个名字。它的核心是 expected occurrence gate。
6. 不要在本轮修改普通前台 `run_bash` 或 ExecutionPolicy profile。
7. 不要把 async subagent 默认接入父 agent 的 output store 读取工具；这会引入跨上下文数据可见性问题，留给后续专门设计。

## 十、下一轮预告

第四轮完成后，第五轮已收口处理：

1. P1-3：梳理 `turnIndex` / `loopRound` / `loopIndex` / `messageSequence` / `transcriptSequence` 时间语义。
2. 文档和注释只做与时间语义直接相关的去漂移。
3. 不拆分 `index.ts` wiring，不做 frontmatter 解析统一。

第五轮是当前 review 重构线的最后一轮优化。后续若继续推进，应按新功能 PDD 组织，而不是继续追加横向 refactor round。
