/**
 * runtime-policy-store.test.ts — Runtime Policy Store 测试
 */

import { describe, expect, it } from "vitest";
import { createRuntimePolicyStore } from "./runtime-policy-store.js";
import { resolveFoundationModelProfile } from "./foundation-models.js";

function createStore(profileId: string, provider = "openai_compatible", model?: string) {
  const profile = resolveFoundationModelProfile({
    provider: provider as import("./llm-providers.js").LLMProviderId,
    model: model ?? profileId,
    explicitProfileId: profileId,
  });
  return createRuntimePolicyStore(profile, model ?? profileId);
}

describe("createRuntimePolicyStore", () => {
  it("returns base policy when no override", () => {
    const store = createStore("generic-openai-compatible");
    const policy = store.getPolicy();
    expect(policy.modelProfileId).toBe("generic-openai-compatible");
    expect(policy.request.thinkingMode).toBe("disabled");
  });

  it("getBasePolicy returns original policy without override", () => {
    const store = createStore("deepseek-v4");
    store.updateOverride({ thinkingMode: "disabled" }, "cli");
    expect(store.getBasePolicy().request.thinkingMode).toBe("adaptive");
    expect(store.getPolicy().request.thinkingMode).toBe("disabled");
  });

  it("getOverride returns a copy", () => {
    const store = createStore("deepseek-v4");
    store.updateOverride({ thinkingMode: "disabled" }, "cli");
    const override = store.getOverride();
    override.thinkingMode = "enabled";
    expect(store.getOverride().thinkingMode).toBe("disabled");
  });

  it("updateOverride merges multiple patches", () => {
    const store = createStore("deepseek-v4");
    store.updateOverride({ thinkingMode: "enabled" }, "cli");
    store.updateOverride({ contextBudgetTokens: 300000 }, "cli");
    const policy = store.getPolicy();
    expect(policy.request.thinkingMode).toBe("enabled");
    expect(policy.context.effectiveBudgetTokens).toBe(300000);
  });

  it("resetOverride clears all overrides", () => {
    const store = createStore("deepseek-v4");
    store.updateOverride({ thinkingMode: "disabled" }, "cli");
    store.resetOverride("cli");
    expect(store.getPolicy().request.thinkingMode).toBe("adaptive");
    expect(store.getOverride()).toEqual({});
  });

  it("snapshot returns immutable copy", () => {
    const store = createStore("deepseek-v4");
    const snap = store.snapshot();
    snap.request.thinkingMode = "disabled";
    expect(store.getPolicy().request.thinkingMode).toBe("adaptive");
  });

  it("rejects thinking override for non-thinking model", () => {
    const store = createStore("generic-openai-compatible");
    expect(() =>
      store.updateOverride({ thinkingMode: "enabled" }, "cli"),
    ).toThrow(/does not support thinking mode/);
  });

  it("rejects context budget exceeding window", () => {
    const store = createStore("deepseek-v4");
    expect(() =>
      store.updateOverride({ contextBudgetTokens: 2000000 }, "cli"),
    ).toThrow(/exceeds model context window/);
  });

  it("rejects invalid context budget", () => {
    const store = createStore("deepseek-v4");
    expect(() =>
      store.updateOverride({ contextBudgetTokens: 0 }, "cli"),
    ).toThrow(/must be a positive number/);
  });

  it("rejects max output exceeding profile limit", () => {
    const store = createStore("generic-openai-compatible");
    expect(() =>
      store.updateOverride({ maxOutputTokens: 10000 }, "cli"),
    ).toThrow(/exceeds profile limit/);
  });

  it("rejects unsupported reasoning effort", () => {
    const store = createStore("kimi-k2.6", "kimi_platform_cn", "kimi-k2.6");
    expect(() =>
      store.updateOverride({ reasoningEffort: "max" }, "cli"),
    ).toThrow(/does not support reasoning effort/);
  });

  it("allows reasoning effort override for supported model", () => {
    const store = createStore("deepseek-v4");
    store.updateOverride({ reasoningEffort: "default" }, "cli");
    expect(store.getPolicy().request.reasoningEffort).toBe("default");
  });

  it("allows null reasoning effort to clear", () => {
    const store = createStore("deepseek-v4");
    store.updateOverride({ reasoningEffort: "default" }, "cli");
    store.updateOverride({ reasoningEffort: null }, "cli");
    expect(store.getPolicy().request.reasoningEffort).toBeUndefined();
  });

  it("re-derives compression config when compressionMode changes", () => {
    const store = createStore("deepseek-v4");
    store.updateOverride({ compressionMode: "aggressive" }, "cli");
    const policy = store.getPolicy();
    expect(policy.context.compressionMode).toBe("aggressive");
    expect(policy.context.toolOutputCompressionThresholdTokens).toBe(2000);
    expect(policy.context.decayThresholdLoops).toBe(3);
    expect(policy.context.compactKeepRecentBlocks).toBe(4);
  });

  it("re-derives compression config when context budget changes", () => {
    const store = createStore("deepseek-v4");
    store.updateOverride(
      { compressionMode: "long_context", contextBudgetTokens: 500000 },
      "cli",
    );
    const policy = store.getPolicy();
    expect(policy.context.effectiveBudgetTokens).toBe(500000);
    expect(policy.context.compressionMode).toBe("long_context");
    expect(policy.context.toolOutputCompressionThresholdTokens).toBe(8000);
  });
});
