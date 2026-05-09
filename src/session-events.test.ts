/**
 * session-events.test.ts — SessionEventBuffer 测试
 *
 * 覆盖：push/drain/peek 基本行为、顺序保持、清空语义。
 */

import { describe, it, expect } from "vitest";
import { createSessionEventBuffer } from "./session-events.js";

// ============================================================================
// drain() 行为
// ============================================================================

describe("SessionEventBuffer drain", () => {
  it("returns empty array when no reminders", () => {
    const buffer = createSessionEventBuffer();
    expect(buffer.drain()).toEqual([]);
  });

  it("returns all reminders and clears buffer", () => {
    const buffer = createSessionEventBuffer();
    buffer.push({ source: "memory", message: "Memory updated" });
    buffer.push({ source: "mode", message: "Mode changed" });

    const result = buffer.drain();
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ source: "memory", message: "Memory updated" });
    expect(result[1]).toEqual({ source: "mode", message: "Mode changed" });

    // drain 后缓冲区应该为空
    expect(buffer.drain()).toEqual([]);
  });
});

// ============================================================================
// peek() 行为
// ============================================================================

describe("SessionEventBuffer peek", () => {
  it("returns empty array when no reminders", () => {
    const buffer = createSessionEventBuffer();
    expect(buffer.peek()).toEqual([]);
  });

  it("returns reminders without clearing buffer", () => {
    const buffer = createSessionEventBuffer();
    buffer.push({ source: "skill", message: "Skills re-scanned" });

    const firstPeek = buffer.peek();
    expect(firstPeek).toHaveLength(1);

    const secondPeek = buffer.peek();
    expect(secondPeek).toHaveLength(1);

    // drain 后才真正清空
    buffer.drain();
    expect(buffer.peek()).toEqual([]);
  });
});

// ============================================================================
// 顺序保持
// ============================================================================

describe("SessionEventBuffer order", () => {
  it("maintains insertion order across multiple pushes", () => {
    const buffer = createSessionEventBuffer();
    buffer.push({ source: "memory", message: "First" });
    buffer.push({ source: "cache", message: "Second" });
    buffer.push({ source: "system", message: "Third" });

    const result = buffer.drain();
    expect(result.map((r) => r.message)).toEqual(["First", "Second", "Third"]);
  });
});
