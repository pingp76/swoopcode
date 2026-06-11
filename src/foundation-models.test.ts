/**
 * foundation-models.test.ts — 基座模型画像解析测试
 */

import { describe, expect, it } from "vitest";
import {
  resolveFoundationModelProfile,
  getRegisteredModelProfileIds,
} from "./foundation-models.js";

describe("resolveFoundationModelProfile", () => {
  it("falls back to generic-openai-compatible for unknown model", () => {
    const result = resolveFoundationModelProfile({
      provider: "openai_compatible",
      model: "some-unknown-model",
    });
    expect(result.id).toBe("generic-openai-compatible");
  });

  it("matches exact model id for kimi-k2.6", () => {
    const result = resolveFoundationModelProfile({
      provider: "kimi_platform_cn",
      model: "kimi-k2.6",
    });
    expect(result.id).toBe("kimi-k2.6");
    expect(result.provider).toBe("kimi_platform_cn");
    expect(result.thinking.supported).toBe(true);
    expect(result.reasoning.mustReplayWithToolCalls).toBe(true);
  });

  it("matches prefix for kimi-k2.x models", () => {
    const result = resolveFoundationModelProfile({
      provider: "kimi_platform_cn",
      model: "kimi-k2.5-preview",
    });
    expect(result.id).toBe("kimi-k2.6");
  });

  it("matches exact model id for kimi-for-coding", () => {
    const result = resolveFoundationModelProfile({
      provider: "kimi_code_cn",
      model: "kimi-for-coding",
    });
    expect(result.id).toBe("kimi-code");
    expect(result.provider).toBe("kimi_code_cn");
    expect(result.optimizationHints.prefersStreaming).toBe(true);
  });

  it("matches exact model id for MiniMax-M2.7", () => {
    const result = resolveFoundationModelProfile({
      provider: "minimax_cn",
      model: "MiniMax-M2.7",
    });
    expect(result.id).toBe("minimax-m2.7");
  });

  it("matches deepseek-v4 by exact id", () => {
    const result = resolveFoundationModelProfile({
      provider: "openai_compatible",
      model: "deepseek-v4",
    });
    expect(result.id).toBe("deepseek-v4");
    expect(result.limits.contextWindowTokens).toBe(1000000);
    expect(result.optimizationHints.defaultCompressionMode).toBe(
      "long_context",
    );
  });

  it("matches deepseek-chat by prefix", () => {
    const result = resolveFoundationModelProfile({
      provider: "openai_compatible",
      model: "deepseek-chat-2024",
    });
    expect(result.id).toBe("deepseek-v4");
  });

  it("uses explicit profile id when provided", () => {
    const result = resolveFoundationModelProfile({
      provider: "kimi_platform_cn",
      model: "some-alias",
      explicitProfileId: "kimi-k2.6",
    });
    expect(result.id).toBe("kimi-k2.6");
  });

  it("throws for unknown explicit profile id", () => {
    expect(() =>
      resolveFoundationModelProfile({
        provider: "kimi_platform_cn",
        model: "kimi-k2.6",
        explicitProfileId: "nonexistent-profile",
      }),
    ).toThrow(/Unknown model profile/);
  });

  it("throws when explicit profile provider mismatches", () => {
    expect(() =>
      resolveFoundationModelProfile({
        provider: "minimax_cn",
        model: "MiniMax-M2.7",
        explicitProfileId: "kimi-k2.6",
      }),
    ).toThrow(
      /provider "kimi_platform_cn".*but current provider is "minimax_cn"/,
    );
  });

  it("returns provider default before generic for known provider", () => {
    // kimi_platform_cn 有 kimi-k2.6 profile，应返回它而不是 generic
    const result = resolveFoundationModelProfile({
      provider: "kimi_platform_cn",
      model: "totally-unknown-kimi-model",
    });
    expect(result.provider).toBe("kimi_platform_cn");
    expect(result.id).toBe("kimi-k2.6");
  });

  it("returns generic for unknown openai_compatible model", () => {
    const result = resolveFoundationModelProfile({
      provider: "openai_compatible",
      model: "custom-model",
    });
    expect(result.id).toBe("generic-openai-compatible");
    expect(result.limits.effectiveContextBudgetTokens).toBe(60000);
  });

  it("does not match by fuzzy includes across providers", () => {
    // minimax_cn 的模型名包含 "kimi" 时不应匹配到 kimi profile
    const result = resolveFoundationModelProfile({
      provider: "minimax_cn",
      model: "some-kimi-lookalike",
    });
    expect(result.provider).toBe("minimax_cn");
    // 应返回 minimax 默认（minimax-m2.7），而不是 kimi
    expect(result.id).not.toContain("kimi");
  });
});

describe("getRegisteredModelProfileIds", () => {
  it("returns all profile ids", () => {
    const ids = getRegisteredModelProfileIds();
    expect(ids).toContain("generic-openai-compatible");
    expect(ids).toContain("kimi-k2.6");
    expect(ids).toContain("kimi-code");
    expect(ids).toContain("minimax-m2.7");
    expect(ids).toContain("deepseek-v4");
    expect(ids).toContain("minimax-m3");
    expect(ids).toContain("mimo-v2.5-pro");
    expect(ids).toContain("qwen3.7-max");
    expect(ids).toContain("glm-5.1");
  });
});
