/**
 * cache-debug.test.ts — Cache Debug 模块测试
 *
 * 覆盖：stableStringify 行为、hash 稳定性、inspect 变化检测、formatCacheDebugLog。
 */

import { describe, it, expect } from "vitest";
import { createCacheDebugTracker, formatCacheDebugLog } from "./cache-debug.js";

// ============================================================================
// createCacheDebugTracker
// ============================================================================

describe("CacheDebugTracker inspect", () => {
  it("returns stable=false for first call (no previous snapshot)", () => {
    const tracker = createCacheDebugTracker();
    const state = tracker.inspect({
      messages: [{ role: "system", content: "You are a helpful assistant." }],
      tools: [],
    });

    expect(state.changed.systemPrompt).toBe(false);
    expect(state.changed.tools).toBe(false);
    expect(state.changed.stablePrefix).toBe(false);
    expect(state.current.messageCount).toBe(1);
    expect(state.current.toolCount).toBe(0);
  });

  it("detects system prompt change", () => {
    const tracker = createCacheDebugTracker();

    tracker.inspect({
      messages: [{ role: "system", content: "Prompt A" }],
      tools: [],
    });

    const state = tracker.inspect({
      messages: [{ role: "system", content: "Prompt B" }],
      tools: [],
    });

    expect(state.changed.systemPrompt).toBe(true);
    expect(state.changed.tools).toBe(false);
    expect(state.changed.stablePrefix).toBe(true);
  });

  it("detects tools change", () => {
    const tracker = createCacheDebugTracker();

    tracker.inspect({
      messages: [{ role: "system", content: "Prompt" }],
      tools: [],
    });

    const state = tracker.inspect({
      messages: [{ role: "system", content: "Prompt" }],
      tools: [
        {
          type: "function",
          function: { name: "run_bash", description: "bash" },
        },
      ],
    });

    expect(state.changed.systemPrompt).toBe(false);
    expect(state.changed.tools).toBe(true);
    expect(state.changed.stablePrefix).toBe(true);
  });

  it("reports all stable when nothing changes", () => {
    const tracker = createCacheDebugTracker();

    tracker.inspect({
      messages: [{ role: "system", content: "Prompt" }],
      tools: [
        {
          type: "function",
          function: { name: "run_bash", description: "bash" },
        },
      ],
    });

    const state = tracker.inspect({
      messages: [{ role: "system", content: "Prompt" }],
      tools: [
        {
          type: "function",
          function: { name: "run_bash", description: "bash" },
        },
      ],
    });

    expect(state.changed.systemPrompt).toBe(false);
    expect(state.changed.tools).toBe(false);
    expect(state.changed.stablePrefix).toBe(false);
  });

  it("ignores non-system message changes for systemPrompt hash", () => {
    const tracker = createCacheDebugTracker();

    tracker.inspect({
      messages: [
        { role: "system", content: "Prompt" },
        { role: "user", content: "Hello" },
      ],
      tools: [],
    });

    const state = tracker.inspect({
      messages: [
        { role: "system", content: "Prompt" },
        { role: "user", content: "World" },
        { role: "assistant", content: "Hi" },
      ],
      tools: [],
    });

    expect(state.changed.systemPrompt).toBe(false);
    expect(state.changed.tools).toBe(false);
    expect(state.changed.stablePrefix).toBe(false);
  });
});

// ============================================================================
// formatCacheDebugLog
// ============================================================================

describe("formatCacheDebugLog", () => {
  it("formats stable state", () => {
    const log = formatCacheDebugLog({
      current: {
        systemPromptHash: "abc123",
        toolsHash: "def456",
        stablePrefixHash: "xyz789",
        messageCount: 5,
        toolCount: 3,
      },
      changed: {
        systemPrompt: false,
        tools: false,
        stablePrefix: false,
      },
    });

    expect(log).toContain("systemPrompt=stable");
    expect(log).toContain("tools=stable");
    expect(log).toContain("prefix=stable");
    expect(log).toContain("systemHash=abc123");
    expect(log).toContain("toolsHash=def456");
    expect(log).toContain("msgs=5");
    expect(log).toContain("tools=3");
  });

  it("formats changed state", () => {
    const log = formatCacheDebugLog({
      current: {
        systemPromptHash: "abc123",
        toolsHash: "def456",
        stablePrefixHash: "xyz789",
        messageCount: 5,
        toolCount: 3,
      },
      changed: {
        systemPrompt: true,
        tools: false,
        stablePrefix: true,
      },
    });

    expect(log).toContain("systemPrompt=changed");
    expect(log).toContain("tools=stable");
    expect(log).toContain("prefix=changed");
  });
});
