/**
 * system-prompt.test.ts — System Prompt 组合器测试
 *
 * 覆盖：buildSystemPrompt 组合、createSystemPromptProvider 忽略 memory 检测。
 */

import { describe, it, expect } from "vitest";
import { buildSystemPrompt, createSystemPromptProvider } from "./system-prompt.js";

// ============================================================================
// buildSystemPrompt
// ============================================================================

describe("buildSystemPrompt", () => {
  it("returns null when no parts", () => {
    expect(buildSystemPrompt({})).toBeNull();
    expect(buildSystemPrompt({ skillHint: null, memoryHint: null })).toBeNull();
  });

  it("returns skill hint only", () => {
    const result = buildSystemPrompt({ skillHint: "skill text" });
    expect(result).toBe("skill text");
  });

  it("returns memory hint only", () => {
    const result = buildSystemPrompt({ memoryHint: "memory text" });
    expect(result).toBe("memory text");
  });

  it("joins multiple hints with double newline", () => {
    const result = buildSystemPrompt({
      skillHint: "skill",
      memoryHint: "memory",
    });
    expect(result).toBe("skill\n\nmemory");
  });
});

// ============================================================================
// createSystemPromptProvider — ignore memory 检测
// ============================================================================

describe("SystemPromptProvider ignore memory", () => {
  const provider = createSystemPromptProvider({
    getSkillHint: () => "skill hint",
    getMemoryHint: () => "memory hint",
  });

  it("includes memory hint for normal query", () => {
    const result = provider.build("帮我分析代码");
    expect(result).toContain("memory hint");
    expect(result).toContain("skill hint");
  });

  it("omits memory hint for '忽略 memory'", () => {
    const result = provider.build("忽略 memory，帮我分析代码");
    expect(result).toContain("skill hint");
    expect(result).not.toContain("memory hint");
  });

  it("omits memory hint for '不要使用 memory'", () => {
    const result = provider.build("不要使用 memory");
    expect(result).toContain("skill hint");
    expect(result).not.toContain("memory hint");
  });

  it("omits memory hint for '本轮不要使用 memory'", () => {
    const result = provider.build("本轮不要使用 memory");
    expect(result).toContain("skill hint");
    expect(result).not.toContain("memory hint");
  });

  it("omits memory hint for '不使用 memory'", () => {
    const result = provider.build("不使用 memory");
    expect(result).not.toContain("memory hint");
  });

  it("omits memory hint for 'ignore memory'", () => {
    const result = provider.build("please ignore memory for this");
    expect(result).not.toContain("memory hint");
  });

  it("omits memory hint for \"don't use memory\"", () => {
    const result = provider.build("don't use memory this turn");
    expect(result).not.toContain("memory hint");
  });
});
