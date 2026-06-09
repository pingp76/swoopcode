/**
 * scripted-terminal.ts — Scripted Terminal
 *
 * 职责：实现 Terminal 接口，用预设答案自动回答权限确认和 REPL 输入。
 *
 * 行为要求：
 * 1. question() 从 questions 队列取值
 * 2. askUser() 从 permissionAnswers 队列取值
 * 3. 如果 permission 队列为空，使用 defaultPermissionAnswer，默认 true
 * 4. 如果 question 队列为空，抛出清晰错误
 * 5. close() 只标记 closed，不操作真实 stdin
 */

import type { Terminal } from "../../../terminal.js";
import type { EvalTerminalPlan, AgentRuntimeEvent } from "../../core/case-schema.js";

/**
 * createScriptedTerminal — 创建脚本化终端
 *
 * @param plan - 终端自动应答计划
 * @returns Terminal 接口实现
 */
export function createScriptedTerminal(
  plan?: EvalTerminalPlan,
  emitEvent?: (event: AgentRuntimeEvent) => void,
): Terminal {
  // question 队列：按顺序消耗
  const questions = plan?.questions ? [...plan.questions] : [];
  // permission 队列：按顺序消耗
  const permissionAnswers = plan?.permissionAnswers ? [...plan.permissionAnswers] : [];
  // permission 队列耗尽后的默认值
  const defaultPermissionAnswer = plan?.defaultPermissionAnswer ?? true;
  // 关闭标记
  let closed = false;

  return {
    async question(_prompt: string): Promise<string> {
      if (closed) {
        throw new Error("ScriptedTerminal is closed");
      }
      if (questions.length === 0) {
        throw new Error(
          "ScriptedTerminal: question queue exhausted. No more scripted answers available.",
        );
      }
      // 从队列头部取出答案并返回
      return questions.shift()!;
    },

    async askUser(message: string): Promise<boolean> {
      if (closed) {
        throw new Error("ScriptedTerminal is closed");
      }
      // 记录权限确认弹窗事件
      emitEvent?.({
        kind: "permission_prompt",
        source: "terminal",
        message,
      } as AgentRuntimeEvent);

      let answer: boolean;
      if (permissionAnswers.length > 0) {
        // 从队列头部取出答案
        answer = permissionAnswers.shift()!;
      } else {
        // 队列耗尽后使用默认值
        answer = defaultPermissionAnswer;
      }

      // 记录权限确认响应事件
      emitEvent?.({
        kind: "permission_response",
        source: "terminal",
        allowed: answer,
      } as AgentRuntimeEvent);

      return answer;
    },

    close(): void {
      closed = true;
    },
  };
}
