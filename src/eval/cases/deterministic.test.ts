/**
 * deterministic.test.ts — Deterministic Eval Suite
 *
 * 职责：使用 scripted LLM 和真实核心工具，验证 eval 系统的确定性行为。
 *
 * 设计原则：
 * - 所有 case 使用 scripted 模式，不依赖真实 LLM，确保任何环境都能稳定通过
 * - Core tool cases 验证 bash/read/write/edit/editExact 在 eval 场景中的正确性
 * - CLI smoke case 验证黑盒 driver 的最小可用性
 */

import { describe, it, expect } from "vitest";
import type { CodingAgentDriver } from "../core/driver.js";
import type { EvalCase, CliDriverPlan } from "../core/case-schema.js";
import { runEvalCase } from "../core/runner.js";
import { createLearnClaudeCodeInProcessDriver } from "../drivers/learn-claude-code/in-process-driver.js";
import { createCliDriver } from "../drivers/cli/cli-driver.js";

// ---------------------------------------------------------------------------
// Driver 工厂
// ---------------------------------------------------------------------------

async function createDriver(plan: EvalCase["driver"]): Promise<CodingAgentDriver> {
  if (plan.kind === "learn-claude-code-in-process") {
    return createLearnClaudeCodeInProcessDriver(
      plan as Extract<EvalCase["driver"], { kind: "learn-claude-code-in-process" }>,
    );
  }
  if (plan.kind === "cli") {
    return createCliDriver(plan as CliDriverPlan);
  }
  throw new Error(`Unsupported driver kind: ${(plan as unknown as Record<string, unknown>).kind}`);
}

// ---------------------------------------------------------------------------
// Core Tool Cases
// ---------------------------------------------------------------------------

describe("Deterministic Suite — Core Tools", () => {
  it("writes a file using run_write", async () => {
    const evalCase: EvalCase = {
      id: "core-write-file",
      title: "Core tool: write file",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_1",
                  name: "run_write",
                  args: { path: "world.txt", content: "hello" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "File written successfully.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        tools: { kind: "core" },
      },
      steps: [{ query: "Write hello to world.txt" }],
      assertions: [
        { kind: "fileExists", path: "world.txt" },
        { kind: "fileContains", path: "world.txt", text: "hello" },
        { kind: "allToolsSucceeded" },
        // 验证 toolNotCalled：本次 case 没有调用 run_bash
        { kind: "toolNotCalled", toolName: "run_bash" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");

    // 验证 instrumented assertions
    const fileExistsResult = result.assertions.find((a) => a.kind === "fileExists");
    expect(fileExistsResult?.passed).toBe(true);

    const allToolsSucceededResult = result.assertions.find((a) => a.kind === "allToolsSucceeded");
    expect(allToolsSucceededResult?.passed).toBe(true);
  });

  it("reads a file using run_read", async () => {
    const evalCase: EvalCase = {
      id: "core-read-file",
      title: "Core tool: read file",
      workspace: {
        initialFiles: {
          "data.txt": "apple banana cherry",
        },
      },
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_1",
                  name: "run_read",
                  args: { path: "data.txt" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "The file contains: apple banana cherry",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        tools: { kind: "core" },
      },
      steps: [{ query: "Read data.txt" }],
      assertions: [
        { kind: "finalOutputContains", text: "apple banana cherry" },
        { kind: "toolCalled", toolName: "run_read" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");

    const toolCalledResult = result.assertions.find((a) => a.kind === "toolCalled");
    expect(toolCalledResult?.passed).toBe(true);
  });

  it("edits a file using run_edit_exact", async () => {
    const evalCase: EvalCase = {
      id: "core-edit-exact",
      title: "Core tool: edit exact",
      workspace: {
        initialFiles: {
          "greet.ts": "console.log('hello');",
        },
      },
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_1",
                  name: "run_edit_exact",
                  args: {
                    path: "greet.ts",
                    old_string: "console.log('hello');",
                    new_string: "console.log('hi');",
                    expected_occurrences: 1,
                  },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "Edited successfully.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        tools: { kind: "core" },
      },
      steps: [{ query: "Change hello to hi" }],
      assertions: [
        { kind: "fileContains", path: "greet.ts", text: "console.log('hi');" },
        { kind: "allToolsSucceeded" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");
  });

  it("executes a safe bash command using run_bash", async () => {
    const evalCase: EvalCase = {
      id: "core-bash-readonly",
      title: "Core tool: bash readonly",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_1",
                  name: "run_bash",
                  args: { command: "echo hello_eval" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "Command output: hello_eval",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        tools: { kind: "core" },
      },
      steps: [{ query: "Echo hello_eval" }],
      assertions: [
        { kind: "finalOutputContains", text: "hello_eval" },
        { kind: "toolCallCount", toolName: "run_bash", count: 1 },
        // 验证 toolArgsContain：run_bash 的参数中包含预期文本
        { kind: "toolArgsContain", toolName: "run_bash", text: "hello_eval" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");

    const toolCallCountResult = result.assertions.find((a) => a.kind === "toolCallCount");
    expect(toolCallCountResult?.passed).toBe(true);
  });

  it("shows permission prompt in default mode", async () => {
    const evalCase: EvalCase = {
      id: "core-permission-prompt",
      title: "Core tool: permission prompt shown in default mode",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "scripted",
          scriptedResponses: [
            {
              content: null,
              toolCalls: [
                {
                  id: "call_1",
                  name: "run_write",
                  args: { path: "allowed.txt", content: "yes" },
                },
              ],
              finishReason: "tool_calls",
            },
            {
              content: "Permission granted and file written.",
              toolCalls: [],
              finishReason: "stop",
            },
          ],
        },
        // default 模式下 run_write 会触发 askUser，从而发射 permission_prompt 事件
        tools: { kind: "core", core: { permissionMode: "default" } },
        terminal: {
          permissionAnswers: [true],
        },
      },
      steps: [{ query: "Write allowed.txt" }],
      assertions: [
        { kind: "permissionPromptShown" },
        { kind: "fileExists", path: "allowed.txt" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");

    const permissionResult = result.assertions.find((a) => a.kind === "permissionPromptShown");
    expect(permissionResult?.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// CLI Driver Smoke Case
// ---------------------------------------------------------------------------

describe("Deterministic Suite — CLI Driver", () => {
  it("echoes input through cat command", async () => {
    const evalCase: EvalCase = {
      id: "cli-echo-smoke",
      title: "CLI driver echo smoke",
      driver: {
        kind: "cli",
        command: "cat",
        args: [],
      },
      steps: [{ query: "hello cli" }],
      assertions: [
        { kind: "finalOutputContains", text: "hello cli" },
        { kind: "exitCodeIs", code: 0 },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.steps[0]?.finalOutput).toContain("hello cli");
  });
});
