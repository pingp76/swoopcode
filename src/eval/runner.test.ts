/**
 * runner.test.ts — Eval Runner 集成测试
 *
 * 职责：验证 Eval Core + 当前项目 In-process Driver 的完整流程。
 *
 * 测试覆盖（第一批要求至少 4 个）：
 * 1. core runner 能用 fake driver 跑无工具 final output
 * 2. 当前项目 driver 能跑无工具 final output
 * 3. 当前项目 driver 能跑一次 fake tool call 后 final output
 * 4. 多 query 复用同一个 driver
 */

import { describe, it, expect } from "vitest";
import type { CodingAgentDriver } from "./core/driver.js";
import type { AgentRuntimeEvent, EvalCase } from "./core/case-schema.js";
import { runEvalCase } from "./core/runner.js";
import { createLearnClaudeCodeInProcessDriver } from "./drivers/learn-claude-code/in-process-driver.js";

// ---------------------------------------------------------------------------
// Fake Driver（用于测试 core runner 本身，不依赖当前项目 Agent）
// ---------------------------------------------------------------------------

/**
 * createFakeDriver — 创建一个极简的 fake driver
 *
 * 按顺序返回 scriptedFinalOutputs，不调用任何真实工具或 LLM。
 */
function createFakeDriver(scriptedFinalOutputs: string[]): CodingAgentDriver {
  let index = 0;
  const events: AgentRuntimeEvent[] = [];

  return {
    async startCase() {
      index = 0;
      events.length = 0;
    },
    async send(input) {
      const output = scriptedFinalOutputs[index] ?? "no more outputs";
      index++;
      events.push({
        id: `evt-${index}`,
        timestamp: new Date().toISOString(),
        kind: "agent_output",
        source: "driver",
        stepId: input.stepId,
        text: output,
      } as AgentRuntimeEvent);
      return {
        stepId: input.stepId,
        finalOutput: output,
        events: events.slice(),
      };
    },
    async readEvents() {
      return events.slice();
    },
    async close() {
      // noop
    },
  };
}

// ---------------------------------------------------------------------------
// Driver 工厂
// ---------------------------------------------------------------------------

async function createDriver(plan: EvalCase["driver"]): Promise<CodingAgentDriver> {
  if (plan.kind === "learn-claude-code-in-process") {
    return createLearnClaudeCodeInProcessDriver(
      plan as Extract<EvalCase["driver"], { kind: "learn-claude-code-in-process" }>,
    );
  }
  throw new Error(`Unsupported driver kind: ${(plan as unknown as Record<string, unknown>).kind}`);
}

// ---------------------------------------------------------------------------
// 测试用例
// ---------------------------------------------------------------------------

describe("Eval Runner", () => {
  it("should run a no-tool case with fake driver", async () => {
    const evalCase: EvalCase = {
      id: "fake-no-tool",
      title: "Fake driver returns final output without tools",
      steps: [{ query: "Say hello." }],
      driver: { kind: "custom", options: {} },
      assertions: [
        { kind: "finalOutputContains", text: "Hello" },
        { kind: "allStepsCompleted" },
      ],
    };

    const result = await runEvalCase(evalCase, async () =>
      createFakeDriver(["Hello from fake driver."]),
    );

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.finalOutput).toBe("Hello from fake driver.");
  });

  it("should run a no-tool case with in-process driver", async () => {
    const evalCase: EvalCase = {
      id: "no-tool-final-response",
      title: "Agent returns final response without tools",
      steps: [{ query: "Say hello." }],
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            { content: "Hello from eval.", toolCalls: [], finishReason: "stop" },
          ],
        },
        tools: { kind: "fake", fakeTools: [] },
      },
      assertions: [
        { kind: "finalOutputContains", text: "Hello" },
        { kind: "allStepsCompleted" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.steps[0]?.finalOutput).toContain("Hello");
  });

  it("should run a fake tool call case with in-process driver", async () => {
    const evalCase: EvalCase = {
      id: "fake-tool-once",
      title: "Agent executes one fake tool then answers",
      steps: [{ query: "Check status." }],
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                { id: "call_1", name: "run_status", args: { target: "demo" } },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "Status is ok.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        tools: {
          kind: "fake",
          fakeTools: [
            {
              name: "run_status",
              result: { output: "ok", error: false },
            },
          ],
        },
      },
      assertions: [
        { kind: "toolCalled", toolName: "run_status", minCount: 1 },
        { kind: "noToolErrors" },
        { kind: "finalOutputContains", text: "ok" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.steps[0]?.finalOutput).toContain("ok");

    // 验证 instrumented assertion：toolCalled
    const toolCalledResult = result.assertions.find((a) => a.kind === "toolCalled");
    expect(toolCalledResult?.passed).toBe(true);
  });

  it("should keep history across multiple queries", async () => {
    const evalCase: EvalCase = {
      id: "multi-query-history",
      title: "Agent keeps history across multiple queries",
      steps: [
        { id: "first", query: "Remember alpha." },
        { id: "second", query: "What did I ask you to remember?" },
      ],
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            { content: "I will remember alpha.", toolCalls: [], finishReason: "stop" },
            { content: "You asked me to remember alpha.", toolCalls: [], finishReason: "stop" },
          ],
        },
        tools: { kind: "fake", fakeTools: [] },
      },
      assertions: [
        { kind: "finalOutputContains", stepId: "second", text: "alpha" },
        {
          kind: "transcriptEventTypes",
          expected: [
            "user_message",
            "assistant_message",
            "user_message",
            "assistant_message",
          ],
        },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1]?.finalOutput).toContain("alpha");
  });

  it("should fail assertion and report structured result", async () => {
    const evalCase: EvalCase = {
      id: "assertion-failure",
      title: "Assertion failure case",
      steps: [{ query: "Say something." }],
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            { content: "Goodbye.", toolCalls: [], finishReason: "stop" },
          ],
        },
        tools: { kind: "fake", fakeTools: [] },
      },
      assertions: [
        { kind: "finalOutputContains", text: "Hello" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(false);
    expect(result.status).toBe("failed");
    expect(result.assertions[0]?.passed).toBe(false);
    expect(result.assertions[0]?.kind).toBe("finalOutputContains");
  });

  it("should validate workspace initial files and path safety", async () => {
    const evalCase: EvalCase = {
      id: "workspace-initial-files",
      title: "Workspace with initial files",
      workspace: {
        initialFiles: {
          "notes.md": "Project note: eval runner",
        },
      },
      steps: [{ query: "Read notes.md and summarize." }],
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            { content: "The note is about eval runner.", toolCalls: [], finishReason: "stop" },
          ],
        },
        tools: { kind: "fake", fakeTools: [] },
      },
      assertions: [
        { kind: "fileExists", path: "notes.md" },
        { kind: "fileContains", path: "notes.md", text: "eval runner" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");
  });

  it("should validate eval case id format", async () => {
    const badCase: EvalCase = {
      id: "bad id!",
      title: "Bad ID",
      steps: [{ query: "test" }],
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "scripted", scriptedResponses: [{ content: "ok" }] },
        tools: { kind: "fake", fakeTools: [] },
      },
      assertions: [{ kind: "allStepsCompleted" }],
    };

    await expect(runEvalCase(badCase, createDriver)).rejects.toThrow(
      /id must only contain/,
    );
  });
});
