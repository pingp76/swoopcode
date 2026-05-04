/**
 * memory.test.ts — MemoryManager 测试
 *
 * 覆盖：name 校验、frontmatter 解析/序列化、create/list/read/delete、
 * 索引重建、buildPromptSection。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createMemoryManager,
  isValidName,
  isValidType,
  serializeMemory,
  parseMemoryFile,
} from "./memory.js";
import type { MemoryEntry } from "./memory.js";
import { createLogger } from "./logger.js";

// 创建测试用 logger（静默模式，不干扰测试输出）
const logger = createLogger("error");

// ============================================================================
// 辅助函数
// ============================================================================

/** 创建临时 memory 目录 */
let tempDir: string;

function setupTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "memory-test-"));
  return tempDir;
}

function cleanupTempDir(): void {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

/** 创建一条测试用的 memory 文件 */
function writeMemoryFile(dir: string, name: string, content: string): void {
  writeFileSync(join(dir, `${name}.md`), content, "utf-8");
}

/** 生成合法的 memory 文件内容 */
function makeMemoryContent(overrides: {
  name?: string;
  description?: string;
  type?: string;
  createdAt?: string;
  updatedAt?: string;
  body?: string;
}): string {
  return [
    "---",
    `name: ${overrides.name ?? "test-memory"}`,
    `description: ${overrides.description ?? "A test memory"}`,
    `type: ${overrides.type ?? "user"}`,
    `createdAt: ${overrides.createdAt ?? "2026-04-30T12:00:00.000Z"}`,
    `updatedAt: ${overrides.updatedAt ?? "2026-04-30T12:00:00.000Z"}`,
    "---",
    overrides.body ?? "This is the body.",
  ].join("\n");
}

// ============================================================================
// isValidName 测试
// ============================================================================

describe("isValidName", () => {
  it("accepts valid names", () => {
    expect(isValidName("prefer_concise")).toBe(true);
    expect(isValidName("verify-123")).toBe(true);
    expect(isValidName("abc")).toBe(true);
    expect(isValidName("a-b_c")).toBe(true);
  });

  it("rejects uppercase letters", () => {
    expect(isValidName("UPPERCASE")).toBe(false);
  });

  it("rejects spaces", () => {
    expect(isValidName("has spaces")).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(isValidName("../path")).toBe(false);
    expect(isValidName("a/b")).toBe(false);
  });

  it("rejects empty string", () => {
    expect(isValidName("")).toBe(false);
  });

  it("rejects dots", () => {
    expect(isValidName("has.dot")).toBe(false);
  });
});

// ============================================================================
// isValidType 测试
// ============================================================================

describe("isValidType", () => {
  it("accepts valid types", () => {
    expect(isValidType("user")).toBe(true);
    expect(isValidType("feedback")).toBe(true);
    expect(isValidType("project")).toBe(true);
    expect(isValidType("reference")).toBe(true);
  });

  it("rejects invalid types", () => {
    expect(isValidType("invalid")).toBe(false);
    expect(isValidType("")).toBe(false);
    expect(isValidType("User")).toBe(false);
  });
});

// ============================================================================
// parseMemoryFile 测试
// ============================================================================

describe("parseMemoryFile", () => {
  it("parses valid frontmatter", () => {
    const content = makeMemoryContent({
      name: "test",
      description: "desc",
      type: "user",
      body: "body text",
    });
    const result = parseMemoryFile(content, "test.md", logger);
    expect(result).not.toBeNull();
    expect(result!.meta.name).toBe("test");
    expect(result!.meta.description).toBe("desc");
    expect(result!.meta.type).toBe("user");
    expect(result!.body).toBe("body text");
  });

  it("returns null for missing required field", () => {
    // 缺少 type 字段
    const content = [
      "---",
      "name: test",
      "description: desc",
      "createdAt: 2026-04-30T12:00:00.000Z",
      "updatedAt: 2026-04-30T12:00:00.000Z",
      "---",
      "body",
    ].join("\n");
    const result = parseMemoryFile(content, "test.md", logger);
    expect(result).toBeNull();
  });

  it("returns null for invalid type", () => {
    const content = makeMemoryContent({ type: "invalid" });
    const result = parseMemoryFile(content, "test.md", logger);
    expect(result).toBeNull();
  });

  it("returns null for no frontmatter", () => {
    const result = parseMemoryFile("no frontmatter here", "test.md", logger);
    expect(result).toBeNull();
  });
});

// ============================================================================
// serializeMemory 测试
// ============================================================================

describe("serializeMemory", () => {
  it("produces valid frontmatter format", () => {
    const entry: MemoryEntry = {
      meta: {
        name: "test",
        description: "A test",
        type: "user",
        createdAt: "2026-04-30T12:00:00.000Z",
        updatedAt: "2026-04-30T12:00:00.000Z",
      },
      body: "Hello world",
    };
    const serialized = serializeMemory(entry);
    expect(serialized).toContain("name: test");
    expect(serialized).toContain("description: A test");
    expect(serialized).toContain("type: user");
    expect(serialized).toContain("Hello world");

    // 验证可以被 parseMemoryFile 解析回来
    const parsed = parseMemoryFile(serialized, "test.md", logger);
    expect(parsed).not.toBeNull();
    expect(parsed!.meta.name).toBe("test");
    expect(parsed!.body).toBe("Hello world");
  });
});

// ============================================================================
// MemoryManager 测试
// ============================================================================

describe("MemoryManager", () => {
  beforeEach(() => {
    setupTempDir();
  });

  afterEach(() => {
    cleanupTempDir();
  });

  // ── scan ──

  describe("scan", () => {
    it("returns valid entries from memory dir", () => {
      writeMemoryFile(
        tempDir,
        "pref-a",
        makeMemoryContent({ name: "pref-a", type: "user" }),
      );
      writeMemoryFile(
        tempDir,
        "note-b",
        makeMemoryContent({ name: "note-b", type: "feedback" }),
      );

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      const entries = manager.scan();

      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.meta.name)).toContain("pref-a");
      expect(entries.map((e) => e.meta.name)).toContain("note-b");
    });

    it("skips MEMORY.md index file", () => {
      writeFileSync(join(tempDir, "MEMORY.md"), "# Index\n", "utf-8");
      writeMemoryFile(tempDir, "test", makeMemoryContent({ name: "test" }));

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      const entries = manager.scan();

      expect(entries).toHaveLength(1);
      expect(entries[0]!.meta.name).toBe("test");
    });

    it("skips invalid files", () => {
      // 无效文件：缺少必填字段
      writeMemoryFile(tempDir, "bad", "---\nname: test\n---\nbody");

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      const entries = manager.scan();

      expect(entries).toHaveLength(0);
    });

    it("skips files where frontmatter name does not match file name", () => {
      // 文件名是 mismatch.md，但 frontmatter name 是 other-name
      writeMemoryFile(
        tempDir,
        "mismatch",
        makeMemoryContent({ name: "other-name" }),
      );

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      const entries = manager.scan();

      expect(entries).toHaveLength(0);
    });

    it("skips files where frontmatter name has invalid format", () => {
      // frontmatter name 包含大写字母
      const content = makeMemoryContent({ name: "Invalid-Name" });
      writeMemoryFile(tempDir, "invalid-name", content);

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      const entries = manager.scan();

      expect(entries).toHaveLength(0);
    });

    it("returns empty for nonexistent directory", () => {
      const nonexistent = join(tempDir, "no-such-dir");
      const manager = createMemoryManager({ memoryDir: nonexistent, logger });
      const entries = manager.scan();

      expect(entries).toHaveLength(0);
    });
  });

  // ── list ──

  describe("list", () => {
    it("returns sorted meta list", () => {
      writeMemoryFile(
        tempDir,
        "z-item",
        makeMemoryContent({ name: "z-item", type: "user" }),
      );
      writeMemoryFile(
        tempDir,
        "a-item",
        makeMemoryContent({ name: "a-item", type: "feedback" }),
      );

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      const list = manager.list();

      // 先按 type 排序（feedback < user），再按 name
      expect(list).toHaveLength(2);
      expect(list[0]!.name).toBe("a-item"); // feedback 排在 user 前面
      expect(list[1]!.name).toBe("z-item");
    });

    it("returns only meta, not body", () => {
      writeMemoryFile(
        tempDir,
        "test",
        makeMemoryContent({ name: "test", body: "secret body" }),
      );

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      const list = manager.list();

      expect(list).toHaveLength(1);
      expect(list[0]!.name).toBe("test");
      // list 返回的是 MemoryMeta，没有 body 字段
      expect(
        (list[0] as unknown as Record<string, unknown>)["body"],
      ).toBeUndefined();
    });
  });

  // ── read ──

  describe("read", () => {
    it("returns full entry for existing memory", () => {
      writeMemoryFile(
        tempDir,
        "test",
        makeMemoryContent({
          name: "test",
          description: "full desc",
          body: "full body content",
        }),
      );

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      const entry = manager.read("test");

      expect(entry).not.toBeNull();
      expect(entry!.meta.name).toBe("test");
      expect(entry!.meta.description).toBe("full desc");
      expect(entry!.body).toBe("full body content");
    });

    it("returns null for nonexistent", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      expect(manager.read("nonexistent")).toBeNull();
    });

    it("returns null for invalid name", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      expect(manager.read("../traversal")).toBeNull();
      expect(manager.read("")).toBeNull();
    });
  });

  // ── create ──

  describe("create", () => {
    it("creates file and returns entry", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();

      const entry = manager.create({
        name: "new-memory",
        description: "A new memory",
        type: "user",
        body: "Content here",
      });

      expect(entry.meta.name).toBe("new-memory");
      expect(entry.meta.description).toBe("A new memory");
      expect(entry.meta.type).toBe("user");
      expect(entry.body).toBe("Content here");
      expect(entry.meta.createdAt).toBe(entry.meta.updatedAt);

      // 文件已创建
      expect(existsSync(join(tempDir, "new-memory.md"))).toBe(true);
    });

    it("rejects invalid name", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      expect(() =>
        manager.create({
          name: "INVALID",
          description: "test",
          type: "user",
          body: "test",
        }),
      ).toThrow("Invalid memory name");
    });

    it("rejects invalid type", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      expect(() =>
        manager.create({
          name: "test",
          description: "test",
          type: "invalid" as "user",
          body: "test",
        }),
      ).toThrow("Invalid memory type");
    });

    it("rejects description with line breaks", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      expect(() =>
        manager.create({
          name: "test",
          description: "line1\nline2",
          type: "user",
          body: "test",
        }),
      ).toThrow("line breaks");
    });

    it("rebuilds MEMORY.md after create", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();

      manager.create({
        name: "test",
        description: "Test memory",
        type: "user",
        body: "content",
      });

      const indexPath = join(tempDir, "MEMORY.md");
      expect(existsSync(indexPath)).toBe(true);

      const indexContent = readFileSync(indexPath, "utf-8");
      expect(indexContent).toContain("test");
      expect(indexContent).toContain("Test memory");
    });

    it("overwrite preserves createdAt, updates updatedAt", async () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();

      // 第一次创建
      const first = manager.create({
        name: "test",
        description: "First version",
        type: "user",
        body: "v1",
      });
      const originalCreatedAt = first.meta.createdAt;

      // 等一小段时间确保 updatedAt 不同
      await new Promise((resolve) => setTimeout(resolve, 10));

      // 覆盖更新
      const second = manager.create({
        name: "test",
        description: "Second version",
        type: "feedback",
        body: "v2",
      });

      expect(second.meta.createdAt).toBe(originalCreatedAt);
      expect(second.meta.updatedAt).not.toBe(originalCreatedAt);
      expect(second.meta.description).toBe("Second version");
      expect(second.body).toBe("v2");
    });
  });

  // ── delete ──

  describe("findSimilar", () => {
    it("finds memory with the same description", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      manager.create({
        name: "prefer-concise",
        description: "User prefers concise answers",
        type: "user",
        body: "The user likes short replies.",
      });

      const similar = manager.findSimilar({
        name: "short-answers",
        description: "User prefers concise answers",
        type: "user",
        body: "The user likes brief responses.",
      });

      expect(similar).toHaveLength(1);
      expect(similar[0]!.entry.meta.name).toBe("prefer-concise");
      expect(similar[0]!.reason).toBe("same description");
    });

    it("does not treat the same name as a duplicate because create will update it", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      manager.create({
        name: "prefer-concise",
        description: "User prefers concise answers",
        type: "user",
        body: "The user likes short replies.",
      });

      const similar = manager.findSimilar({
        name: "prefer-concise",
        description: "User prefers concise answers",
        type: "user",
        body: "The user likes short replies.",
      });

      expect(similar).toHaveLength(0);
    });
  });

  // ── delete ──

  describe("delete", () => {
    it("deletes file and returns true", () => {
      writeMemoryFile(tempDir, "test", makeMemoryContent({ name: "test" }));

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();

      expect(manager.delete("test")).toBe(true);
      expect(existsSync(join(tempDir, "test.md"))).toBe(false);
    });

    it("returns false for nonexistent", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      expect(manager.delete("nonexistent")).toBe(false);
    });

    it("returns false for invalid name", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      expect(manager.delete("../traversal")).toBe(false);
    });

    it("rebuilds index after delete", () => {
      writeMemoryFile(tempDir, "a", makeMemoryContent({ name: "a" }));
      writeMemoryFile(tempDir, "b", makeMemoryContent({ name: "b" }));

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();

      manager.delete("a");

      const indexContent = readFileSync(join(tempDir, "MEMORY.md"), "utf-8");
      expect(indexContent).not.toContain("name: a");
      expect(indexContent).toContain("b");
    });
  });

  // ── buildPromptSection ──

  describe("buildPromptSection", () => {
    it("returns null when empty", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      expect(manager.buildPromptSection()).toBeNull();
    });

    it("returns formatted string with entries", () => {
      writeMemoryFile(
        tempDir,
        "pref",
        makeMemoryContent({
          name: "pref",
          description: "User prefers concise answers",
          type: "user",
        }),
      );
      writeMemoryFile(
        tempDir,
        "verify",
        makeMemoryContent({
          name: "verify",
          description: "Always verify before concluding",
          type: "feedback",
        }),
      );

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();

      const section = manager.buildPromptSection();
      expect(section).not.toBeNull();
      expect(section!).toContain(
        "[feedback] verify: Always verify before concluding",
      );
      expect(section!).toContain("[user] pref: User prefers concise answers");
      expect(section!).toContain("Use memory as a hint, not as proof");
    });
  });

  // ── rebuildIndex ──

  describe("rebuildIndex", () => {
    it("generates MEMORY.md with all entries", () => {
      writeMemoryFile(
        tempDir,
        "a",
        makeMemoryContent({ name: "a", description: "desc a" }),
      );
      writeMemoryFile(
        tempDir,
        "b",
        makeMemoryContent({ name: "b", description: "desc b" }),
      );

      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      manager.scan();
      manager.rebuildIndex();

      const indexContent = readFileSync(join(tempDir, "MEMORY.md"), "utf-8");
      expect(indexContent).toContain("a: desc a");
      expect(indexContent).toContain("b: desc b");
    });
  });

  // ── getMemoryDir ──

  describe("getMemoryDir", () => {
    it("returns the configured directory", () => {
      const manager = createMemoryManager({ memoryDir: tempDir, logger });
      expect(manager.getMemoryDir()).toBe(tempDir);
    });
  });
});
