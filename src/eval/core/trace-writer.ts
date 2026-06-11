/**
 * trace-writer.ts — Eval Trace JSON 输出器
 *
 * 职责：将 EvalTrace 写入 JSON 文件，便于 CI artifact 和失败分析。
 *
 * 设计原则：
 * - 默认不写入仓库目录，避免产生脏文件
 * - 支持 EVAL_TRACE_DIR 环境变量覆盖输出目录
 * - 文件名使用安全 case id，避免路径注入
 */

import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EvalTrace } from "./case-schema.js";

/** Trace 写入选项 */
export interface EvalTraceWriterOptions {
  /** 输出目录 */
  outputDir?: string;
  /** 是否启用写入 */
  enabled?: boolean;
}

/**
 * writeEvalTrace — 将 trace 写入 JSON 文件
 *
 * @param trace - 完整的 eval trace
 * @param options - 写入选项
 * @returns 写入的文件路径，或 null（如果未启用）
 *
 * 行为要求：
 * 1. 默认不写入仓库目录
 * 2. 如果 EVAL_TRACE_DIR 环境变量存在，则使用该目录
 * 3. 文件名使用安全 case id，例如 `<case-id>.trace.json`
 * 4. 写入 JSON 使用两空格缩进
 * 5. 失败 trace 也要写
 * 6. 返回写入路径，供测试失败消息打印
 */
export async function writeEvalTrace(
  trace: EvalTrace,
  options: EvalTraceWriterOptions,
): Promise<string | null> {
  // 如果显式禁用，直接返回 null
  if (options.enabled === false) {
    return null;
  }

  // 决定输出目录：优先级为 options.outputDir > EVAL_TRACE_DIR > 系统临时目录
  const outputDir =
    options.outputDir ?? process.env["EVAL_TRACE_DIR"] ?? join(tmpdir(), "eval-traces");

  // 创建目录（递归，不报错）
  await mkdir(outputDir, { recursive: true });

  // 文件名安全化：把非安全字符替换为下划线
  const safeCaseId = trace.caseId.replace(/[^a-zA-Z0-9._-]/g, "_");
  const fileName = `${safeCaseId}.trace.json`;
  const filePath = join(outputDir, fileName);

  // 两空格缩进写入 JSON
  await writeFile(filePath, JSON.stringify(trace, null, 2), "utf-8");

  return filePath;
}
