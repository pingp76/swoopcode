/**
 * replay-suite.test.ts — Replay Eval Suite
 *
 * 职责：验证 replay fixture 能正确读取并驱动 agent，产生与 scripted 一致的结果。
 */

import { describe, it, expect } from "vitest";
import type { CodingAgentDriver } from "../core/driver.js";
import type { EvalCase } from "../core/case-schema.js";
import { runEvalCase } from "../core/runner.js";
import { createLearnClaudeCodeInProcessDriver } from "../drivers/learn-claude-code/in-process-driver.js";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

async function createDriver(
  plan: EvalCase["driver"],
): Promise<CodingAgentDriver> {
  if (plan.kind === "learn-claude-code-in-process") {
    return createLearnClaudeCodeInProcessDriver(
      plan as Extract<
        EvalCase["driver"],
        { kind: "learn-claude-code-in-process" }
      >,
    );
  }
  throw new Error(
    `Unsupported driver kind: ${(plan as unknown as Record<string, unknown>).kind}`,
  );
}

describe("Replay Suite", () => {
  it("reads a file using replay fixture", async () => {
    const evalCase: EvalCase = {
      id: "replay-read-file",
      title: "Replay: read file",
      mode: "replay",
      workspace: {
        initialFiles: {
          "data.txt": "apple banana cherry",
        },
      },
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "replay",
          replayFile: join(__dirname, "fixtures", "replay-read.json"),
        },
        tools: { kind: "core" },
      },
      steps: [{ query: "Read data.txt" }],
      assertions: [
        { kind: "finalOutputContains", text: "apple banana cherry" },
        { kind: "toolCalled", toolName: "run_read" },
        { kind: "allToolsSucceeded" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");
  });

  it("writes a file using replay fixture", async () => {
    const evalCase: EvalCase = {
      id: "replay-write-file",
      title: "Replay: write file",
      mode: "replay",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: {
          kind: "replay",
          replayFile: join(__dirname, "fixtures", "replay-write.json"),
        },
        tools: { kind: "core" },
      },
      steps: [{ query: "Create hello.txt" }],
      assertions: [
        { kind: "fileExists", path: "hello.txt" },
        { kind: "fileContains", path: "hello.txt", text: "hello world" },
        { kind: "allToolsSucceeded" },
      ],
    };

    const result = await runEvalCase(evalCase, createDriver);

    expect(result.passed).toBe(true);
    expect(result.status).toBe("passed");
  });
});
