/**
 * _driver-factory.ts — Live suite 共享 Driver 工厂
 *
 * 职责：为 live smoke 和 live regression suite 提供统一的 driver 创建逻辑。
 *
 * 当前 live suite 只支持 learn-claude-code-in-process driver，
 * 未来如果需要扩展 CLI driver 或其他 driver，可在此集中处理。
 */

import type { LLMClient } from "../../llm.js";
import type { CodingAgentDriver } from "../core/driver.js";
import type { EvalCase } from "../core/case-schema.js";
import { createLearnClaudeCodeInProcessDriver } from "../drivers/learn-claude-code/in-process-driver.js";
import { createLLMClient } from "../../llm.js";
import { loadConfig } from "../../config.js";
import type { ResolvedLLMConfig } from "../../llm-providers.js";

/**
 * createLiveDriver — 根据 EvalCase 的 driver plan 创建具体 driver 实例
 *
 * 当前只支持 learn-claude-code-in-process driver。
 */
/**
 * createJudgeLLM — 创建用于 Judge 评估的 LLM 客户端
 *
 * Judge 默认使用与 Agent 相同的 provider 配置（API key、baseURL 等），
 * 但允许通过 JUDGE_MODEL 环境变量覆盖模型名（例如用轻量模型做 judge）。
 * 如果环境缺少 API key，返回 undefined，runner 会跳过 judge 阶段。
 */
export function createJudgeLLM(): LLMClient | undefined {
  try {
    const config = loadConfig();
    if (!config.apiKey) {
      return undefined;
    }
    const judgeModel = process.env["JUDGE_MODEL"] ?? config.model;
    const resolvedConfig: ResolvedLLMConfig = {
      provider: config.provider,
      displayName: config.providerDisplayName,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: judgeModel,
      capabilities: config.llmCapabilities,
    };
    return createLLMClient(resolvedConfig, undefined, config.runtimePolicy);
  } catch {
    return undefined;
  }
}

export async function createLiveDriver(
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
    `Unsupported driver kind for live suite: ${(plan as unknown as Record<string, unknown>).kind}. ` +
      'Use "learn-claude-code-in-process".',
  );
}
