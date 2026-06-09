/**
 * live-suite.test.ts — Live Smoke Eval Suite
 *
 * 职责：使用真实 LLM 验证 agent 的基本行为。
 *
 * 启用条件：EVAL_LIVE=1 环境变量。
 * 默认 skip，避免 CI 因缺少 API key 而失败。
 */

import { describe, it, expect } from "vitest";
import type { CodingAgentDriver } from "../core/driver.js";
import type { EvalCase } from "../core/case-schema.js";
import { runEvalCase } from "../core/runner.js";
import { createLearnClaudeCodeInProcessDriver } from "../drivers/learn-claude-code/in-process-driver.js";

async function createDriver(plan: EvalCase["driver"]): Promise<CodingAgentDriver> {
  if (plan.kind === "learn-claude-code-in-process") {
    return createLearnClaudeCodeInProcessDriver(
      plan as Extract<EvalCase["driver"], { kind: "learn-claude-code-in-process" }>,
    );
  }
  throw new Error(`Unsupported driver kind: ${(plan as unknown as Record<string, unknown>).kind}`);
}

const liveEnabled = process.env["EVAL_LIVE"] === "1";

const suite = liveEnabled ? describe : describe.skip;

suite("Live Smoke Suite", () => {
  it(
    "agent completes a simple greeting step",
    async () => {
      const evalCase: EvalCase = {
        id: "live-hello",
        title: "Live: simple greeting",
        mode: "live",
        driver: {
          kind: "learn-claude-code-in-process",
          llm: { kind: "live", live: { maxCalls: 5 } },
          tools: { kind: "core" },
          maxRounds: 5,
        },
        steps: [{ query: "Say hello and confirm you are ready." }],
        assertions: [
          { kind: "allStepsCompleted" },
          { kind: "noToolErrors" },
        ],
      };

      const result = await runEvalCase(evalCase, createDriver);

      // live case 只做结构性断言，不强制文本匹配（真实 LLM 输出不稳定）
      expect(result.status).toBe("passed");
      expect(result.passed).toBe(true);
      expect(result.steps).toHaveLength(1);
      expect(result.steps[0]?.finalOutput).toBeTruthy();
    },
    30000,
  );

  it(
    "agent reads a provided fixture file",
    async () => {
      const evalCase: EvalCase = {
        id: "live-read-file",
        title: "Live: read fixture file",
        mode: "live",
        workspace: {
          initialFiles: {
            "info.txt": "The answer is 42.",
          },
        },
        driver: {
          kind: "learn-claude-code-in-process",
          llm: { kind: "live", live: { maxCalls: 8 } },
          tools: { kind: "core" },
          maxRounds: 8,
        },
        steps: [{ query: "Read info.txt and tell me what it says." }],
        assertions: [
          { kind: "allStepsCompleted" },
          { kind: "toolCalled", toolName: "run_read" },
          { kind: "noToolErrors" },
        ],
      };

      const result = await runEvalCase(evalCase, createDriver);

      expect(result.status).toBe("passed");
      expect(result.passed).toBe(true);
      expect(result.steps).toHaveLength(1);
    },
    30000,
  );
});
