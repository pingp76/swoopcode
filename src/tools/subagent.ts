/**
 * subagent.ts — 子智能体工具模块
 *
 * 职责：定义 run_subagent 工具，让父智能体能够委托旁支任务给子智能体。
 *
 * 子智能体的核心设计思想：
 * - 子智能体是一个独立的 Agent 实例，拥有自己的对话历史
 * - 子智能体执行过程中产生的所有中间消息对父智能体不可见
 * - 子智能体只返回最终的文本结果（通过 ToolResult）
 * - 工具注册表经过过滤：排除 run_subagent（防递归）和 run_todo_*（防干扰父级任务）
 *
 * 循环依赖的解决方式：
 * - subagent.ts 不直接 import createAgent，而是通过参数注入 createAgentFn
 * - 这样打破了 agent.ts → registry.ts → subagent.ts → agent.ts 的循环
 * - 实际的依赖组装在 index.ts（组装根）中完成
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolResult } from "./types.js";
import type { ToolRegistry } from "./registry.js";
import type { LLMClient } from "../llm.js";
import type { Logger } from "../logger.js";
import type { Agent } from "../agent.js";
import type { ContextCompressor } from "../compressor.js";
import type { PermissionManager } from "../permission.js";
import type { HookRunner } from "../hooks.js";
import { createHistory } from "../history.js";
import { SKILL_SYSTEM_PROMPT_HINT } from "../skills.js";

/**
 * subagentToolDefinition — run_subagent 工具的定义
 *
 * 这个定义会被发送给 LLM，告诉它有这样一个工具可用。
 * LLM 可以在需要委托旁支任务时调用此工具。
 */
export const subagentToolDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_subagent",
    description:
      "Delegate a task to an independent sub-agent. The sub-agent has its own " +
      "isolated context and can use: run_bash, run_read, run_write, run_edit, " +
      "and run_skill. It returns a final text result — intermediate steps are " +
      "not visible in the parent conversation.\n\n" +
      "Best practices:\n" +
      "- The sub-agent can load skills (run_skill) on its own — no need to load " +
      "skills in the parent before delegating. For example, delegate " +
      "\"Review src/agent.ts for code quality issues\" and the sub-agent will " +
      "load the code-review skill internally if needed.\n" +
      "- Use TODO tasks to track progress at the parent level, and delegate " +
      "the actual work to sub-agents.\n" +
      "- IMPORTANT: Multiple tool calls in one response are executed SEQUENTIALLY, " +
      "not in parallel. Do NOT call run_subagent twice in one response. " +
      "Instead, call run_subagent for one task, wait for the result, then " +
      "call run_subagent for the next task in the next response.",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "子智能体需要完成的具体任务描述",
        },
        max_rounds: {
          type: "number",
          description: "子智能体最大循环轮数（默认 20）",
        },
      },
      required: ["task"],
    },
  },
};

/**
 * SubagentToolProvider — 子智能体工具提供者接口
 *
 * 与 TodoToolProvider 模式一致：提供工具定义和执行函数，
 * 由 ToolRegistry 统一注册管理。
 */
export interface SubagentToolProvider {
  toolEntries: Array<{
    definition: ChatCompletionTool;
    execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  }>;
}

/**
 * createSubagentToolProvider — 创建子智能体工具提供者
 *
 * @param deps.llm - 共享的 LLM 客户端（复用父级的连接和配置）
 * @param deps.logger - 共享的日志器（子智能体日志带 [SubAgent] 前缀）
 * @param deps.createFilteredRegistry - 工厂函数，返回过滤后的工具注册表
 *   过滤后的注册表只包含 run_bash、run_read、run_write、run_edit
 * @param deps.createAgentFn - Agent 工厂函数（注入而非 import，打破循环依赖）
 *
 * 为什么用注入而不是直接 import？
 * - subagent.ts 如果 import createAgent，会形成循环：
 *   agent.ts → registry.ts → subagent.ts → agent.ts
 * - 通过参数注入，循环在 index.ts（组装根）中被打破
 * - 这是依赖注入模式的典型应用：模块只声明需要什么，不关心从哪里来
 */
export function createSubagentToolProvider(deps: {
  llm: LLMClient;
  logger: Logger;
  createFilteredRegistry: () => ToolRegistry;
  createAgentFn: (deps: {
    llm: LLMClient;
    history: import("../history.js").History;
    tools: ToolRegistry;
    logger: Logger;
    maxRounds?: number;
    compressor: ContextCompressor;
    maxContextTokens?: number;
    permissionManager: PermissionManager;
    askUserFn?: import("../permission.js").AskUserFn;
    /** Hook 运行器：子智能体继承父级 Hook */
    hookRunner?: HookRunner;
  }) => Agent;
  createCompressorFn: () => ContextCompressor;
  /** 权限管理器：子智能体继承父级的同一个实例 */
  permissionManager: PermissionManager;
  /** Hook 运行器：子智能体继承父级 Hook，工具执行前后可观察 */
  hookRunner?: HookRunner;
  /** Memory hint 摘要（可选），注入子智能体 system prompt，让它知道用户的长期偏好 */
  memoryHint?: string | null;
}): SubagentToolProvider {
  const { llm, logger, createFilteredRegistry, createAgentFn, createCompressorFn, permissionManager, hookRunner, memoryHint } = deps;

  /**
   * executeSubagent — 执行子智能体任务
   *
   * 这是 run_subagent 工具的实际执行函数：
   * 1. 参数校验（task 不能为空）
   * 2. 创建独立的对话历史
   * 3. 获取过滤后的工具注册表
   * 4. 创建并运行子 Agent
   * 5. 返回 ToolResult（成功或失败）
   *
   * @param args - LLM 传入的工具参数（task + 可选的 max_rounds）
   */
  async function executeSubagent(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const task = String(args["task"] ?? "");
    // max_rounds 参数：默认 20 轮，父智能体可以通过参数覆盖
    const maxRounds = Number(args["max_rounds"]) || 20;

    // 参数校验：task 是必填的
    if (!task.trim()) {
      return {
        output: "Error: 'task' parameter is required and cannot be empty.",
        error: true,
      };
    }

    logger.info("[SubAgent] Starting sub-agent for task: %s", task.slice(0, 100));

    try {
      // 1. 创建独立的对话历史（不与父级共享引用）
      //    子智能体的所有中间消息都只存在于这个 history 中
      //    设置 system prompt hint，帮助子智能体理解如何使用 skill
      const subHistory = createHistory();
      // 子智能体 system prompt 包含 Skill hint + Memory hint（如果有）
      // 这样子智能体能了解用户的长期偏好和反馈约定
      const subParts = [SKILL_SYSTEM_PROMPT_HINT];
      if (memoryHint) subParts.push(memoryHint);
      subHistory.setSystemPrompt(subParts.join("\n\n"));

      // 2. 获取过滤后的工具注册表
      //    只有 bash + files 四个工具，没有 run_subagent（防递归）和 run_todo_*（防干扰）
      const subTools = createFilteredRegistry();

      // 3. 创建子 Agent 实例
      //    - 复用父级的 llm 和 logger（共享连接和配置）
      //    - 不传 todoManager（子智能体不做任务管理）
      //    - 设置 maxRounds（硬性轮数上限）
      //    - 使用独立的压缩器实例（隔离压缩状态）
      //    - 共享同一个 permissionManager（继承父级权限模式）
      //    - 不传 askUserFn（子智能体内的 ask 降级为 deny）
      const subCompressor = createCompressorFn();
      // 子智能体创建参数：只有 hookRunner 有值时才传入
      // exactOptionalPropertyTypes 不允许显式传 undefined 给可选属性
      const subAgentDeps: Parameters<typeof createAgentFn>[0] = {
        llm,
        history: subHistory,
        tools: subTools,
        logger,
        maxRounds,
        compressor: subCompressor,
        permissionManager,
        // 不传 askUserFn：子智能体内的 ask 决策降级为 deny
      };
      if (hookRunner) {
        subAgentDeps.hookRunner = hookRunner;
      }
      const subAgent = createAgentFn(subAgentDeps);

      // 4. 运行子 Agent（父智能体在此阻塞等待）
      const result = await subAgent.run(task);

      logger.info("[SubAgent] Completed sub-agent task");
      // 成功：返回子智能体的最终文本
      return { output: result, error: false };
    } catch (err) {
      // LLM 调用失败或其他异常：返回错误信息，不中断父智能体
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("[SubAgent] Error: %s", errMsg);
      return {
        output: `Sub-agent error: ${errMsg}`,
        error: true,
      };
    }
  }

  // 返回工具提供者，包含一个工具条目（定义 + 执行函数）
  return {
    toolEntries: [
      {
        definition: subagentToolDefinition,
        execute: executeSubagent,
      },
    ],
  };
}
