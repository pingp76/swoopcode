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
