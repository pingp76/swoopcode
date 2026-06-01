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
 * 第一版范围：
 * - repo map：目录结构 + 关键配置文件列表（不读取文件内容）
 * - pinned files：用户显式指定的文件，按路径排序
 * - working set：当前任务相关的设计文档
 * - evidence：最近 tool 输出摘要（占位，第一版仅框架）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type { ContextBudgetPlan } from "./context-budget.js";

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

/** 稳定上下文管理器接口 */
export interface StableContextManager {
  getState(): StableContextState;
  setEnabled(enabled: boolean): void;
  rebuildRepoMap(): StableContextPack;
  pinPath(filePath: string): void;
  unpinPath(filePath: string): void;
  buildMessages(currentQuery: string): ChatCompletionMessageParam[];
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
  const chineseCount = (text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g) ?? []).length;
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
  const keyFiles = [
    "package.json",
    "tsconfig.json",
    "AGENTS.md",
    "CLAUDE.md",
  ];
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
      if (asset.kind === "source_file" && asset.tokenEstimate > budgetTokens - usedTokens) {
        const maxChars = Math.floor((budgetTokens - usedTokens) / 0.25);
        const truncated = asset.content.slice(0, maxChars) + "\n... (truncated)";
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
      (a) => `  - ${a.source.label} (${a.kind}, ${a.tokenEstimate}t, hash=${a.contentHash})`,
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
}): StableContextPack {
  const { projectRoot, budgetTokens } = params;
  const assets: ContextAsset[] = [];

  // 第一版：只包含 doc/summary.md（如果存在）
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

  // 预算裁剪
  let usedTokens = 0;
  const keptAssets: ContextAsset[] = [];
  for (const asset of assets) {
    if (usedTokens + asset.tokenEstimate > budgetTokens) break;
    keptAssets.push(asset);
    usedTokens += asset.tokenEstimate;
  }

  const manifest = [
    `<working-set-manifest>`,
    `  assets: ${keptAssets.length}`,
    `  tokens: ${usedTokens}`,
    ...keptAssets.map(
      (a) => `  - ${a.source.label} (${a.kind}, ${a.tokenEstimate}t)`,
    ),
    `</working-set-manifest>`,
  ].join("\n");

  return {
    id: `working-${Date.now()}`,
    createdAt: new Date().toISOString(),
    projectRoot: params.projectRoot,
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
 * @param projectRoot - 项目根目录
 * @param modelProfileId - 当前模型 profile id（用于 pack 元数据）
 * @param getBudget - 获取当前上下文预算计划的函数
 */
export function createStableContextManager(
  projectRoot: string,
  _modelProfileId: string = "generic",
  getBudget?: () => ContextBudgetPlan,
): StableContextManager {
  let enabled = true;
  const pinnedPaths: string[] = [];
  let cachedRepoMap: string | null = null;

  function getRepoMap(): string {
    if (cachedRepoMap === null) {
      cachedRepoMap = buildRepoMap(projectRoot);
    }
    return cachedRepoMap;
  }

  return {
    getState(): StableContextState {
      const repoMap = getRepoMap();
      const stable = buildStablePack({
        projectRoot,
        repoMap,
        pinnedPaths,
        budgetTokens: Number.MAX_SAFE_INTEGER, // state 展示时不裁剪
      });
      const working = buildWorkingSetPack({
        projectRoot,
        budgetTokens: Number.MAX_SAFE_INTEGER,
      });
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
        totalTokens: stable.tokenEstimate + working.tokenEstimate + evidence.tokenEstimate,
      };
    },

    setEnabled(value: boolean): void {
      enabled = value;
    },

    rebuildRepoMap(): StableContextPack {
      cachedRepoMap = buildRepoMap(projectRoot);
      return buildStablePack({
        projectRoot,
        repoMap: cachedRepoMap,
        pinnedPaths,
        budgetTokens: Number.MAX_SAFE_INTEGER,
      });
    },

    pinPath(filePath: string): void {
      const normalized = path.normalize(filePath);
      if (!pinnedPaths.includes(normalized)) {
        pinnedPaths.push(normalized);
      }
    },

    unpinPath(filePath: string): void {
      const normalized = path.normalize(filePath);
      const idx = pinnedPaths.indexOf(normalized);
      if (idx >= 0) {
        pinnedPaths.splice(idx, 1);
      }
    },

    buildMessages(_currentQuery: string): ChatCompletionMessageParam[] {
      if (!enabled) {
        return [];
      }

      // 如果没有提供 getBudget，使用一个保守的默认预算
      const budget: ContextBudgetPlan = getBudget?.() ?? {
        effectiveBudgetTokens: 80000,
        outputReserveTokens: 4096,
        conversationReserveTokens: 20000,
        stablePackBudgetTokens: 20000,
        workingSetBudgetTokens: 20000,
        evidenceBudgetTokens: 5000,
        headroomTokens: 10904,
      };
      const repoMap = getRepoMap();

      // 按预算构建三个 pack
      const stable = buildStablePack({
        projectRoot,
        repoMap,
        pinnedPaths,
        budgetTokens: budget.stablePackBudgetTokens,
      });

      const working = buildWorkingSetPack({
        projectRoot,
        budgetTokens: budget.workingSetBudgetTokens,
      });

      const evidence = buildEvidencePack({
        projectRoot,
        budgetTokens: budget.evidenceBudgetTokens,
      });

      // 组装为消息列表
      // 顺序：stable pack -> working set pack -> evidence pack
      // 每个 pack 作为一条 user 消息，便于跟踪和调试
      const messages: ChatCompletionMessageParam[] = [];

      if (stable.assets.length > 0) {
        messages.push({
          role: "user",
          content: `<stable-context-pack>\n${stable.manifest}\n\n${stable.assets.map((a) => a.content).join("\n\n")}\n</stable-context-pack>`,
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
  };
}
