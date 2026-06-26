/**
 * llm-providers.test.ts — Provider Profile 解析规则单元测试
 *
 * 覆盖：provider 默认值、环境变量覆盖优先级、错误提示、能力标记。
 */

import { describe, it, expect } from "vitest";
import {
  resolveLLMProviderConfig,
  getLLMProviderProfile,
} from "./llm-providers.js";

// ============================================================
// 默认值与基础解析
// ============================================================

describe("resolveLLMProviderConfig", () => {
  it("默认 provider 是 openai_compatible", () => {
    const config = resolveLLMProviderConfig({
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://api.test.com/v1",
      LLM_MODEL: "test-model",
    });
    expect(config.provider).toBe("openai_compatible");
    expect(config.displayName).toBe("OpenAI-compatible");
  });

  it("openai_compatible 缺少 LLM_BASE_URL 时失败", () => {
    expect(() =>
      resolveLLMProviderConfig({
        LLM_API_KEY: "sk-test",
        LLM_MODEL: "test-model",
      }),
    ).toThrow("Missing LLM base URL");
  });

  it("openai_compatible 缺少 LLM_MODEL 时失败", () => {
    expect(() =>
      resolveLLMProviderConfig({
        LLM_API_KEY: "sk-test",
        LLM_BASE_URL: "https://api.test.com/v1",
      }),
    ).toThrow("Missing LLM model");
  });

  it("openai_compatible 缺少 apiKey 时失败", () => {
    expect(() =>
      resolveLLMProviderConfig({
        LLM_BASE_URL: "https://api.test.com/v1",
        LLM_MODEL: "test-model",
      }),
    ).toThrow("Missing LLM API key");
  });
});

// ============================================================
// kimi_code_cn 解析
// ============================================================

describe("kimi_code_cn provider", () => {
  it("只设置 KIMI_CODE_API_KEY 时可解析成功", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "kimi_code_cn",
      KIMI_CODE_API_KEY: "sk-kimi-test",
    });
    expect(config.provider).toBe("kimi_code_cn");
    expect(config.apiKey).toBe("sk-kimi-test");
    expect(config.baseURL).toBe("https://api.kimi.com/coding/v1");
    expect(config.model).toBe("kimi-for-coding");
  });

  it("默认 baseURL 是 https://api.kimi.com/coding/v1", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "kimi_code_cn",
      KIMI_CODE_API_KEY: "sk-kimi-test",
    });
    expect(config.baseURL).toBe("https://api.kimi.com/coding/v1");
  });

  it("默认模型是 kimi-for-coding", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "kimi_code_cn",
      KIMI_CODE_API_KEY: "sk-kimi-test",
    });
    expect(config.model).toBe("kimi-for-coding");
  });

  it("LLM_API_KEY 优先于 KIMI_CODE_API_KEY", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "kimi_code_cn",
      LLM_API_KEY: "sk-generic",
      KIMI_CODE_API_KEY: "sk-kimi-test",
    });
    expect(config.apiKey).toBe("sk-generic");
  });

  it("LLM_BASE_URL 优先于默认 baseURL", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "kimi_code_cn",
      KIMI_CODE_API_KEY: "sk-kimi-test",
      LLM_BASE_URL: "https://proxy.example.com/v1",
    });
    expect(config.baseURL).toBe("https://proxy.example.com/v1");
  });

  it("LLM_MODEL 优先于默认模型", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "kimi_code_cn",
      KIMI_CODE_API_KEY: "sk-kimi-test",
      LLM_MODEL: "custom-model",
    });
    expect(config.model).toBe("custom-model");
  });

  it("prefersStreaming 为 true", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "kimi_code_cn",
      KIMI_CODE_API_KEY: "sk-kimi-test",
    });
    expect(config.capabilities.prefersStreaming).toBe(true);
  });
});

// ============================================================
// kimi_platform_cn 解析
// ============================================================

describe("kimi_platform_cn provider", () => {
  it("只设置 MOONSHOT_API_KEY 时可解析成功", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "kimi_platform_cn",
      MOONSHOT_API_KEY: "sk-moonshot-test",
    });
    expect(config.provider).toBe("kimi_platform_cn");
    expect(config.apiKey).toBe("sk-moonshot-test");
    expect(config.baseURL).toBe("https://api.moonshot.cn/v1");
    expect(config.model).toBe("kimi-k2.6");
  });

  it("supportsThinking 为 true", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "kimi_platform_cn",
      MOONSHOT_API_KEY: "sk-moonshot-test",
    });
    expect(config.capabilities.supportsThinking).toBe(true);
  });

  it("LLM_API_KEY 优先于 MOONSHOT_API_KEY", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "kimi_platform_cn",
      LLM_API_KEY: "sk-generic",
      MOONSHOT_API_KEY: "sk-moonshot-test",
    });
    expect(config.apiKey).toBe("sk-generic");
  });
});

// ============================================================
// minimax_cn 解析
// ============================================================

describe("minimax_cn provider", () => {
  it("只设置 MINIMAX_CN_API_KEY 时可解析成功", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "minimax_cn",
      MINIMAX_CN_API_KEY: "sk-minimax-test",
    });
    expect(config.provider).toBe("minimax_cn");
    expect(config.apiKey).toBe("sk-minimax-test");
    expect(config.baseURL).toBe("https://api.minimaxi.com/v1");
    expect(config.model).toBe("MiniMax-M2.7");
  });

  it("MINIMAX_API_KEY 也可作为 fallback", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "minimax_cn",
      MINIMAX_API_KEY: "sk-minimax-fallback",
    });
    expect(config.apiKey).toBe("sk-minimax-fallback");
  });
});

// ============================================================
// zhipuai_cn 解析
// ============================================================

describe("zhipuai_cn provider", () => {
  it("只设置 ZHIPUAI_API_KEY 时可解析成功", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "zhipuai_cn",
      ZHIPUAI_API_KEY: "sk-zhipu-test",
    });
    expect(config.provider).toBe("zhipuai_cn");
    expect(config.apiKey).toBe("sk-zhipu-test");
    expect(config.baseURL).toBe("https://open.bigmodel.cn/api/paas/v4/");
    expect(config.model).toBe("glm-5.2");
  });

  it("BIGMODEL_API_KEY 也可作为 fallback", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "zhipuai_cn",
      BIGMODEL_API_KEY: "sk-bigmodel-fallback",
    });
    expect(config.apiKey).toBe("sk-bigmodel-fallback");
  });

  it("LLM_MODEL 优先于 GLM-5.2 默认模型", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "zhipuai_cn",
      ZHIPUAI_API_KEY: "sk-zhipu-test",
      LLM_MODEL: "glm-5.2-proxy",
    });
    expect(config.model).toBe("glm-5.2-proxy");
  });

  it("声明 supportsThinking 和 prefersStreaming 能力", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "zhipuai_cn",
      ZHIPUAI_API_KEY: "sk-zhipu-test",
    });
    expect(config.capabilities.supportsThinking).toBe(true);
    expect(config.capabilities.prefersStreaming).toBe(true);
  });
});

// ============================================================
// 启发式推断
// ============================================================

describe("baseURL 启发式推断", () => {
  it("未设置 LLM_PROVIDER 时，从 LLM_BASE_URL 推断为 kimi_code_cn", () => {
    const config = resolveLLMProviderConfig({
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://api.kimi.com/coding/v1",
      LLM_MODEL: "kimi-for-coding",
    });
    expect(config.provider).toBe("kimi_code_cn");
    expect(config.capabilities.prefersStreaming).toBe(true);
  });

  it("未设置 LLM_PROVIDER 时，从 LLM_BASE_URL 推断为 minimax_cn", () => {
    const config = resolveLLMProviderConfig({
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://api.minimaxi.com/v1",
      LLM_MODEL: "MiniMax-M2.7",
    });
    expect(config.provider).toBe("minimax_cn");
  });

  it("未设置 LLM_PROVIDER 时，从 LLM_BASE_URL 推断为 kimi_platform_cn", () => {
    const config = resolveLLMProviderConfig({
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://api.moonshot.cn/v1",
      LLM_MODEL: "kimi-k2.6",
    });
    expect(config.provider).toBe("kimi_platform_cn");
  });

  it("未设置 LLM_PROVIDER 时，从 LLM_BASE_URL 推断为 zhipuai_cn", () => {
    const config = resolveLLMProviderConfig({
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://open.bigmodel.cn/api/paas/v4/",
      LLM_MODEL: "glm-5.2",
    });
    expect(config.provider).toBe("zhipuai_cn");
    expect(config.capabilities.supportsThinking).toBe(true);
  });

  it("不匹配的 baseURL 回退到 openai_compatible", () => {
    const config = resolveLLMProviderConfig({
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://proxy.example.com/v1",
      LLM_MODEL: "custom-model",
    });
    expect(config.provider).toBe("openai_compatible");
  });

  it("显式 LLM_PROVIDER 优先于 baseURL 推断", () => {
    const config = resolveLLMProviderConfig({
      LLM_PROVIDER: "openai_compatible",
      LLM_API_KEY: "sk-test",
      LLM_BASE_URL: "https://api.kimi.com/coding/v1",
      LLM_MODEL: "custom-model",
    });
    expect(config.provider).toBe("openai_compatible");
  });
});

// ============================================================
// 错误处理
// ============================================================

describe("错误提示", () => {
  it("未知 provider 报错并列出合法 provider id", () => {
    expect(() =>
      resolveLLMProviderConfig({
        LLM_PROVIDER: "unknown_provider",
        LLM_API_KEY: "sk-test",
        LLM_BASE_URL: "https://api.test.com/v1",
        LLM_MODEL: "test-model",
      }),
    ).toThrow(/Unknown LLM provider "unknown_provider"/);

    expect(() =>
      resolveLLMProviderConfig({
        LLM_PROVIDER: "unknown_provider",
        LLM_API_KEY: "sk-test",
        LLM_BASE_URL: "https://api.test.com/v1",
        LLM_MODEL: "test-model",
      }),
    ).toThrow(/openai_compatible/);
  });

  it("apiKey 缺失错误提示包含 provider id 和候选 key env", () => {
    expect(() =>
      resolveLLMProviderConfig({
        LLM_PROVIDER: "zhipuai_cn",
      }),
    ).toThrow('provider "zhipuai_cn"');

    expect(() =>
      resolveLLMProviderConfig({
        LLM_PROVIDER: "zhipuai_cn",
      }),
    ).toThrow("LLM_API_KEY, ZHIPUAI_API_KEY, BIGMODEL_API_KEY");
  });

  it("错误信息不泄漏已有 key 值", () => {
    // 确保报错信息里不会把已有的 key 打出来
    // 使用 openai_compatible（无默认 baseURL/model），提供 apiKey，让它在 baseURL 阶段报错
    const env = {
      LLM_PROVIDER: "openai_compatible",
      LLM_API_KEY: "sk-secret-value",
    };
    expect(() => resolveLLMProviderConfig(env)).toThrow("Missing LLM base URL");
    // 确认报错信息里没有出现 key 值
    let thrown = false;
    try {
      resolveLLMProviderConfig(env);
    } catch (err) {
      thrown = true;
      const msg = err instanceof Error ? err.message : String(err);
      expect(msg).not.toContain("sk-secret-value");
    }
    expect(thrown).toBe(true);
  });
});

// ============================================================
// getLLMProviderProfile
// ============================================================

describe("getLLMProviderProfile", () => {
  it("能获取已知的 profile", () => {
    const profile = getLLMProviderProfile("kimi_code_cn");
    expect(profile.id).toBe("kimi_code_cn");
    expect(profile.displayName).toBe("Kimi Code CN");
  });

  it("未知 id 抛出错误", () => {
    expect(() => getLLMProviderProfile("not_a_provider")).toThrow(
      "Unknown LLM provider",
    );
  });
});
