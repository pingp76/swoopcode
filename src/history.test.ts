import { describe, it, expect } from "vitest";
import { createHistory } from "./history.js";

describe("createHistory", () => {
  it("starts empty", () => {
    const history = createHistory();
    expect(history.getMessages()).toEqual([]);
  });

  it("adds messages", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" });
    history.add({ role: "assistant", content: "hi there" });
    const msgs = history.getMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toEqual({ role: "user", content: "hello" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "hi there" });
  });

  it("returns a copy of messages", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" });
    const copy = history.getMessages();
    copy.push({ role: "assistant", content: "mutated" });
    expect(history.getMessages()).toHaveLength(1);
  });

  it("clears all messages", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" });
    history.clear();
    expect(history.getMessages()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// add() with meta — 轮次元信息存储
// ---------------------------------------------------------------------------

describe("add with meta", () => {
  it("stores round metadata alongside message", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" }, { round: 0 });
    history.add({ role: "assistant", content: "hi" }, { round: 1 });
    const entries = history.getEntries();
    expect(entries).toHaveLength(2);
    expect(entries[0]!.round).toBe(0);
    expect(entries[1]!.round).toBe(1);
  });

  it("allows undefined round when no meta passed (backward compatible)", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" }); // 不传 meta
    const entries = history.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.round).toBeUndefined();
  });

  it("allows explicit undefined round in meta", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" }, {}); // meta 存在但 round 未定义
    const entries = history.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.round).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getEntries() — 带元信息的条目列表
// ---------------------------------------------------------------------------

describe("getEntries", () => {
  it("returns empty array for new history", () => {
    const history = createHistory();
    expect(history.getEntries()).toEqual([]);
  });

  it("returns entries without system prompt", () => {
    const history = createHistory();
    history.setSystemPrompt("You are a helper");
    history.add({ role: "user", content: "hello" }, { round: 1 });
    const entries = history.getEntries();
    // system prompt 不在 entries 中
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toEqual({ role: "user", content: "hello" });
    expect(entries[0]!.round).toBe(1);
  });

  it("returns a copy (mutations do not affect internal state)", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" }, { round: 1 });
    const entries = history.getEntries();
    // 修改返回的数组不应影响内部状态
    entries.push({ message: { role: "assistant", content: "hi" }, round: 2 });
    expect(history.getEntries()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getSystemPrompt()
// ---------------------------------------------------------------------------

describe("getSystemPrompt", () => {
  it("returns null when no system prompt set", () => {
    const history = createHistory();
    expect(history.getSystemPrompt()).toBeNull();
  });

  it("returns the system prompt string when set", () => {
    const history = createHistory();
    history.setSystemPrompt("You are a helper");
    expect(history.getSystemPrompt()).toBe("You are a helper");
  });
});

// ---------------------------------------------------------------------------
// clear() — 同时清空 entries 和 rounds
// ---------------------------------------------------------------------------

describe("clear with entries", () => {
  it("clears entries and rounds", () => {
    const history = createHistory();
    history.add({ role: "user", content: "hello" }, { round: 0 });
    history.clear();
    expect(history.getEntries()).toEqual([]);
    expect(history.getMessages()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// replaceEntries() — 替换消息和元信息
// ---------------------------------------------------------------------------

describe("replaceEntries", () => {
  it("replaces ordinary messages", () => {
    const history = createHistory();
    history.add({ role: "user", content: "old" }, { round: 0 });
    history.replaceEntries([
      { message: { role: "user", content: "new" }, round: 1 },
    ]);
    const entries = history.getEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.message).toEqual({ role: "user", content: "new" });
    expect(entries[0]!.round).toBe(1);
  });

  it("preserves round metadata", () => {
    const history = createHistory();
    history.add({ role: "assistant", content: "a" }, { round: 2 });
    history.replaceEntries([
      { message: { role: "user", content: "u" }, round: 3 },
      { message: { role: "assistant", content: "a2" }, round: 4 },
    ]);
    const entries = history.getEntries();
    expect(entries[0]!.round).toBe(3);
    expect(entries[1]!.round).toBe(4);
  });

  it("does not modify system prompt", () => {
    const history = createHistory();
    history.setSystemPrompt("You are a helper");
    history.add({ role: "user", content: "hello" }, { round: 0 });
    history.replaceEntries([
      { message: { role: "user", content: "replaced" }, round: 1 },
    ]);
    expect(history.getSystemPrompt()).toBe("You are a helper");
  });

  it("getMessages still prepends system prompt after replacement", () => {
    const history = createHistory();
    history.setSystemPrompt("SYS");
    history.add({ role: "user", content: "old" }, { round: 0 });
    history.replaceEntries([
      { message: { role: "user", content: "new" }, round: 1 },
    ]);
    const msgs = history.getMessages();
    expect(msgs[0]).toEqual({ role: "system", content: "SYS" });
    expect(msgs[1]).toEqual({ role: "user", content: "new" });
  });

  it("removes all previous messages when replacing", () => {
    const history = createHistory();
    history.add({ role: "user", content: "a" }, { round: 0 });
    history.add({ role: "assistant", content: "b" }, { round: 1 });
    history.replaceEntries([]);
    expect(history.getEntries()).toHaveLength(0);
    expect(history.getMessages()).toHaveLength(0);
  });
});
