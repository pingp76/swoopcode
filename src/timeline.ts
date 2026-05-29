/**
 * timeline.ts — Agent 时间语义类型
 *
 * 职责：统一描述 History、MessageBlock、Transcript 之间共享的时间元信息。
 *
 * 这里不放状态机，只放小类型。真正的计数器仍由 owner 模块维护：
 * - Agent 维护 turnIndex / loopRound / loopIndex
 * - History 维护 messageSequence
 * - Transcript 维护自己的 event sequence
 */

export interface MessageTimingInput {
  /** 第几次外部用户输入触发的 agent.run() */
  turnIndex?: number;
  /** 当前 turn 内第几次 LLM 调用；旧 round 语义的明确命名 */
  loopRound?: number;
  /** 当前 Agent 实例内第几次 LLM 调用；用于压缩年龄判断 */
  loopIndex?: number;
  /** 兼容旧调用点：等价于 loopRound，不再用于跨 turn 衰减判断 */
  round?: number;
}

export interface MessageTiming {
  /** 第几次外部用户输入触发的 agent.run() */
  turnIndex?: number;
  /** 当前 turn 内第几次 LLM 调用 */
  loopRound?: number;
  /** 当前 Agent 实例内第几次 LLM 调用 */
  loopIndex?: number;
  /** History 中普通对话消息的单调递增序号 */
  messageSequence: number;
  /** 兼容字段：短期保留，后续新代码不要主动依赖 */
  round?: number;
}
