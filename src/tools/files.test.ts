/**
 * files.test.ts — 文件操作工具测试
 *
 * 测试三个文件工具（run_read、run_write、run_edit）以及路径安全检查。
 *
 * 使用 os.tmpdir() 创建临时目录作为测试工作目录，
 * 通过 baseDir 参数将路径限制在临时目录内，避免影响真实的项目文件。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isPathSafe,
  executeRead,
  executeWrite,
  executeEdit,
  executeEditExact,
} from "./files.js";

/**
 * 路径安全检查测试
 *
 * 测试 isPathSafe 能否正确拦截路径穿越攻击。
 * 注意：isPathSafe 默认使用 process.cwd() 作为基准路径，
 * 所以测试路径是相对于当前进程的工作目录来判断的。
 */
describe("isPathSafe", () => {
  it("allows paths within current working directory", () => {
    expect(isPathSafe("src/file.ts")).toBe(true);
    expect(isPathSafe("package.json")).toBe(true);
    expect(isPathSafe("./README.md")).toBe(true);
  });

  it("blocks parent directory traversal", () => {
    expect(isPathSafe("../../etc/passwd")).toBe(false);
    expect(isPathSafe("../../../etc/passwd")).toBe(false);
    expect(isPathSafe("../secret")).toBe(false);
  });

  it("blocks absolute paths outside cwd", () => {
    expect(isPathSafe("/etc/passwd")).toBe(false);
    expect(isPathSafe("/tmp/evil")).toBe(false);
  });

  it("allows paths within custom baseDir", () => {
    const tmp = tmpdir();
    expect(isPathSafe(join(tmp, "file.txt"), tmp)).toBe(true);
    expect(isPathSafe(join(tmp, "sub", "dir", "file.txt"), tmp)).toBe(true);
  });

  it("blocks paths outside custom baseDir", () => {
    const tmp = tmpdir();
    expect(isPathSafe("/etc/passwd", tmp)).toBe(false);
    expect(isPathSafe(join(tmp, "..", "etc", "passwd"), tmp)).toBe(false);
  });
});

/**
 * 文件读取测试
 */
describe("executeRead", () => {
  const testDir = join(tmpdir(), "agent-files-test-read");

  beforeEach(async () => {
    // 创建临时测试目录
    await mkdir(testDir, { recursive: true });
    // 创建测试文件
    await writeFile(join(testDir, "hello.txt"), "hello world", "utf-8");
  });

  afterEach(async () => {
    // 清理临时目录
    await rm(testDir, { recursive: true, force: true });
  });

  it("reads existing file successfully", async () => {
    const result = await executeRead(join(testDir, "hello.txt"), testDir);
    expect(result.error).toBe(false);
    expect(result.output).toBe("hello world");
  });

  it("returns error for non-existent file", async () => {
    const result = await executeRead(
      join(testDir, "no-such-file.txt"),
      testDir,
    );
    expect(result.error).toBe(true);
    expect(result.output).toContain("not found");
  });

  it("returns error for path outside working directory", async () => {
    const result = await executeRead("/etc/passwd");
    expect(result.error).toBe(true);
    expect(result.output).toContain("outside the working directory");
  });
});

/**
 * 文件写入测试
 */
describe("executeWrite", () => {
  const testDir = join(tmpdir(), "agent-files-test-write");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("writes content to a new file", async () => {
    const filePath = join(testDir, "new-file.txt");
    const result = await executeWrite(filePath, "test content", testDir);
    expect(result.error).toBe(false);
    expect(result.output).toContain("Successfully wrote");

    // 验证文件内容
    const content = await executeRead(filePath, testDir);
    expect(content.output).toBe("test content");
  });

  it("creates parent directories automatically", async () => {
    const filePath = join(testDir, "sub", "dir", "file.txt");
    const result = await executeWrite(filePath, "nested content", testDir);
    expect(result.error).toBe(false);

    const content = await executeRead(filePath, testDir);
    expect(content.output).toBe("nested content");
  });

  it("overwrites existing file", async () => {
    const filePath = join(testDir, "overwrite.txt");
    await executeWrite(filePath, "original", testDir);
    await executeWrite(filePath, "replaced", testDir);

    const content = await executeRead(filePath, testDir);
    expect(content.output).toBe("replaced");
  });

  it("returns error for path outside working directory", async () => {
    const result = await executeWrite("/tmp/evil/file.txt", "bad");
    expect(result.error).toBe(true);
    expect(result.output).toContain("outside the working directory");
  });
});

/**
 * 文件编辑测试
 */
describe("executeEdit", () => {
  const testDir = join(tmpdir(), "agent-files-test-edit");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("replaces text in file", async () => {
    const filePath = join(testDir, "edit.txt");
    await executeWrite(filePath, "hello world", testDir);

    const result = await executeEdit(filePath, "world", "TypeScript", testDir);
    expect(result.error).toBe(false);
    expect(result.output).toContain("Successfully edited");

    const content = await executeRead(filePath, testDir);
    expect(content.output).toBe("hello TypeScript");
  });

  it("replaces all occurrences (replaceAll behavior)", async () => {
    const filePath = join(testDir, "multi.txt");
    await executeWrite(filePath, "aaa bbb aaa", testDir);

    await executeEdit(filePath, "aaa", "ccc", testDir);

    const content = await executeRead(filePath, testDir);
    expect(content.output).toBe("ccc bbb ccc");
  });

  it("returns error when old_string not found", async () => {
    const filePath = join(testDir, "notfound.txt");
    await executeWrite(filePath, "hello", testDir);

    const result = await executeEdit(
      filePath,
      "not-in-file",
      "replacement",
      testDir,
    );
    expect(result.error).toBe(true);
    expect(result.output).toContain("not found");
  });

  it("returns error for non-existent file", async () => {
    const result = await executeEdit(
      join(testDir, "missing.txt"),
      "a",
      "b",
      testDir,
    );
    expect(result.error).toBe(true);
    expect(result.output).toContain("not found");
  });

  it("returns error for path outside working directory", async () => {
    const result = await executeEdit("/etc/passwd", "a", "b");
    expect(result.error).toBe(true);
    expect(result.output).toContain("outside the working directory");
  });
});

/**
 * 安全文件编辑测试
 */
describe("executeEditExact", () => {
  const testDir = join(tmpdir(), "agent-files-test-edit-exact");

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("replaces a single expected occurrence", async () => {
    const filePath = join(testDir, "single.txt");
    await executeWrite(filePath, "hello world", testDir);

    const result = await executeEditExact(
      filePath,
      "world",
      "TypeScript",
      1,
      testDir,
    );

    expect(result.error).toBe(false);
    expect(result.output).toContain("1 replacement");
    const content = await executeRead(filePath, testDir);
    expect(content.output).toBe("hello TypeScript");
  });

  it("rejects multiple matches when expected_occurrences is one", async () => {
    const filePath = join(testDir, "multi-reject.txt");
    await executeWrite(filePath, "aaa bbb aaa", testDir);

    const result = await executeEditExact(filePath, "aaa", "ccc", 1, testDir);

    expect(result.error).toBe(true);
    expect(result.output).toContain("found 2");
    const content = await executeRead(filePath, testDir);
    expect(content.output).toBe("aaa bbb aaa");
  });

  it("replaces multiple matches when expected_occurrences matches", async () => {
    const filePath = join(testDir, "multi-accept.txt");
    await executeWrite(filePath, "aaa bbb aaa", testDir);

    const result = await executeEditExact(filePath, "aaa", "ccc", 2, testDir);

    expect(result.error).toBe(false);
    const content = await executeRead(filePath, testDir);
    expect(content.output).toBe("ccc bbb ccc");
  });

  it("rejects empty old_string", async () => {
    const filePath = join(testDir, "empty.txt");
    await executeWrite(filePath, "hello", testDir);

    const result = await executeEditExact(filePath, "", "x", 1, testDir);

    expect(result.error).toBe(true);
    expect(result.output).toContain("non-empty");
  });

  it("rejects invalid expected_occurrences", async () => {
    const filePath = join(testDir, "invalid-expected.txt");
    await executeWrite(filePath, "hello", testDir);

    const result = await executeEditExact(filePath, "hello", "x", 0, testDir);

    expect(result.error).toBe(true);
    expect(result.output).toContain("positive integer");
  });

  it("returns error for path outside working directory", async () => {
    const result = await executeEditExact("/etc/passwd", "a", "b", 1);
    expect(result.error).toBe(true);
    expect(result.output).toContain("outside the working directory");
  });
});
