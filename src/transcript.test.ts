import { describe, it, expect } from "vitest";
import { createTranscriptStore, classifyMessage } from "./transcript.js";

describe("classifyMessage", () => {
  it("classifies normal user messages separately from reminders", () => {
    expect(classifyMessage({ role: "user", content: "hello" })).toBe(
      "user_message",
    );
    expect(
      classifyMessage({
        role: "user",
        content: '<system-reminder source="memory">ignore</system-reminder>',
      }),
    ).toBe("system_reminder");
    expect(
      classifyMessage({ role: "user", content: "[Hook: SessionStart]\nhi" }),
    ).toBe("hook_message");
  });

  it("classifies assistant and tool messages", () => {
    expect(classifyMessage({ role: "assistant", content: "done" })).toBe(
      "assistant_message",
    );
    expect(
      classifyMessage({
        role: "tool",
        tool_call_id: "call_1",
        content: "ok",
      }),
    ).toBe("tool_result");
  });
});

describe("createTranscriptStore", () => {
  function createTestStore() {
    let id = 0;
    return createTranscriptStore({
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      idGenerator: () => `event-${++id}`,
    });
  }

  it("appends events with per-session sequence", () => {
    const store = createTestStore();

    const a = store.append({
      sessionId: "s1",
      type: "user_message",
      round: 0,
      payload: { text: "a" },
    });
    const b = store.append({
      sessionId: "s1",
      type: "assistant_message",
      round: 1,
      payload: { text: "b" },
    });
    const c = store.append({
      sessionId: "s2",
      type: "user_message",
      round: 0,
      payload: { text: "c" },
    });

    expect(a.sequence).toBe(1);
    expect(b.sequence).toBe(2);
    expect(c.sequence).toBe(1);
  });

  it("appendMessage preserves raw message payload by copy", () => {
    const store = createTestStore();
    const message = { role: "user" as const, content: "hello" };
    const event = store.appendMessage({
      sessionId: "s1",
      timing: { turnIndex: 1, loopRound: 0, loopIndex: 1 },
      historySequence: 7,
      message,
    });

    message.content = "changed";

    expect(event.type).toBe("user_message");
    expect(event.turnIndex).toBe(1);
    expect(event.loopRound).toBe(0);
    expect(event.loopIndex).toBe(1);
    expect(event.round).toBe(0);
    expect(event.historySequence).toBe(7);
    expect(event.payload).toEqual({
      message: { role: "user", content: "hello" },
    });
  });

  it("keeps transcript sequence separate from historySequence", () => {
    const store = createTestStore();

    const first = store.appendMessage({
      sessionId: "s1",
      timing: { turnIndex: 1, loopRound: 1, loopIndex: 1 },
      historySequence: 42,
      message: { role: "assistant", content: "hello" },
    });
    const second = store.append({
      sessionId: "s1",
      type: "recovery_event",
      timing: { turnIndex: 1, loopRound: 1, loopIndex: 1 },
      payload: { action: "backoff" },
    });

    expect(first.sequence).toBe(1);
    expect(first.historySequence).toBe(42);
    expect(second.sequence).toBe(2);
    expect(second.historySequence).toBeUndefined();
    expect(second.loopIndex).toBe(1);
  });

  it("reads and searches events without mutating the log", () => {
    const store = createTestStore();
    store.append({
      sessionId: "s1",
      type: "user_message",
      payload: { text: "alpha" },
    });
    store.append({
      sessionId: "s2",
      type: "assistant_message",
      payload: { text: "beta" },
    });

    expect(store.readSession("s1")).toHaveLength(1);
    expect(store.search({ text: "beta" })).toHaveLength(1);
    expect(
      store.search({ sessionId: "s2", type: "assistant_message" }),
    ).toHaveLength(1);
    expect(store.list()).toHaveLength(2);
  });
});
