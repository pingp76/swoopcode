/**
 * full-tool-runtime.test.ts — full-tools eval runtime 的确定性测试
 *
 * 这组测试不调用真实 LLM，只验证 eval driver 的组装边界：
 * - 所有持久化目录落在临时 agentHome
 * - enabledTools 只打开指定 provider
 * - seedSkills / seedMemories 可被真实工具读取
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LLMClient } from "../../../llm.js";
import { createLogger } from "../../../logger.js";
import { createScriptedLLMClient } from "./scripted-llm.js";
import {
  createFullEvalRuntime,
  type FullEvalRuntime,
} from "./full-tool-runtime.js";
import type {
  AgentRuntimeEvent,
  EvalFullToolGroup,
} from "../../core/case-schema.js";

describe("createFullEvalRuntime", () => {
  const cleanupFns: Array<() => Promise<void>> = [];

  afterEach(async () => {
    const fns = cleanupFns.splice(0);
    await Promise.all(fns.map((fn) => fn()));
  });

  it("creates full runtime directories under the temporary agentHome", async () => {
    const { workspaceRoot, agentHome, runtime } = await createRuntime();

    expect(existsSync(join(agentHome, "skills"))).toBe(true);
    expect(existsSync(join(agentHome, "memory"))).toBe(true);
    expect(existsSync(join(agentHome, "logs"))).toBe(true);
    expect(existsSync(join(agentHome, ".task_outputs"))).toBe(true);
    expect(existsSync(join(agentHome, "tasks"))).toBe(true);
    expect(existsSync(join(agentHome, "schedules"))).toBe(true);
    expect(existsSync(join(workspaceRoot, "memory"))).toBe(false);

    await runtime.cleanup();
    expect(existsSync(agentHome)).toBe(false);
  });

  it("registers only core and TODO providers when enabledTools is scoped", async () => {
    const { runtime } = await createRuntime({
      enabledTools: ["core", "todo"],
    });

    const toolNames = getToolNames(runtime);
    expect(toolNames).toContain("run_bash");
    expect(toolNames).toContain("run_read");
    expect(toolNames).toContain("run_todo_create");
    expect(toolNames).not.toContain("run_task_group_create");
    expect(toolNames).not.toContain("run_memory_create");
    expect(toolNames).not.toContain("run_skill");
    expect(toolNames).not.toContain("run_subagent");
    expect(toolNames).not.toContain("run_async_start");
    expect(toolNames).not.toContain("run_schedule_create");
    expect(toolNames).not.toContain("run_output_read");
  });

  it("registers complex tool providers when full tools are enabled", async () => {
    const { runtime } = await createRuntime();

    const toolNames = getToolNames(runtime);
    expect(toolNames).toContain("run_task_group_create");
    expect(toolNames).toContain("run_memory_create");
    expect(toolNames).toContain("run_skill");
    expect(toolNames).toContain("run_subagent");
    expect(toolNames).toContain("run_async_start");
    expect(toolNames).toContain("run_schedule_create");
    expect(toolNames).toContain("run_output_read");
  });

  it("loads seeded skills through the real run_skill tool", async () => {
    const { runtime } = await createRuntime({
      enabledTools: ["core", "skill"],
      seedSkills: {
        "eval-format/SKILL.md": [
          "When this skill is loaded, mention SKILL_SEED_OK.",
          "Use it only for eval runtime tests.",
        ].join("\n"),
      },
    });

    const executor = runtime.tools.getExecutor("run_skill");
    expect(executor).toBeDefined();
    const result = await executor!({ name: "eval-format" });

    expect(result.error).toBe(false);
    expect(result.output).toContain("SKILL_SEED_OK");
  });

  it("seeds memories in temporary agentHome rather than the workspace", async () => {
    const { workspaceRoot, agentHome, runtime } = await createRuntime({
      enabledTools: ["memory"],
      seedMemories: {
        eval_seed: {
          description: "Eval seeded memory",
          type: "project",
          body: "LIVE_MEM_SEED_OK",
        },
      },
    });

    const seededMemory = runtime.memoryManager.read("eval_seed");
    expect(seededMemory?.body).toContain("LIVE_MEM_SEED_OK");
    expect(existsSync(join(agentHome, "memory", "eval_seed.md"))).toBe(true);
    expect(existsSync(join(workspaceRoot, "memory", "eval_seed.md"))).toBe(
      false,
    );
  });

  it("abandons running async runs during cleanup", async () => {
    const hangingLLM: LLMClient = {
      async chat() {
        // 这个 Promise 故意永不 resolve，用来模拟 cleanup 时仍在运行的 subagent。
        // 它没有 timer 或 IO handle，因此不会让 Vitest 进程悬挂。
        return new Promise(() => {});
      },
    };
    const { runtime } = await createRuntime({
      enabledTools: ["async", "output"],
      llm: hangingLLM,
    });

    expect(runtime.asyncRunManager).toBeDefined();
    const started = runtime.asyncRunManager!.start({
      title: "hanging eval subagent",
      executor: "subagent",
      prompt: "Stay pending until cleanup.",
      resources: { read_paths: ["."], write_paths: [] },
      timeoutMs: 10_000,
      maxRounds: 1,
    });
    expect(runtime.asyncRunManager!.list({ status: "running" })).toHaveLength(
      1,
    );

    await runtime.cleanup();

    expect(runtime.asyncRunManager!.list({ status: "running" })).toHaveLength(
      0,
    );
    expect(runtime.asyncRunManager!.check(started.id)?.status).toBe(
      "abandoned",
    );
  });

  async function createRuntime(options?: {
    enabledTools?: EvalFullToolGroup[];
    seedSkills?: Record<string, string>;
    seedMemories?: Parameters<typeof createFullEvalRuntime>[0]["seedMemories"];
    llm?: LLMClient;
  }): Promise<{
    workspaceRoot: string;
    agentHome: string;
    runtime: FullEvalRuntime;
    events: AgentRuntimeEvent[];
  }> {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "eval-full-ws-"));
    const agentHome = await mkdtemp(join(tmpdir(), "eval-full-home-"));
    const events: AgentRuntimeEvent[] = [];

    cleanupFns.push(async () => {
      await rm(workspaceRoot, { recursive: true, force: true });
      await rm(agentHome, { recursive: true, force: true });
    });

    const runtimeOptions: Parameters<typeof createFullEvalRuntime>[0] = {
      workspaceRoot,
      agentHome,
      llm:
        options?.llm ??
        createScriptedLLMClient({
          caseId: "full-tool-runtime-test",
          responses: [{ content: "ok", toolCalls: [], finishReason: "stop" }],
          emitEvent: (event) => events.push(event),
        }),
      logger: createLogger("error"),
      emitEvent: (event) => events.push(event),
    };
    if (options?.enabledTools !== undefined) {
      runtimeOptions.enabledTools = options.enabledTools;
    }
    if (options?.seedSkills !== undefined) {
      runtimeOptions.seedSkills = options.seedSkills;
    }
    if (options?.seedMemories !== undefined) {
      runtimeOptions.seedMemories = options.seedMemories;
    }

    const runtime = await createFullEvalRuntime(runtimeOptions);

    cleanupFns.push(async () => {
      await runtime.cleanup();
    });

    return { workspaceRoot, agentHome, runtime, events };
  }

  function getToolNames(runtime: FullEvalRuntime): string[] {
    return runtime.tools
      .getToolDefinitions()
      .map((definition) => definition.function.name);
  }
});
