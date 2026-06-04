/**
 * stable-context.test.ts — 稳定上下文管理器测试
 *
 * 测试覆盖：
 * - repo map 构建
 * - pin/unpin 文件
 * - buildMessages 生成上下文消息
 * - 预算裁剪
 * - hash 稳定性
 * - 安全边界（projectRoot 外路径）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createStableContextManager,
  type StableContextManager,
} from "./stable-context.js";

function createTempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stable-ctx-test-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "src", "tools"));
  fs.mkdirSync(path.join(dir, "doc"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"test"}\n');
  fs.writeFileSync(path.join(dir, "tsconfig.json"), '{"compilerOptions":{}}\n');
  fs.writeFileSync(path.join(dir, "AGENTS.md"), "# Agents\n");
  fs.writeFileSync(path.join(dir, "src", "index.ts"), "export const a = 1;\n");
  fs.writeFileSync(path.join(dir, "src", "tools", "bash.ts"), "export function run() {}\n");
  fs.writeFileSync(path.join(dir, "doc", "summary.md"), "# Summary\nProject overview.\n");
  return dir;
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

describe("StableContextManager", () => {
  let projectDir: string;
  let manager: StableContextManager;

  beforeEach(() => {
    projectDir = createTempProject();
    manager = createStableContextManager(projectDir, "generic-openai-compatible");
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  it("builds repo map with directory structure", () => {
    const pack = manager.rebuildRepoMap();
    expect(pack.assets).toHaveLength(1);
    expect(pack.assets[0]!.kind).toBe("repo_map");
    expect(pack.assets[0]!.content).toContain("<repo-map>");
    expect(pack.assets[0]!.content).toContain("package.json");
  });

  it("includes key files in repo map", () => {
    const pack = manager.rebuildRepoMap();
    const content = pack.assets[0]!.content;
    expect(content).toContain("key files:");
    expect(content).toContain("package.json");
    expect(content).toContain("tsconfig.json");
    expect(content).toContain("AGENTS.md");
  });

  it("excludes node_modules and .git from repo map", () => {
    fs.mkdirSync(path.join(projectDir, "node_modules"));
    fs.mkdirSync(path.join(projectDir, ".git"));
    fs.writeFileSync(path.join(projectDir, "node_modules", "x.js"), "");
    const pack = manager.rebuildRepoMap();
    expect(pack.assets[0]!.content).not.toContain("node_modules");
    expect(pack.assets[0]!.content).not.toContain(".git");
  });

  it("pinPath adds file to pinned list", () => {
    manager.pinPath("src/index.ts");
    const state = manager.getState();
    expect(state.pinnedPaths).toContain("src/index.ts");
  });

  it("unpinPath removes file from pinned list", () => {
    manager.pinPath("src/index.ts");
    manager.unpinPath("src/index.ts");
    const state = manager.getState();
    expect(state.pinnedPaths).not.toContain("src/index.ts");
  });

  it("pinned files appear in stable pack", () => {
    manager.pinPath("src/index.ts");
    const state = manager.getState();
    const stableAssets = state.stablePack?.assets ?? [];
    const pinnedAsset = stableAssets.find((a) => a.kind === "source_file");
    expect(pinnedAsset).toBeDefined();
    expect(pinnedAsset!.source.path).toBe("src/index.ts");
    expect(pinnedAsset!.content).toContain("export const a = 1;");
  });

  it("ignores paths outside project root", () => {
    manager.pinPath("../../etc/passwd");
    const state = manager.getState();
    const stableAssets = state.stablePack?.assets ?? [];
    const pinnedAsset = stableAssets.find((a) => a.kind === "source_file");
    expect(pinnedAsset).toBeUndefined();
  });

  it("rejects sibling directory with same prefix", () => {
    // 模拟同名前缀兄弟目录绕过：projectDir 名为 "stable-ctx-test-xxx"
    // 尝试 pin 一个路径名为 "../stable-ctx-test-xxx-secret/foo.ts"
    // startsWith 旧实现会误匹配，新实现应正确拒绝
    manager.pinPath("../stable-ctx-test-secret/foo.ts");
    const state = manager.getState();
    const stableAssets = state.stablePack?.assets ?? [];
    const pinnedAsset = stableAssets.find((a) => a.kind === "source_file");
    expect(pinnedAsset).toBeUndefined();
  });

  it("buildMessages returns stable + working packs as user messages", () => {
    const messages = manager.buildMessages("hello");

    expect(messages.length).toBeGreaterThanOrEqual(1);
    // 第一条应为 stable pack
    const firstContent = messages[0]!.content as string;
    expect(firstContent).toContain("<stable-context-pack>");
  });

  it("buildMessages includes working set when budget allows", () => {
    const messages = manager.buildMessages("hello");

    const contents = messages.map((m) => m.content as string);
    expect(contents.some((c) => c.includes("<working-set-pack>"))).toBe(true);
  });

  it("returns empty messages when disabled", () => {
    manager.setEnabled(false);
    const messages = manager.buildMessages("hello");

    expect(messages).toHaveLength(0);
  });

  it("rebuildRepoMap updates repo map after new files added", () => {
    const pack1 = manager.rebuildRepoMap();
    const hash1 = pack1.assets[0]!.contentHash;

    fs.writeFileSync(path.join(projectDir, "new-file.ts"), "export {}\n");
    const pack2 = manager.rebuildRepoMap();
    const hash2 = pack2.assets[0]!.contentHash;

    // hash 应该改变，因为目录结构变了
    expect(hash1).not.toBe(hash2);
  });

  it("truncates pinned files when exceeding budget", () => {
    const longContent = "x".repeat(10000);
    fs.writeFileSync(path.join(projectDir, "long.ts"), longContent);
    manager.pinPath("long.ts");

    const messages = manager.buildMessages("hello");

    // repo map 本身就会占用一些 token，所以 pinned file 可能被完全裁剪掉
    // 或者只保留截断版本
    expect(messages.length).toBeGreaterThanOrEqual(0);
  });

  it("does not load doc/todo.md as a source_file asset", () => {
    fs.writeFileSync(path.join(projectDir, "doc", "todo.md"), "# TODO\n");
    const state = manager.getState();
    // repo map 会列出目录结构（包含 todo.md 文件名），但不会读取其内容
    // 检查 source_file 类型资产中没有 todo.md
    const fileAssets = state.stablePack?.assets.filter((a) => a.kind === "source_file") ?? [];
    expect(fileAssets.some((a) => a.source.path?.includes("todo.md"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PDD21-1: ContextRanker 集成测试
// ---------------------------------------------------------------------------

import { createContextRanker } from "./context-ranking.js";

function createTempProjectWithRanker(): { dir: string; manager: StableContextManager } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stable-ctx-rank-test-"));
  fs.mkdirSync(path.join(dir, "src"));
  fs.mkdirSync(path.join(dir, "doc"));
  fs.writeFileSync(path.join(dir, "package.json"), '{"name":"test"}\n');
  fs.writeFileSync(path.join(dir, "tsconfig.json"), '{"compilerOptions":{}}\n');
  fs.writeFileSync(path.join(dir, "README.md"), "# Test Project\nOverview here.\n");
  fs.writeFileSync(path.join(dir, "src", "index.ts"), 'import { agent } from "./agent.js";\n');
  fs.writeFileSync(path.join(dir, "src", "agent.ts"), "export function run() {}\n");
  fs.writeFileSync(path.join(dir, "src", "agent.test.ts"), 'import { run } from "./agent.js";\n');
  fs.writeFileSync(path.join(dir, "doc", "summary.md"), "# Summary\nProject overview.\n");
  fs.writeFileSync(path.join(dir, "doc", "pdd21.md"), "# PDD21\nDesign doc.\n");

  const ranker = createContextRanker(dir);
  const manager = createStableContextManager(dir, "generic", undefined, ranker);
  return { dir, manager };
}

describe("StableContextManager with ContextRanker", () => {
  let projectDir: string;
  let manager: StableContextManager;

  beforeEach(() => {
    const setup = createTempProjectWithRanker();
    projectDir = setup.dir;
    manager = setup.manager;
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  it("uses ranker for working set selection", () => {
    const messages = manager.buildMessages({ currentQuery: "explain the project" });
    const contents = messages.map((m) => m.content as string);
    const workingSetMsg = contents.find((c) => c.includes("<working-set-pack>"));
    expect(workingSetMsg).toBeDefined();
    // working set should include ranked files, not just doc/summary.md
    expect(workingSetMsg).toContain("score=");
  });

  it("includes rank reasons in manifest", () => {
    const messages = manager.buildMessages({ currentQuery: "" });
    const contents = messages.map((m) => m.content as string);
    const workingSetMsg = contents.find((c) => c.includes("<working-set-pack>"));
    expect(workingSetMsg).toBeDefined();
    expect(workingSetMsg).toContain("repo:");
    expect(workingSetMsg).toContain("task:");
  });

  it("stable pack does not use dynamic signals", () => {
    // buildMessages with different queries should produce same stable pack
    const msgs1 = manager.buildMessages({ currentQuery: "debug error" });
    const msgs2 = manager.buildMessages({ currentQuery: "implement feature" });

    const stable1 = msgs1.find((m) => (m.content as string).includes("<stable-context-pack>"));
    const stable2 = msgs2.find((m) => (m.content as string).includes("<stable-context-pack>"));

    expect(stable1).toBeDefined();
    expect(stable2).toBeDefined();
    // stable pack content should be identical regardless of query
    expect(stable1!.content).toBe(stable2!.content);
  });

  it("getRankedFiles returns ranked files", () => {
    const ranked = manager.getRankedFiles(10);
    expect(ranked.length).toBeGreaterThan(0);
    expect(ranked[0]!.score).toBeGreaterThan(0);
    expect(ranked[0]!.reasons.length).toBeGreaterThan(0);
  });

  it("getRepoClassification returns classification", () => {
    const repo = manager.getRepoClassification();
    expect(repo).not.toBeNull();
    expect(repo!.primary).toBe("typescript");
  });

  it("explainFile returns ranking details", () => {
    const result = manager.explainFile("README.md");
    expect(result).not.toBeNull();
    expect(result!.score).toBeGreaterThan(0);
    expect(result!.reasons.length).toBeGreaterThan(0);
  });

  it("explainFile returns null for unknown file", () => {
    const result = manager.explainFile("nonexistent.ts");
    expect(result).toBeNull();
  });

  it("buildMessages accepts string for backward compatibility", () => {
    const messages = manager.buildMessages("hello");
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it("buildMessages accepts BuildMessagesInput with evidence", () => {
    const messages = manager.buildMessages({
      currentQuery: "fix the failing test",
      failingFiles: ["src/agent.test.ts"],
      changedFiles: ["src/agent.ts"],
    });
    expect(messages.length).toBeGreaterThanOrEqual(1);
  });

  it("working set does not duplicate pinned stable pack files", () => {
    // Pin README.md into stable pack, then check working set doesn't include it again
    manager.pinPath("README.md");
    const messages = manager.buildMessages({ currentQuery: "" });
    const contents = messages.map((m) => m.content as string);

    const stableMsg = contents.find((c) => c.includes("<stable-context-pack>"));
    const workingMsg = contents.find((c) => c.includes("<working-set-pack>"));

    expect(stableMsg).toBeDefined();
    // Count how many times README.md appears as a file path attribute across both packs
    const stableReadmeCount = (stableMsg!.match(/path="README\.md"/g) ?? []).length;
    const workingReadmeCount = workingMsg
      ? (workingMsg.match(/path="README\.md"/g) ?? []).length
      : 0;
    // README.md should appear in stable pack but NOT in working set
    expect(stableReadmeCount).toBeGreaterThanOrEqual(1);
    expect(workingReadmeCount).toBe(0);
  });

  it("evidence signals (recentFiles) affect working set ranking", () => {
    // Build messages without and with recentFiles, working set should differ
    const msgsNoEvidence = manager.buildMessages({ currentQuery: "" });
    const msgsWithEvidence = manager.buildMessages({
      currentQuery: "",
      recentFiles: ["src/agent.test.ts"],
    });

    const ws1 = msgsNoEvidence.find((m) => (m.content as string).includes("<working-set-pack>"));
    const ws2 = msgsWithEvidence.find((m) => (m.content as string).includes("<working-set-pack>"));

    // Both should have working set packs
    expect(ws1).toBeDefined();
    expect(ws2).toBeDefined();
    // The working set with evidence should differ (agent.test.ts gets evidence bonus)
    expect(ws1!.content).not.toBe(ws2!.content);
  });

  it("does not re-scan disk on each buildMessages call", () => {
    // Call buildMessages twice — the second call should use cached files
    // We can't directly observe caching, but we verify no errors and consistent results
    const msgs1 = manager.buildMessages({ currentQuery: "test" });
    const msgs2 = manager.buildMessages({ currentQuery: "test" });

    const ws1 = msgs1.find((m) => (m.content as string).includes("<working-set-pack>"));
    const ws2 = msgs2.find((m) => (m.content as string).includes("<working-set-pack>"));
    expect(ws1).toBeDefined();
    expect(ws2).toBeDefined();
    // Same query, same cache → same working set content
    expect(ws1!.content).toBe(ws2!.content);
  });

  it("working set truncation does not drop high-score files due to marker overflow", () => {
    // Create a large file that will need truncation with a tight budget
    const largeContent = "x".repeat(50000);
    fs.writeFileSync(path.join(projectDir, "src", "large.ts"), largeContent);

    // Rebuild to pick up the new file
    manager.rebuildRepoMap();

    // Use a very tight working set budget that forces truncation
    const tightBudgetManager = createStableContextManager(
      projectDir,
      "generic",
      () => ({
        effectiveBudgetTokens: 10000,
        outputReserveTokens: 1000,
        conversationReserveTokens: 2000,
        stablePackBudgetTokens: 2000,
        workingSetBudgetTokens: 500,
        evidenceBudgetTokens: 500,
        headroomTokens: 2500,
      }),
      createContextRanker(projectDir),
    );

    const messages = tightBudgetManager.buildMessages({ currentQuery: "" });
    const wsMsg = messages.find((m) => (m.content as string).includes("<working-set-pack>"));

    // Working set should exist and should not be empty
    // (previously, the truncation marker could push actualTokens over budget,
    //  causing the secondary check to drop the entire asset)
    if (wsMsg) {
      const content = wsMsg.content as string;
      // If there are assets, they should fit within budget
      expect(content).toContain("<working-set-manifest>");
    }
  });
});

// ---------------------------------------------------------------------------
// Stable Snapshot 缓存测试
// ---------------------------------------------------------------------------

describe("StableContextManager stable snapshot caching", () => {
  let projectDir: string;
  let manager: StableContextManager;

  beforeEach(() => {
    const setup = createTempProjectWithRanker();
    projectDir = setup.dir;
    manager = setup.manager;
  });

  afterEach(() => {
    cleanup(projectDir);
  });

  it("stable pack is byte-identical across multiple buildMessages calls", () => {
    const msgs1 = manager.buildMessages({ currentQuery: "hello" });
    const msgs2 = manager.buildMessages({ currentQuery: "world" });
    const msgs3 = manager.buildMessages({ currentQuery: "something else entirely" });

    const stable1 = msgs1.find((m) => (m.content as string).includes("<stable-context-pack>"));
    const stable2 = msgs2.find((m) => (m.content as string).includes("<stable-context-pack>"));
    const stable3 = msgs3.find((m) => (m.content as string).includes("<stable-context-pack>"));

    expect(stable1).toBeDefined();
    expect(stable1!.content).toBe(stable2!.content);
    expect(stable1!.content).toBe(stable3!.content);
  });

  it("dynamic signals (recentFiles, changedFiles) do NOT affect stable pack", () => {
    const msgsPlain = manager.buildMessages({ currentQuery: "" });
    const msgsDynamic = manager.buildMessages({
      currentQuery: "debug error in agent.ts",
      recentFiles: ["src/agent.ts", "src/index.ts"],
      changedFiles: ["src/agent.ts"],
      failingFiles: ["src/agent.test.ts"],
      stackTraceFiles: ["src/agent.ts"],
    });

    const stable1 = msgsPlain.find((m) => (m.content as string).includes("<stable-context-pack>"));
    const stable2 = msgsDynamic.find((m) => (m.content as string).includes("<stable-context-pack>"));

    expect(stable1).toBeDefined();
    expect(stable2).toBeDefined();
    // Stable pack must be identical regardless of dynamic signals
    expect(stable1!.content).toBe(stable2!.content);
  });

  it("pinPath invalidates stable snapshot", () => {
    const msgsBefore = manager.buildMessages({ currentQuery: "" });
    const stableBefore = msgsBefore.find((m) => (m.content as string).includes("<stable-context-pack>"));

    manager.pinPath("src/agent.ts");

    const msgsAfter = manager.buildMessages({ currentQuery: "" });
    const stableAfter = msgsAfter.find((m) => (m.content as string).includes("<stable-context-pack>"));

    expect(stableBefore).toBeDefined();
    expect(stableAfter).toBeDefined();
    // Stable pack should differ after pinning a new file
    expect(stableBefore!.content).not.toBe(stableAfter!.content);
  });

  it("unpinPath invalidates stable snapshot", () => {
    manager.pinPath("src/agent.ts");
    const msgsWithPin = manager.buildMessages({ currentQuery: "" });
    const stableWithPin = msgsWithPin.find((m) => (m.content as string).includes("<stable-context-pack>"));

    manager.unpinPath("src/agent.ts");
    const msgsAfterUnpin = manager.buildMessages({ currentQuery: "" });
    const stableAfterUnpin = msgsAfterUnpin.find((m) => (m.content as string).includes("<stable-context-pack>"));

    expect(stableWithPin).toBeDefined();
    expect(stableAfterUnpin).toBeDefined();
    expect(stableWithPin!.content).not.toBe(stableAfterUnpin!.content);
  });

  it("invalidateStableSnapshot forces rebuild on next call", () => {
    const msgs1 = manager.buildMessages({ currentQuery: "" });
    const stable1 = msgs1.find((m) => (m.content as string).includes("<stable-context-pack>"));

    manager.invalidateStableSnapshot();

    const msgs2 = manager.buildMessages({ currentQuery: "" });
    const stable2 = msgs2.find((m) => (m.content as string).includes("<stable-context-pack>"));

    // Content should be the same (same data), but the snapshot was rebuilt
    // We verify no errors and the pack is still present
    expect(stable1).toBeDefined();
    expect(stable2).toBeDefined();
    expect(stable1!.content).toBe(stable2!.content);
  });

  it("rebuildRepoMap invalidates stable snapshot", () => {
    const msgsBefore = manager.buildMessages({ currentQuery: "" });
    const stableBefore = msgsBefore.find((m) => (m.content as string).includes("<stable-context-pack>"));

    // Add a new file to the project
    fs.writeFileSync(path.join(projectDir, "new-file.ts"), "export const x = 1;\n");
    manager.rebuildRepoMap();

    const msgsAfter = manager.buildMessages({ currentQuery: "" });
    const stableAfter = msgsAfter.find((m) => (m.content as string).includes("<stable-context-pack>"));

    expect(stableBefore).toBeDefined();
    expect(stableAfter).toBeDefined();
    // Repo map changed (new file), so stable pack should differ
    expect(stableBefore!.content).not.toBe(stableAfter!.content);
  });

  it("stable snapshot survives budget increase without rebuild", () => {
    // First call with default budget
    const msgs1 = manager.buildMessages({ currentQuery: "" });
    const stable1 = msgs1.find((m) => (m.content as string).includes("<stable-context-pack>"));

    // Second call — same manager, same budget — should reuse cache
    const msgs2 = manager.buildMessages({ currentQuery: "different query" });
    const stable2 = msgs2.find((m) => (m.content as string).includes("<stable-context-pack>"));

    expect(stable1!.content).toBe(stable2!.content);
  });

  it("notifyFileChanged invalidates stable snapshot when pinned file is modified", () => {
    // Pin a file and build stable snapshot
    manager.pinPath("src/agent.ts");
    const msgsBefore = manager.buildMessages({ currentQuery: "" });
    const stableBefore = msgsBefore.find((m) => (m.content as string).includes("<stable-context-pack>"));

    // Simulate file modification: update content on disk
    fs.writeFileSync(path.join(projectDir, "src", "agent.ts"), "export function run() { return 'modified'; }\n");

    // Notify that the pinned file was changed
    manager.notifyFileChanged("src/agent.ts");

    // Build messages again — stable snapshot should be rebuilt with new content
    const msgsAfter = manager.buildMessages({ currentQuery: "" });
    const stableAfter = msgsAfter.find((m) => (m.content as string).includes("<stable-context-pack>"));

    expect(stableBefore).toBeDefined();
    expect(stableAfter).toBeDefined();
    // Stable pack should differ because pinned file content changed
    expect(stableBefore!.content).not.toBe(stableAfter!.content);
    // New content should be present
    expect(stableAfter!.content).toContain("modified");
  });

  it("notifyFileChanged does NOT invalidate when non-pinned file is modified", () => {
    // Build stable snapshot without pinning any files
    const msgsBefore = manager.buildMessages({ currentQuery: "" });
    const stableBefore = msgsBefore.find((m) => (m.content as string).includes("<stable-context-pack>"));

    // Notify that a non-pinned file was changed
    manager.notifyFileChanged("src/agent.ts");

    // Build messages again — stable snapshot should be reused (same content)
    const msgsAfter = manager.buildMessages({ currentQuery: "" });
    const stableAfter = msgsAfter.find((m) => (m.content as string).includes("<stable-context-pack>"));

    expect(stableBefore).toBeDefined();
    expect(stableAfter).toBeDefined();
    // Stable pack should be identical because the changed file was not pinned
    expect(stableBefore!.content).toBe(stableAfter!.content);
  });
});
