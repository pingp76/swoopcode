/**
 * async-runs.ts — Async Run 管理器
 *
 * 职责：管理 session-local 的非阻塞运行实例。
 *
 * 核心概念：
 * - Async Run = 一次非阻塞运行实例，记录 run_id / status / output / notification
 * - 与 PDD12 的持久化 Task Group 不同：Async Run 是运行时执行层，不是长期计划层
 * - 第一版只支持 command 和 subagent 两种 executor
 * - 第一版最多允许 3 个同时 running 的 async runs
 * - 第一版只允许只读探索和诊断命令
 *
 * 核心正确性保证：finishRun() 是所有终态收敛的唯一入口，确保：
 * 1. 只有 running → 终态的转换有效
 * 2. 第一个进入终态的路径 wins（通过 Set 保证）
 * 3. late result 不能覆盖 timeout
 * 4. 不重复递减 runningCount、不重复推送 notification
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import type { Logger } from "./logger.js";
import type { LLMClient } from "./llm.js";
import type { Agent } from "./agent.js";
import type { SessionManager } from "./session.js";
import type { TranscriptStore } from "./transcript.js";
import type { PermissionManager } from "./permission.js";
import { createScopedSubagentPermissionManager } from "./permission.js";
import type { HookRunner } from "./hooks.js";
import type { ContextCompressor } from "./compressor.js";
import type { History } from "./history.js";
import type { ToolRegistry } from "./tools/registry.js";
import { executeBash } from "./tools/bash.js";
import {
  createExecutionPolicy,
  createReadonlyCommandPolicy,
  type AsyncCommandPolicy,
  type ExecutionPolicy,
} from "./execution-policy.js";
import { createHistory } from "./history.js";
import type { OutputStore } from "./output-store.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type AsyncRunExecutor = "command" | "subagent";

export type AsyncRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "timeout"
  | "abandoned";

/**
 * AsyncRunTrigger — 触发元数据
 * 为 PDD14 scheduler 预留，第一版 LLM 手动触发时 kind="manual"
 */
export interface AsyncRunTrigger {
  kind: "manual" | "schedule";
  scheduleId?: string;
  occurrenceId?: string;
  firedAt?: string;
}

/**
 * ResourceClaim — LLM 启动 async run 时声明的资源范围
 */
export interface ResourceClaim {
  readPaths: string[];
  writePaths: string[];
}

/**
 * AsyncRunRecord — async run 的运行记录
 * 严格对齐 PDD13 的数据结构定义
 */
export interface AsyncRunRecord {
  id: string;
  executor: AsyncRunExecutor;
  title: string;
  status: AsyncRunStatus;
  groupId?: string;
  persistentTaskId?: string;
  command?: string;
  prompt?: string;
  resourceClaim: ResourceClaim;
  startedAt: string;
  timeoutAt: string;
  finishedAt?: string;
  durationMs?: number;
  preview: string;
  outputId?: string;
  outputPath?: string;
  error?: string;
  childSessionId?: string;
  maxRounds?: number;
  trigger: AsyncRunTrigger;
}

/**
 * AsyncRunNotification — async run 完成/失败/超时后写入通知队列的简短通知
 */
export interface AsyncRunNotification {
  id: string;
  runId: string;
  type: "async_run_finished";
  status: Exclude<AsyncRunStatus, "running">;
  executor: AsyncRunExecutor;
  title: string;
  groupId?: string;
  persistentTaskId?: string;
  preview: string;
  outputRef?: { runId: string; outputId?: string; path?: string };
  timestamp: string;
}

/**
 * StartAsyncRunInput — 启动 async run 的输入参数
 */
export interface StartAsyncRunInput {
  title: string;
  executor: AsyncRunExecutor;
  command?: string;
  prompt?: string;
  groupId?: string;
  persistentTaskId?: string;
  resources?: {
    read_paths?: string[];
    write_paths?: string[];
  };
  timeoutMs?: number;
  maxRounds?: number;
  trigger?: AsyncRunTrigger;
}

/**
 * AsyncRunListQuery — 列出 async runs 的查询参数
 */
export interface AsyncRunListQuery {
  status?: AsyncRunStatus;
  includeTerminal?: boolean;
}

/**
 * ReadAsyncRunOutputInput — 读取 async run 输出的输入参数
 */
export interface ReadAsyncRunOutputInput {
  runId: string;
  maxBytes?: number;
}

/**
 * AsyncRunManager — 异步运行管理器接口
 */
export interface AsyncRunManager {
  start(input: StartAsyncRunInput): AsyncRunRecord;
  check(runId: string): AsyncRunRecord | null;
  list(query?: AsyncRunListQuery): AsyncRunRecord[];
  readOutput(input: ReadAsyncRunOutputInput): string;
  drainNotifications(): AsyncRunNotification[];
  checkForegroundToolConflict(input: {
    toolName: string;
    args: Record<string, unknown>;
  }): { blocked: boolean; reason?: string };
  setOnFinish?(handler: (record: AsyncRunRecord) => void): void;
}

/**
 * CreateAgentFn — 创建 Agent 的工厂函数类型
 * 通过注入而非直接 import，打破循环依赖
 */
export type CreateAgentFn = (deps: {
  llm: LLMClient;
  history: History;
  tools: ToolRegistry;
  logger: Logger;
  maxRounds?: number;
  compressor: ContextCompressor;
  maxContextTokens?: number;
  permissionManager: PermissionManager;
  hookRunner?: HookRunner;
  transcriptStore?: TranscriptStore;
  sessionId?: string;
  abortSignal?: AbortSignal;
}) => Agent;

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_ROUNDS = 8;
const MAX_MAX_ROUNDS = 20;
const MAX_CONCURRENCY = 3;
const DEFAULT_MAX_BYTES = 20_000;
const MAX_MAX_BYTES = 100_000;

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * generateRunId — 生成 run_id
 *
 * 格式：ar_YYYYMMDD_HHMMSS_[a-z0-9]{4,12}
 * 示例：ar_20260519_153000_a1b2
 */
function generateRunId(now: Date): string {
  const y = String(now.getFullYear());
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const H = String(now.getHours()).padStart(2, "0");
  const M = String(now.getMinutes()).padStart(2, "0");
  const S = String(now.getSeconds()).padStart(2, "0");
  // 生成 4-12 位随机字母数字后缀
  const suffix = randomBytes(8)
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, 8)
    .toLowerCase();
  return `ar_${y}${m}${d}_${H}${M}${S}_${suffix}`;
}

/**
 * validateRunId — 验证 run_id 格式
 */
function validateRunId(id: string): boolean {
  return /^ar_\d{8}_\d{6}_[a-z0-9]{4,12}$/.test(id);
}

/**
 * deepClone — 深拷贝对象（用于 public read 返回隔离副本）
 */
function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/**
 * pathsOverlap — 检查两个路径是否重叠（一个是另一个的前缀或相同）
 *
 * 用于前台冲突检测：前台写入路径与 async run 声明的 readPaths 是否重叠
 */
function pathsOverlap(a: string, b: string, baseDir: string): boolean {
  const ra = resolve(baseDir, a);
  const rb = resolve(baseDir, b);
  return (
    ra === rb || ra.startsWith(rb + sep) || rb.startsWith(ra + sep)
  );
}

/**
 * writeRecordSnapshot — 将 record 快照写入磁盘
 */
function writeRecordSnapshot(record: AsyncRunRecord): void {
  if (!record.outputPath) return;
  const recordPath = resolve(
    record.outputPath,
    "..",
    "record.json",
  );
  try {
    writeFileSync(recordPath, JSON.stringify(record, null, 2));
  } catch {
    // 快照写入失败不阻塞主流程，只影响调试
  }
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createAsyncRunManager — 创建 Async Run 管理器
 *
 * @param deps.projectRoot - 项目根目录，用于路径边界检查
 * @param deps.taskOutputsDir - Agent 全局输出目录，async run 输出放在其下的 async-runs/
 * @param deps.llm - LLM 客户端，供 subagent executor 复用
 * @param deps.logger - 日志器
 * @param deps.executionPolicy - 非交互执行边界，用于验证资源声明和命令 profile
 * @param deps.commandPolicy - 兼容旧接口的 readonly 命令策略
 * @param deps.createAgentFn - Agent 工厂函数，供 subagent executor 创建 child Agent
 * @param deps.createCompressorFn - 压缩器工厂函数，供 subagent 创建独立压缩器
 * @param deps.createReadonlyRegistryFn - 只读注册表工厂函数，供 subagent 获取过滤后的工具集
 * @param deps.getStableSystemPrompt - 获取父级稳定 system prompt 快照
 * @param deps.sessionManager - 可选，session 管理器
 * @param deps.transcriptStore - 可选，transcript 存储
 * @param deps.parentSessionId - 可选，父 session id
 * @param deps.hookRunner - 可选，Hook 运行器
 * @param deps.permissionManager - 可选，权限管理器
 */
export function createAsyncRunManager(deps: {
  projectRoot: string;
  taskOutputsDir: string;
  llm: LLMClient;
  logger: Logger;
  executionPolicy?: ExecutionPolicy;
  commandPolicy?: AsyncCommandPolicy;
  outputStore?: OutputStore;
  createAgentFn: CreateAgentFn;
  createCompressorFn: () => ContextCompressor;
  createReadonlyRegistryFn: (readPaths: string[]) => ToolRegistry;
  getStableSystemPrompt: () => string | null;
  sessionManager?: SessionManager;
  transcriptStore?: TranscriptStore;
  parentSessionId?: string;
  hookRunner?: HookRunner;
  permissionManager?: PermissionManager;
  onFinish?(record: AsyncRunRecord): void;
}): AsyncRunManager {
  const {
    projectRoot,
    taskOutputsDir,
    llm,
    logger,
    commandPolicy,
    outputStore,
    createAgentFn,
    createCompressorFn,
    createReadonlyRegistryFn,
    getStableSystemPrompt,
    sessionManager,
    transcriptStore,
    parentSessionId,
    hookRunner,
    permissionManager,
    onFinish,
  } = deps;

  const executionPolicy = deps.executionPolicy ?? createExecutionPolicy();
  const readonlyCommandPolicy =
    commandPolicy ?? createReadonlyCommandPolicy(executionPolicy);

  // 进程内 record 表：run_id → AsyncRunRecord
  const records = new Map<string, AsyncRunRecord>();
  // 通知队列：等待主循环领取的已完成通知
  const notificationQueue: AsyncRunNotification[] = [];
  // 已收敛为终态的 run_id 集合：防止 late result 覆盖 timeout
  const finishedRunIds = new Set<string>();
  // 当前 running 的 async run 数量
  let runningCount = 0;
  // 可选的 finish 生命周期回调（供 ScheduleManager 注册）
  let onFinishRef = onFinish;

  // -------------------------------------------------------------------------
  // finishRun — 终态收敛（核心正确性函数）
  // -------------------------------------------------------------------------

  /**
   * finishRun — 将 running 的 async run 收敛为终态
   *
   * 正确性保证：
   * 1. 只有 record.status === "running" 时才允许进入终态
   * 2. 第一个进入终态的路径负责写输出、写 finishedAt、递减 runningCount、推送 notification
   * 3. late result 不能覆盖 timeout
   * 4. late result 不能重复递减 runningCount
   * 5. late result 不能重复推送 notification
   *
   * @param record - 要收敛的 record（必须是 running 状态）
   * @param nextStatus - 目标终态
   * @param output - 可选输出内容
   * @param error - 可选错误信息
   * @returns boolean - true 表示成功收敛，false 表示已被其他路径收敛
   */
  function finishRun(
    record: AsyncRunRecord,
    nextStatus: Exclude<AsyncRunStatus, "running">,
    output?: string,
    error?: string,
  ): boolean {
    // 只有 running 状态才允许进入终态
    if (record.status !== "running") {
      return false;
    }

    // 第一个进入终态的路径 wins（Set 保证幂等）
    if (finishedRunIds.has(record.id)) {
      return false;
    }
    finishedRunIds.add(record.id);

    // 执行状态转换
    const now = new Date();
    record.status = nextStatus;
    record.finishedAt = now.toISOString();

    // 计算持续时间
    const started = new Date(record.startedAt).getTime();
    record.durationMs = now.getTime() - started;

    // 先把完整输出登记到 OutputStore，得到 LLM 可读的 output_id。
    // 旧 outputPath 仍会继续写入，保持 run_async_output_read 的 PDD13 兼容语义。
    if (output !== undefined && outputStore) {
      try {
        const stored = outputStore.writeText({
          sourceKind: "async_run",
          sourceId: record.id,
          runId: record.id,
          projectRoot,
          content: output,
        });
        record.outputId = stored.id;
      } catch (err) {
        logger.warn(
          "Failed to register async run output for %s: %s",
          record.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // 写输出到旧文件路径
    if (output !== undefined && record.outputPath) {
      const outputDir = resolve(record.outputPath, "..");
      try {
        // 确保目录存在
        if (!existsSync(outputDir)) {
          mkdirSync(outputDir, { recursive: true });
        }
        writeFileSync(record.outputPath, output);
      } catch (err) {
        logger.warn(
          "Failed to write async run output for %s: %s",
          record.id,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // 写 error（如果有）
    if (error !== undefined) {
      record.error = error;
    }

    // 更新 preview
    if (nextStatus === "completed") {
      record.preview = output
        ? output.slice(0, 200)
        : `Async run "${record.title}" completed.`;
    } else if (nextStatus === "timeout") {
      record.preview = `Async run "${record.title}" timed out.`;
      record.error = record.error || "Timeout exceeded";
    } else {
      record.preview =
        error?.slice(0, 200) || `Async run "${record.title}" ${nextStatus}.`;
    }

    // 递减 runningCount（只减一次）
    runningCount--;

    // 更新 record 快照
    writeRecordSnapshot(record);

    // 调用 lifecycle hook（如果有）
    onFinishRef?.(record);

    // 推送 notification（只推一次）
    const notification: AsyncRunNotification = {
      id: `${record.id}_${now.getTime()}`,
      runId: record.id,
      type: "async_run_finished",
      status: nextStatus,
      executor: record.executor,
      title: record.title,
      preview: record.preview,
      timestamp: record.finishedAt,
    };
    if (record.groupId !== undefined) notification.groupId = record.groupId;
    if (record.persistentTaskId !== undefined)
      notification.persistentTaskId = record.persistentTaskId;
    if (record.outputId || record.outputPath) {
      notification.outputRef = { runId: record.id };
      if (record.outputId) notification.outputRef.outputId = record.outputId;
      if (record.outputPath) notification.outputRef.path = record.outputPath;
    }
    notificationQueue.push(notification);

    logger.info(
      "Async run %s finished with status %s (running: %d)",
      record.id,
      nextStatus,
      runningCount,
    );

    return true;
  }

  // -------------------------------------------------------------------------
  // start — 启动 async run
  // -------------------------------------------------------------------------

  function start(input: StartAsyncRunInput): AsyncRunRecord {
    // 验证 executor
    if (input.executor !== "command" && input.executor !== "subagent") {
      throw new Error(
        `Invalid executor: "${input.executor}". Must be "command" or "subagent"`,
      );
    }

    // 验证必填字段
    if (input.executor === "command" && !input.command) {
      throw new Error("command is required when executor='command'");
    }
    if (input.executor === "subagent" && !input.prompt) {
      throw new Error("prompt is required when executor='subagent'");
    }

    // 验证 resources（必填）
    if (!input.resources) {
      throw new Error("resources is required");
    }
    if (
      typeof input.resources !== "object" ||
      Array.isArray(input.resources) ||
      input.resources === null
    ) {
      throw new Error(
        "resources must be an object with read_paths and write_paths",
      );
    }

    const readPaths = input.resources.read_paths ?? [];
    const writePaths = input.resources.write_paths ?? [];

    if (!Array.isArray(readPaths) || !Array.isArray(writePaths)) {
      throw new Error(
        "resources.read_paths and resources.write_paths must be arrays",
      );
    }

    // 第一版 async run 仍然是只读执行层，先保留 PDD13 的用户友好错误文案。
    if (writePaths.length > 0) {
      throw new Error(
        "write_paths must be empty in the first version of async runs",
      );
    }

    const resourceValidation = executionPolicy.validateResources({
      projectRoot,
      readPaths,
      writePaths,
      profile: "readonly",
    });
    if (!resourceValidation.allowed) {
      throw new Error(resourceValidation.reason ?? "Invalid async run resources");
    }

    if (input.executor === "command" && input.command) {
      const commandValidation = readonlyCommandPolicy.validate(input.command);
      if (!commandValidation.allowed) {
        throw new Error(
          commandValidation.reason ?? "Command is not allowed in async run",
        );
      }
    }

    // 验证 timeout
    const timeoutMs =
      input.timeoutMs !== undefined ? input.timeoutMs : DEFAULT_TIMEOUT_MS;
    if (timeoutMs < 0) {
      throw new Error(`timeout_ms (${timeoutMs}) must be non-negative`);
    }
    if (timeoutMs > MAX_TIMEOUT_MS) {
      throw new Error(
        `timeout_ms (${timeoutMs}) exceeds maximum (${MAX_TIMEOUT_MS})`,
      );
    }

    // 验证 max_rounds（只对 subagent 有效）
    const maxRounds =
      input.maxRounds !== undefined ? input.maxRounds : DEFAULT_MAX_ROUNDS;
    if (maxRounds < 0) {
      throw new Error(`max_rounds (${maxRounds}) must be non-negative`);
    }
    if (maxRounds > MAX_MAX_ROUNDS) {
      throw new Error(
        `max_rounds (${maxRounds}) exceeds maximum (${MAX_MAX_ROUNDS})`,
      );
    }

    // 并发限制
    if (runningCount >= MAX_CONCURRENCY) {
      throw new Error(
        `Maximum concurrent async runs (${MAX_CONCURRENCY}) reached`,
      );
    }

    // 生成 run_id 和目录
    const now = new Date();
    const runId = generateRunId(now);
    const outputDir = resolve(taskOutputsDir, "async-runs", runId);
    const outputPath = resolve(outputDir, "output.txt");

    // 创建输出目录
    mkdirSync(outputDir, { recursive: true });

    // 构建 resource claim
    const resourceClaim: ResourceClaim = {
      readPaths: [...readPaths],
      writePaths: [...writePaths],
    };

    // 构建 trigger
    const trigger: AsyncRunTrigger = input.trigger ?? { kind: "manual" };

    // 计算 timeoutAt
    const timeoutAt = new Date(now.getTime() + timeoutMs).toISOString();

    // 构建 preview
    const preview =
      input.executor === "command"
        ? `Async command run: ${input.title}`
        : `Async subagent run: ${input.title}`;

    // 创建 record（使用条件赋值避免 exactOptionalPropertyTypes 问题）
    const record: AsyncRunRecord = {
      id: runId,
      executor: input.executor,
      title: input.title,
      status: "running",
      resourceClaim,
      startedAt: now.toISOString(),
      timeoutAt,
      preview,
      outputPath,
      trigger,
    };
    if (input.groupId !== undefined) record.groupId = input.groupId;
    if (input.persistentTaskId !== undefined)
      record.persistentTaskId = input.persistentTaskId;
    if (input.command !== undefined) record.command = input.command;
    if (input.prompt !== undefined) record.prompt = input.prompt;
    if (input.executor === "subagent") record.maxRounds = maxRounds;

    // 保存到内存表
    records.set(runId, record);
    runningCount++;

    // 写入初始快照
    writeRecordSnapshot(record);

    logger.info(
      "Async run %s started (executor=%s, running=%d)",
      runId,
      input.executor,
      runningCount,
    );

    // 启动 executor
    if (input.executor === "command" && input.command) {
      launchCommandRunner(record, input.command, timeoutMs);
    } else if (input.executor === "subagent" && input.prompt) {
      launchSubagentRunner(
        record,
        input.prompt,
        maxRounds,
        timeoutMs,
        resourceClaim.readPaths,
      );
    }

    // 返回深拷贝，防止外部修改内部状态
    return deepClone(record);
  }

  // -------------------------------------------------------------------------
  // launchCommandRunner — 启动 command executor
  // -------------------------------------------------------------------------

  function launchCommandRunner(
    record: AsyncRunRecord,
    command: string,
    timeoutMs: number,
  ): void {
    // 设置超时监控
    const timeoutId = setTimeout(() => {
      finishRun(record, "timeout", undefined, `Exceeded timeout of ${timeoutMs}ms`);
    }, timeoutMs);

    // 异步执行命令
    executeBash(command, projectRoot, timeoutMs)
      .then((result) => {
        clearTimeout(timeoutId);
        if (result.error) {
          finishRun(record, "failed", result.output, result.output);
        } else {
          finishRun(record, "completed", result.output);
        }
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        const errMsg = err instanceof Error ? err.message : String(err);
        finishRun(record, "failed", undefined, errMsg);
      });
  }

  // -------------------------------------------------------------------------
  // launchSubagentRunner — 启动 subagent executor
  // -------------------------------------------------------------------------

  function launchSubagentRunner(
    record: AsyncRunRecord,
    prompt: string,
    maxRounds: number,
    timeoutMs: number,
    readPaths: string[],
  ): void {
    // 创建子 Agent 所需的独立组件
    const subHistory = createHistory();
    const stablePrompt = getStableSystemPrompt();
    if (stablePrompt) {
      subHistory.setSystemPrompt(stablePrompt);
    }

    // 传入 readPaths，让 registry 可以按 declared read_paths 限制 run_read
    const subTools = createReadonlyRegistryFn(readPaths);
    const subCompressor = createCompressorFn();

    // 创建 child session
    const childSession =
      sessionManager && parentSessionId
        ? sessionManager.createChildSession(parentSessionId, record.title.slice(0, 80))
        : null;
    const childSessionId = childSession?.id ?? null;
    if (childSessionId) {
      record.childSessionId = childSessionId;
    }

    // AbortController：timeout 后向 child Agent 发送中止信号，阻止新的 LLM/tool 调用
    const abortController = new AbortController();

    // 构建 child Agent 参数
    // 注意：不传递 asyncRunManager（防止嵌套）、不传递 askUserFn（ask 降级为 deny）

    // 创建 scoped permission manager：子智能体内部不 ask，只允许只读诊断命令
    const scopedPermissionManager = permissionManager
      ? createScopedSubagentPermissionManager({
          parent: permissionManager,
          commandPolicy: readonlyCommandPolicy,
        })
      : {
          check: () => ({ action: "allow" } as import("./permission.js").PermissionDecision),
          setMode: () => {},
          getMode: () => "auto" as import("./permission.js").PermissionMode,
          getProjectDir: () => projectRoot,
        };

    const subAgentDeps: Parameters<typeof createAgentFn>[0] = {
      llm,
      history: subHistory,
      tools: subTools,
      logger,
      maxRounds,
      compressor: subCompressor,
      permissionManager: scopedPermissionManager,
      abortSignal: abortController.signal,
    };

    if (hookRunner) {
      subAgentDeps.hookRunner = hookRunner;
    }
    if (transcriptStore && childSessionId) {
      subAgentDeps.transcriptStore = transcriptStore;
      subAgentDeps.sessionId = childSessionId;
    }

    const subAgent = createAgentFn(subAgentDeps);

    // 设置超时监控：超时后先 abort child Agent，再 finishRun
    const timeoutId = setTimeout(() => {
      abortController.abort();
      finishRun(record, "timeout", undefined, `Exceeded timeout of ${timeoutMs}ms`);
    }, timeoutMs);

    // 运行子 Agent
    subAgent
      .run(prompt)
      .then((output) => {
        clearTimeout(timeoutId);
        if (childSessionId) {
          sessionManager?.endSession(childSessionId);
        }
        finishRun(record, "completed", output);
      })
      .catch((err) => {
        clearTimeout(timeoutId);
        if (childSessionId) {
          sessionManager?.endSession(childSessionId);
        }
        const errMsg = err instanceof Error ? err.message : String(err);
        finishRun(record, "failed", undefined, errMsg);
      });
  }

  // -------------------------------------------------------------------------
  // check — 查询单个 async run
  // -------------------------------------------------------------------------

  function check(runId: string): AsyncRunRecord | null {
    if (!validateRunId(runId)) return null;
    const record = records.get(runId);
    return record ? deepClone(record) : null;
  }

  // -------------------------------------------------------------------------
  // list — 列出 async runs
  // -------------------------------------------------------------------------

  function list(query?: AsyncRunListQuery): AsyncRunRecord[] {
    const all = Array.from(records.values());
    const statusFilter = query?.status;
    const includeTerminal = query?.includeTerminal ?? true;

    const filtered = all.filter((r) => {
      // status 过滤
      if (statusFilter && r.status !== statusFilter) return false;
      // include_terminal 过滤：false 时只返回 running
      if (!includeTerminal && r.status !== "running") return false;
      return true;
    });

    // 按 startedAt 倒序排列（最新的在前）
    filtered.sort(
      (a, b) =>
        new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
    );

    return filtered.map(deepClone);
  }

  // -------------------------------------------------------------------------
  // readOutput — 读取 async run 的完整输出
  // -------------------------------------------------------------------------

  function readOutput(input: ReadAsyncRunOutputInput): string {
    const { runId, maxBytes = DEFAULT_MAX_BYTES } = input;

    if (!validateRunId(runId)) {
      throw new Error(`Invalid run_id format: ${runId}`);
    }

    const record = records.get(runId);
    if (!record || !record.outputPath) {
      throw new Error(`Async run not found or no output path: ${runId}`);
    }

    // 新版本优先通过 OutputStore 读取，保证输出读取走统一 output_id 边界。
    if (record.outputId && outputStore) {
      return outputStore.read({
        outputId: record.outputId,
        maxBytes,
      }).content;
    }

    // 安全检查：输出路径必须在 taskOutputsDir/async-runs/ 下
    const expectedPrefix = resolve(taskOutputsDir, "async-runs");
    const resolvedOutputPath = resolve(record.outputPath);
    if (
      resolvedOutputPath !== expectedPrefix &&
      !resolvedOutputPath.startsWith(expectedPrefix + sep)
    ) {
      throw new Error(`Output path is outside async-runs directory`);
    }

    if (!existsSync(record.outputPath)) {
      throw new Error(`Output not found for async run: ${runId}`);
    }

    // 限制 maxBytes
    const effectiveMaxBytes = Math.min(maxBytes, MAX_MAX_BYTES);

    // 读取文件内容
    const content = readFileSync(record.outputPath);

    // 按 UTF-8 byte 截断
    if (content.length > effectiveMaxBytes) {
      return content.subarray(0, effectiveMaxBytes).toString("utf-8");
    }

    return content.toString("utf-8");
  }

  // -------------------------------------------------------------------------
  // drainNotifications —  drain 通知队列
  // -------------------------------------------------------------------------

  function drainNotifications(): AsyncRunNotification[] {
    const result = notificationQueue.slice();
    notificationQueue.length = 0;
    return result;
  }

  // -------------------------------------------------------------------------
  // checkForegroundToolConflict — 前台工具冲突检查
  // -------------------------------------------------------------------------

  function checkForegroundToolConflict(input: {
    toolName: string;
    args: Record<string, unknown>;
  }): { blocked: boolean; reason?: string } {
    const { toolName, args } = input;

    // 获取所有 running 的 async runs
    const runningRuns = Array.from(records.values()).filter(
      (r) => r.status === "running",
    );

    // 没有 running 的 async runs，直接放行
    if (runningRuns.length === 0) {
      return { blocked: false };
    }

    // run_write / run_edit / run_edit_exact：检查路径是否与 running runs 的 readPaths 重叠
    if (
      toolName === "run_write" ||
      toolName === "run_edit" ||
      toolName === "run_edit_exact"
    ) {
      const path = String(args["path"] ?? "");
      if (!path) return { blocked: false };

      for (const run of runningRuns) {
        for (const readPath of run.resourceClaim.readPaths) {
          if (pathsOverlap(path, readPath, projectRoot)) {
            return {
              blocked: true,
              reason: `path "${path}" is currently claimed by running async run ${run.id}`,
            };
          }
        }
      }
    }

    // run_bash：如果存在 running async runs，只允许 strict read-only command
    if (toolName === "run_bash") {
      const command = String(args["command"] ?? "");
      if (!command) return { blocked: false };

      const validation = readonlyCommandPolicy.validate(command);
      if (!validation.allowed) {
        return {
          blocked: true,
          reason: `Foreground bash blocked while async runs are active: ${validation.reason}`,
        };
      }
    }

    // 其他工具第一版不做冲突检查
    return { blocked: false };
  }

  // -------------------------------------------------------------------------
  // 返回 AsyncRunManager 接口
  // -------------------------------------------------------------------------

  return {
    start,
    check,
    list,
    readOutput,
    drainNotifications,
    checkForegroundToolConflict,
    setOnFinish(handler: (record: AsyncRunRecord) => void): void {
      onFinishRef = handler;
    },
  };
}
