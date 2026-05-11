import { describe, it, expect } from "vitest";
import { createSessionManager } from "./session.js";

describe("createSessionManager", () => {
  function createTestManager() {
    let id = 0;
    return createSessionManager({
      projectRoot: "/repo",
      cwd: "/repo",
      model: "test-model",
      now: () => new Date("2026-05-11T00:00:00.000Z"),
      idGenerator: () => `session-${++id}`,
    });
  }

  it("creates a main session with project metadata", () => {
    const manager = createTestManager();
    const session = manager.createMainSession("main");

    expect(session).toEqual({
      id: "session-1",
      kind: "main",
      startedAt: "2026-05-11T00:00:00.000Z",
      title: "main",
      projectRoot: "/repo",
      cwd: "/repo",
      model: "test-model",
    });
  });

  it("creates child sessions with parentSessionId", () => {
    const manager = createTestManager();
    const parent = manager.createMainSession();
    const child = manager.createChildSession(parent.id, "sub task");

    expect(child.kind).toBe("subagent");
    expect(child.parentSessionId).toBe(parent.id);
    expect(child.title).toBe("sub task");
  });

  it("lists and ends sessions", () => {
    const manager = createTestManager();
    const session = manager.createMainSession();

    manager.endSession(session.id);

    expect(manager.get(session.id)?.endedAt).toBe("2026-05-11T00:00:00.000Z");
    expect(manager.list()).toHaveLength(1);
  });
});
