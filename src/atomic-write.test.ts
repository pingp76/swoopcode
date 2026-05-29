/**
 * atomic-write.test.ts — 原子写文件工具测试
 *
 * 这些测试聚焦底层运行态安全：写入失败时不能破坏已经存在的正式文件，
 * 也不能留下越来越多的临时文件。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteJsonFile, atomicWriteTextFile } from "./atomic-write.js";

describe("atomic-write", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-write-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes text through a same-directory temporary file", () => {
    const filePath = path.join(tmpDir, "nested", "value.txt");

    atomicWriteTextFile(filePath, "hello");

    expect(fs.readFileSync(filePath, "utf-8")).toBe("hello");
    expect(fs.readdirSync(path.dirname(filePath))).toEqual(["value.txt"]);
  });

  it("writes formatted JSON that can be parsed immediately", () => {
    const filePath = path.join(tmpDir, "index.json");

    atomicWriteJsonFile(filePath, { version: 1, items: ["a"] });

    expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toEqual({
      version: 1,
      items: ["a"],
    });
  });

  it("keeps the previous file when JSON serialization fails", () => {
    const filePath = path.join(tmpDir, "index.json");
    atomicWriteJsonFile(filePath, { version: 1 });

    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    expect(() => atomicWriteJsonFile(filePath, circular)).toThrow();
    expect(JSON.parse(fs.readFileSync(filePath, "utf-8"))).toEqual({
      version: 1,
    });
    expect(
      fs.readdirSync(tmpDir).filter((name) => name.startsWith(".tmp-")),
    ).toEqual([]);
  });
});
