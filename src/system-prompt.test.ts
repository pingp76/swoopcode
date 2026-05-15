/**
 * system-prompt.test.ts — System Prompt 组合器测试（Cache-Ready 版本）
 *
 * 覆盖：buildSystemPrompt 组合、createSystemPromptProvider 的 snapshot 稳定性
 * 和 turn reminder 行为。
 */

import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  createSystemPromptProvider,
  TASK_PLANNING_SYSTEM_HINT,
} from "./system-prompt.js";

// ============================================================================
// buildSystemPrompt
// ============================================================================

describe("buildSystemPrompt", () => {
  it("returns null when no parts", () => {
    expect(buildSystemPrompt({})).toBeNull();
    expect(
      buildSystemPrompt({
        projectInstructions: null,
        skillHint: null,
        memoryHint: null,
      }),
    ).toBeNull();
  });

  it("returns project instructions first", () => {
    const result = buildSystemPrompt({
      projectInstructions: "agents text",
      taskPlanningHint: "task planning",
      skillHint: "skill",
      memoryHint: "memory",
    });
    expect(result).toBe("agents text\n\ntask planning\n\nskill\n\nmemory");
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
// createSystemPromptProvider — snapshot 稳定性
// ============================================================================

describe("SystemPromptProvider snapshot stability", () => {
  it("returns same snapshot on multiple getSnapshot() calls", () => {
    const provider = createSystemPromptProvider({
      getSkillHint: () => "skill hint",
      getMemoryHint: () => "memory hint",
    });

    const s1 = provider.getSnapshot();
    const s2 = provider.getSnapshot();
    expect(s1.systemPrompt).toBe(s2.systemPrompt);
    expect(s1.projectInstructions).toBe(s2.projectInstructions);
    expect(s1.taskPlanningHint).toBe(TASK_PLANNING_SYSTEM_HINT);
    expect(s1.skillHint).toBe(s2.skillHint);
    expect(s1.memoryHint).toBe(s2.memoryHint);
  });

  it("snapshot includes project instructions from AGENTS.md provider", () => {
    const provider = createSystemPromptProvider({
      getProjectInstructions: () => "project rules",
      getSkillHint: () => "skill hint",
      getMemoryHint: () => "memory hint",
    });

    const snapshot = provider.getSnapshot();
    expect(snapshot.projectInstructions).toBe("project rules");
    expect(snapshot.taskPlanningHint).toContain("TODO vs Task Tool Choice");
    expect(snapshot.systemPrompt).toBe(
      `project rules\n\n${TASK_PLANNING_SYSTEM_HINT}\n\nskill hint\n\nmemory hint`,
    );
  });

  it("snapshot always includes stable TODO vs Task guidance", () => {
    const provider = createSystemPromptProvider({
      getSkillHint: () => null,
      getMemoryHint: () => null,
    });

    const snapshot = provider.getSnapshot();
    expect(snapshot.taskPlanningHint).toContain("Use TODO tools");
    expect(snapshot.taskPlanningHint).toContain("Use Task tools");
    expect(snapshot.systemPrompt).toBe(TASK_PLANNING_SYSTEM_HINT);
  });

  it("snapshot does not change when memory source changes without refresh", () => {
    let memoryHint = "memory hint v1";
    const provider = createSystemPromptProvider({
      getSkillHint: () => "skill hint",
      getMemoryHint: () => memoryHint,
    });

    const s1 = provider.getSnapshot();
    memoryHint = "memory hint v2";
    const s2 = provider.getSnapshot();
    expect(s2.systemPrompt).toBe(s1.systemPrompt);
    expect(s2.memoryHint).toBe("memory hint v1");
  });

  it("snapshot updates after refreshSnapshot()", () => {
    let memoryHint = "memory hint v1";
    let projectInstructions = "project rules v1";
    const provider = createSystemPromptProvider({
      getProjectInstructions: () => projectInstructions,
      getSkillHint: () => "skill hint",
      getMemoryHint: () => memoryHint,
    });

    const s1 = provider.getSnapshot();
    memoryHint = "memory hint v2";
    projectInstructions = "project rules v2";
    const s2 = provider.refreshSnapshot();
    expect(s2.systemPrompt).toContain("project rules v2");
    expect(s2.projectInstructions).toBe("project rules v2");
    expect(s2.systemPrompt).toContain("memory hint v2");
    expect(s2.memoryHint).toBe("memory hint v2");
    expect(s2.systemPrompt).not.toBe(s1.systemPrompt);

    // getSnapshot 也返回更新后的值
    const s3 = provider.getSnapshot();
    expect(s3.systemPrompt).toBe(s2.systemPrompt);
  });
});

// ============================================================================
// createSystemPromptProvider — turn reminders
// ============================================================================

describe("SystemPromptProvider turn reminders", () => {
  const provider = createSystemPromptProvider({
    getSkillHint: () => "skill hint",
    getMemoryHint: () => "memory hint",
  });

  it("returns empty reminders for normal query", () => {
    const reminders = provider.buildTurnReminders({ query: "帮我分析代码" });
    expect(reminders).toHaveLength(0);
  });

  it("returns memory reminder for '忽略 memory'", () => {
    const reminders = provider.buildTurnReminders({
      query: "忽略 memory，帮我分析代码",
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.source).toBe("memory");
    expect(reminders[0]?.message).toContain("do not use long-term memory");
  });

  it("returns memory reminder for '不要使用 memory'", () => {
    const reminders = provider.buildTurnReminders({ query: "不要使用 memory" });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.source).toBe("memory");
  });

  it("returns memory reminder for '本轮不要使用 memory'", () => {
    const reminders = provider.buildTurnReminders({
      query: "本轮不要使用 memory",
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.source).toBe("memory");
  });

  it("returns memory reminder for '不使用 memory'", () => {
    const reminders = provider.buildTurnReminders({ query: "不使用 memory" });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.source).toBe("memory");
  });

  it("returns memory reminder for 'ignore memory'", () => {
    const reminders = provider.buildTurnReminders({
      query: "please ignore memory for this",
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.source).toBe("memory");
  });

  it('returns memory reminder for "don\'t use memory"', () => {
    const reminders = provider.buildTurnReminders({
      query: "don't use memory this turn",
    });
    expect(reminders).toHaveLength(1);
    expect(reminders[0]?.source).toBe("memory");
  });

  it("snapshot still contains memory hint even when reminder says ignore", () => {
    const snapshot = provider.getSnapshot();
    expect(snapshot.memoryHint).toBe("memory hint");

    const reminders = provider.buildTurnReminders({ query: "ignore memory" });
    expect(reminders).toHaveLength(1);
    // snapshot 不应该被修改
    expect(provider.getSnapshot().memoryHint).toBe("memory hint");
  });
});
