/**
 * config.ts — 配置加载模块
 *
 * 职责：从 .env 文件中读取环境变量，通过 llm-providers 解析为 ResolvedLLMConfig，
 * 再与压缩、日志等本地配置组装成类型安全的 Config 对象。
 *
 * 这样做的好处：
 * - 敏感信息（API Key）与代码分离
 * - 不同环境使用不同的 .env 文件
 * - 厂商差异集中在 llm-providers.ts，本模块只负责组装
 */

// dotenv/config 是 dotenv 的副作用导入，不需要使用它的返回值
// 它的作用是：在 import 执行时，自动读取项目根目录的 .env 文件，
// 把里面的键值对设置到 process.env 中
import "dotenv/config";

import {
  resolveLLMProviderConfig,
  type LLMProviderId,
  type LLMProviderCapabilities,
} from "./llm-providers.js";

/**
 * Config — 应用配置的类型定义
 *
 * 通过 interface 定义配置的形状，TypeScript 会在编译时检查
 * 所有使用配置的地方是否正确访问了这些字段。
 */
export interface Config {
  /** 当前使用的 provider id */
  provider: LLMProviderId;
  /** provider 的显示名称 */
  providerDisplayName: string;
  /** LLM API 的认证密钥 */
  apiKey: string;
  /** LLM API 的基础 URL */
  baseURL: string;
  /** 要调用的模型名称 */
  model: string;
  /** provider 能力标记，供 llm.ts 做兼容决策 */
  llmCapabilities: LLMProviderCapabilities;
  /** 日志级别：debug < info < warn < error */
  logLevel: string;
  /** 上下文压缩配置 */
  compression: CompressionConfig;
}

/**
 * CompressionConfig — 压缩相关配置项
 *
 * 所有项都有默认值，通过环境变量覆盖。
 */
export interface CompressionConfig {
  /** 即时压缩的 token 阈值（超过此值存文件） */
  thresholdToolOutput: number;
  /** 衰减压缩的轮次阈值（超过此轮数的工具结果会被截断） */
  decayThreshold: number;
  /** 衰减后保留的 token 数 */
  decayPreviewTokens: number;
  /** 触发全量压缩的 token 阈值 */
  maxContextTokens: number;
  /** 全量压缩时保留的最近消息块数 */
  compactKeepRecent: number;
}

/**
 * loadConfig — 加载并返回应用配置
 *
 * 1. 调用 resolveLLMProviderConfig() 解析 provider、apiKey、baseURL、model
 * 2. 保留原有 compression / logLevel 逻辑
 * 3. 返回统一的 Config 对象
 *
 * 后续代码只需要依赖这个 Config 对象，不需要直接访问 process.env。
 */
export function loadConfig(): Config {
  // 解析 LLM provider 配置（含优先级处理和环境变量覆盖）
  const resolved = resolveLLMProviderConfig(process.env);

  return {
    provider: resolved.provider,
    providerDisplayName: resolved.displayName,
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    model: resolved.model,
    llmCapabilities: resolved.capabilities,
    // ?? 是空值合并运算符：只有当左边是 null 或 undefined 时才使用右边的默认值
    logLevel: process.env["LOG_LEVEL"] ?? "info",
    compression: {
      thresholdToolOutput: Number(process.env["COMPRESS_TOOL_OUTPUT"]) || 2000,
      decayThreshold: Number(process.env["COMPRESS_DECAY_THRESHOLD"]) || 3,
      decayPreviewTokens: Number(process.env["COMPRESS_DECAY_PREVIEW"]) || 100,
      maxContextTokens: Number(process.env["COMPRESS_MAX_CONTEXT"]) || 80000,
      compactKeepRecent: Number(process.env["COMPACT_KEEP_RECENT"]) || 4,
    },
  };
}
