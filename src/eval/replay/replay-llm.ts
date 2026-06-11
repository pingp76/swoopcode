/**
 * replay-llm.ts — Replay LLM Client
 *
 * 职责：从 JSON fixture 读取录制好的 LLM 响应序列，复用 scripted LLM 路径驱动 Agent。
 *
 * 设计决策：
 * - 不重新实现 LLM 协议解析，而是把 fixture 转换为 ScriptedLLMResponse[]，
 *   然后调用 createScriptedLLMClient()，确保 replay 与 scripted 在 runner 层行为一致。
 * - fixture 格式遵循 PDD22 定义：version、caseId、provider、model、recordedAt、responses。
 * - 验证 fixture 的 version 和 caseId，提前发现 fixture 与 case 不匹配的问题。
 * - 第一版 replay 只读取 fixture，不负责自动录制。
 */

import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import type { LLMClient } from "../../llm.js";
import type { AgentRuntimeEvent } from "../core/case-schema.js";
import type { ScriptedLLMResponse } from "../core/case-schema.js";
import { createScriptedLLMClient } from "../drivers/learn-claude-code/scripted-llm.js";

/**
 * Replay fixture 的顶层结构
 */
interface ReplayFixture {
  version: number;
  caseId: string;
  provider?: string;
  model?: string;
  recordedAt?: string;
  responses: ReplayFixtureResponse[];
}

/**
 * Replay fixture 中的单条响应
 *
 * 与 ScriptedLLMResponse 同构，但用 JSON 序列化格式存储。
 */
interface ReplayFixtureResponse {
  id?: string;
  content?: string | null;
  toolCalls?: ReplayFixtureToolCall[];
  finishReason?: string;
}

interface ReplayFixtureToolCall {
  id: string;
  name: string;
  args?: Record<string, unknown>;
  rawArguments?: string;
}

/**
 * createReplayLLMClient — 创建 replay LLM 客户端
 *
 * @param options.caseId - 当前 case 标识，用于验证 fixture 匹配
 * @param options.replayFile - fixture 文件路径（绝对路径或相对于进程 cwd 的路径）
 * @param options.emitEvent - 事件发射回调
 * @returns LLMClient 接口实现
 */
export async function createReplayLLMClient(options: {
  caseId: string;
  replayFile: string;
  emitEvent: (event: AgentRuntimeEvent) => void;
}): Promise<LLMClient> {
  // 将相对路径解析为绝对路径（基于进程 cwd），避免 case 文件位置变化导致静默找不到 fixture
  const replayFilePath = isAbsolute(options.replayFile)
    ? options.replayFile
    : resolve(process.cwd(), options.replayFile);

  // 读取 fixture 文件，失败时给出包含 caseId 和路径的上下文
  let raw: string;
  try {
    raw = await readFile(replayFilePath, "utf-8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to read replay fixture for case "${options.caseId}" at "${replayFilePath}": ${message}`,
    );
  }

  let fixture: ReplayFixture;
  try {
    fixture = JSON.parse(raw) as ReplayFixture;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to parse replay fixture for case "${options.caseId}" at "${replayFilePath}": ${message}`,
    );
  }

  // 验证版本号
  if (fixture.version !== 1) {
    throw new Error(
      `Replay fixture version mismatch: expected 1, got ${fixture.version}`,
    );
  }

  // 验证 caseId 匹配（防御 fixture 与 case 混用）
  if (fixture.caseId !== options.caseId) {
    throw new Error(
      `Replay fixture caseId mismatch: fixture="${fixture.caseId}", case="${options.caseId}"`,
    );
  }

  // 将 fixture responses 转换为 ScriptedLLMResponse[]
  const responses: ScriptedLLMResponse[] = fixture.responses.map((r) => {
    const response: ScriptedLLMResponse = {};
    if (r.id !== undefined) response.id = r.id;
    if (r.content !== undefined) response.content = r.content;
    if (r.toolCalls !== undefined) {
      response.toolCalls = r.toolCalls.map((tc) => {
        const toolCall: {
          id: string;
          name: string;
          args?: Record<string, unknown>;
          rawArguments?: string;
        } = {
          id: tc.id,
          name: tc.name,
        };
        if (tc.args !== undefined) toolCall.args = tc.args;
        if (tc.rawArguments !== undefined)
          toolCall.rawArguments = tc.rawArguments;
        return toolCall;
      });
    }
    if (r.finishReason !== undefined) response.finishReason = r.finishReason;
    return response;
  });

  // 复用 scripted LLM 客户端，保持行为一致
  return createScriptedLLMClient({
    caseId: options.caseId,
    responses,
    emitEvent: options.emitEvent,
  });
}
