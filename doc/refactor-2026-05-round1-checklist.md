# 2026-05 第一轮重构 Checklist 与精确改动计划

本文是 `doc/refactor-2026-05-project-review.md` 的第一轮执行计划。它面向后续真正编码的 coding agent，要求在动代码前先逐条核对本 checklist。

本轮使用 extra high reasoning 做设计锁定；后续每个独立 PR/commit 可以用 high reasoning 实施。若实施过程中改变了这里的范围或取舍，必须先更新本文档或在新的设计备注中说明原因。

实施状态（2026-05-28）：

- 本轮 checklist 已落地为一次集中重构：Schedule 当前项目默认边界、running occurrence orphaned 收敛、Schedule tool 契约裁剪、AsyncRun finish callback 注册清理均已实现。
- 本文下方 checklist 保留为后续 review/audit 的逐项核对模板，实际实现状态以 `doc/summary.md`、`doc/pdd13.md`、`doc/pdd14.md` 和测试结果为准。

## 一、本轮目标

本轮只处理 P0 中和 Schedule / Async Run / Permission 交叉边界直接相关的问题：

1. Schedule 只能默认作用于当前 `projectRoot`，不能因为 `agentHome` 全局存储而跨项目误触发。
2. Schedule 的 durable occurrence 必须能在进程重启后从 `running` 收敛，不允许永久悬挂。
3. Schedule 暴露给 LLM 的 tool schema 必须只承诺当前实现真实支持的能力。
4. Async Run 完成回调只能有一个清晰的注册路径，不能依赖私有字段和重复注册。
5. 相关文档和测试必须同步，避免后续 agent 继续基于错误边界实现功能。

## 二、本轮不做

以下事项明确不纳入第一轮，避免重构范围失控：

1. 不实现完整 `ExecutionPolicy` 抽象。那是下一轮 P1。
2. 不实现 `workspace_write` schedule。
3. 不实现 `linked_task_update` 对 Task Group 的自动写入。
4. 不实现 `save_raw_output=false` 的真实输出抑制。
5. 不修改 `normalize.ts` 的 tool_call / tool_result 修复逻辑。
6. 不新增 `OutputStore` 或 `run_output_read`。
7. 不新增安全 patch/edit 工具。
8. 不改动 provider、LLM、prompt cache 主逻辑。

## 三、核心设计决定

### 1. Schedule 读写和触发默认绑定当前项目

物理存储仍然放在全局 `<agentHome>/schedules`。这是正确的，因为 Schedule 是 agent 运行数据，不应该写入用户项目。

但业务层默认视图必须是当前项目：

```text
agentHome/schedules  = 全局物理存储
ScheduleStore        = 可以扫描全局物理存储的低层存储模块
ScheduleManager      = 当前 projectRoot 的业务边界
Schedule tools / CLI = 默认只看当前 projectRoot
```

允许跨项目读全局摘要，但必须显式传入 `currentProjectOnly: false` 或 CLI `--all-projects`。本轮不允许跨项目触发、取消、删除。

### 2. 重启后的 running occurrence 固定收敛为 orphaned

本轮不做 wall-clock timeout 推断。只要进程重启后扫描到 persisted occurrence 仍是 `running`，并且当前 Async Run 表里不可能恢复对应进程，就统一标记为：

```ts
status: "orphaned"
reason: "Async run was session-local and the agent process restarted before completion"
```

理由：

- PDD13 已定义 Async Run 不跨重启。
- wall-clock 推断 timeout 容易让读者误以为后台进程仍被监控。
- `orphaned` 能清楚表达：执行实例已经失联，不能恢复输出。

### 3. 本轮采用 Schedule 契约裁剪，不补未来能力

`save_raw_output`、`linked_task_update` 当前没有真实实现。本轮不补 Task 自动更新，也不补 raw output 抑制，而是从 LLM 可见 schema 中移除这两个参数。

内部存储类型可以暂时保留：

- `outputPolicy.saveRawOutput` 固定写入 `true`。
- `outputPolicy.linkedTaskUpdate` 固定写入 `"never"`。

这样既不破坏已有 PDD14 设计预留，又不让 LLM 误以为当前版本支持这些行为。

### 4. Permission Profile 本轮只收紧公开语义

当前 `permissionProfile` 不是完整执行策略边界。第一轮不实现 `readonly` / `ci` 的完整差异化。实施时二选一：

优先路线 A：

- `run_schedule_create` 公开 schema 只保留 `permission_profile: "readonly"`，或干脆不暴露该字段，内部默认 `readonly`。
- `ScheduleFile.execution.permissionProfile` 类型继续保留 `readonly | ci | workspace_write`，作为 PDD14 预留和兼容老文件。
- 文档说明 `ci` / `workspace_write` 是后续 `ExecutionPolicy` 阶段实现的能力。

备选路线 B：

- 如果实施 agent 判断保留 `ci` 更符合当前教学章节，则必须补测试证明 `ci` 与 `readonly` 的差异。
- 如果不能补出真实差异，不允许在 tool description 中宣称 `ci` 有更宽权限。

推荐路线：A。

### 5. AsyncRunManager 完成回调由 ScheduleManager 单点注册

当前 `createScheduleManager()` 内部已经调用 `asyncRunManager.setOnFinish?.(onAsyncRunFinish)`，但 `index.ts` 又通过 `_onAsyncRunFinish` 私有字段重复注册一次。

本轮决定：

- 保留 `ScheduleManager` 内部注册。
- 删除 `index.ts` 中对 `_onAsyncRunFinish` 的 cast 和二次注册。
- 删除 `ScheduleManager` 返回值中的 `_onAsyncRunFinish` 私有字段。

如果未来需要多个完成监听器，再新增 `addFinishListener()`。本轮不做多监听器抽象。

## 四、改动清单

### A. ScheduleStore 项目过滤

#### 文件

- `src/schedule-store.ts`
- `src/schedule-store.test.ts`

#### 具体改动

- [ ] 给 `ScheduleListQuery` 增加 `currentProjectOnly?: boolean`。
- [ ] `createScheduleStore()` 内部保留 `currentProjectRoot = path.resolve(options.projectRoot)`。
- [ ] `list(query = {})` 默认 `currentProjectOnly = true`。
- [ ] 当 `query.projectRoot` 存在时，用它作为过滤项目。
- [ ] 当 `query.projectRoot` 不存在且 `currentProjectOnly !== false` 时，用当前 store 的 `currentProjectRoot` 过滤。
- [ ] 当 `currentProjectOnly === false` 且未传 `projectRoot` 时，返回所有项目的 schedule。
- [ ] `scan()` 仍扫描所有物理 schedule 到内存 cache。
- [ ] `scan()` 返回值仿照 `TaskStore.scan()`，使用 `{ includeArchived: true, includeCancelled: true, currentProjectOnly: false }`，避免重建索引时被当前项目过滤误导。

#### 必补测试

- [ ] `list()` 默认只返回当前项目 schedule。
- [ ] `list({ currentProjectOnly: false })` 返回所有项目 schedule。
- [ ] `list({ projectRoot: "/tmp/project-b" })` 只返回指定项目 schedule。
- [ ] `scan()` 重建索引后仍能返回所有项目 summary。
- [ ] 现有 archived/cancelled 过滤不退化。

### B. ScheduleManager 当前项目业务边界

#### 文件

- `src/schedules.ts`
- `src/schedules.test.ts`

#### 具体改动

- [ ] `reloadActiveSchedules()` 调用 `store.list()` 时显式传入当前 `projectRoot` 或依赖 store 默认 current-project-only。
- [ ] `activeSchedules` 只能包含当前项目 active schedule。
- [ ] `tick()` 不触发其他项目 schedule。
- [ ] `list(query)` 默认当前项目；只有显式 `currentProjectOnly: false` 才返回所有项目 summary。
- [ ] `read(scheduleId)` 如果 schedule 不属于当前项目，返回 `null` 或明确拒绝。推荐返回 `null`，与 not found 语义保持简单。
- [ ] `cancel(scheduleId)` 如果 schedule 不属于当前项目，抛出错误。
- [ ] `delete(scheduleId)` 如果 schedule 不属于当前项目，抛出错误。
- [ ] `listOccurrences({ scheduleId })` 如果 schedule 不属于当前项目，返回空数组或抛错。推荐返回空数组，减少只读工具报错噪音。
- [ ] 增加内部辅助函数 `isCurrentProjectSchedule(schedule)`，避免到处手写 `path.resolve(schedule.projectRoot) === path.resolve(projectRoot)`。

#### 必补测试

- [ ] 同一个 store 中存在项目 A 和项目 B 的 due schedule，从项目 B 的 manager `tick()` 只触发项目 B。
- [ ] 项目 B 的 manager `list()` 默认不显示项目 A。
- [ ] 项目 B 的 manager `list({ currentProjectOnly: false })` 可以显示项目 A/B 摘要。
- [ ] 项目 B 的 manager `read(projectAId)` 返回 `null`。
- [ ] 项目 B 的 manager `cancel(projectAId)` 拒绝。
- [ ] 项目 B 的 manager `delete(projectAId)` 拒绝。
- [ ] 项目 B 的 manager `listOccurrences({ scheduleId: projectAId })` 不泄漏 occurrence。

### C. CLI 和 Tool 的当前项目默认语义

#### 文件

- `src/cli-commands.ts`
- `src/tools/schedules.ts`
- `src/cli-commands.test.ts`
- `src/tools/schedules.test.ts`，如果不存在则新增

#### CLI 具体改动

- [ ] `/schedule list` 默认当前项目。
- [ ] `/schedule list --all` 只表示包含 archived/cancelled，不表示跨项目。
- [ ] 新增 `/schedule list --all-projects` 显式跨项目读摘要。
- [ ] `/schedule show/cancel/delete/occurrences <id>` 不跨项目。
- [ ] usage 文案更新为 `/schedule list [--all] [--all-projects]`。

#### Tool 具体改动

- [ ] `run_schedule_list` description 明确：“默认只列当前项目 schedule”。
- [ ] `run_schedule_list` 增加 `current_project_only` 参数，默认 `true`，与 Task tool 保持一致。
- [ ] `executeList()` 读取 `current_project_only`，传入 manager。
- [ ] `run_schedule_read/cancel/delete/occurrence_list` 不增加 all-projects 参数。
- [ ] tool 输出中可以保留 `schedule_id/title/status` 等摘要，但不额外暴露其他项目详情。

#### 必补测试

- [ ] CLI `/schedule list` 传给 manager 的 query 默认 current project。
- [ ] CLI `/schedule list --all-projects` 传 `currentProjectOnly: false`。
- [ ] Tool `run_schedule_list` 默认 query 不跨项目。
- [ ] Tool `run_schedule_list { current_project_only: false }` 可以跨项目读 summary。
- [ ] Tool definitions 顺序稳定。

### D. running occurrence 重启收敛

#### 文件

- `src/schedule-store.ts`
- `src/schedules.ts`
- `src/schedules.test.ts`
- `doc/pdd14.md`
- `doc/summary.md`

#### 具体改动

- [ ] `OccurrenceStatus` 增加 `"orphaned"`。
- [ ] `validateOccurrenceFile()` 接受 `orphaned`。
- [ ] `ScheduleNotification["type"]` 增加 `"orphaned"`，如果当前类型定义需要。
- [ ] 在 `reloadActiveSchedules()` 中，`checkMissedOccurrences()` 之前执行 `reconcileOrphanedOccurrences()`。
- [ ] `reconcileOrphanedOccurrences()` 只处理当前项目 active schedule 的 occurrences。
- [ ] 扫描 `store.listOccurrences(schedule.id)`，找到 `status === "running"` 的 occurrence。
- [ ] 将 running occurrence 更新为 `orphaned`。
- [ ] 写入 `completedAt` 或新增 `orphanedAt` 二选一。推荐本轮使用现有 `completedAt` 表示“终态收敛时间”，避免扩 schema；`reason` 写明 orphaned 原因。
- [ ] 从 `runningOccurrences` 内存 map 移除该 occurrence。
- [ ] 如果 schedule `outputPolicy.notifyLlm` 为 true，入队一条 orphaned notification。
- [ ] 不递增 `missedCount`。orphaned 不是 missed，它曾经触发并进入 running。
- [ ] 不修改 `triggeredCount`。triggeredCount 已在触发时增加。

#### 必补测试

- [ ] 启动扫描时 running occurrence 变为 orphaned。
- [ ] orphaned occurrence 产生 schedule notification。
- [ ] notifyLlm=false 时不产生 notification。
- [ ] orphaned 不增加 missedCount。
- [ ] orphaned 后 overlapPolicy=skip 不再因为旧 running 阻塞新 occurrence。
- [ ] 其他项目的 running occurrence 不被当前项目 manager 收敛。

### E. Schedule 对外契约裁剪

#### 文件

- `src/tools/schedules.ts`
- `src/schedules.ts`
- `src/schedule-store.ts`
- `src/tools/schedules.test.ts`
- `doc/pdd14.md`
- `doc/summary.md`

#### 具体改动

- [ ] 从 `run_schedule_create` tool schema 移除 `output_policy.save_raw_output`。
- [ ] 从 `run_schedule_create` tool schema 移除 `output_policy.linked_task_update`。
- [ ] `parse/executeCreate` 中不再读取 `save_raw_output` 和 `linked_task_update`。
- [ ] 创建 schedule 时内部固定：
  - [ ] `outputPolicy.saveRawOutput = true`
  - [ ] `outputPolicy.linkedTaskUpdate = "never"`
- [ ] 如果选择推荐路线 A，从 tool schema 移除 `permission_profile` 或把 enum 收紧为 `["readonly"]`。
- [ ] 如果保留 `permission_profile`，tool description 必须去掉尚未实现的差异化承诺。
- [ ] `formatScheduleView()` 可以继续输出完整 `output_policy`，但文档要说明其中部分字段当前固定。
- [ ] `doc/pdd14.md` 增加“当前实现裁剪”小节，说明这些字段是设计预留，不在本轮暴露。

#### 必补测试

- [ ] Tool definition 不包含 `save_raw_output`。
- [ ] Tool definition 不包含 `linked_task_update`。
- [ ] 创建 schedule 后 `saveRawOutput` 固定为 true。
- [ ] 创建 schedule 后 `linkedTaskUpdate` 固定为 never。
- [ ] 如果移除 `permission_profile`，测试默认 `permissionProfile` 为 readonly。
- [ ] 如果保留 `permission_profile`，测试 description 不再承诺未实现能力。

### F. AsyncRun 完成回调注册收敛

#### 文件

- `src/schedules.ts`
- `src/index.ts`
- `src/async-runs.ts`
- `src/schedules.test.ts`
- `src/index.test.ts`，如果需要

#### 具体改动

- [ ] 保留 `createScheduleManager()` 内部的 `asyncRunManager.setOnFinish?.(onAsyncRunFinish)`。
- [ ] 删除 `ScheduleManager` 返回值中的 `_onAsyncRunFinish` 私有字段。
- [ ] 删除 `index.ts` 中通过 `(scheduleManager as unknown as { _onAsyncRunFinish: ... })` 二次注册的代码。
- [ ] 确认 `AsyncRunManager.setOnFinish()` 仍只注册一次 schedule 回调。
- [ ] 如果测试 mock 依赖 `_onAsyncRunFinish`，改为通过 fake `asyncRunManager.setOnFinish` 捕获 handler。

#### 必补测试

- [ ] `createScheduleManager()` 创建时调用一次 `setOnFinish`。
- [ ] Async run 完成 handler 能更新 occurrence。
- [ ] index 不再访问 `_onAsyncRunFinish`。

### G. 文档同步

#### 文件

- `doc/summary.md`
- `doc/pdd13.md`
- `doc/pdd14.md`
- `doc/refactor-2026-05-project-review.md`，如本轮实际取舍变化

#### 具体改动

- [ ] `doc/summary.md` 增加或补全 Schedule 已实现功能段落。
- [ ] `doc/summary.md` 测试覆盖表加入 Schedule tool 测试、Schedule store/manager 新增覆盖。
- [ ] `doc/summary.md` 明确 Schedule 默认当前项目，跨项目只读 summary 需要显式参数。
- [ ] `doc/summary.md` 明确 running occurrence 重启后收敛为 orphaned。
- [ ] `doc/pdd13.md` 补一句：Async Run 不跨重启，Schedule 只能恢复 occurrence 状态，不能恢复 async run 执行。
- [ ] `doc/pdd14.md` 补“当前实现裁剪”：`saveRawOutput=false`、`linkedTaskUpdate`、`workspace_write` 不在当前实现暴露。

## 五、建议 PR / Commit 切分

### PR 1：Schedule 当前项目过滤

目标：

- 完成 A、B、C 中和项目过滤相关的所有改动。
- 不碰 orphaned、不碰 schema 裁剪。

建议文件：

- `src/schedule-store.ts`
- `src/schedules.ts`
- `src/cli-commands.ts`
- `src/tools/schedules.ts`
- `src/schedule-store.test.ts`
- `src/schedules.test.ts`
- `src/cli-commands.test.ts`
- `src/tools/schedules.test.ts`

验证：

```bash
npm run typecheck
npx vitest run src/schedule-store.test.ts src/schedules.test.ts
npx vitest run src/cli-commands.test.ts src/tools/schedules.test.ts
```

### PR 2：running occurrence orphaned 收敛

目标：

- 完成 D。
- 不改 tool schema。

建议文件：

- `src/schedule-store.ts`
- `src/schedules.ts`
- `src/schedules.test.ts`

验证：

```bash
npm run typecheck
npx vitest run src/schedules.test.ts src/schedule-store.test.ts
```

### PR 3：Schedule tool 契约裁剪

目标：

- 完成 E。
- 更新相关 PDD 和 summary。

建议文件：

- `src/tools/schedules.ts`
- `src/tools/schedules.test.ts`
- `doc/pdd14.md`
- `doc/summary.md`

验证：

```bash
npm run typecheck
npx vitest run src/tools/schedules.test.ts src/schedules.test.ts
```

### PR 4：AsyncRun finish callback 注册清理

目标：

- 完成 F。
- 这是小 PR，避免和业务逻辑混在一起。

建议文件：

- `src/schedules.ts`
- `src/index.ts`
- `src/schedules.test.ts`
- `src/index.test.ts`，如果需要

验证：

```bash
npm run typecheck
npx vitest run src/schedules.test.ts src/index.test.ts
```

### PR 5：文档收尾

目标：

- 完成 G 中剩余同步项。
- 如果 PR 3 已经更新过部分文档，本 PR 只做遗漏检查。

验证：

```bash
npm run typecheck
npm test
```

如果本地 Vitest 因 Rollup native optional dependency 或 macOS code signature 问题无法启动，需要在最终回复中明确说明这是环境问题，不是测试断言失败。

## 六、跨文件依赖顺序

实施 agent 应按以下依赖顺序编码：

1. 先改类型：`ScheduleListQuery`、`OccurrenceStatus`、notification type。
2. 再改 store 行为：list 默认过滤、scan 返回所有项目。
3. 再改 manager 行为：active schedule 过滤、跨项目 read/cancel/delete/listOccurrences 边界、orphaned reconcile。
4. 再改 tool/CLI 入参和描述。
5. 再改 callback 注册。
6. 最后改文档。

不要先改文档再凭记忆编码；每个代码步骤完成后都要回查 checklist。

## 七、实现时的注意点

### 1. Store 和 Manager 的职责不要反过来

`ScheduleStore` 是物理存储层，可以知道所有 schedule。它负责扫描、读写、低层过滤。

`ScheduleManager` 是当前进程业务层，必须对当前 `projectRoot` 负责。跨项目触发和跨项目写操作应该在 manager 层被挡住。

### 2. 不要用当前 cwd 替代 schedule.projectRoot

本轮不实现跨项目触发，所以不应该在触发时尝试切换 cwd 或 projectRoot。任何不属于当前项目的 schedule 都不进入 active trigger 集合。

### 3. 不要让 `--all` 同时表达两个含义

`--all` 已经常用于 archived/cancelled。跨项目必须使用 `--all-projects`，避免 CLI 语义混淆。

### 4. 不要把 orphaned 当 missed

`missed` 表示进程离线时 due occurrence 没有触发。

`orphaned` 表示 occurrence 已触发并进入 running，但 async run 因进程重启无法恢复。

两者计数和 notification 文案必须区分。

### 5. 不要通过删除存储字段来裁剪 tool 契约

PDD14 已经设计了 output policy 和 linked task。第一轮只是不让 LLM 设置未实现字段。存储字段可以保留默认值，为后续章节铺路。

### 6. 不要引入复杂 scheduler 抽象

本轮修复边界，不重写调度器。`setInterval`、`tick()`、`computeNextRunAt()` 都可以保持现有结构。

## 八、最终验收总表

第一轮全部完成后，必须满足：

- [ ] 当前项目启动不会触发其他项目 schedule。
- [ ] 当前项目默认不会读出其他项目 schedule 详情。
- [ ] 跨项目 summary 查询必须显式请求。
- [ ] running occurrence 在重启扫描后不会永久悬挂。
- [ ] orphaned 与 missed 有独立语义和测试。
- [ ] LLM 可见 schedule create schema 不再暴露未实现字段。
- [ ] AsyncRun finish callback 不再通过私有字段二次注册。
- [ ] `doc/summary.md`、`doc/pdd13.md`、`doc/pdd14.md` 与实现一致。
- [ ] `npm run typecheck` 通过。
- [ ] 相关 Vitest 文件通过，或明确记录环境阻塞原因。

## 九、下一轮预告

第一轮完成后，再进入第二轮：

- `normalize.ts` 纯函数化。
- tool_call / tool_result 按 message block 修复。
- History round / turn / sequence 的语义整理。

不要在第一轮顺手做这些改动。
