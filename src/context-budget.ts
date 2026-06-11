/**
 * context-budget.ts — 上下文预算分配器
 *
 * 职责：根据 effective context budget 和压缩模式，
 * 按比例分配 stable pack / working set / evidence / conversation / output / headroom 子预算。
 *
 * 核心约束：所有子预算总和不超过 effectiveBudgetTokens。
 * 如果 overrides 导致超支，按固定优先级裁剪。
 */

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * 上下文预算分配计划
 *
 * 回答"在当前模型和模式下，各类上下文各能使用多少 token"。
 */
export interface ContextBudgetPlan {
  /** 总有效预算 */
  effectiveBudgetTokens: number;
  /** 为模型输出预留的 token */
  outputReserveTokens: number;
  /** 为对话历史预留的 token */
  conversationReserveTokens: number;
  /** stable context pack 预算 */
  stablePackBudgetTokens: number;
  /** working set 预算 */
  workingSetBudgetTokens: number;
  /** evidence pack 预算 */
  evidenceBudgetTokens: number;
  /** 安全余量（未分配部分） */
  headroomTokens: number;
}

/**
 * 预算覆盖项
 *
 * 用户通过 CLI 显式调整子预算时使用。
 */
export interface ContextBudgetOverrides {
  stableContextBudgetTokens?: number;
  evidenceBudgetTokens?: number;
  conversationReserveTokens?: number;
}

// ---------------------------------------------------------------------------
// 预算解析器
// ---------------------------------------------------------------------------

/**
 * 解析上下文预算分配
 *
 * 算法：
 * 1. 先保留 outputReserve（maxOutputTokens 或 effectiveBudget 的 12%，取较小值）
 * 2. 再保留 headroom（8000 或 effectiveBudget 的 5%，取较大值）
 * 3. 剩余 usable 按压缩模式比例分配
 * 4. 应用 overrides，必要时裁剪
 * 5. 确保子预算总和 <= effectiveBudget
 *
 * @param input - 预算分配输入参数
 * @returns 预算分配计划
 */
export function resolveContextBudgets(input: {
  effectiveBudgetTokens: number;
  compressionMode: "aggressive" | "balanced" | "long_context";
  maxOutputTokens: number;
  overrides?: ContextBudgetOverrides;
}): ContextBudgetPlan {
  const { effectiveBudgetTokens, compressionMode, maxOutputTokens, overrides } =
    input;

  // 1. 保留输出预算（给模型回复留空间）
  const outputReserve = Math.min(
    maxOutputTokens,
    Math.floor(effectiveBudgetTokens * 0.12),
  );

  // 2. 保留安全余量
  const headroom = Math.max(
    8000,
    Math.floor(effectiveBudgetTokens * 0.05),
  );

  // 3. 实际可分配给上下文内容的 token
  //    当 budget 很小时（如用户通过 /m c 1000 调低），outputReserve + headroom
  //    可能超过 effectiveBudgetTokens，导致 usable 为负。clamp 到 0，
  //    确保后续子预算不会变成负数。
  const usable = Math.max(
    0,
    effectiveBudgetTokens - outputReserve - headroom,
  );

  // 按压缩模式获取比例
  const ratios = getModeRatios(compressionMode);

  // 4. 按比例分配（向下取整）
  let stablePack = Math.floor(usable * ratios.stable);
  let workingSet = Math.floor(usable * ratios.working);
  let evidence = Math.floor(usable * ratios.evidence);
  let conversation = Math.floor(usable * ratios.conversation);

  // 5. 应用 overrides
  //    overrides 只影响 stable/working/evidence，不挤占 outputReserve 和 headroom
  if (overrides?.stableContextBudgetTokens !== undefined) {
    // stable context 总预算不能超过 stable + working + evidence 的总和
    const contentBudget = stablePack + workingSet + evidence;
    stablePack = Math.min(overrides.stableContextBudgetTokens, contentBudget);
  }

  if (overrides?.evidenceBudgetTokens !== undefined) {
    // evidence 不能超过当前 evidence + workingSet（workingSet 可被 evidence 挤占）
    const maxEvidence = evidence + workingSet;
    const newEvidence = Math.min(overrides.evidenceBudgetTokens, maxEvidence);
    // workingSet 同步扣除被 evidence 挤占的部分
    const evidenceIncrease = newEvidence - evidence;
    if (evidenceIncrease > 0) {
      workingSet = Math.max(0, workingSet - evidenceIncrease);
    }
    evidence = newEvidence;
  }

  if (overrides?.conversationReserveTokens !== undefined) {
    conversation = Math.min(
      overrides.conversationReserveTokens,
      conversation,
    );
  }

  // 6. 确保子预算总和不超过 usable，超出时按优先级裁剪
  //    优先级：evidence -> workingSet -> stablePack -> conversation（最后）
  const contentTotal = stablePack + workingSet + evidence + conversation;
  let finalHeadroom = effectiveBudgetTokens - outputReserve - contentTotal;

  if (contentTotal > usable) {
    const excess = contentTotal - usable;

    // 先裁剪 evidence
    const evidenceCut = Math.min(evidence, excess);
    evidence -= evidenceCut;
    let remaining = excess - evidenceCut;

    // 再裁剪 workingSet
    const workingCut = Math.min(workingSet, remaining);
    workingSet -= workingCut;
    remaining -= workingCut;

    // 再裁剪 stablePack
    const stableCut = Math.min(stablePack, remaining);
    stablePack -= stableCut;
    remaining -= stableCut;

    // 最后裁剪 conversation（尽量不牺牲对话历史）
    conversation -= Math.min(conversation, remaining);

    finalHeadroom =
      effectiveBudgetTokens -
      outputReserve -
      (stablePack + workingSet + evidence + conversation);
  }

  return {
    effectiveBudgetTokens,
    outputReserveTokens: outputReserve,
    conversationReserveTokens: conversation,
    stablePackBudgetTokens: stablePack,
    workingSetBudgetTokens: workingSet,
    evidenceBudgetTokens: evidence,
    headroomTokens: finalHeadroom,
  };
}

// ---------------------------------------------------------------------------
// 内部辅助
// ---------------------------------------------------------------------------

interface ModeRatios {
  stable: number;
  working: number;
  evidence: number;
  conversation: number;
}

/**
 * 获取各压缩模式下的预算分配比例
 */
function getModeRatios(
  mode: "aggressive" | "balanced" | "long_context",
): ModeRatios {
  switch (mode) {
    case "aggressive":
      // 保守分配：conversation 和 evidence 占比较大，stable 较小
      return { stable: 0.2, working: 0.3, evidence: 0.2, conversation: 0.3 };
    case "balanced":
      // 均衡分配：working set 最多，stable 适中
      return { stable: 0.3, working: 0.35, evidence: 0.15, conversation: 0.2 };
    case "long_context":
      // 长上下文：stable pack 占比最大，evidence 和 conversation 较小
      return { stable: 0.42, working: 0.35, evidence: 0.11, conversation: 0.12 };
  }
}
