/**
 * in-process-driver.ts — 当前项目 in-process Driver
 *
 * 职责：通过依赖注入组装当前项目的 createAgent()，并包装为 CodingAgentDriver 接口。
 *
 * 组装清单：
 * - LLM：ScriptedLLMClient（确定性响应序列）
 * - Terminal：ScriptedTerminal（自动应答权限确认）
 * - Tools：Fake Tool Registry（第一批只用 fake tools）
 * - History：新建（每个 case 独立）
 * - Logger：静音级别
 * - Compressor：新建
 * - PermissionManager：auto 模式
 * - TranscriptStore：新建（用于 transcriptEventTypes 断言）
 * - SystemPromptProvider：最小化实现
 * - SessionEventBuffer：新建
 *
 * 映射到 RuntimeEvent：
 * - LLM 事件由 ScriptedLLMClient 直接 emit
 * - Tool 事件由 wrapToolRegistryForTrace 包装后 emit
 * - Transcript 事件在 readEvents() 时从 TranscriptStore 读取并转换
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { createAgent } from "../../../agent.js";
import { createHistory } from "../../../history.js";
import { createLogger } from "../../../logger.js";
import { createContextCompressor } from "../../../compressor.js";
import { createPermissionManager } from "../../../permission.js";
import { createTranscriptStore } from "../../../transcript.js";
import { createSessionEventBuffer } from "../../../session-events.js";
import { createSystemPromptProvider } from "../../../system-prompt.js";
import type { ToolRegistry } from "../../../tools/registry.js";
import type { ToolResult } from "../../../tools/types.js";
import type {
  CodingAgentDriver,
  AgentCaseContext,
  AgentInput,
  AgentTurnResult,
} from "../../core/driver.js";
import type {
  AgentRuntimeEvent,
  LearnClaudeCodeInProcessDriverPlan,
  EvalFakeTool,
} from "../../core/case-schema.js";
import { createScriptedLLMClient } from "./scripted-llm.js";
import { createScriptedTerminal } from "./scripted-terminal.js";
import { createCoreEvalToolRegistry } from "./core-tool-runtime.js";
import { wrapToolRegistryForTrace } from "./tool-trace.js";

/**
 * createLearnClaudeCodeInProcessDriver — 创建当前项目 in-process driver
 *
 * @param plan - driver 计划配置
 * @returns CodingAgentDriver 实例
 */
export async function createLearnClaudeCodeInProcessDriver(
  plan: LearnClaudeCodeInProcessDriverPlan,
): Promise<CodingAgentDriver> {
  // 运行时事件收集器：driver 内部各组件共享此回调来写入事件
  const runtimeEvents: AgentRuntimeEvent[] = [];
  function emitEvent(event: AgentRuntimeEvent): void {
    // 补全 id 和 timestamp，确保事件可被唯一标识和排序
    const fullEvent: AgentRuntimeEvent = {
      ...event,
      id: event.id ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: event.timestamp ?? new Date().toISOString(),
    } as AgentRuntimeEvent;
    runtimeEvents.push(fullEvent);
  }

  // LLM 和 PermissionManager 延迟到 startCase 创建，以便传入正确的 caseId/workspaceRoot
  let llm: ReturnType<typeof createScriptedLLMClient> | undefined;
  let permissionManager: ReturnType<typeof createPermissionManager> | undefined;

  // 创建 Scripted Terminal，用于自动应答权限确认
  // 传入 emitEvent 以便在 askUser 被调用时记录 permission_prompt / permission_response 事件
  const terminal = createScriptedTerminal(plan.terminal, emitEvent);

  // 工具注册表延迟到 startCase 创建，因为 core registry 需要 workspaceRoot
  let tools: ToolRegistry;

  // 创建 History（每个 case 独立，不共享）
  const history = createHistory();

  // 创建静音 Logger（eval 运行时不输出大量日志）
  const logger = createLogger("error");

  // 创建 Compressor（使用默认配置）
  const compressor = createContextCompressor();



  // 创建 TranscriptStore（内存版）
  const transcriptStore = createTranscriptStore();

  // 创建 SessionEventBuffer
  const sessionEventBuffer = createSessionEventBuffer();

  // 创建最小化的 SystemPromptProvider
  const systemPromptProvider = createSystemPromptProvider({
    getSkillHint: () => null,
    getMemoryHint: () => null,
  });

  // 生成 sessionId
  const sessionId = `eval-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Agent 实例引用，延迟到 startCase 创建
  let agent: ReturnType<typeof createAgent> | undefined;

  return {
    async startCase(context: AgentCaseContext): Promise<void> {
      // 根据 tools.kind 选择注册表类型
      if (plan.tools?.kind === "core") {
        // 第二批：使用真实核心工具，限制在临时 workspace 内
        const coreOptions = plan.tools.core ?? {};
        const coreRegistry = createCoreEvalToolRegistry({
          projectRoot: context.workspaceRoot,
          includeBash: coreOptions.includeBash ?? true,
          includeRead: coreOptions.includeRead ?? true,
          includeWrite: coreOptions.includeWrite ?? true,
          includeEdit: coreOptions.includeEdit ?? true,
          includeEditExact: coreOptions.includeEditExact ?? true,
        });
        // 包装追踪层，自动发射 tool_call / tool_result 事件
        tools = wrapToolRegistryForTrace(coreRegistry, emitEvent);
      } else {
        // 第一批及默认：使用 fake tools
        tools = createFakeToolRegistry(plan.tools?.fakeTools ?? [], emitEvent);
      }

      // 创建 Scripted LLM（此时已知 caseId）
      llm = createScriptedLLMClient({
        caseId: context.caseId,
        responses: plan.llm.scriptedResponses ?? [],
        emitEvent,
      });

      // 创建 PermissionManager，项目目录设为当前 workspace
      permissionManager = createPermissionManager(context.workspaceRoot);
      // 从 plan 读取权限模式，支持 case 作者选择 default/plan 来触发 askUser，
      // 从而验证 permissionPromptShown 等断言。默认 auto 模式不调用 askUser。
      const permissionMode = plan.tools?.core?.permissionMode ?? "auto";
      permissionManager.setMode(permissionMode);

      // 创建 Agent 实例
      const agentOptions: {
        llm: typeof llm;
        history: typeof history;
        tools: typeof tools;
        logger: typeof logger;
        compressor: typeof compressor;
        permissionManager: typeof permissionManager;
        askUserFn: typeof terminal.askUser;
        systemPromptProvider: typeof systemPromptProvider;
        sessionEventBuffer: typeof sessionEventBuffer;
        transcriptStore: typeof transcriptStore;
        sessionId: string;
        maxRounds?: number;
      } = {
        llm,
        history,
        tools,
        logger,
        compressor,
        permissionManager,
        askUserFn: terminal.askUser.bind(terminal),
        systemPromptProvider,
        sessionEventBuffer,
        transcriptStore,
        sessionId,
      };
      if (plan.maxRounds !== undefined) {
        agentOptions.maxRounds = plan.maxRounds;
      }
      agent = createAgent(agentOptions);
    },

    async send(input: AgentInput): Promise<AgentTurnResult> {
      if (!agent || !llm) {
        throw new Error("Driver not started. Call startCase() first.");
      }

      // 记录发送前的 runtimeEvents 长度，以便只返回本步产生的新事件
      const beforeCount = runtimeEvents.length;

      // 调用 Agent 的 run() 处理用户输入
      const finalOutput = await agent.run(input.query);

      // 只返回本步新产生的事件，避免跨 step 累积导致重复
      const stepEvents = runtimeEvents.slice(beforeCount);

      return {
        stepId: input.stepId,
        finalOutput,
        events: stepEvents,
      };
    },

    async readEvents(): Promise<AgentRuntimeEvent[]> {
      // 只返回 TranscriptStore 映射事件。
      // LLM/tool 等 driver 内部事件已经在 send() 的 step events 中返回给 runner，
      // readEvents() 的职责是补充 transcript 视角的事件，避免与 step events 重复。
      const transcriptEvents = transcriptStore.readSession(sessionId);
      const mapped: AgentRuntimeEvent[] = transcriptEvents.map(
        (te) =>
          ({
            id: te.id,
            timestamp: te.timestamp,
            kind: te.type,
            source: "agent",
            stepId: undefined,
          } as unknown as AgentRuntimeEvent),
      );
      return mapped;
    },

    async close(): Promise<void> {
      terminal.close();
      compressor.cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// Fake Tool Registry
// ---------------------------------------------------------------------------

/**
 * createFakeToolRegistry — 创建仅包含 fake tools 的注册表
 *
 * 第一批 eval 不使用真实 bash/files 工具，避免副作用。
 * fake tools 通过 plan.fakeTools 注入，名称和参数完全由 case 定义。
 */
function createFakeToolRegistry(
  fakeTools: EvalFakeTool[],
  emitEvent: (event: AgentRuntimeEvent) => void,
): ToolRegistry {
  // 去重校验：fake tool 名称不能重复
  const nameSet = new Set<string>();
  for (const ft of fakeTools) {
    if (nameSet.has(ft.name)) {
      throw new Error(`Duplicate fake tool name: ${ft.name}`);
    }
    nameSet.add(ft.name);
  }

  // 构建工具定义列表（供 LLM 调用时传入）
  const definitions: ChatCompletionTool[] = fakeTools.map((ft) => ({
    type: "function",
    function: {
      name: ft.name,
      description: ft.description ?? `Fake tool: ${ft.name}`,
      parameters: ft.parameters ?? { type: "object", properties: {} },
    },
  }));

  // 构建执行器映射
  const executors = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  for (const ft of fakeTools) {
    executors.set(ft.name, async (args) => {
      // 记录 tool_call 事件
      emitEvent({
        kind: "tool_call",
        source: "tool",
        toolName: ft.name,
        args,
      } as AgentRuntimeEvent);

      let result: ToolResult;
      if (typeof ft.result === "function") {
        result = await ft.result(args);
      } else {
        result = ft.result;
      }

      // 记录 tool_result 事件
      emitEvent({
        kind: "tool_result",
        source: "tool",
        toolName: ft.name,
        result: result.output.slice(0, 500),
        error: result.error,
      } as AgentRuntimeEvent);

      return result;
    });
  }

  return {
    getToolDefinitions() {
      return definitions;
    },
    getExecutor(name: string) {
      return executors.get(name);
    },
  };
}
