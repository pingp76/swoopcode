/**
 * tools/memory.test.ts — Memory 工具测试
 *
 * 重点覆盖教学版去重逻辑：
 * - 默认不允许创建明显重复的 memory
 * - 用户明确确认后可以通过 allow_duplicate 保留两条相似 memory
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger } from "../logger.js";
import { createMemoryManager } from "../memory.js";
import { createMemoryToolProvider } from "./memory.js";

const logger = createLogger("error");

let tempDir: string;

function setupTempDir(): string {
  tempDir = mkdtempSync(join(tmpdir(), "memory-tool-test-"));
  return tempDir;
}

function cleanupTempDir(): void {
  if (tempDir && existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("Memory tools", () => {
  beforeEach(() => {
    setupTempDir();
  });

  afterEach(() => {
    cleanupTempDir();
  });

  function getTool(name: string) {
    const manager = createMemoryManager({ memoryDir: tempDir, logger });
    manager.scan();
    const provider = createMemoryToolProvider(manager);
    const tool = provider.toolEntries.find(
      (entry) => entry.definition.function.name === name,
    );
    if (!tool) {
      throw new Error(`Tool not found: ${name}`);
    }
    return tool.execute;
  }

  it("blocks a likely duplicate memory by default", async () => {
    const create = getTool("run_memory_create");

    const first = await create({
      name: "prefer-concise",
      description: "User prefers concise answers",
      type: "user",
      body: "The user likes short replies.",
    });
    expect(first.error).toBe(false);

    const duplicate = await create({
      name: "short-answers",
      description: "User prefers concise answers",
      type: "user",
      body: "The user likes brief responses.",
    });

    expect(duplicate.error).toBe(true);
    expect(duplicate.output).toContain("Potential duplicate memory found");
    expect(duplicate.output).toContain("prefer-concise");
    expect(existsSync(join(tempDir, "short-answers.md"))).toBe(false);
  });

  it("allows duplicate memory only when allow_duplicate is true", async () => {
    const create = getTool("run_memory_create");

    await create({
      name: "prefer-concise",
      description: "User prefers concise answers",
      type: "user",
      body: "The user likes short replies.",
    });

    const duplicate = await create({
      name: "short-answers",
      description: "User prefers concise answers",
      type: "user",
      body: "The user likes brief responses.",
      allow_duplicate: true,
    });

    expect(duplicate.error).toBe(false);
    expect(existsSync(join(tempDir, "short-answers.md"))).toBe(true);
    expect(readFileSync(join(tempDir, "MEMORY.md"), "utf-8")).toContain(
      "short-answers",
    );
  });
});
