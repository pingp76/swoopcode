/**
 * full-tool-runtime.ts — Eval 专用完整工具运行时
 *
 * 职责：在临时 workspace + 临时 agentHome 中组装当前项目的真实工具系统。
 *
 * 这个文件刻意放在 learn-claude-code driver 目录下，而不是 Eval Core：
 * - Eval Core 只认识 driver/trace/assertion 这些中立协议
 * - 当前项目的 Task/Memory/Skill/Schedule 组装细节留在 adapter 层
 * - 将来主 Agent 组装方式变化时，优先改这里，不需要改 case schema 或 runner
 */

import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Agent } from "../../../agent.js";
import { createAgent } from "../../../agent.js";
import type { ContextCompressor } from "../../../compressor.js";
import { createContextCompressor } from "../../../compressor.js";
import {
  createExecutionPolicy,
  createReadonlyCommandPolicy,
} from "../../../execution-policy.js";
import type { LLMClient } from "../../../llm.js";
import type { Logger } from "../../../logger.js";
import type { MemoryManager } from "../../../memory.js";
import { createMemoryManager } from "../../../memory.js";
import type { OutputStore } from "../../../output-store.js";
import { createOutputStore } from "../../../output-store.js";
import type { PermissionManager, PermissionMode } from "../../../permission.js";
import { createPermissionManager } from "../../../permission.js";
import { createProjectContext } from "../../../project-context.js";
import type { ScheduleManager } from "../../../schedules.js";
import { createScheduleManager } from "../../../schedules.js";
import { createScheduleStore } from "../../../schedule-store.js";
import type { SessionEventBuffer } from "../../../session-events.js";
import { createSessionEventBuffer } from "../../../session-events.js";
import type { SessionManager } from "../../../session.js";
import { createSessionManager } from "../../../session.js";
import type { SkillManager } from "../../../skills.js";
import {
  createSkillManager,
  createSkillToolProvider,
  SKILL_SYSTEM_PROMPT_HINT,
} from "../../../skills.js";
import type { SystemPromptProvider } from "../../../system-prompt.js";
import { createSystemPromptProvider } from "../../../system-prompt.js";
import { createTaskStore } from "../../../task-store.js";
import { createTaskManager } from "../../../tasks.js";
import type { TodoManager } from "../../../todo.js";
import { createTodoManager } from "../../../todo.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import { createToolRegistry } from "../../../tools/registry.js";
import { createAsyncRunToolProvider } from "../../../tools/async-runs.js";
import { createMemoryToolProvider } from "../../../tools/memory.js";
import { createOutputToolProvider } from "../../../tools/output.js";
import { createScheduleToolProvider } from "../../../tools/schedules.js";
import { createSubagentToolProvider } from "../../../tools/subagent.js";
import { createTaskToolProvider } from "../../../tools/tasks.js";
import type { TranscriptStore } from "../../../transcript.js";
import { createTranscriptStore } from "../../../transcript.js";
import type {
  AgentRuntimeEvent,
  EvalFullToolGroup,
  EvalMcpServerPlan,
  EvalSeedMemory,
} from "../../core/case-schema.js";
import {
  createAsyncRunManager,
  type AsyncRunManager,
} from "../../../async-runs.js";
import { wrapToolRegistryForTrace } from "./tool-trace.js";
import {
  combineToolRegistries,
  createEvalMcpRuntime,
  type EvalMcpRuntime,
} from "./mcp-runtime.js";

/** Full runtime 创建参数。 */
export interface CreateFullEvalRuntimeOptions {
  workspaceRoot: string;
  agentHome: string;
  llm: LLMClient;
  logger: Logger;
  emitEvent: (event: AgentRuntimeEvent) => void;
  getStepId?: () => string | undefined;
  enabledTools?: EvalFullToolGroup[];
  seedSkills?: Record<string, string>;
  seedMemories?: Record<string, EvalSeedMemory>;
  mcpServers?: EvalMcpServerPlan[];
  mcpClientTimeoutMs?: number;
  permissionMode?: PermissionMode;
  startScheduleManager?: boolean;
}

/** Eval full-tools 模式暴露给 in-process driver 的组装结果。 */
export interface FullEvalRuntime {
  tools: ToolRegistry;
  permissionManager: PermissionManager;
  systemPromptProvider: SystemPromptProvider;
  sessionEventBuffer: SessionEventBuffer;
  transcriptStore: TranscriptStore;
  sessionManager: SessionManager;
  sessionId: string;
  compressor: ContextCompressor;
  todoManager: TodoManager;
  outputStore: OutputStore;
  skillManager: SkillManager;
  memoryManager: MemoryManager;
  mcpRuntime: EvalMcpRuntime | undefined;
  asyncRunManager: AsyncRunManager | undefined;
  scheduleManager: ScheduleManager | undefined;
  cleanup(options?: { keepAgentHome?: boolean }): Promise<void>;
}

const DEFAULT_FULL_TOOL_GROUPS: ReadonlySet<EvalFullToolGroup> = new Set([
  "core",
  "todo",
  "task",
  "memory",
  "skill",
  "subagent",
  "async",
  "schedule",
  "output",
  "mcp",
]);

const VALID_SEEDED_SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * createFullEvalRuntime — 创建完整工具 eval 运行时
 *
 * 组装顺序尽量贴近 index.ts，但所有可持久化数据都落在 temp agentHome。
 */
export async function createFullEvalRuntime(
  options: CreateFullEvalRuntimeOptions,
): Promise<FullEvalRuntime> {
  const enabledGroups = new Set(
    options.enabledTools ?? Array.from(DEFAULT_FULL_TOOL_GROUPS),
  );

  const projectContext = createProjectContext({
    projectRoot: options.workspaceRoot,
    agentHome: options.agentHome,
  });

  await ensureRuntimeDirectories([
    projectContext.skillsDir,
    projectContext.memoryDir,
    projectContext.logsDir,
    projectContext.taskOutputsDir,
    projectContext.tasksDir,
    projectContext.schedulesDir,
  ]);

  await seedSkills(projectContext.skillsDir, options.seedSkills ?? {});

  const skillManager = createSkillManager(projectContext.skillsDir);
  skillManager.scan();
  const skillProvider = isEnabled(enabledGroups, "skill")
    ? createSkillToolProvider(skillManager)
    : undefined;

  const memoryManager = createMemoryManager({
    memoryDir: projectContext.memoryDir,
    logger: options.logger,
  });
  memoryManager.scan();
  seedMemories(memoryManager, options.seedMemories ?? {});
  const sessionEventBuffer = createSessionEventBuffer();
  const memoryProviderWithSession = isEnabled(enabledGroups, "memory")
    ? createMemoryToolProvider(memoryManager, { sessionEventBuffer })
    : undefined;

  const todoManager = createTodoManager();
  const taskStore = createTaskStore({
    tasksDir: projectContext.tasksDir,
    projectRoot: projectContext.projectRoot,
    logger: options.logger,
  });
  taskStore.cleanupTempFiles();
  taskStore.scan();
  const taskManager = createTaskManager({
    store: taskStore,
    projectRoot: projectContext.projectRoot,
  });
  const taskProvider = isEnabled(enabledGroups, "task")
    ? createTaskToolProvider(taskManager, { sessionEventBuffer })
    : undefined;

  const outputStore = createOutputStore({
    outputDir: projectContext.taskOutputsDir,
  });
  const outputProvider = isEnabled(enabledGroups, "output")
    ? createOutputToolProvider(outputStore)
    : undefined;

  const permissionManager = createPermissionManager(projectContext.projectRoot);
  permissionManager.setMode(options.permissionMode ?? "auto");

  const executionPolicy = createExecutionPolicy();
  const readonlyCommandPolicy = createReadonlyCommandPolicy(executionPolicy);

  const transcriptStore = createTranscriptStore();
  const sessionManager = createSessionManager({
    projectRoot: projectContext.projectRoot,
    model: "eval-full-tools",
    cwd: projectContext.projectRoot,
  });
  const mainSession = sessionManager.createMainSession("eval full-tools");

  const projectInstructions = existsSync(projectContext.agentsFile)
    ? readFileSync(projectContext.agentsFile, "utf-8")
    : null;

  const systemPromptProvider = createSystemPromptProvider({
    getProjectInstructions: () => projectInstructions,
    getSkillHint: () =>
      skillManager.listMeta().length > 0 ? SKILL_SYSTEM_PROMPT_HINT : null,
    getMemoryHint: () => memoryManager.buildPromptSection(),
  });

  let asyncRunManager: AsyncRunManager | undefined;
  let scheduleManager: ScheduleManager | undefined;
  let mcpRuntime: EvalMcpRuntime | undefined;
  const toolTraceOptions =
    options.getStepId === undefined
      ? undefined
      : { getStepId: options.getStepId };

  const createReadonlyRegistry = (readPaths: string[]) =>
    wrapToolRegistryForTrace(
      createToolRegistry(
        undefined,
        undefined,
        skillProvider,
        memoryProviderWithSession,
        undefined,
        undefined,
        {
          projectRoot: projectContext.projectRoot,
          commandPolicy: readonlyCommandPolicy,
          includeFileWrite: false,
          includeFileEdit: false,
          readPolicy: {
            validate(path: string) {
              return validateReadPath(
                projectContext.projectRoot,
                path,
                readPaths,
              );
            },
          },
        },
      ),
      options.emitEvent,
      toolTraceOptions,
    );

  if (
    isEnabled(enabledGroups, "async") ||
    isEnabled(enabledGroups, "schedule")
  ) {
    asyncRunManager = createAsyncRunManager({
      projectRoot: projectContext.projectRoot,
      taskOutputsDir: projectContext.taskOutputsDir,
      llm: options.llm,
      logger: options.logger,
      executionPolicy,
      commandPolicy: readonlyCommandPolicy,
      outputStore,
      createAgentFn: createAgentForAsync,
      createCompressorFn: () =>
        createContextCompressor({
          outputDir: projectContext.taskOutputsDir,
          outputStore,
        }),
      createReadonlyRegistryFn: createReadonlyRegistry,
      getStableSystemPrompt: () =>
        systemPromptProvider.getSnapshot().systemPrompt,
      sessionManager,
      transcriptStore,
      parentSessionId: mainSession.id,
      permissionManager,
    });
  }

  if (isEnabled(enabledGroups, "schedule") && asyncRunManager) {
    const scheduleStore = createScheduleStore({
      schedulesDir: projectContext.schedulesDir,
      projectRoot: projectContext.projectRoot,
      logger: options.logger,
    });
    scheduleStore.scan();
    scheduleManager = createScheduleManager({
      store: scheduleStore,
      asyncRunManager,
      projectRoot: projectContext.projectRoot,
      logger: options.logger,
      executionPolicy,
      commandPolicy: readonlyCommandPolicy,
    });
    if (options.startScheduleManager === true) {
      scheduleManager.start();
    }
  }

  const asyncRunProvider =
    isEnabled(enabledGroups, "async") && asyncRunManager
      ? createAsyncRunToolProvider(asyncRunManager, readonlyCommandPolicy)
      : undefined;
  const scheduleProvider =
    isEnabled(enabledGroups, "schedule") && scheduleManager
      ? createScheduleToolProvider(scheduleManager)
      : undefined;

  if (
    isEnabled(enabledGroups, "mcp") &&
    options.mcpServers &&
    options.mcpServers.length > 0
  ) {
    const mcpOptions: Parameters<typeof createEvalMcpRuntime>[0] = {
      servers: options.mcpServers,
      emitEvent: options.emitEvent,
    };
    if (options.getStepId !== undefined) {
      mcpOptions.getStepId = options.getStepId;
    }
    if (options.mcpClientTimeoutMs !== undefined) {
      mcpOptions.clientTimeoutMs = options.mcpClientTimeoutMs;
    }
    mcpRuntime = await createEvalMcpRuntime(mcpOptions);
  }

  const subagentProvider = isEnabled(enabledGroups, "subagent")
    ? createSubagentToolProvider({
        llm: options.llm,
        logger: options.logger,
        createFilteredRegistry: () => createReadonlyRegistry(["."]),
        createAgentFn: createAgentForSubagent,
        createCompressorFn: () =>
          createContextCompressor({
            outputDir: projectContext.taskOutputsDir,
            outputStore,
          }),
        permissionManager,
        commandPolicy: readonlyCommandPolicy,
        getStableSystemPrompt: () =>
          systemPromptProvider.getSnapshot().systemPrompt,
        sessionManager,
        transcriptStore,
        parentSessionId: mainSession.id,
      })
    : undefined;

  const rawTools = createToolRegistry(
    isEnabled(enabledGroups, "todo") ? todoManager : undefined,
    subagentProvider,
    skillProvider,
    memoryProviderWithSession,
    taskProvider,
    asyncRunProvider,
    { projectRoot: projectContext.projectRoot },
    scheduleProvider,
    outputProvider,
  );
  const combinedTools =
    mcpRuntime === undefined
      ? rawTools
      : combineToolRegistries([rawTools, mcpRuntime.tools]);
  const tools = wrapToolRegistryForTrace(
    combinedTools,
    options.emitEvent,
    toolTraceOptions,
  );

  const compressor = createContextCompressor({
    outputDir: projectContext.taskOutputsDir,
    outputStore,
  });

  options.emitEvent({
    kind: "runtime_path",
    source: "driver",
    label: "agentHome",
    path: projectContext.agentHome,
  } as AgentRuntimeEvent);

  return {
    tools,
    permissionManager,
    systemPromptProvider,
    sessionEventBuffer,
    transcriptStore,
    sessionManager,
    sessionId: mainSession.id,
    compressor,
    todoManager,
    outputStore,
    skillManager,
    memoryManager,
    mcpRuntime,
    asyncRunManager,
    scheduleManager,
    async cleanup(cleanupOptions) {
      scheduleManager?.stop();
      await mcpRuntime?.cleanup();
      const abandonedRuns = asyncRunManager?.shutdown?.(
        "Full eval runtime cleanup",
      );
      if (abandonedRuns && abandonedRuns.length > 0) {
        options.logger.warn(
          "Full eval runtime abandoned %d running async run(s) during cleanup",
          abandonedRuns.length,
        );
      }
      if (cleanupOptions?.keepAgentHome === true) {
        return;
      }
      await rm(projectContext.agentHome, { recursive: true, force: true });
    },
  };
}

function createAgentForAsync(deps: Parameters<typeof createAgent>[0]): Agent {
  return createAgent(deps);
}

function createAgentForSubagent(
  deps: Parameters<typeof createAgent>[0],
): Agent {
  return createAgent(deps);
}

function isEnabled(
  enabledGroups: ReadonlySet<EvalFullToolGroup>,
  group: EvalFullToolGroup,
): boolean {
  return enabledGroups.has(group);
}

async function ensureRuntimeDirectories(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
}

async function seedSkills(
  skillsDir: string,
  seedSkills: Record<string, string>,
): Promise<void> {
  for (const [rawPath, rawContent] of Object.entries(seedSkills)) {
    const skillFilePath = resolveSkillSeedPath(skillsDir, rawPath);
    const skillName = relative(skillsDir, skillFilePath).split(sep)[0]!;
    if (!VALID_SEEDED_SKILL_NAME.test(skillName)) {
      throw new Error(`Invalid seeded skill name: ${skillName}`);
    }
    await mkdir(dirname(skillFilePath), { recursive: true });
    await writeFile(
      skillFilePath,
      normalizeSkillContent(skillName, rawContent),
      "utf-8",
    );
  }
}

function resolveSkillSeedPath(skillsDir: string, rawPath: string): string {
  const normalizedPath = rawPath.endsWith("SKILL.md")
    ? rawPath
    : join(rawPath, "SKILL.md");
  return resolveSafeChild(skillsDir, normalizedPath, "seed skill path");
}

function normalizeSkillContent(skillName: string, content: string): string {
  if (content.trimStart().startsWith("---")) {
    return content;
  }
  return [
    "---",
    `name: ${skillName}`,
    `description: Seeded eval skill ${skillName}`,
    "---",
    content.trimStart(),
  ].join("\n");
}

function seedMemories(
  memoryManager: MemoryManager,
  seedMemories: Record<string, EvalSeedMemory>,
): void {
  for (const [name, memory] of Object.entries(seedMemories)) {
    memoryManager.create({
      name,
      description: memory.description,
      type: memory.type,
      body: memory.body,
    });
  }
}

function resolveSafeChild(
  root: string,
  childPath: string,
  label: string,
): string {
  if (isAbsolute(childPath)) {
    throw new Error(`${label} must be relative: ${childPath}`);
  }
  const rootPath = resolve(root);
  const resolvedPath = resolve(rootPath, childPath);
  if (resolvedPath !== rootPath && !resolvedPath.startsWith(rootPath + sep)) {
    throw new Error(`${label} escapes root: ${childPath}`);
  }
  return resolvedPath;
}

function validateReadPath(
  projectRoot: string,
  path: string,
  readPaths: string[],
): { allowed: boolean; reason?: string } {
  if (readPaths.length === 0) {
    return {
      allowed: false,
      reason: "No read paths declared for this eval subagent",
    };
  }

  const resolvedPath = resolve(projectRoot, path);
  for (const allowedPath of readPaths) {
    const resolvedAllowed = resolve(projectRoot, allowedPath);
    if (
      resolvedPath === resolvedAllowed ||
      resolvedPath.startsWith(resolvedAllowed + sep)
    ) {
      return { allowed: true };
    }
  }
  return {
    allowed: false,
    reason: `Path "${path}" is outside declared read paths: ${readPaths.join(", ")}`,
  };
}
