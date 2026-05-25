/**
 * config.test.ts — 配置加载模块单元测试
 *
 * 覆盖：loadConfig() 解析 provider 字段、compression/logLevel 默认值、错误信息不泄漏 key。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// 在 import 之前 mock llm-providers，以便控制 resolver 的返回值
const mockResolveLLMProviderConfig = vi.fn();

vi.mock("./llm-providers.js", () => ({
  resolveLLMProviderConfig: mockResolveLLMProviderConfig,
}));

// 动态 import config.ts，确保它在 mock 之后加载
// 但由于 dotenv/config 的副作用和模块缓存，我们直接用 mock 后的函数测试
const { loadConfig } = await import("./config.js");

describe("loadConfig", () => {
  // 保存原始环境变量
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockResolveLLMProviderConfig.mockReset();
  });

  afterEach(() => {
    // 恢复环境变量
    for (const key of Object.keys(process.env)) {
      delete process.env[key];
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value !== undefined) {
        process.env[key] = value;
      }
    }
  });

  it("能把 resolved provider 字段写入 Config", () => {
    mockResolveLLMProviderConfig.mockReturnValue({
      provider: "kimi_code_cn",
      displayName: "Kimi Code CN",
      apiKey: "sk-kimi-test",
      baseURL: "https://api.kimi.com/coding/v1",
      model: "kimi-for-coding",
      capabilities: {
        supportsTools: true,
        supportsToolChoiceRequired: false,
        prefersStreaming: true,
        supportsThinking: false,
      },
    });

    const config = loadConfig();

    expect(config.provider).toBe("kimi_code_cn");
    expect(config.providerDisplayName).toBe("Kimi Code CN");
    expect(config.apiKey).toBe("sk-kimi-test");
    expect(config.baseURL).toBe("https://api.kimi.com/coding/v1");
    expect(config.model).toBe("kimi-for-coding");
    expect(config.llmCapabilities.prefersStreaming).toBe(true);
  });

  it("compression 默认值不受 provider 变更影响", () => {
    mockResolveLLMProviderConfig.mockReturnValue({
      provider: "openai_compatible",
      displayName: "OpenAI-compatible",
      apiKey: "sk-test",
      baseURL: "https://api.test.com/v1",
      model: "test-model",
      capabilities: {
        supportsTools: true,
        supportsToolChoiceRequired: false,
        prefersStreaming: false,
        supportsThinking: false,
      },
    });

    const config = loadConfig();

    expect(config.compression.thresholdToolOutput).toBe(2000);
    expect(config.compression.decayThreshold).toBe(3);
    expect(config.compression.decayPreviewTokens).toBe(100);
    expect(config.compression.maxContextTokens).toBe(80000);
    expect(config.compression.compactKeepRecent).toBe(4);
  });

  it("logLevel 默认值为 info", () => {
    // 显式清除 LOG_LEVEL，避免 .env 文件中的值干扰测试
    delete process.env["LOG_LEVEL"];

    mockResolveLLMProviderConfig.mockReturnValue({
      provider: "openai_compatible",
      displayName: "OpenAI-compatible",
      apiKey: "sk-test",
      baseURL: "https://api.test.com/v1",
      model: "test-model",
      capabilities: {
        supportsTools: true,
        supportsToolChoiceRequired: false,
        prefersStreaming: false,
        supportsThinking: false,
      },
    });

    const config = loadConfig();
    expect(config.logLevel).toBe("info");
  });

  it("logLevel 可被 LOG_LEVEL 环境变量覆盖", () => {
    process.env["LOG_LEVEL"] = "debug";

    mockResolveLLMProviderConfig.mockReturnValue({
      provider: "openai_compatible",
      displayName: "OpenAI-compatible",
      apiKey: "sk-test",
      baseURL: "https://api.test.com/v1",
      model: "test-model",
      capabilities: {
        supportsTools: true,
        supportsToolChoiceRequired: false,
        prefersStreaming: false,
        supportsThinking: false,
      },
    });

    const config = loadConfig();
    expect(config.logLevel).toBe("debug");
  });

  it("认证错误信息不泄漏 key 值", () => {
    mockResolveLLMProviderConfig.mockImplementation(() => {
      const err = new Error(
        'Missing LLM API key for provider "kimi_code_cn". Set one of: LLM_API_KEY, KIMI_CODE_API_KEY.',
      );
      throw err;
    });

    expect(() => loadConfig()).toThrow("Missing LLM API key");
    expect(() => loadConfig()).toThrow("kimi_code_cn");

    let thrown = false;
    try {
      loadConfig();
    } catch (err) {
      thrown = true;
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("sk-");
    }
    expect(thrown).toBe(true);
  });
});
