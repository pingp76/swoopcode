/**
 * runtime-policy.test.ts — Runtime Policy 解析测试
 */

import { describe, expect, it } from "vitest";
import {
  resolveRuntimePolicy,
  extractCompressionDefaultsFromPolicy,
} from "./runtime-policy.js";
import {
  resolveFoundationModelProfile,
  type FoundationModelProfile,
} from "./foundation-models.js";

function getProfile(
  id: string,
  provider = "openai_compatible",
): FoundationModelProfile {
  return resolveFoundationModelProfile({
    provider: provider as import("./llm-providers.js").LLMProviderId,
    model: id,
    explicitProfileId: id,
  });
}

describe("resolveRuntimePolicy defaults", () => {
  it("derives correct defaults for generic-openai-compatible", () => {
    const profile = getProfile("generic-openai-compatible");
    const policy = resolveRuntimePolicy(profile, "some-model");

    expect(policy.modelProfileId).toBe("generic-openai-compatible");
    expect(policy.protocol.selected).toBe("openai-chat-completions");
    expect(policy.protocol.implemented).toBe(true);
    expect(policy.context.contextWindowTokens).toBe(80000);
    expect(policy.context.effectiveBudgetTokens).toBe(60000);
    expect(policy.context.compressionMode).toBe("balanced");
    expect(policy.request.prefersStreaming).toBe(false);
    expect(policy.request.thinkingMode).toBe("disabled");
    expect(policy.tools.supportsTools).toBe(true);
    expect(policy.cache.supported).toBe(false);
    expect(policy.telemetry.recordReasoningTokens).toBe(false);
    expect(policy.telemetry.recordCacheTokens).toBe(false);
  });

  it("derives correct defaults for deepseek-v4", () => {
    const profile = getProfile("deepseek-v4");
    const policy = resolveRuntimePolicy(profile, "deepseek-v4");

    expect(policy.modelProfileId).toBe("deepseek-v4");
    expect(policy.context.contextWindowTokens).toBe(1000000);
    expect(policy.context.effectiveBudgetTokens).toBe(750000);
    expect(policy.context.longContextThresholdTokens).toBe(512000);
    expect(policy.context.compressionMode).toBe("long_context");
    expect(policy.request.prefersStreaming).toBe(true);
    expect(policy.request.thinkingMode).toBe("adaptive");
    expect(policy.request.maxTokensField).toBe("max_tokens");
    expect(policy.reasoning.mustReplayWithToolCalls).toBe(true);
    expect(policy.cache.supported).toBe(true);
    expect(policy.telemetry.recordCacheTokens).toBe(true);
  });

  it("derives correct defaults for kimi-k2.6", () => {
    const profile = resolveFoundationModelProfile({
      provider: "kimi_platform_cn",
      model: "kimi-k2.6",
    });
    const policy = resolveRuntimePolicy(profile, "kimi-k2.6");

    expect(policy.modelProfileId).toBe("kimi-k2.6");
    expect(policy.request.thinkingMode).toBe("enabled");
    expect(policy.reasoning.preserveRawAssistantMessage).toBe(true);
    expect(policy.reasoning.responseFields).toEqual(["reasoning_content"]);
    expect(policy.context.compressionMode).toBe("balanced");
  });

  it("derives correct defaults for glm-5.2", () => {
    const profile = resolveFoundationModelProfile({
      provider: "zhipuai_cn",
      model: "glm-5.2",
    });
    const policy = resolveRuntimePolicy(profile, "glm-5.2");

    expect(policy.modelProfileId).toBe("glm-5.2");
    expect(policy.context.contextWindowTokens).toBe(1000000);
    expect(policy.context.effectiveBudgetTokens).toBe(750000);
    expect(policy.context.longContextThresholdTokens).toBe(512000);
    expect(policy.context.compressionMode).toBe("long_context");
    expect(policy.request.prefersStreaming).toBe(true);
    expect(policy.request.thinkingMode).toBe("adaptive");
    expect(policy.request.extraBody).toEqual({
      thinking: { type: "auto" },
    });
    expect(policy.reasoning.responseFields).toEqual(["reasoning_content"]);
    expect(policy.tools.streamingArguments).toBe(true);
    expect(policy.cache.supported).toBe(false);
    expect(policy.telemetry.recordCacheTokens).toBe(false);
  });

  it("derives long_context compression with relaxed thresholds", () => {
    const profile = getProfile("deepseek-v4");
    const policy = resolveRuntimePolicy(profile, "deepseek-v4");

    expect(policy.context.toolOutputCompressionThresholdTokens).toBe(8000);
    expect(policy.context.decayThresholdLoops).toBe(8);
    expect(policy.context.decayPreviewTokens).toBe(400);
    expect(policy.context.compactKeepRecentBlocks).toBe(10);
    // maxContextTokens 不在 RuntimePolicy.context 中，
    // 而是通过 extractCompressionDefaultsFromPolicy 导出给 CompressionConfig 使用
  });
});

describe("resolveRuntimePolicy env overrides", () => {
  it("allows LLM_CONTEXT_BUDGET override", () => {
    const profile = getProfile("deepseek-v4");
    const policy = resolveRuntimePolicy(profile, "deepseek-v4", {
      LLM_CONTEXT_BUDGET: "300000",
    });
    expect(policy.context.effectiveBudgetTokens).toBe(300000);
  });

  it("rejects LLM_CONTEXT_BUDGET exceeding window", () => {
    const profile = getProfile("deepseek-v4");
    expect(() =>
      resolveRuntimePolicy(profile, "deepseek-v4", {
        LLM_CONTEXT_BUDGET: "2000000",
      }),
    ).toThrow(/exceeds model context window/);
  });

  it("rejects invalid LLM_CONTEXT_BUDGET", () => {
    const profile = getProfile("generic-openai-compatible");
    expect(() =>
      resolveRuntimePolicy(profile, "some-model", {
        LLM_CONTEXT_BUDGET: "not-a-number",
      }),
    ).toThrow(/Invalid LLM_CONTEXT_BUDGET/);
  });

  it("allows LLM_THINKING=enabled for thinking-capable model", () => {
    const profile = getProfile("deepseek-v4");
    const policy = resolveRuntimePolicy(profile, "deepseek-v4", {
      LLM_THINKING: "enabled",
    });
    expect(policy.request.thinkingMode).toBe("enabled");
  });

  it("rejects LLM_THINKING=enabled for non-thinking model", () => {
    const profile = getProfile("generic-openai-compatible");
    expect(() =>
      resolveRuntimePolicy(profile, "some-model", {
        LLM_THINKING: "enabled",
      }),
    ).toThrow(/does not support thinking mode/);
  });

  it("rejects invalid LLM_THINKING value", () => {
    const profile = getProfile("deepseek-v4");
    expect(() =>
      resolveRuntimePolicy(profile, "deepseek-v4", {
        LLM_THINKING: "maybe",
      }),
    ).toThrow(/Invalid LLM_THINKING/);
  });

  it("allows LLM_REASONING_EFFORT for supported effort", () => {
    const profile = getProfile("deepseek-v4");
    const policy = resolveRuntimePolicy(profile, "deepseek-v4", {
      LLM_REASONING_EFFORT: "default",
    });
    expect(policy.request.reasoningEffort).toBe("default");
  });

  it("rejects unsupported LLM_REASONING_EFFORT", () => {
    const profile = getProfile("kimi-k2.6", "kimi_platform_cn");
    expect(() =>
      resolveRuntimePolicy(profile, "kimi-k2.6", {
        LLM_REASONING_EFFORT: "max",
      }),
    ).toThrow(/does not support reasoning effort/);
  });

  it("allows LLM_MAX_OUTPUT_TOKENS override", () => {
    const profile = getProfile("generic-openai-compatible");
    const policy = resolveRuntimePolicy(profile, "some-model", {
      LLM_MAX_OUTPUT_TOKENS: "2048",
    });
    expect(policy.request.maxOutputTokens).toBe(2048);
  });

  it("rejects LLM_MAX_OUTPUT_TOKENS exceeding profile limit", () => {
    const profile = getProfile("generic-openai-compatible");
    expect(() =>
      resolveRuntimePolicy(profile, "some-model", {
        LLM_MAX_OUTPUT_TOKENS: "10000",
      }),
    ).toThrow(/exceeds profile limit/);
  });

  it("allows explicit LLM_PROTOCOL if implemented", () => {
    const profile = getProfile("generic-openai-compatible");
    const policy = resolveRuntimePolicy(profile, "some-model", {
      LLM_PROTOCOL: "openai-chat-completions",
    });
    expect(policy.protocol.selected).toBe("openai-chat-completions");
    expect(policy.protocol.implemented).toBe(true);
  });

  it("rejects unimplemented explicit LLM_PROTOCOL", () => {
    const profile = getProfile("generic-openai-compatible");
    expect(() =>
      resolveRuntimePolicy(profile, "some-model", {
        LLM_PROTOCOL: "anthropic-messages",
      }),
    ).toThrow(/not implemented yet/);
  });

  it("falls back to implemented protocol when preferred is not implemented", () => {
    const profile = getProfile("minimax-m3", "minimax_cn");
    const policy = resolveRuntimePolicy(profile, "MiniMax-M3");
    // minimax-m3 首选 anthropic-messages（未实现），fallback 到 openai-chat-completions
    expect(policy.protocol.selected).toBe("openai-chat-completions");
    expect(policy.protocol.implemented).toBe(true);
  });

  it("throws when preferred and fallbacks are all unimplemented", () => {
    // 构造一个所有协议都未实现的 profile（仅用于测试）
    const profile: FoundationModelProfile = {
      ...getProfile("generic-openai-compatible"),
      protocol: {
        preferred: "anthropic-messages",
        fallbacks: ["openai-chat-completions"],
        implemented: [],
      },
    };
    expect(() => resolveRuntimePolicy(profile, "some-model")).toThrow(
      /No implemented protocol available/,
    );
  });
});

describe("extractCompressionDefaultsFromPolicy", () => {
  it("extracts compression defaults from policy", () => {
    const profile = getProfile("deepseek-v4");
    const policy = resolveRuntimePolicy(profile, "deepseek-v4");
    const compression = extractCompressionDefaultsFromPolicy(policy);

    expect(compression.thresholdToolOutput).toBe(8000);
    expect(compression.decayThreshold).toBe(8);
    expect(compression.decayPreviewTokens).toBe(400);
    expect(compression.maxContextTokens).toBe(750000);
    expect(compression.compactKeepRecent).toBe(10);
  });
});
