/**
 * judge-suite.test.ts — Judge 集成测试
 *
 * 职责：验证 judge 的 prompt builder、JSON 解析和评分逻辑。
 *
 * 设计决策：
 * - 使用 scripted judge LLM（不调用真实模型），确保测试确定性。
 * - 覆盖正常评分、JSON 解析失败降级、hard assertions 失败时 judge 不覆盖结果。
 */

import { describe, it, expect } from "vitest";
import type { LLMClient } from "../../llm.js";
import type { EvalJudgeInput } from "../core/case-schema.js";
import { runJudge, parseJudgeResponse } from "./judge.js";

/**
 * createScriptedJudgeLLM — 创建返回预设 JSON 的 scripted judge LLM
 *
 * @param responses - 预设的 JSON 字符串响应序列
 */
function createScriptedJudgeLLM(responses: string[]): LLMClient {
  let index = 0;
  return {
    async chat() {
      const text = responses[index] ?? '{"passed":false,"score":0,"summary":"No more responses"}';
      index += 1;
      return {
        content: text,
        toolCalls: [],
        finishReason: "stop",
        assistantMessage: { role: "assistant", content: text },
      };
    },
  };
}

/** 构造一个最小可用的 EvalJudgeInput */
function makeJudgeInput(): EvalJudgeInput {
  return {
    caseId: "test-case",
    title: "Test Case",
    description: undefined,
    userQueries: ["Say hello."],
    finalOutputs: ["Hello!"],
    runtimeEvents: [],
    hardAssertionResults: [
      { kind: "finalOutputContains", passed: true, message: "Output contains hello" },
    ],
    rubric: {
      goal: "Agent should greet the user politely.",
      passCriteria: ["Output is friendly", "No tool errors"],
      failCriteria: ["Output is empty", "Tool call errors"],
      scoring: { minPassingScore: 7, maxScore: 10 },
    },
  };
}

describe("Judge", () => {
  it("returns a valid judge result for well-formed JSON", async () => {
    const judgeLLM = createScriptedJudgeLLM([
      JSON.stringify({
        passed: true,
        score: 8,
        summary: "Good greeting.",
        strengths: ["Friendly tone"],
        problems: [],
        evidence: [{ kind: "final_output", ref: "step_0", note: "Says hello" }],
        needsHumanReview: false,
      }),
    ]);

    const result = await runJudge(makeJudgeInput(), judgeLLM);

    expect(result.enabled).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(8);
    expect(result.summary).toBe("Good greeting.");
    expect(result.strengths).toContain("Friendly tone");
    expect(result.needsHumanReview).toBe(false);
  });

  it("handles JSON wrapped in markdown code block", async () => {
    const judgeLLM = createScriptedJudgeLLM([
      '```json\n{"passed":true,"score":9,"summary":"Excellent.","strengths":[],"problems":[],"evidence":[],"needsHumanReview":false}\n```',
    ]);

    const result = await runJudge(makeJudgeInput(), judgeLLM);

    expect(result.enabled).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.score).toBe(9);
  });

  it("returns judge_failed when JSON is invalid", async () => {
    const judgeLLM = createScriptedJudgeLLM(["This is not JSON at all."]);

    const result = await runJudge(makeJudgeInput(), judgeLLM);

    expect(result.enabled).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.summary).toBe("Judge JSON parse failed");
    expect(result.needsHumanReview).toBe(true);
  });

  it("returns judge_failed when required fields are missing", async () => {
    const judgeLLM = createScriptedJudgeLLM([JSON.stringify({ passed: true })]);

    const result = await runJudge(makeJudgeInput(), judgeLLM);

    expect(result.enabled).toBe(true);
    expect(result.passed).toBe(false);
    expect(result.summary).toContain("validation failed");
    expect(result.needsHumanReview).toBe(true);
  });

  it("parseJudgeResponse extracts JSON from nested text", () => {
    const parsed = parseJudgeResponse('Some preamble {"passed":true,"score":5,"summary":"ok"} trailing text');
    expect(parsed).toEqual({ passed: true, score: 5, summary: "ok" });
  });

  it("parseJudgeResponse returns null for completely invalid text", () => {
    const parsed = parseJudgeResponse("no json here");
    expect(parsed).toBeNull();
  });

  it("parseJudgeResponse extracts nested JSON with evidence array from extra text", () => {
    const judgeObj = {
      passed: true,
      score: 7,
      summary: "ok",
      strengths: [],
      problems: [],
      evidence: [{ kind: "runtime_event", ref: "evt-1", note: "tool called" }],
      needsHumanReview: false,
    };
    const parsed = parseJudgeResponse(`Preamble ${JSON.stringify(judgeObj)} trailing text`);
    expect(parsed).toEqual(judgeObj);
  });
});
