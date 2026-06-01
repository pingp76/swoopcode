/**
 * llm-logger.test.ts — LLM 通信日志轮转测试
 *
 * LLM 日志通常比普通 agent.log 更容易变大，因为它记录完整 prompt、
 * 工具定义和模型响应。这里验证它不再通过清空文件控制大小，而是保留
 * 可追溯的轮转历史。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLLMLogger } from "./llm-logger.js";
import type { LLMResponse } from "./llm.js";

describe("createLLMLogger", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-logger-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rotates llm.log instead of clearing previous content", () => {
    const logger = createLLMLogger({
      logDir: tempDir,
      maxSize: 20,
      keepFiles: 2,
    });
    const response: LLMResponse = {
      content: "a long model response",
      toolCalls: [],
      finishReason: "stop",
      assistantMessage: {
        role: "assistant",
        content: "a long model response",
      } as import("openai/resources/chat/completions").ChatCompletionMessageParam,
    };

    logger.logResponse(response, 123);

    const logFile = path.join(tempDir, "llm.log");
    expect(fs.readFileSync(`${logFile}.1`, "utf-8")).toContain("[BOOT]");
    expect(fs.readFileSync(logFile, "utf-8")).toContain("[RESPONSE]");
    expect(fs.existsSync(`${logFile}.3`)).toBe(false);
  });
});
