/**
 * temp-cleanup.test.ts — Eval 临时产物清理器测试
 *
 * 这些测试的重点不是“rm 能不能工作”，而是验证清理边界：
 * - 只删除白名单 eval 目录
 * - manifest 优先于 mtime
 * - trace 只删除旧 trace JSON
 * - dry-run 不产生真实删除
 */

import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupEvalArtifacts,
  parseEvalCleanupDuration,
  writeEvalArtifactManifest,
} from "./temp-cleanup.js";

describe("cleanupEvalArtifacts", () => {
  const roots: string[] = [];
  const baseNow = new Date("2026-06-12T00:00:00.000Z");
  const sevenDays = parseEvalCleanupDuration("7d");

  afterEach(async () => {
    const pending = roots.splice(0);
    await Promise.all(
      pending.map((root) => rm(root, { recursive: true, force: true })),
    );
  });

  it("removes only old directories with eval whitelist prefixes", async () => {
    const root = await createRoot();
    const oldEval = join(root, "eval-old-case");
    const youngEval = join(root, "eval-young-case");
    const unrelated = join(root, "project-cache-old");
    await mkdir(oldEval);
    await mkdir(youngEval);
    await mkdir(unrelated);
    await touchMtime(oldEval, new Date(baseNow.getTime() - sevenDays - 1000));
    await touchMtime(youngEval, baseNow);
    await touchMtime(unrelated, new Date(baseNow.getTime() - sevenDays - 1000));

    const result = await cleanupEvalArtifacts({
      rootDir: root,
      olderThanMs: sevenDays,
      now: baseNow,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.deleted.map((entry) => entry.path)).toContain(oldEval);
    expect(existsSync(oldEval)).toBe(false);
    expect(existsSync(youngEval)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  it("uses manifest expiresAt before falling back to mtime", async () => {
    const root = await createRoot();
    const expiredHome = join(root, "learn-claude-eval-home-expired");
    const activeHome = join(root, "learn-claude-eval-home-active");
    await mkdir(expiredHome);
    await mkdir(activeHome);
    await writeEvalArtifactManifest(expiredHome, {
      caseId: "expired-case",
      kind: "agentHome",
      now: new Date(baseNow.getTime() - 2 * sevenDays),
      ttlMs: sevenDays,
    });
    await writeEvalArtifactManifest(activeHome, {
      caseId: "active-case",
      kind: "agentHome",
      now: baseNow,
      ttlMs: sevenDays,
    });

    const result = await cleanupEvalArtifacts({
      rootDir: root,
      olderThanMs: sevenDays,
      now: baseNow,
    });

    expect(result.errors).toHaveLength(0);
    expect(existsSync(expiredHome)).toBe(false);
    expect(existsSync(activeHome)).toBe(true);
  });

  it("removes old trace JSON files without touching unrelated trace files", async () => {
    const root = await createRoot();
    const traceDir = join(root, "eval-traces");
    const oldTrace = join(traceDir, "case-a.trace.json");
    const youngTrace = join(traceDir, "case-b.trace.json");
    const note = join(traceDir, "notes.txt");
    await mkdir(traceDir);
    await writeFile(oldTrace, "{}", "utf-8");
    await writeFile(youngTrace, "{}", "utf-8");
    await writeFile(note, "keep", "utf-8");
    await touchMtime(oldTrace, new Date(baseNow.getTime() - sevenDays - 1000));
    await touchMtime(youngTrace, baseNow);
    await touchMtime(note, new Date(baseNow.getTime() - sevenDays - 1000));

    const result = await cleanupEvalArtifacts({
      rootDir: root,
      olderThanMs: sevenDays,
      now: baseNow,
    });

    expect(result.errors).toHaveLength(0);
    expect(result.deleted.map((entry) => entry.path)).toContain(oldTrace);
    expect(existsSync(oldTrace)).toBe(false);
    expect(existsSync(youngTrace)).toBe(true);
    expect(existsSync(note)).toBe(true);
  });

  it("reports deletions in dry-run mode without removing files", async () => {
    const root = await createRoot();
    const oldEval = join(root, "eval-dry-run-case");
    await mkdir(oldEval);
    await touchMtime(oldEval, new Date(baseNow.getTime() - sevenDays - 1000));

    const result = await cleanupEvalArtifacts({
      rootDir: root,
      olderThanMs: sevenDays,
      now: baseNow,
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.deleted.map((entry) => entry.path)).toContain(oldEval);
    expect(existsSync(oldEval)).toBe(true);
  });

  async function createRoot(): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "eval-cleanup-test-"));
    roots.push(root);
    return root;
  }

  async function touchMtime(path: string, time: Date): Promise<void> {
    await utimes(path, time, time);
  }
});
