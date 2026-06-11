/**
 * live-full-suite.test.ts — Full-system Live Regression 端到端测试
 *
 * 职责：使用真实 LLM 验证当前单 Agent 的复杂工具系统。
 *
 * 启用条件：
 *   EVAL_LIVE_FULL=1
 *
 * 默认 skip，避免普通 CI 误触真实 LLM、后台任务或持久化工具。
 */

import { describe, expect, it } from "vitest";
import type { EvalCase } from "../core/case-schema.js";
import { runEvalCase } from "../core/runner.js";
import { createJudgeLLM, createLiveDriver } from "./_driver-factory.js";

const liveFullEnabled = process.env["EVAL_LIVE_FULL"] === "1";
const suite = liveFullEnabled ? describe : describe.skip;

// Judge 仍然独立控制。Release case 的 hard assertions 已足够做自动门禁；
// judge 只补充“是否合理使用工具”的语义评价。
const judgeLLM =
  process.env["EVAL_JUDGE"] === "1" ? createJudgeLLM() : undefined;

suite("Live Full Suite — Release", () => {
  it("uses TODO to guide a file change", async () => {
    const evalCase: EvalCase = {
      id: "live-full-todo-guided-file-change",
      title: "Live full: TODO guided file change",
      mode: "live",
      workspace: {
        initialFiles: {
          "docs/todo-target.md": "status: draft\n",
        },
      },
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "live", live: { maxCalls: 12 } },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["core", "todo"],
          },
        },
        maxRounds: 12,
      },
      steps: [
        {
          query: [
            "Use a TODO list to track this work:",
            "1. Read docs/todo-target.md.",
            "2. Update it so status becomes complete and add marker TODO_LIVE_DONE.",
            "Complete the TODO items as you finish them.",
          ].join("\n"),
        },
      ],
      assertions: [
        { kind: "allStepsCompleted" },
        { kind: "toolCalled", toolName: "run_todo_create" },
        { kind: "toolCalled", toolName: "run_todo_update", minCount: 2 },
        {
          kind: "fileContains",
          path: "docs/todo-target.md",
          text: "status: complete",
        },
        {
          kind: "fileContains",
          path: "docs/todo-target.md",
          text: "TODO_LIVE_DONE",
        },
        { kind: "noWritesOutsideWorkspace" },
        { kind: "allToolsSucceeded" },
      ],
      judge: {
        rubric: {
          goal: "Agent uses TODO to track the requested read/update workflow and actually edits the file.",
          passCriteria: [
            "TODO items reflect the requested work",
            "The file is updated with the requested status and marker",
            "The agent does not claim completion before making the file change",
          ],
          failCriteria: [
            "Creates TODOs but never updates the file",
            "Updates the file without marking TODO progress",
            "Writes to an unrelated path",
          ],
          scoring: { minPassingScore: 7, maxScore: 10 },
        },
      },
    };

    const result = await runEvalCase(evalCase, createLiveDriver, judgeLLM);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  }, 60000);

  it("creates confirmed memory and reads it back on the next turn", async () => {
    const evalCase: EvalCase = {
      id: "live-full-memory-confirmed-create-and-read",
      title: "Live full: confirmed memory create and read",
      mode: "live",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "live", live: { maxCalls: 12 } },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["memory"],
          },
        },
        maxRounds: 12,
      },
      steps: [
        {
          id: "remember",
          query:
            "Please remember this for the eval project: release keyword is LIVE-MEM-42.",
        },
        {
          id: "read-back",
          query: "List or read your memories and tell me the release keyword.",
          assertions: [{ kind: "finalOutputContains", text: "LIVE-MEM-42" }],
        },
      ],
      assertions: [
        { kind: "allStepsCompleted" },
        { kind: "toolCalled", toolName: "run_memory_create" },
        {
          kind: "toolCalledOneOf",
          toolNames: ["run_memory_list", "run_memory_read"],
        },
        { kind: "allToolsSucceeded" },
      ],
      judge: {
        rubric: {
          goal: "Agent stores the explicitly requested memory and retrieves the release keyword in a later turn.",
          passCriteria: [
            "Memory is created only because the user explicitly asked",
            "The later answer uses stored memory rather than inventing a value",
            "The keyword LIVE-MEM-42 is returned correctly",
          ],
          failCriteria: [
            "Refuses to create memory despite explicit user request",
            "Forgets or mutates the release keyword",
            "Creates unrelated memories",
          ],
          scoring: { minPassingScore: 7, maxScore: 10 },
        },
      },
    };

    const result = await runEvalCase(evalCase, createLiveDriver, judgeLLM);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  }, 60000);

  it("loads a seeded skill and follows its file format instruction", async () => {
    const evalCase: EvalCase = {
      id: "live-full-skill-guided-output",
      title: "Live full: skill guided output",
      mode: "live",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "live", live: { maxCalls: 12 } },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["core", "skill"],
            seedSkills: {
              "eval-format/SKILL.md": [
                "When asked to create an eval status file, first write the marker SKILL_USED_22.",
                "Then include the user's requested status as a line like: status: passed.",
                "Use the requested target file path exactly.",
              ].join("\n"),
            },
          },
        },
        maxRounds: 12,
      },
      steps: [
        {
          query:
            "Use the eval-format skill to create skill-output.md with status: passed.",
        },
      ],
      assertions: [
        { kind: "allStepsCompleted" },
        { kind: "toolCalled", toolName: "run_skill" },
        {
          kind: "fileContains",
          path: "skill-output.md",
          text: "SKILL_USED_22",
        },
        {
          kind: "fileContains",
          path: "skill-output.md",
          text: "status: passed",
        },
        { kind: "noWritesOutsideWorkspace" },
        { kind: "allToolsSucceeded" },
      ],
      judge: {
        rubric: {
          goal: "Agent loads the seeded skill and follows the skill-specific output format.",
          passCriteria: [
            "run_skill is used before creating the file",
            "The output file includes the skill marker",
            "The requested status is preserved",
          ],
          failCriteria: [
            "Creates the file without loading the skill",
            "Omits the marker required by the skill",
            "Writes to the wrong file",
          ],
          scoring: { minPassingScore: 7, maxScore: 10 },
        },
      },
    };

    const result = await runEvalCase(evalCase, createLiveDriver, judgeLLM);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  }, 60000);

  it("delegates readonly file analysis to a subagent", async () => {
    const evalCase: EvalCase = {
      id: "live-full-subagent-readonly-analysis",
      title: "Live full: subagent readonly analysis",
      mode: "live",
      workspace: {
        initialFiles: {
          "src/a.ts": 'export const liveToken = "SUBAGENT_LIVE_01";\n',
        },
      },
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "live", live: { maxCalls: 18 } },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["core", "subagent", "skill"],
          },
        },
        maxRounds: 14,
      },
      steps: [
        {
          query: [
            "Ask a subagent to inspect src/a.ts and report the liveToken value.",
            "Do not modify any files.",
          ].join("\n"),
        },
      ],
      assertions: [
        { kind: "allStepsCompleted" },
        { kind: "toolCalled", toolName: "run_subagent" },
        { kind: "finalOutputContains", text: "SUBAGENT_LIVE_01" },
        { kind: "toolNotCalled", toolName: "run_write" },
        { kind: "toolNotCalled", toolName: "run_edit" },
        { kind: "toolNotCalled", toolName: "run_edit_exact" },
        { kind: "allToolsSucceeded" },
      ],
      judge: {
        rubric: {
          goal: "Parent agent delegates readonly analysis to a subagent and integrates the result.",
          passCriteria: [
            "run_subagent is used",
            "The parent final answer includes SUBAGENT_LIVE_01",
            "No file modification tools are called",
          ],
          failCriteria: [
            "Parent reads directly instead of delegating",
            "Subagent result is ignored or misreported",
            "Any file is modified",
          ],
          scoring: { minPassingScore: 7, maxScore: 10 },
        },
      },
    };

    const result = await runEvalCase(evalCase, createLiveDriver, judgeLLM);

    expect(result.status).toBe("passed");
    expect(result.passed).toBe(true);
  }, 90000);
});

describe.skip("Live Full Suite — Nightly", () => {
  it("creates, updates, and reads a durable task group", async () => {
    const evalCase: EvalCase = {
      id: "live-full-task-group-durable-plan",
      title: "Live full nightly: task group durable plan",
      mode: "live",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "live", live: { maxCalls: 16 } },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["task"],
          },
        },
        maxRounds: 16,
      },
      steps: [
        {
          query:
            'Create a durable Task Group named "Live regression plan" with two tasks, mark the first task completed, read the group back, and summarize it.',
        },
      ],
      assertions: [
        { kind: "allStepsCompleted" },
        { kind: "toolCalled", toolName: "run_task_group_create" },
        { kind: "toolCalled", toolName: "run_task_update" },
        { kind: "toolCalled", toolName: "run_task_group_read" },
        { kind: "finalOutputContains", text: "Live regression plan" },
        { kind: "allToolsSucceeded" },
      ],
    };

    const result = await runEvalCase(evalCase, createLiveDriver, judgeLLM);
    expect(result.status).toBe("passed");
  }, 120000);

  it("starts an async command and reads its output handle", async () => {
    const evalCase: EvalCase = {
      id: "live-full-async-output-handle",
      title: "Live full nightly: async output handle",
      mode: "live",
      workspace: {
        initialFiles: {
          "async-output.txt": "ASYNC_LIVE_OK\n",
        },
      },
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "live", live: { maxCalls: 12 } },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["async", "output"],
          },
        },
        maxRounds: 12,
      },
      steps: [
        {
          query: [
            "Start an async run for: cat async-output.txt",
            "Then check it and read the output until you can report ASYNC_LIVE_OK.",
          ].join("\n"),
        },
      ],
      assertions: [
        { kind: "allStepsCompleted" },
        { kind: "toolCalled", toolName: "run_async_start" },
        {
          kind: "toolCalledOneOf",
          toolNames: [
            "run_async_check",
            "run_async_output_read",
            "run_output_read",
          ],
        },
        { kind: "finalOutputContains", text: "ASYNC_LIVE_OK" },
        { kind: "allToolsSucceeded" },
      ],
    };

    const result = await runEvalCase(evalCase, createLiveDriver, judgeLLM);
    expect(result.status).toBe("passed");
  }, 120000);

  it("creates, reads, and cancels a future schedule without ticking", async () => {
    const evalCase: EvalCase = {
      id: "live-full-schedule-create-read-cancel",
      title: "Live full nightly: schedule create read cancel",
      mode: "live",
      driver: {
        kind: "learn-claude-code-in-process",
        llm: { kind: "live", live: { maxCalls: 16 } },
        tools: {
          kind: "full",
          full: {
            agentHome: "temp",
            enabledTools: ["schedule"],
            startScheduleManager: false,
          },
        },
        maxRounds: 16,
      },
      steps: [
        {
          query:
            'Create a schedule far in the future named "live regression schedule" that would run: echo SCHEDULE_LIVE_OK. Then read or list the schedule and cancel it.',
        },
      ],
      assertions: [
        { kind: "allStepsCompleted" },
        { kind: "toolCalled", toolName: "run_schedule_create" },
        {
          kind: "toolCalledOneOf",
          toolNames: ["run_schedule_read", "run_schedule_list"],
        },
        { kind: "toolCalled", toolName: "run_schedule_cancel" },
        { kind: "finalOutputContains", text: "live regression schedule" },
        { kind: "allToolsSucceeded" },
      ],
    };

    const result = await runEvalCase(evalCase, createLiveDriver, judgeLLM);
    expect(result.status).toBe("passed");
  }, 120000);
});
