/**
 * recovery.test.ts — 错误恢复模块单元测试
 *
 * 覆盖 classifyLLMError、decideRecovery、formatRecoveryNotice、formatFailureMessage。
 */

import { describe, it, expect } from "vitest";
import {
  classifyLLMError,
  decideRecovery,
  formatRecoveryNotice,
  formatFailureMessage,
  createRecoveryState,
  DEFAULT_RECOVERY_CONFIG,
} from "./recovery.js";

// ---------------------------------------------------------------------------
// classifyLLMError
// ---------------------------------------------------------------------------

describe("classifyLLMError", () => {
  it("401 -> credential", () => {
    expect(classifyLLMError({ status: 401, message: "Unauthorized" })).toBe(
      "credential",
    );
  });

  it("403 -> credential", () => {
    expect(classifyLLMError({ status: 403, message: "Forbidden" })).toBe(
      "credential",
    );
  });

  it("429 with quota message -> quota", () => {
    expect(
      classifyLLMError({ status: 429, message: "insufficient_quota" }),
    ).toBe("quota");
  });

  it("429 with balance message -> quota", () => {
    expect(
      classifyLLMError({ status: 429, message: "You exceeded your balance" }),
    ).toBe("quota");
  });

  it("429 without quota message -> rate_limit", () => {
    expect(
      classifyLLMError({ status: 429, message: "Too many requests" }),
    ).toBe("rate_limit");
  });

  it("400 with context length message -> context_length", () => {
    expect(
      classifyLLMError({
        status: 400,
        message: "This model's maximum context length is 4097 tokens",
      }),
    ).toBe("context_length");
  });

  it("413 -> context_length", () => {
    expect(classifyLLMError({ status: 413, message: "Payload Too Large" })).toBe(
      "context_length",
    );
  });

  it("500 -> network", () => {
    expect(classifyLLMError({ status: 500, message: "Internal Server Error" })).toBe(
      "network",
    );
  });

  it("502 -> network", () => {
    expect(classifyLLMError({ status: 502, message: "Bad Gateway" })).toBe(
      "network",
    );
  });

  it("503 -> network", () => {
    expect(classifyLLMError({ status: 503, message: "Service Unavailable" })).toBe(
      "network",
    );
  });

  it("504 -> network", () => {
    expect(classifyLLMError({ status: 504, message: "Gateway Timeout" })).toBe(
      "network",
    );
  });

  it("timeout message -> network", () => {
    expect(classifyLLMError({ message: "Request timeout" })).toBe("network");
  });

  it("ECONNRESET message -> network", () => {
    expect(classifyLLMError({ message: "read ECONNRESET" })).toBe("network");
  });

  it("ETIMEDOUT message -> network", () => {
    expect(classifyLLMError({ message: "connect ETIMEDOUT" })).toBe("network");
  });

  it("ENOTFOUND message -> network", () => {
    expect(classifyLLMError({ message: "getaddrinfo ENOTFOUND" })).toBe(
      "network",
    );
  });

  it("AbortError message -> network", () => {
    expect(classifyLLMError({ message: "AbortError: user aborted" })).toBe(
      "network",
    );
  });

  it("unknown error -> unknown", () => {
    expect(classifyLLMError({ message: "something weird happened" })).toBe(
      "unknown",
    );
  });

  it("message from Error instance -> credential", () => {
    const err = new Error("invalid api key provided");
    expect(classifyLLMError(err)).toBe("credential");
  });
});

// ---------------------------------------------------------------------------
// decideRecovery
// ---------------------------------------------------------------------------

describe("decideRecovery", () => {
  it("network within limit -> backoff", () => {
    const state = createRecoveryState();
    state.apiRetryCount = 2;
    expect(decideRecovery("network", state)).toBe("backoff");
  });

  it("network over limit -> fail", () => {
    const state = createRecoveryState();
    state.apiRetryCount = DEFAULT_RECOVERY_CONFIG.maxApiRetries;
    expect(decideRecovery("network", state)).toBe("fail");
  });

  it("rate_limit within limit -> backoff", () => {
    const state = createRecoveryState();
    state.apiRetryCount = 4;
    expect(decideRecovery("rate_limit", state)).toBe("backoff");
  });

  it("rate_limit over limit -> fail", () => {
    const state = createRecoveryState();
    state.apiRetryCount = DEFAULT_RECOVERY_CONFIG.maxApiRetries;
    expect(decideRecovery("rate_limit", state)).toBe("fail");
  });

  it("context_length within limit -> compact", () => {
    const state = createRecoveryState();
    expect(decideRecovery("context_length", state)).toBe("compact");
  });

  it("context_length over limit -> fail", () => {
    const state = createRecoveryState();
    state.compactRetryCount = DEFAULT_RECOVERY_CONFIG.maxCompactRetries;
    expect(decideRecovery("context_length", state)).toBe("fail");
  });

  it("output_interrupted within limit -> continue", () => {
    const state = createRecoveryState();
    expect(decideRecovery("output_interrupted", state)).toBe("continue");
  });

  it("output_interrupted over limit -> fail", () => {
    const state = createRecoveryState();
    state.continueRetryCount = DEFAULT_RECOVERY_CONFIG.maxContinueRetries;
    expect(decideRecovery("output_interrupted", state)).toBe("fail");
  });

  it("credential -> always fail", () => {
    const state = createRecoveryState();
    expect(decideRecovery("credential", state)).toBe("fail");
  });

  it("quota -> always fail", () => {
    const state = createRecoveryState();
    expect(decideRecovery("quota", state)).toBe("fail");
  });

  it("unknown -> always fail", () => {
    const state = createRecoveryState();
    expect(decideRecovery("unknown", state)).toBe("fail");
  });
});

// ---------------------------------------------------------------------------
// formatRecoveryNotice
// ---------------------------------------------------------------------------

describe("formatRecoveryNotice", () => {
  it("backoff notice includes retry count", () => {
    const state = createRecoveryState();
    state.apiRetryCount = 1;
    const notice = formatRecoveryNotice("backoff", "network", state);
    expect(notice).toContain("重试 1/5");
    expect(notice).toContain("3 秒后继续");
  });

  it("compact notice", () => {
    const notice = formatRecoveryNotice("compact", "context_length", createRecoveryState());
    expect(notice).toContain("压缩历史后重试");
  });

  it("continue notice includes retry count", () => {
    const state = createRecoveryState();
    state.continueRetryCount = 1;
    const notice = formatRecoveryNotice("continue", "output_interrupted", state);
    expect(notice).toContain("从断点继续 1/2");
  });

  it("fail notice for network", () => {
    const state = createRecoveryState();
    state.apiRetryCount = DEFAULT_RECOVERY_CONFIG.maxApiRetries;
    const notice = formatRecoveryNotice("fail", "network", state);
    expect(notice).toContain("已达到最大重试次数");
  });

  it("fail notice for context_length", () => {
    const state = createRecoveryState();
    state.compactRetryCount = DEFAULT_RECOVERY_CONFIG.maxCompactRetries;
    const notice = formatRecoveryNotice("fail", "context_length", state);
    expect(notice).toContain("压缩后仍然超过模型窗口");
  });

  it("fail notice for output_interrupted", () => {
    const state = createRecoveryState();
    state.continueRetryCount = DEFAULT_RECOVERY_CONFIG.maxContinueRetries;
    const notice = formatRecoveryNotice("fail", "output_interrupted", state);
    expect(notice).toContain("已达到继续次数上限");
  });
});

// ---------------------------------------------------------------------------
// formatFailureMessage
// ---------------------------------------------------------------------------

describe("formatFailureMessage", () => {
  it("credential message", () => {
    expect(formatFailureMessage("credential")).toContain("认证配置错误");
  });

  it("quota message", () => {
    expect(formatFailureMessage("quota")).toContain("额度或账户余额不足");
  });

  it("context_length message", () => {
    expect(formatFailureMessage("context_length")).toContain("开启新会话或减少上下文");
  });

  it("output_interrupted message", () => {
    expect(formatFailureMessage("output_interrupted")).toContain("多次被截断");
  });

  it("network message includes original error", () => {
    const msg = formatFailureMessage("network", new Error("timeout"));
    expect(msg).toContain("暂时不可用");
    expect(msg).toContain("timeout");
  });

  it("unknown message includes original error", () => {
    const msg = formatFailureMessage("unknown", new Error("boom"));
    expect(msg).toContain("未知错误");
    expect(msg).toContain("boom");
  });
});
