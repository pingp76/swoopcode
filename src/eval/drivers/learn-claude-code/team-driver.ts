/**
 * team-driver.ts — learn-claude-code Agent Team eval driver
 *
 * 职责：为 PDD24 提供真实 LLM 驱动的 Team E2E harness。
 *
 * 设计取舍：
 * - 第一版采用顺序 supervisor 拓扑，不做并发
 * - 每个成员都是一个真实 Agent 实例，拥有独立 history 和受限工具集
 * - 同一个 case 内共享 LLM client、workspace、terminal 与 MCP runtime
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent } from "../../../agent.js";
import { createContextCompressor } from "../../../compressor.js";
import { createHistory } from "../../../history.js";
import type { LLMClient } from "../../../llm.js";
import { createLogger } from "../../../logger.js";
import {
  createPermissionManager,
  type PermissionMode,
} from "../../../permission.js";
import { createSystemPromptProvider } from "../../../system-prompt.js";
import { createSessionEventBuffer } from "../../../session-events.js";
import type { ToolExecutor, ToolRegistry } from "../../../tools/registry.js";
import type { ToolResult } from "../../../tools/types.js";
import { createTodoManager } from "../../../todo.js";
import type {
  AgentCaseContext,
  AgentInput,
  AgentTurnResult,
  CodingAgentDriver,
} from "../../core/driver.js";
import type {
  AgentRuntimeEvent,
  EvalTeamMemberPlan,
  LearnClaudeCodeTeamDriverPlan,
} from "../../core/case-schema.js";
import { createReplayLLMClient } from "../../replay/replay-llm.js";
import { createLiveEvalLLMClient } from "../../live/live-llm.js";
import { createScriptedLLMClient } from "./scripted-llm.js";
import { createScriptedTerminal } from "./scripted-terminal.js";
import { createCoreEvalToolRegistry } from "./core-tool-runtime.js";
import { wrapToolRegistryForTrace } from "./tool-trace.js";
import {
  combineToolRegistries,
  createEvalMcpRuntime,
  type EvalMcpRuntime,
} from "./mcp-runtime.js";
import { emitTeamEvent, previewTeamText } from "../../team/team-trace.js";

interface MemberRunReport {
  agentId: string;
  role: string;
  output: string;
  failed: boolean;
}

interface MemberRuntimeState {
  toolCallCount: number;
  injectedFailure: boolean;
}

/**
 * createLearnClaudeCodeTeamDriver — 创建顺序 supervisor team driver
 */
export async function createLearnClaudeCodeTeamDriver(
  plan: LearnClaudeCodeTeamDriverPlan,
): Promise<CodingAgentDriver> {
  const runtimeEvents: AgentRuntimeEvent[] = [];
  function emitEvent(event: AgentRuntimeEvent): void {
    const fullEvent: AgentRuntimeEvent = {
      ...event,
      id: event.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: event.timestamp ?? new Date().toISOString(),
    } as AgentRuntimeEvent;
    runtimeEvents.push(fullEvent);
  }

  const logger = createLogger("error");
  const terminal = createScriptedTerminal(plan.terminal, emitEvent);
  const permissionMode = resolveTeamPermissionMode(plan);
  let context: AgentCaseContext | undefined;
  let llm: LLMClient | undefined;
  let currentStepId: string | undefined;
  let agentHome: string | undefined;
  let mcpRuntime: EvalMcpRuntime | undefined;

  return {
    async startCase(caseContext): Promise<void> {
      context = caseContext;
      emitEvent({
        kind: "runtime_path",
        source: "driver",
        label: "workspaceRoot",
        path: caseContext.workspaceRoot,
      } as AgentRuntimeEvent);

      agentHome = await mkdtemp(join(tmpdir(), "learn-claude-team-home-"));
      emitEvent({
        kind: "runtime_path",
        source: "driver",
        label: "agentHome",
        path: agentHome,
      } as AgentRuntimeEvent);

      llm = await createTeamLLM(plan, caseContext.caseId, emitEvent);

      if (plan.mcpServers && plan.mcpServers.length > 0) {
        mcpRuntime = await createEvalMcpRuntime({
          servers: plan.mcpServers,
          emitEvent,
          getStepId: () => currentStepId,
        });
      }
    },

    async send(input: AgentInput): Promise<AgentTurnResult> {
      if (!context || !llm) {
        throw new Error("Team driver not started. Call startCase() first.");
      }
      currentStepId = input.stepId;
      const beforeCount = runtimeEvents.length;
      const teamId = `${context.caseId}-${input.stepId}`;
      const reports: MemberRunReport[] = [];
      let terminationNote: string | null = null;

      emitTeamEvent(emitEvent, {
        kind: "team_start",
        stepId: input.stepId,
        teamId,
        textPreview: previewTeamText(input.query),
      });

      try {
        for (let index = 0; index < plan.members.length; index += 1) {
          if (plan.maxTeamSteps !== undefined && index >= plan.maxTeamSteps) {
            terminationNote = "terminated: maxTeamSteps reached";
            break;
          }

          const member = plan.members[index]!;
          if (index > 0) {
            const previous = plan.members[index - 1]!;
            emitTeamEvent(emitEvent, {
              kind: "handoff",
              stepId: input.stepId,
              teamId,
              agentId: previous.id,
              role: previous.role,
              targetAgentId: member.id,
              textPreview: previewTeamText(reports.at(-1)?.output ?? ""),
            });
          }

          const report = await runMember({
            teamId,
            member,
            input,
            reports,
            workspaceRoot: context.workspaceRoot,
            llm,
            permissionMode,
            mcpRuntime,
            emitEvent,
            getStepId: () => currentStepId,
          });
          reports.push(report);
        }

        const finalOutput = buildTeamFinalOutput(reports, terminationNote);
        emitTeamEvent(emitEvent, {
          kind: "team_completed",
          stepId: input.stepId,
          teamId,
          textPreview: previewTeamText(finalOutput),
        });
        return {
          stepId: input.stepId,
          finalOutput,
          events: runtimeEvents.slice(beforeCount),
        };
      } finally {
        currentStepId = undefined;
      }
    },

    async readEvents(): Promise<AgentRuntimeEvent[]> {
      return runtimeEvents.slice();
    },

    async close(options): Promise<void> {
      terminal.close();
      await mcpRuntime?.cleanup();
      if (agentHome && options?.keepArtifacts !== true) {
        await rm(agentHome, { recursive: true, force: true });
      }
    },
  };

  async function runMember(options: {
    teamId: string;
    member: EvalTeamMemberPlan;
    input: AgentInput;
    reports: MemberRunReport[];
    workspaceRoot: string;
    llm: LLMClient;
    permissionMode: PermissionMode;
    mcpRuntime: EvalMcpRuntime | undefined;
    emitEvent: (event: AgentRuntimeEvent) => void;
    getStepId: () => string | undefined;
  }): Promise<MemberRunReport> {
    const { member } = options;
    const memberState: MemberRuntimeState = {
      toolCallCount: 0,
      injectedFailure: false,
    };

    emitTeamEvent(options.emitEvent, {
      kind: "agent_spawned",
      stepId: options.input.stepId,
      teamId: options.teamId,
      agentId: member.id,
      role: member.role,
    });

    const registry = createMemberToolRegistry({
      member,
      workspaceRoot: options.workspaceRoot,
      mcpRuntime: options.mcpRuntime,
      emitEvent: options.emitEvent,
      teamId: options.teamId,
      getStepId: options.getStepId,
      state: memberState,
    });
    const permissionManager = createPermissionManager(options.workspaceRoot);
    permissionManager.setMode(options.permissionMode);
    const history = createHistory();
    history.setSystemPrompt(buildMemberSystemPrompt(member));
    const agent = createAgent({
      llm: options.llm,
      history,
      tools: registry,
      logger,
      maxRounds: member.maxRounds ?? plan.maxTeamSteps ?? 8,
      compressor: createContextCompressor(),
      permissionManager,
      askUserFn: terminal.askUser.bind(terminal),
      systemPromptProvider: createSystemPromptProvider({
        getSkillHint: () => null,
        getMemoryHint: () => null,
      }),
      sessionEventBuffer: createSessionEventBuffer(),
    });

    try {
      const output = await agent.run(
        buildMemberQuery(member, options.input.query, options.reports),
      );
      emitTeamEvent(options.emitEvent, {
        kind: "agent_message",
        stepId: options.input.stepId,
        teamId: options.teamId,
        agentId: member.id,
        role: member.role,
        textPreview: previewTeamText(output),
      });
      emitTeamEvent(options.emitEvent, {
        kind: "agent_completed",
        stepId: options.input.stepId,
        teamId: options.teamId,
        agentId: member.id,
        role: member.role,
      });
      return { agentId: member.id, role: member.role, output, failed: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const output = `Team member ${member.id} failed: ${message}`;
      emitTeamEvent(options.emitEvent, {
        kind: "agent_failed",
        stepId: options.input.stepId,
        teamId: options.teamId,
        agentId: member.id,
        role: member.role,
        textPreview: previewTeamText(output),
      });
      return { agentId: member.id, role: member.role, output, failed: true };
    }
  }
}

async function createTeamLLM(
  plan: LearnClaudeCodeTeamDriverPlan,
  caseId: string,
  emitEvent: (event: AgentRuntimeEvent) => void,
): Promise<LLMClient> {
  if (plan.llm.kind === "replay") {
    if (!plan.llm.replayFile) {
      throw new Error(`EvalCase ${caseId}: replay mode requires replayFile`);
    }
    return createReplayLLMClient({
      caseId,
      replayFile: plan.llm.replayFile,
      emitEvent,
    });
  }
  if (plan.llm.kind === "live") {
    const liveOptions: { emitEvent: typeof emitEvent; maxCalls?: number } = {
      emitEvent,
    };
    if (plan.llm.live?.maxCalls !== undefined) {
      liveOptions.maxCalls = plan.llm.live.maxCalls;
    }
    return createLiveEvalLLMClient(liveOptions);
  }
  return createScriptedLLMClient({
    caseId,
    responses: plan.llm.scriptedResponses ?? [],
    emitEvent,
  });
}

function createMemberToolRegistry(options: {
  member: EvalTeamMemberPlan;
  workspaceRoot: string;
  mcpRuntime: EvalMcpRuntime | undefined;
  emitEvent: (event: AgentRuntimeEvent) => void;
  teamId: string;
  getStepId: () => string | undefined;
  state: MemberRuntimeState;
}): ToolRegistry {
  const registries: ToolRegistry[] = [];
  const groups = new Set(options.member.tools);

  if (groups.has("core") || groups.has("read") || groups.has("bash")) {
    registries.push(
      createCoreEvalToolRegistry({
        projectRoot: options.workspaceRoot,
        includeBash: groups.has("core") || groups.has("bash"),
        includeRead: groups.has("core") || groups.has("read"),
        includeWrite: groups.has("core"),
        includeEdit: groups.has("core"),
        includeEditExact: groups.has("core"),
      }),
    );
  }

  if (groups.has("todo")) {
    registries.push(createToolEntriesRegistry(createTodoManager().toolEntries));
  }

  if (groups.has("mcp") && options.mcpRuntime) {
    registries.push(options.mcpRuntime.tools);
  }

  const combined =
    registries.length === 0
      ? createEmptyToolRegistry()
      : combineToolRegistries(registries);
  const traced = wrapToolRegistryForTrace(combined, options.emitEvent, {
    getStepId: options.getStepId,
  });
  return wrapRegistryForTeamEvents(traced, options);
}

function createToolEntriesRegistry(
  entries: Array<{
    definition: ChatCompletionTool;
    execute: ToolExecutor;
  }>,
): ToolRegistry {
  return {
    getToolDefinitions() {
      return entries.map((entry) => entry.definition);
    },
    getExecutor(name) {
      return entries.find((entry) => entry.definition.function.name === name)
        ?.execute;
    },
  };
}

function createEmptyToolRegistry(): ToolRegistry {
  return {
    getToolDefinitions() {
      return [];
    },
    getExecutor() {
      return undefined;
    },
  };
}

function wrapRegistryForTeamEvents(
  registry: ToolRegistry,
  options: {
    member: EvalTeamMemberPlan;
    emitEvent: (event: AgentRuntimeEvent) => void;
    teamId: string;
    getStepId: () => string | undefined;
    state: MemberRuntimeState;
  },
): ToolRegistry {
  return {
    getToolDefinitions() {
      return registry.getToolDefinitions();
    },
    getExecutor(name) {
      const executor = registry.getExecutor(name);
      if (!executor) {
        return undefined;
      }
      return async (args: Record<string, unknown>): Promise<ToolResult> => {
        options.state.toolCallCount += 1;
        emitTeamEvent(options.emitEvent, {
          kind: "agent_tool_call",
          stepId: options.getStepId(),
          teamId: options.teamId,
          agentId: options.member.id,
          role: options.member.role,
          toolName: name,
        });
        const result = await executor(args);
        if (!result.error && isArtifactTool(name)) {
          const artifactPath = extractArtifactPath(args);
          if (artifactPath) {
            emitTeamEvent(options.emitEvent, {
              kind: "artifact_produced",
              stepId: options.getStepId(),
              teamId: options.teamId,
              agentId: options.member.id,
              role: options.member.role,
              toolName: name,
              artifactPath,
              textPreview: previewTeamText(result.output),
            });
          }
        }
        if (
          options.member.failAfterFirstToolCall === true &&
          options.state.toolCallCount >= 1 &&
          !options.state.injectedFailure
        ) {
          options.state.injectedFailure = true;
          throw new Error(
            `Injected failure for team member ${options.member.id} after first tool call`,
          );
        }
        return result;
      };
    },
  };
}

function resolveTeamPermissionMode(
  plan: LearnClaudeCodeTeamDriverPlan,
): PermissionMode {
  if (plan.tools?.kind === "core" && plan.tools.core?.permissionMode) {
    return plan.tools.core.permissionMode;
  }
  if (plan.tools?.kind === "full" && plan.tools.full?.permissionMode) {
    return plan.tools.full.permissionMode;
  }
  return "auto";
}

function buildMemberSystemPrompt(member: EvalTeamMemberPlan): string {
  return [
    `You are an eval Agent Team member.`,
    `Member id: ${member.id}.`,
    `Role: ${member.role}.`,
    "Stay inside your role and use only the tools available to you.",
    "Return a concise member report with concrete evidence.",
  ].join("\n");
}

function isArtifactTool(toolName: string): boolean {
  return (
    toolName === "run_write" ||
    toolName === "run_edit" ||
    toolName === "run_edit_exact"
  );
}

function extractArtifactPath(args: Record<string, unknown>): string | null {
  const path = args["path"];
  return typeof path === "string" && path.trim() ? path : null;
}

function buildMemberQuery(
  member: EvalTeamMemberPlan,
  userQuery: string,
  reports: MemberRunReport[],
): string {
  const previous =
    reports.length === 0
      ? "No previous member reports."
      : reports
          .map(
            (report) =>
              `${report.agentId} (${report.role})${report.failed ? " failed" : ""}:\n${report.output}`,
          )
          .join("\n\n");

  return [
    `Original user request:\n${userQuery}`,
    `Previous member reports:\n${previous}`,
    `Your member id is ${member.id}; your role is ${member.role}.`,
    roleInstruction(member.role),
    "Do the part appropriate for your role now. If your role requires inspecting or editing files, use tools to do it.",
  ].join("\n\n");
}

function roleInstruction(role: string): string {
  if (role === "planner") {
    return "Create a short plan. Do not edit files.";
  }
  if (role === "implementer") {
    return "Implement the requested file changes in the workspace.";
  }
  if (role === "reviewer") {
    return "Inspect the final artifact with read-only evidence before reporting.";
  }
  if (role === "researcher") {
    return "Use available research tools such as MCP or read tools, then report grounded facts.";
  }
  return "Complete your assigned part and report what happened.";
}

function buildTeamFinalOutput(
  reports: MemberRunReport[],
  terminationNote: string | null,
): string {
  const output = reports
    .map((report) =>
      [
        `Agent ${report.agentId} (${report.role}) ${report.failed ? "failed" : "completed"}.`,
        report.output,
      ].join("\n"),
    )
    .join("\n\n");
  if (!terminationNote) {
    return output;
  }
  return output ? `${output}\n\n${terminationNote}` : terminationNote;
}
