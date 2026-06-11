/**
 * stable-context.ts — 稳定上下文管理器
 *
 * 职责：为长上下文模型提供结构化的项目上下文装载。
 *
 * 核心设计：
 * - 稳定内容靠前（repo map、设计文档、pinned files），利于 prompt cache
 * - 动态证据靠后（diff、test failure、tool output），不污染稳定前缀
 * - 所有内容按确定性顺序生成，未变化时 hash 不变
 * - 预算超支时按固定优先级裁剪：evidence → working set → stable pack → conversation
 *
 * PDD21-1 增强：
 * - 集成 ContextRanker 实现通用内容重要性排序
 * - Working set 使用 ranker 选择，不再硬编码 doc/summary.md
 * - Stable pack 不使用动态信号（mtime/open file/git diff/query terms）
 * - Manifest 输出 rank reasons，帮助调试和理解装载决策
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ContextBudgetPlan } from "./context-budget.js";
import type {
  ContextRanker,
  RankedFile,
  RepoClassification,
  TaskContext,
} from "./context-ranking.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 上下文资产类型 */
export type ContextAssetKind =
  | "repo_map"
  | "project_doc"
  | "design_doc"
  | "source_file"
  | "test_file"
  | "diff"
  | "tool_evidence"
  | "summary";

/** 上下文资产稳定性 */
export type ContextStability = "stable" | "semi_stable" | "dynamic";

/** 单个上下文资产 */
export interface ContextAsset {
  id: string;
  kind: ContextAssetKind;
  stability: ContextStability;
  source: {
    path?: string;
    outputId?: string;
    label: string;
  };
  priority: number;
  tokenEstimate: number;
  contentHash: string;
  content: string;
}

/** 稳定上下文包 */
export interface StableContextPack {
  id: string;
  createdAt: string;
  projectRoot: string;
  modelProfileId: string;
  tokenEstimate: number;
  assets: ContextAsset[];
  manifest: string;
}

/** 稳定上下文管理器状态 */
export interface StableContextState {
  enabled: boolean;
  pinnedPaths: string[];
  repoMapPack: StableContextPack | null;
  stablePack: StableContextPack | null;
  workingSetPack: StableContextPack | null;
  evidencePack: StableContextPack | null;
  totalTokens: number;
}

/** buildMessages 输入参数 */
export interface BuildMessagesInput {
  currentQuery: string;
  recentFiles?: string[];
  openFiles?: string[];
  changedFiles?: string[];
  failingFiles?: string[];
  stackTraceFiles?: string[];
}

/** 稳定上下文管理器接口 */
export interface StableContextManager {
  getState(): StableContextState;
  setEnabled(enabled: boolean): void;
  rebuildRepoMap(): StableContextPack;
  pinPath(filePath: string): void;
  unpinPath(filePath: string): void;
  buildMessages(
    input: string | BuildMessagesInput,
  ): ChatCompletionMessageParam[];
  getRankedFiles(maxResults?: number): RankedFile[];
  getRepoClassification(): RepoClassification | null;
  explainFile(filePath: string): RankedFile | null;
  invalidateStableSnapshot(): void;
  /** 通知文件被修改：如果命中 pinned path 则 invalidate stable snapshot */
  notifyFileChanged(filePath: string): void;
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 计算字符串 SHA256 hash（取前 8 位） */
function sha256Short(input: string): string {
  return createHash("sha256").update(input, "utf-8").digest("hex").slice(0, 8);
}

/** 基于字符数估算 token 数（与 message-block.ts 保持一致） */
function estimateTokens(text: string): number {
  if (!text) return 0;
  const chineseCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? [])
    .length;
  return Math.max(chineseCount * 1.5, text.length * 0.25);
}

/** 安全读取文件内容，失败时返回 null */
function safeReadFile(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

/** 判断路径是否在项目根目录内
 *
 * 使用 path.relative 而非 startsWith，避免同名前缀兄弟目录绕过：
 * 例如 projectRoot=/a/b，filePath=../b-secret/foo 时：
 * startsWith 会误匹配 /a/b-secret/foo，但 relative 返回 ../b-secret/foo，
 * 以 .. 开头，正确拒绝。
 */
function isInsideProject(filePath: string, projectRoot: string): boolean {
  const resolved = path.resolve(projectRoot, filePath);
  const rootResolved = path.resolve(projectRoot);
  const relative = path.relative(rootResolved, resolved);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** 默认排除的目录和文件模式 */
const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  "dist",
  "coverage",
  ".env",
  ".env.*",
  "*.log",
  "*.lock",
  "package-lock.json",
];

/** 判断文件名是否应被排除 */
function isExcluded(name: string): boolean {
  for (const pattern of DEFAULT_EXCLUDES) {
    if (pattern.includes("*")) {
      const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
      if (regex.test(name)) return true;
    } else if (name === pattern) {
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Repo Map Builder
// ---------------------------------------------------------------------------

/**
 * 构建项目 repo map
 *
 * 第一版实现：
 * - 列出目录结构（最多 2 层深度）
 * - 标注关键配置文件
 * - 标注源码目录和测试目录
 * - 不包含文件内容
 */
function buildRepoMap(projectRoot: string): string {
  const lines: string[] = ["<repo-map>", `projectRoot: ${projectRoot}`, ""];

  // 关键配置文件
  const keyFiles = ["package.json", "tsconfig.json", "AGENTS.md", "CLAUDE.md"];
  const foundKeyFiles: string[] = [];
  for (const f of keyFiles) {
    const fp = path.join(projectRoot, f);
    if (fs.existsSync(fp)) {
      foundKeyFiles.push(f);
    }
  }
  if (foundKeyFiles.length > 0) {
    lines.push("key files:", ...foundKeyFiles.map((f) => `  - ${f}`), "");
  }

  // 目录结构（递归扫描，排除 node_modules 等）
  function scanDir(dir: string, depth: number, prefix: string): void {
    if (depth > 2) return;
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    entries.sort();
    for (const entry of entries) {
      if (isExcluded(entry)) continue;
      const fullPath = path.join(dir, entry);
      const stat = fs.statSync(fullPath);
      if (stat.isDirectory()) {
        lines.push(`${prefix}${entry}/`);
        scanDir(fullPath, depth + 1, prefix + "  ");
      } else {
        lines.push(`${prefix}${entry}`);
      }
    }
  }

  lines.push("directory structure:");
  scanDir(projectRoot, 0, "  ");
  lines.push("</repo-map>");

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Pack Builders
// ---------------------------------------------------------------------------

function buildStablePack(params: {
  projectRoot: string;
  repoMap: string;
  pinnedPaths: string[];
  budgetTokens: number;
}): StableContextPack {
  const { projectRoot, repoMap, pinnedPaths, budgetTokens } = params;
  const assets: ContextAsset[] = [];

  // 1. repo map（优先级最高）
  const repoMapTokens = estimateTokens(repoMap);
  assets.push({
    id: "repo-map",
    kind: "repo_map",
    stability: "stable",
    source: { label: "Repository Map" },
    priority: 1,
    tokenEstimate: repoMapTokens,
    contentHash: sha256Short(repoMap),
    content: repoMap,
  });

  // 2. pinned files（按路径排序，确定性顺序）
  const sortedPins = [...pinnedPaths].sort();
  for (const pinPath of sortedPins) {
    if (!isInsideProject(pinPath, projectRoot)) continue;
    const fullPath = path.resolve(projectRoot, pinPath);
    const content = safeReadFile(fullPath);
    if (content === null) continue;
    const relPath = path.relative(projectRoot, fullPath);
    assets.push({
      id: `pin-${relPath}`,
      kind: "source_file",
      stability: "semi_stable",
      source: { path: relPath, label: `Pinned: ${relPath}` },
      priority: 2,
      tokenEstimate: estimateTokens(content),
      contentHash: sha256Short(content),
      content: `<file path="${relPath}">\n${content}\n</file>`,
    });
  }

  // 3. 预算裁剪：按优先级保留，超预算时截断
  let usedTokens = 0;
  const keptAssets: ContextAsset[] = [];
  for (const asset of assets) {
    if (usedTokens + asset.tokenEstimate > budgetTokens) {
      // 超预算：如果当前资产是文件，尝试只保留头部摘要
      if (
        asset.kind === "source_file" &&
        asset.tokenEstimate > budgetTokens - usedTokens
      ) {
        const maxChars = Math.floor((budgetTokens - usedTokens) / 0.25);
        const truncated =
          asset.content.slice(0, maxChars) + "\n... (truncated)";
        keptAssets.push({
          ...asset,
          content: truncated,
          tokenEstimate: estimateTokens(truncated),
        });
        usedTokens += estimateTokens(truncated);
      }
      break;
    }
    keptAssets.push(asset);
    usedTokens += asset.tokenEstimate;
  }

  const manifest = [
    `<context-manifest>`,
    `  assets: ${keptAssets.length}`,
    `  tokens: ${usedTokens}`,
    `  budget: ${budgetTokens}`,
    ...keptAssets.map(
      (a) =>
        `  - ${a.source.label} (${a.kind}, ${a.tokenEstimate}t, hash=${a.contentHash})`,
    ),
    `</context-manifest>`,
  ].join("\n");

  return {
    id: `stable-${Date.now()}`,
    createdAt: new Date().toISOString(),
    projectRoot,
    modelProfileId: "generic",
    tokenEstimate: usedTokens,
    assets: keptAssets,
    manifest,
  };
}

function buildWorkingSetPack(params: {
  projectRoot: string;
  budgetTokens: number;
  ranker?: ContextRanker;
  task?: TaskContext;
  repo?: RepoClassification;
  cachedFiles?: import("./context-ranking.js").FileFacts[];
  stablePackPaths?: Set<string>;
}): StableContextPack {
  const {
    projectRoot,
    budgetTokens,
    ranker,
    task,
    repo,
    cachedFiles,
    stablePackPaths,
  } = params;
  const assets: ContextAsset[] = [];

  if (ranker && task && repo && cachedFiles) {
    // PDD21-1: 使用 ContextRanker 选择 working set
    // 使用已缓存的文件事实，不重复扫描磁盘
    const ranked = ranker.rankFiles({
      files: cachedFiles,
      repo,
      task,
      maxResults: 20,
    });

    let usedTokens = 0;

    for (const rf of ranked) {
      if (rf.score <= 0) continue;
      if (rf.facts.roles.includes("project_instruction")) continue;
      // 跳过已在 stable pack 中的文件，避免重复装载浪费预算
      if (stablePackPaths?.has(rf.path)) continue;

      // 先用 sizeBytes 预估 token 数，避免读取超大文件后才发现问题
      const estimatedTokens = Math.max(
        rf.facts.sizeBytes * 0.25,
        (rf.facts.lineCount ?? 0) * 10,
      );
      const remainingBudget = budgetTokens - usedTokens;

      // 如果预估已超剩余预算且剩余预算太小（< 200t），跳过
      if (estimatedTokens > remainingBudget && remainingBudget < 200) continue;

      const fullPath = path.join(projectRoot, rf.path);
      let content = safeReadFile(fullPath);
      if (content === null) continue;

      let actualTokens = estimateTokens(content);

      // 如果实际 token 超预算，截断而非整体丢弃
      if (actualTokens > remainingBudget && remainingBudget >= 200) {
        // 预留 truncation marker 的 token 预算，避免截断后仍超预算
        const truncationMarker =
          "\n... (truncated, exceeded working set budget)";
        const markerTokens = estimateTokens(truncationMarker);
        const availableForContent = Math.max(0, remainingBudget - markerTokens);
        const maxChars = Math.floor(availableForContent / 0.25);
        content = content.slice(0, maxChars) + truncationMarker;
        actualTokens = estimateTokens(content);
        // 安全兜底：如果仍超预算，进一步收缩
        if (actualTokens > remainingBudget) {
          const safeMaxChars = Math.max(
            0,
            Math.floor((remainingBudget - markerTokens) / 0.3),
          );
          content = content.slice(0, safeMaxChars) + truncationMarker;
          actualTokens = estimateTokens(content);
        }
      } else if (actualTokens > remainingBudget) {
        continue;
      }

      const reasonSummary = rf.reasons
        .filter((r) => r.points > 0)
        .slice(0, 3)
        .map((r) => r.note)
        .join(", ");

      const kind: ContextAssetKind = rf.facts.roles.includes("test")
        ? "test_file"
        : rf.facts.roles.includes("design_doc")
          ? "design_doc"
          : rf.facts.roles.includes("project_summary")
            ? "project_doc"
            : "source_file";

      assets.push({
        id: `ws-${rf.path}`,
        kind,
        stability: "semi_stable",
        source: { path: rf.path, label: rf.path },
        priority: rf.score,
        tokenEstimate: actualTokens,
        contentHash: sha256Short(content),
        content: `<file path="${rf.path}" score="${rf.score}" reasons="${reasonSummary}">\n${content}\n</file>`,
      });

      usedTokens += actualTokens;
      if (usedTokens >= budgetTokens) break;
    }
  } else {
    // fallback: 只包含 doc/summary.md（如果存在）
    const summaryPath = path.join(projectRoot, "doc", "summary.md");
    if (fs.existsSync(summaryPath)) {
      const content = safeReadFile(summaryPath) ?? "";
      assets.push({
        id: "doc-summary",
        kind: "project_doc",
        stability: "semi_stable",
        source: { path: "doc/summary.md", label: "Project Summary" },
        priority: 1,
        tokenEstimate: estimateTokens(content),
        contentHash: sha256Short(content),
        content: `<project-summary>\n${content}\n</project-summary>`,
      });
    }
  }

  // 预算裁剪（fallback 路径仍需裁剪）
  let usedTokens = 0;
  const keptAssets: ContextAsset[] = [];
  for (const asset of assets) {
    if (usedTokens + asset.tokenEstimate > budgetTokens) break;
    keptAssets.push(asset);
    usedTokens += asset.tokenEstimate;
  }

  const repoLabel = repo
    ? repo.primary === "mixed"
      ? `mixed(${repo.all.join(", ")})`
      : repo.primary
    : "unknown";
  const taskLabel = task?.intent ?? "unknown";

  const manifest = [
    `<working-set-manifest>`,
    `  assets: ${keptAssets.length}`,
    `  tokens: ${usedTokens}`,
    `  repo: ${repoLabel}`,
    `  task: ${taskLabel}`,
    ...keptAssets.map(
      (a) =>
        `  - ${a.source.label} score=${a.priority} (${a.kind}, ${a.tokenEstimate}t)`,
    ),
    `</working-set-manifest>`,
  ].join("\n");

  return {
    id: `working-${Date.now()}`,
    createdAt: new Date().toISOString(),
    projectRoot,
    modelProfileId: "generic",
    tokenEstimate: usedTokens,
    assets: keptAssets,
    manifest,
  };
}

function buildEvidencePack(params: {
  projectRoot: string;
  budgetTokens: number;
}): StableContextPack {
  // 第一版 evidence pack 是占位：只返回空 pack
  // 后续版本可以接入最近 tool 输出、diff、test failure 等
  const manifest = [
    `<evidence-manifest>`,
    `  assets: 0`,
    `  tokens: 0`,
    `  note: evidence pack is empty in first version`,
    `</evidence-manifest>`,
  ].join("\n");

  return {
    id: `evidence-${Date.now()}`,
    createdAt: new Date().toISOString(),
    projectRoot: params.projectRoot,
    modelProfileId: "generic",
    tokenEstimate: 0,
    assets: [],
    manifest,
  };
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * 创建稳定上下文管理器
 *
 * Stable Snapshot 语义：
 * - stable pack 在首次 buildMessages 时构建一次，之后缓存渲染后的字符串
 * - 只有显式失效事件（pin/unpin/rebuild/invalidate）才会触发重建
 * - currentQuery、recentFiles、failingFiles、mtime、git diff 永远不进入 stable
 * - 预算在 snapshot 创建时锁定；如果用户调小预算导致放不下，触发重建而非静默裁剪
 *
 * @param projectRoot - 项目根目录
 * @param modelProfileId - 当前模型 profile id（用于 pack 元数据）
 * @param getBudget - 获取当前上下文预算计划的函数
 * @param ranker - 可选，ContextRanker 实例（PDD21-1 增强）
 */
export function createStableContextManager(
  projectRoot: string,
  _modelProfileId: string = "generic",
  getBudget?: () => ContextBudgetPlan,
  ranker?: ContextRanker,
): StableContextManager {
  let enabled = true;
  const pinnedPaths: string[] = [];
  let cachedRepoMap: string | null = null;
  let cachedRepoClassification: RepoClassification | null = null;
  let cachedFiles: import("./context-ranking.js").FileFacts[] | null = null;

  // Stable snapshot 缓存：渲染后的消息字符串 + pack 对象 + 锁定的预算
  let cachedStableMessage: string | null = null;
  let cachedStablePack: StableContextPack | null = null;
  let stableBudgetLocked = 0;

  function getRepoMap(): string {
    if (cachedRepoMap === null) {
      cachedRepoMap = buildRepoMap(projectRoot);
    }
    return cachedRepoMap;
  }

  function getRepoAndFiles(): {
    repo: RepoClassification;
    files: import("./context-ranking.js").FileFacts[];
  } | null {
    if (!ranker) return null;
    if (cachedFiles === null) {
      cachedFiles = ranker.scanFileFacts();
    }
    if (cachedRepoClassification === null) {
      cachedRepoClassification = ranker.classifyRepo(cachedFiles);
    }
    return { repo: cachedRepoClassification, files: cachedFiles };
  }

  /**
   * 使 stable snapshot 失效
   *
   * 下次 buildMessages 时会重新构建 stable pack 并缓存渲染结果。
   * 触发场景：pinPath、unpinPath、rebuildRepoMap、用户显式调用。
   */
  function invalidateStableSnapshot(): void {
    cachedStableMessage = null;
    cachedStablePack = null;
    stableBudgetLocked = 0;
  }

  /**
   * 获取或构建 stable snapshot
   *
   * 如果缓存存在且预算兼容，直接返回缓存。
   * 如果预算缩小导致放不下，触发重建。
   */
  function getOrBuildStableSnapshot(budgetTokens: number): {
    pack: StableContextPack;
    message: string;
  } {
    // 缓存命中：预算未缩小，或缩小后仍放得下
    if (cachedStableMessage !== null && cachedStablePack !== null) {
      if (
        budgetTokens >= stableBudgetLocked ||
        cachedStablePack.tokenEstimate <= budgetTokens
      ) {
        return { pack: cachedStablePack, message: cachedStableMessage };
      }
      // 预算缩小且放不下，需要重建
    }

    const repoMap = getRepoMap();
    const pack = buildStablePack({
      projectRoot,
      repoMap,
      pinnedPaths,
      budgetTokens,
    });

    const message =
      pack.assets.length > 0
        ? `<stable-context-pack>\n${pack.manifest}\n\n${pack.assets.map((a) => a.content).join("\n\n")}\n</stable-context-pack>`
        : "";

    cachedStablePack = pack;
    cachedStableMessage = message;
    stableBudgetLocked = budgetTokens;

    return { pack, message };
  }

  return {
    getState(): StableContextState {
      // getState 使用 MAX 预算查看完整 stable 内容（不裁剪）
      const stable =
        cachedStablePack ??
        buildStablePack({
          projectRoot,
          repoMap: getRepoMap(),
          pinnedPaths,
          budgetTokens: Number.MAX_SAFE_INTEGER,
        });
      const repoAndFiles = getRepoAndFiles();
      const stablePaths = new Set(
        stable.assets
          .map((a) => a.source.path)
          .filter((p): p is string => p !== undefined),
      );
      const workingParams: Parameters<typeof buildWorkingSetPack>[0] = {
        projectRoot,
        budgetTokens: Number.MAX_SAFE_INTEGER,
        stablePackPaths: stablePaths,
      };
      if (ranker) workingParams.ranker = ranker;
      if (repoAndFiles?.repo) workingParams.repo = repoAndFiles.repo;
      if (repoAndFiles?.files) workingParams.cachedFiles = repoAndFiles.files;
      const working = buildWorkingSetPack(workingParams);
      const evidence = buildEvidencePack({
        projectRoot,
        budgetTokens: Number.MAX_SAFE_INTEGER,
      });

      return {
        enabled,
        pinnedPaths: [...pinnedPaths],
        repoMapPack: stable,
        stablePack: stable,
        workingSetPack: working,
        evidencePack: evidence,
        totalTokens:
          stable.tokenEstimate + working.tokenEstimate + evidence.tokenEstimate,
      };
    },

    setEnabled(value: boolean): void {
      enabled = value;
    },

    rebuildRepoMap(): StableContextPack {
      cachedRepoMap = buildRepoMap(projectRoot);
      cachedFiles = null;
      cachedRepoClassification = null;
      invalidateStableSnapshot();
      // 返回新的 stable pack（使用 MAX 预算展示完整内容）
      const pack = buildStablePack({
        projectRoot,
        repoMap: cachedRepoMap,
        pinnedPaths,
        budgetTokens: Number.MAX_SAFE_INTEGER,
      });
      cachedStablePack = pack;
      return pack;
    },

    pinPath(filePath: string): void {
      const normalized = path.normalize(filePath);
      if (!pinnedPaths.includes(normalized)) {
        pinnedPaths.push(normalized);
        invalidateStableSnapshot();
      }
    },

    unpinPath(filePath: string): void {
      const normalized = path.normalize(filePath);
      const idx = pinnedPaths.indexOf(normalized);
      if (idx >= 0) {
        pinnedPaths.splice(idx, 1);
        invalidateStableSnapshot();
      }
    },

    invalidateStableSnapshot(): void {
      invalidateStableSnapshot();
    },

    notifyFileChanged(filePath: string): void {
      // 检查修改的文件是否命中 pinned paths，如果是则 invalidate stable snapshot
      // 这样下次 buildMessages 会重新读取 pinned 文件的最新内容
      const normalized = path.normalize(filePath);
      if (pinnedPaths.includes(normalized)) {
        invalidateStableSnapshot();
      }
    },

    buildMessages(
      input: string | BuildMessagesInput,
    ): ChatCompletionMessageParam[] {
      if (!enabled) {
        return [];
      }

      // 兼容旧 API：string 参数转为 BuildMessagesInput
      const params: BuildMessagesInput =
        typeof input === "string" ? { currentQuery: input } : input;

      const budget: ContextBudgetPlan = getBudget?.() ?? {
        effectiveBudgetTokens: 80000,
        outputReserveTokens: 4096,
        conversationReserveTokens: 20000,
        stablePackBudgetTokens: 20000,
        workingSetBudgetTokens: 20000,
        evidenceBudgetTokens: 5000,
        headroomTokens: 10904,
      };

      // 1. Stable snapshot：复用缓存或首次构建
      const stable = getOrBuildStableSnapshot(budget.stablePackBudgetTokens);

      // 2. Working set：每轮重新构建（使用 dynamic 信号）
      const repoAndFiles = getRepoAndFiles();
      let task: TaskContext | undefined;
      if (ranker && repoAndFiles) {
        task = ranker.classifyTask({
          query: params.currentQuery,
          recentFiles: params.recentFiles ?? [],
          openFiles: params.openFiles ?? [],
          changedFiles: params.changedFiles ?? [],
          failingFiles: params.failingFiles ?? [],
          stackTraceFiles: params.stackTraceFiles ?? [],
        });
      }

      const stablePaths = new Set(
        stable.pack.assets
          .map((a) => a.source.path)
          .filter((p): p is string => p !== undefined),
      );
      const workingParams: Parameters<typeof buildWorkingSetPack>[0] = {
        projectRoot,
        budgetTokens: budget.workingSetBudgetTokens,
        stablePackPaths: stablePaths,
      };
      if (ranker) workingParams.ranker = ranker;
      if (task) workingParams.task = task;
      if (repoAndFiles?.repo) workingParams.repo = repoAndFiles.repo;
      if (repoAndFiles?.files) workingParams.cachedFiles = repoAndFiles.files;
      const working = buildWorkingSetPack(workingParams);

      // 3. Evidence pack：每轮重新构建
      const evidence = buildEvidencePack({
        projectRoot,
        budgetTokens: budget.evidenceBudgetTokens,
      });

      // 4. 组装消息列表
      const messages: ChatCompletionMessageParam[] = [];

      if (stable.message) {
        messages.push({
          role: "user",
          content: stable.message,
        } as ChatCompletionMessageParam);
      }

      if (working.assets.length > 0) {
        messages.push({
          role: "user",
          content: `<working-set-pack>\n${working.manifest}\n\n${working.assets.map((a) => a.content).join("\n\n")}\n</working-set-pack>`,
        } as ChatCompletionMessageParam);
      }

      if (evidence.assets.length > 0) {
        messages.push({
          role: "user",
          content: `<evidence-pack>\n${evidence.manifest}\n\n${evidence.assets.map((a) => a.content).join("\n\n")}\n</evidence-pack>`,
        } as ChatCompletionMessageParam);
      }

      return messages;
    },

    getRankedFiles(maxResults?: number): RankedFile[] {
      if (!ranker) return [];
      const repoAndFiles = getRepoAndFiles();
      if (!repoAndFiles) return [];
      const task = ranker.classifyTask({
        query: "",
        recentFiles: [],
        openFiles: [],
        changedFiles: [],
        failingFiles: [],
        stackTraceFiles: [],
      });
      return ranker.rankFiles({
        files: repoAndFiles.files,
        repo: repoAndFiles.repo,
        task,
        maxResults: maxResults ?? 20,
      });
    },

    getRepoClassification(): RepoClassification | null {
      const repoAndFiles = getRepoAndFiles();
      return repoAndFiles?.repo ?? null;
    },

    explainFile(filePath: string): RankedFile | null {
      if (!ranker) return null;
      const repoAndFiles = getRepoAndFiles();
      if (!repoAndFiles) return null;
      const task = ranker.classifyTask({
        query: "",
        recentFiles: [],
        openFiles: [],
        changedFiles: [],
        failingFiles: [],
        stackTraceFiles: [],
      });
      const ranked = ranker.rankFiles({
        files: repoAndFiles.files,
        repo: repoAndFiles.repo,
        task,
      });
      const normalized = path.normalize(filePath);
      return (
        ranked.find((r) => r.path === normalized || r.path === filePath) ?? null
      );
    },
  };
}
