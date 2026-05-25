/**
 * recovery.ts — Agent 循环错误恢复模块
 *
 * 职责：封装 LLM 错误分类、恢复决策、用户提示文案、等待函数。
 *
 * 设计原则：
 * - classifyLLMError() 不依赖 OpenAI SDK 的具体类型，只通过宽松结构读取 status、code、message。
 * - decideRecovery() 是纯函数，便于单元测试。
 * - formatFailureMessage() 返回面向用户的中文提示。
 * - sleep() 单独导出，测试时可 mock 或用 fake timer。
 */

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/**
 * LLMErrorKind — 统一错误分类
 *
 * 将各种 LLM 调用失败归并为 7 种类型，每种对应明确的恢复策略。
 */
export type LLMErrorKind =
  | "network"
  | "rate_limit"
  | "credential"
  | "quota"
  | "context_length"
  | "output_interrupted"
  | "unknown";

/**
 * RecoveryAction — 恢复动作
 *
 * - continue：向历史追加 continuation reminder，再次调用 LLM（输出中断场景）。
 * - compact：强制压缩当前历史，然后再次调用 LLM（上下文过长场景）。
 * - backoff：等待固定时间后重试同一次 LLM 调用（网络/限流场景）。
 * - fail：停止本次 run()，返回用户可理解的失败提示。
 */
export type RecoveryAction = "continue" | "compact" | "backoff" | "fail";

/**
 * RecoveryState — 本次请求内的恢复状态
 *
 * 生命周期：每次 agent.run(query) 创建新实例，不持久化。
 */
export interface RecoveryState {
  /** network / rate_limit 的 backoff 重试计数 */
  apiRetryCount: number;
  /** context_length 触发的 compact 计数 */
  compactRetryCount: number;
  /** output_interrupted 触发的 continuation 计数 */
  continueRetryCount: number;
}

/**
 * RecoveryConfig — 恢复配置
 *
 * 教学项目优先保持直观，默认值写成代码内常量。
 */
export interface RecoveryConfig {
  /** API 调用最大重试次数（network / rate_limit） */
  maxApiRetries: number;
  /** compact 最大重试次数 */
  maxCompactRetries: number;
  /** continue 最大重试次数 */
  maxContinueRetries: number;
  /** 每次 backoff 等待毫秒数 */
  retryDelayMs: number;
}

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  maxApiRetries: 5,
  maxCompactRetries: 1,
  maxContinueRetries: 2,
  retryDelayMs: 3000,
};

// ---------------------------------------------------------------------------
// 状态工厂
// ---------------------------------------------------------------------------

export function createRecoveryState(): RecoveryState {
  return {
    apiRetryCount: 0,
    compactRetryCount: 0,
    continueRetryCount: 0,
  };
}

// ---------------------------------------------------------------------------
// 错误分类
// ---------------------------------------------------------------------------

/**
 * classifyLLMError — 将任意错误对象分类为 LLMErrorKind
 *
 * 不依赖 OpenAI SDK 类型，通过以下结构读取：
 * - error.status（HTTP 状态码）
 * - error.code（错误码）
 * - error.message（错误信息字符串）
 */
export function classifyLLMError(error: unknown): LLMErrorKind {
  // 提取可读取的字段
  const status = extractNumber(error, "status");
  const message = extractString(error, "message").toLowerCase();

  // 1. credential：401 / 403，或明确提到认证相关关键词
  if (
    status === 401 ||
    status === 403 ||
    message.includes("api key") ||
    message.includes("unauthorized") ||
    message.includes("forbidden") ||
    message.includes("credential")
  ) {
    return "credential";
  }

  // 2. quota：429 且提到额度/余额/billing
  if (
    status === 429 &&
    (message.includes("quota") ||
      message.includes("insufficient_quota") ||
      message.includes("balance") ||
      message.includes("billing"))
  ) {
    return "quota";
  }

  // 3. rate_limit：其他 429
  if (status === 429) {
    return "rate_limit";
  }

  // 4. context_length：413 或明确提到上下文长度相关关键词
  // 注意：不是所有 400 都是 context_length，Kimi 等 provider 可能用 400
  // 返回参数校验错误（如 thinking/reasoning_content 缺失）
  if (
    status === 413 ||
    message.includes("context length") ||
    message.includes("maximum context") ||
    message.includes("token limit") ||
    message.includes("too many tokens")
  ) {
    return "context_length";
  }

  // 5. network：5xx 或网络/超时相关关键词
  if (
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504 ||
    message.includes("timeout") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("enotfound") ||
    message.includes("aborterror")
  ) {
    return "network";
  }

  // 6. 无法识别
  return "unknown";
}

// ---------------------------------------------------------------------------
// 恢复决策
// ---------------------------------------------------------------------------

/**
 * decideRecovery — 根据错误类型和当前恢复状态决定下一步动作
 *
 * 纯函数：相同输入永远产生相同输出，便于单元测试。
 */
export function decideRecovery(
  kind: LLMErrorKind,
  state: RecoveryState,
  config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): RecoveryAction {
  switch (kind) {
    case "network":
      return state.apiRetryCount < config.maxApiRetries ? "backoff" : "fail";

    case "rate_limit":
      return state.apiRetryCount < config.maxApiRetries ? "backoff" : "fail";

    case "context_length":
      return state.compactRetryCount < config.maxCompactRetries
        ? "compact"
        : "fail";

    case "output_interrupted":
      return state.continueRetryCount < config.maxContinueRetries
        ? "continue"
        : "fail";

    case "credential":
    case "quota":
    case "unknown":
      return "fail";
  }
}

// ---------------------------------------------------------------------------
// 提示文案
// ---------------------------------------------------------------------------

/**
 * formatRecoveryNotice — 生成恢复过程中的日志提示
 *
 * 供 logger.warn / logger.info / logger.error 使用。
 */
export function formatRecoveryNotice(
  action: RecoveryAction,
  kind: LLMErrorKind,
  state: RecoveryState,
  config: RecoveryConfig = DEFAULT_RECOVERY_CONFIG,
): string {
  switch (action) {
    case "backoff":
      return `LLM 调用失败，正在重试 ${state.apiRetryCount}/${config.maxApiRetries}，${config.retryDelayMs / 1000} 秒后继续...`;

    case "compact":
      return "LLM 上下文过长，正在压缩历史后重试...";

    case "continue":
      return `LLM 输出被截断，正在请求从断点继续 ${state.continueRetryCount}/${config.maxContinueRetries}...`;

    case "fail": {
      if (kind === "network" || kind === "rate_limit") {
        return `LLM 调用失败，已达到最大重试次数 (${config.maxApiRetries})，停止重试。`;
      }
      if (kind === "context_length") {
        return "上下文压缩后仍然超过模型窗口，停止重试。";
      }
      if (kind === "output_interrupted") {
        return "LLM 输出多次被截断，已达到继续次数上限。";
      }
      return "LLM 调用失败，无法恢复。";
    }
  }
}

/**
 * formatFailureMessage — 生成面向用户的最终失败提示
 */
export function formatFailureMessage(
  kind: LLMErrorKind,
  error?: unknown,
): string {
  switch (kind) {
    case "credential":
      return "LLM 认证配置错误，请检查 LLM_PROVIDER、API key、baseURL 和模型名。";

    case "quota":
      return "LLM token 额度或账户余额不足，请稍后或补充额度后再试。";

    case "context_length":
      return "上下文压缩后仍然超过模型窗口，请开启新会话或减少上下文。";

    case "output_interrupted":
      // output_interrupted 的 fail 通常带已有内容，由调用方拼接
      return "模型输出多次被截断，无法继续。";

    case "network":
    case "rate_limit": {
      const errMsg =
        error instanceof Error ? error.message : String(error ?? "");
      return `LLM 服务暂时不可用，已多次重试仍未恢复。${errMsg ? ` (${errMsg})` : ""}`;
    }

    case "unknown": {
      const errMsg =
        error instanceof Error ? error.message : String(error ?? "");
      return `LLM 调用出现未知错误：${errMsg}`;
    }
  }
}

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * sleep — 延迟指定毫秒数
 *
 * 单独导出，测试中可 mock。
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// 内部辅助：从任意对象安全提取字段
// ---------------------------------------------------------------------------

function extractNumber(obj: unknown, key: string): number | undefined {
  if (obj && typeof obj === "object" && key in obj) {
    const val = (obj as Record<string, unknown>)[key];
    if (typeof val === "number") return val;
  }
  return undefined;
}

function extractString(obj: unknown, key: string): string {
  if (obj && typeof obj === "object" && key in obj) {
    const val = (obj as Record<string, unknown>)[key];
    if (typeof val === "string") return val;
  }
  return "";
}
