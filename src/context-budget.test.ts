/**
 * context-budget.test.ts — 上下文预算分配器测试
 *
 * 测试覆盖：
 * - 三种压缩模式的预算分配
 * - 子预算总和约束
 * - overrides 处理与裁剪
 * - 极小预算边界
 */

import { describe, it, expect } from "vitest";
import { resolveContextBudgets } from "./context-budget.js";

describe("resolveContextBudgets", () => {
  it("balanced mode: sub-budgets sum to <= effectiveBudget", () => {
    const plan = resolveContextBudgets({
      effectiveBudgetTokens: 180000,
      compressionMode: "balanced",
      maxOutputTokens: 32768,
    });

    const total =
      plan.outputReserveTokens +
      plan.conversationReserveTokens +
      plan.stablePackBudgetTokens +
      plan.workingSetBudgetTokens +
      plan.evidenceBudgetTokens +
      plan.headroomTokens;

    expect(total).toBeLessThanOrEqual(plan.effectiveBudgetTokens);
    expect(plan.effectiveBudgetTokens).toBe(180000);
  });

  it("long_context mode: stable pack gets the largest share", () => {
    const plan = resolveContextBudgets({
      effectiveBudgetTokens: 750000,
      compressionMode: "long_context",
      maxOutputTokens: 128000,
    });

    // long_context 模式下 stablePack 应占 usable 的 42%
    expect(plan.stablePackBudgetTokens).toBeGreaterThan(
      plan.workingSetBudgetTokens,
    );
    expect(plan.stablePackBudgetTokens).toBeGreaterThan(
      plan.evidenceBudgetTokens,
    );
  });

  it("aggressive mode: conversation gets larger share than long_context", () => {
    const aggressive = resolveContextBudgets({
      effectiveBudgetTokens: 60000,
      compressionMode: "aggressive",
      maxOutputTokens: 4096,
    });

    const longCtx = resolveContextBudgets({
      effectiveBudgetTokens: 60000,
      compressionMode: "long_context",
      maxOutputTokens: 4096,
    });

    expect(aggressive.conversationReserveTokens).toBeGreaterThan(
      longCtx.conversationReserveTokens,
    );
  });

  it("outputReserve is capped at maxOutputTokens", () => {
    const plan = resolveContextBudgets({
      effectiveBudgetTokens: 100000,
      compressionMode: "balanced",
      maxOutputTokens: 5000,
    });

    expect(plan.outputReserveTokens).toBe(5000);
  });

  it("headroom is at least 8000 tokens", () => {
    const plan = resolveContextBudgets({
      effectiveBudgetTokens: 50000,
      compressionMode: "balanced",
      maxOutputTokens: 4096,
    });

    expect(plan.headroomTokens).toBeGreaterThanOrEqual(8000);
  });

  it("stableContextBudgetTokens override is respected when within limits", () => {
    const plan = resolveContextBudgets({
      effectiveBudgetTokens: 180000,
      compressionMode: "balanced",
      maxOutputTokens: 32768,
      overrides: {
        stableContextBudgetTokens: 40000,
      },
    });

    expect(plan.stablePackBudgetTokens).toBe(40000);
  });

  it("evidenceBudgetTokens override is respected", () => {
    const plan = resolveContextBudgets({
      effectiveBudgetTokens: 180000,
      compressionMode: "balanced",
      maxOutputTokens: 32768,
      overrides: {
        evidenceBudgetTokens: 5000,
      },
    });

    expect(plan.evidenceBudgetTokens).toBe(5000);
  });

  it("evidenceBudgetTokens override squeezes workingSet", () => {
    // 获取无 override 时的 baseline
    const baseline = resolveContextBudgets({
      effectiveBudgetTokens: 180000,
      compressionMode: "balanced",
      maxOutputTokens: 32768,
    });

    // evidence override 增加到 evidence + workingSet 的总量
    const plan = resolveContextBudgets({
      effectiveBudgetTokens: 180000,
      compressionMode: "balanced",
      maxOutputTokens: 32768,
      overrides: {
        evidenceBudgetTokens:
          baseline.evidenceBudgetTokens + baseline.workingSetBudgetTokens,
      },
    });

    // evidence 应拿到全部（原 evidence + workingSet）
    expect(plan.evidenceBudgetTokens).toBe(
      baseline.evidenceBudgetTokens + baseline.workingSetBudgetTokens,
    );
    // workingSet 应被挤占到 0
    expect(plan.workingSetBudgetTokens).toBe(0);
  });

  it("cuts evidence first when total exceeds usable", () => {
    const plan = resolveContextBudgets({
      effectiveBudgetTokens: 50000,
      compressionMode: "balanced",
      maxOutputTokens: 4096,
      overrides: {
        stableContextBudgetTokens: 30000,
        evidenceBudgetTokens: 20000,
      },
    });

    const total =
      plan.outputReserveTokens +
      plan.conversationReserveTokens +
      plan.stablePackBudgetTokens +
      plan.workingSetBudgetTokens +
      plan.evidenceBudgetTokens +
      plan.headroomTokens;

    expect(total).toBeLessThanOrEqual(plan.effectiveBudgetTokens);
  });

  it("handles small budgets without negative values", () => {
    const plan = resolveContextBudgets({
      effectiveBudgetTokens: 20000,
      compressionMode: "aggressive",
      maxOutputTokens: 4096,
    });

    expect(plan.stablePackBudgetTokens).toBeGreaterThanOrEqual(0);
    expect(plan.workingSetBudgetTokens).toBeGreaterThanOrEqual(0);
    expect(plan.evidenceBudgetTokens).toBeGreaterThanOrEqual(0);
    expect(plan.conversationReserveTokens).toBeGreaterThanOrEqual(0);
    expect(plan.headroomTokens).toBeGreaterThanOrEqual(0);
  });
});
