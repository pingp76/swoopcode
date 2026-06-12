/**
 * temp-cleanup.ts — Eval 临时产物清理器
 *
 * 职责：清理 eval harness 在系统临时目录中遗留的 workspace、agentHome 和 trace 文件。
 *
 * 设计原则：
 * - 只清理固定白名单前缀，避免误删用户自己的临时目录
 * - 优先读取 manifest 中的 expiresAt；老版本产物没有 manifest 时再按 mtime 兜底
 * - 支持 dry-run，让本地调试和 CI 接入前可以先观察会删除什么
 * - trace 目录特殊处理：只删除旧的 *.trace.json 文件，不清空未知内容
 */

import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Eval 临时产物目录中的 manifest 文件名。 */
export const EVAL_ARTIFACT_MANIFEST = ".eval-artifact.json";

/** 本地默认保留 7 天：足够排查失败，又不会无限膨胀。 */
export const DEFAULT_EVAL_ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 允许清理的目录名前缀。 */
const EVAL_TEMP_DIR_PREFIXES = [
  "eval-",
  "learn-claude-eval-home-",
  "learn-claude-team-home-",
  "eval-full-ws-",
  "eval-full-home-",
  "eval-replay-test-",
] as const;

/** Trace 默认目录名。 */
const EVAL_TRACE_DIR_NAME = "eval-traces";

/** 可写入 manifest 的临时产物类型。 */
export type EvalArtifactKind = "workspace" | "agentHome";

/** manifest 记录为什么保留该目录，以及它何时可以被清理。 */
export interface EvalArtifactManifest {
  caseId: string;
  kind: EvalArtifactKind;
  createdAt: string;
  expiresAt: string;
  reason: "keepOnFailure";
}

export interface WriteEvalArtifactManifestOptions {
  caseId: string;
  kind: EvalArtifactKind;
  now?: Date;
  ttlMs?: number;
}

export interface CleanupEvalArtifactsOptions {
  /** 扫描根目录，默认是 OS tmpdir。测试可传入独立目录。 */
  rootDir?: string;
  /** 没有 manifest 的旧产物按 mtime 判断，默认 7 天。 */
  olderThanMs?: number;
  /** 当前时间注入，便于测试。 */
  now?: Date;
  /** 只报告不删除。 */
  dryRun?: boolean;
}

export interface CleanupEvalArtifactEntry {
  path: string;
  kind: "directory" | "traceFile";
  reason: string;
}

export interface CleanupEvalArtifactsResult {
  rootDir: string;
  dryRun: boolean;
  scanned: number;
  deleted: CleanupEvalArtifactEntry[];
  kept: CleanupEvalArtifactEntry[];
  errors: Array<{ path: string; message: string }>;
}

/**
 * writeEvalArtifactManifest — 给保留的失败产物写入过期信息。
 *
 * 运行内 cleanup 已经能删除正常通过的 case；manifest 只服务于 keepOnFailure
 * 或进程异常退出后的跨运行 GC。它刻意使用简单 JSON，方便人手打开查看。
 */
export async function writeEvalArtifactManifest(
  artifactRoot: string,
  options: WriteEvalArtifactManifestOptions,
): Promise<void> {
  const now = options.now ?? new Date();
  const ttlMs = options.ttlMs ?? DEFAULT_EVAL_ARTIFACT_TTL_MS;
  const manifest: EvalArtifactManifest = {
    caseId: options.caseId,
    kind: options.kind,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
    reason: "keepOnFailure",
  };

  await mkdir(artifactRoot, { recursive: true });
  await writeFile(
    join(artifactRoot, EVAL_ARTIFACT_MANIFEST),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
}

/**
 * cleanupEvalArtifacts — 扫描并清理过期 eval 临时产物。
 *
 * 安全边界：
 * - 不递归扫描任意目录树，只看 rootDir 的直接子项
 * - 目录必须匹配 eval 白名单前缀
 * - symlink 不删除，避免链接逃逸
 * - eval-traces 中只删除旧的 *.trace.json 文件
 */
export async function cleanupEvalArtifacts(
  options: CleanupEvalArtifactsOptions = {},
): Promise<CleanupEvalArtifactsResult> {
  const rootDir = resolve(options.rootDir ?? tmpdir());
  const now = options.now ?? new Date();
  const olderThanMs = options.olderThanMs ?? DEFAULT_EVAL_ARTIFACT_TTL_MS;
  const dryRun = options.dryRun === true;
  const result: CleanupEvalArtifactsResult = {
    rootDir,
    dryRun,
    scanned: 0,
    deleted: [],
    kept: [],
    errors: [],
  };

  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch (err) {
    result.errors.push({
      path: rootDir,
      message: err instanceof Error ? err.message : String(err),
    });
    return result;
  }

  for (const entry of entries) {
    const entryPath = join(rootDir, entry.name);

    if (entry.name === EVAL_TRACE_DIR_NAME && entry.isDirectory()) {
      await cleanupTraceFiles(entryPath, now, olderThanMs, dryRun, result);
      continue;
    }

    if (!entry.isDirectory() || !isEvalTempDirectoryName(entry.name)) {
      continue;
    }

    result.scanned++;
    try {
      const entryStat = await lstat(entryPath);
      if (!entryStat.isDirectory() || entryStat.isSymbolicLink()) {
        result.kept.push({
          path: entryPath,
          kind: "directory",
          reason: "not a real directory",
        });
        continue;
      }

      const decision = await shouldDeleteDirectory(
        entryPath,
        entryStat.mtimeMs,
        now,
        olderThanMs,
      );
      if (!decision.delete) {
        result.kept.push({
          path: entryPath,
          kind: "directory",
          reason: decision.reason,
        });
        continue;
      }

      result.deleted.push({
        path: entryPath,
        kind: "directory",
        reason: decision.reason,
      });
      if (!dryRun) {
        await rm(entryPath, { recursive: true, force: true });
      }
    } catch (err) {
      result.errors.push({
        path: entryPath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

/**
 * parseEvalCleanupDuration — 解析 CLI 中的 24h / 7d / 30m 等保留时间。
 *
 * 只支持少量明确单位，避免把复杂自然语言解析带进教学项目。
 */
export function parseEvalCleanupDuration(input: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(input.trim());
  if (!match) {
    throw new Error(
      `Invalid duration "${input}". Use formats like 24h, 7d, 30m, or 1000ms.`,
    );
  }

  const amountText = match[1];
  const unit = match[2];
  if (amountText === undefined || unit === undefined) {
    throw new Error(`Invalid duration "${input}".`);
  }

  const amount = Number.parseInt(amountText, 10);
  const multipliers: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  };
  return amount * multipliers[unit]!;
}

function isEvalTempDirectoryName(name: string): boolean {
  return EVAL_TEMP_DIR_PREFIXES.some((prefix) => name.startsWith(prefix));
}

async function shouldDeleteDirectory(
  directoryPath: string,
  mtimeMs: number,
  now: Date,
  olderThanMs: number,
): Promise<{ delete: boolean; reason: string }> {
  const manifest = await readManifest(directoryPath);
  if (manifest !== undefined) {
    const expiresAtMs = Date.parse(manifest.expiresAt);
    if (!Number.isNaN(expiresAtMs)) {
      return expiresAtMs <= now.getTime()
        ? { delete: true, reason: `manifest expired at ${manifest.expiresAt}` }
        : {
            delete: false,
            reason: `manifest expires at ${manifest.expiresAt}`,
          };
    }
  }

  const ageMs = now.getTime() - mtimeMs;
  return ageMs >= olderThanMs
    ? { delete: true, reason: `mtime older than ${olderThanMs}ms` }
    : { delete: false, reason: `mtime newer than ${olderThanMs}ms` };
}

async function readManifest(
  directoryPath: string,
): Promise<EvalArtifactManifest | undefined> {
  try {
    const raw = await readFile(
      join(directoryPath, EVAL_ARTIFACT_MANIFEST),
      "utf-8",
    );
    return JSON.parse(raw) as EvalArtifactManifest;
  } catch {
    return undefined;
  }
}

async function cleanupTraceFiles(
  traceDir: string,
  now: Date,
  olderThanMs: number,
  dryRun: boolean,
  result: CleanupEvalArtifactsResult,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(traceDir, { withFileTypes: true });
  } catch (err) {
    result.errors.push({
      path: traceDir,
      message: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  for (const entry of entries) {
    const filePath = join(traceDir, entry.name);
    if (!entry.isFile() || !entry.name.endsWith(".trace.json")) {
      continue;
    }

    result.scanned++;
    try {
      const fileStat = await stat(filePath);
      const ageMs = now.getTime() - fileStat.mtimeMs;
      if (ageMs < olderThanMs) {
        result.kept.push({
          path: filePath,
          kind: "traceFile",
          reason: `mtime newer than ${olderThanMs}ms`,
        });
        continue;
      }

      result.deleted.push({
        path: filePath,
        kind: "traceFile",
        reason: `mtime older than ${olderThanMs}ms`,
      });
      if (!dryRun) {
        await rm(filePath, { force: true });
      }
    } catch (err) {
      result.errors.push({
        path: filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await removeEmptyTraceDir(traceDir, dryRun, result);
}

async function removeEmptyTraceDir(
  traceDir: string,
  dryRun: boolean,
  result: CleanupEvalArtifactsResult,
): Promise<void> {
  try {
    const remaining = await readdir(traceDir);
    if (remaining.length > 0) {
      return;
    }
    result.deleted.push({
      path: traceDir,
      kind: "directory",
      reason: `${basename(traceDir)} is empty after trace cleanup`,
    });
    if (!dryRun) {
      await rm(traceDir, { recursive: true, force: true });
    }
  } catch (err) {
    result.errors.push({
      path: traceDir,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
