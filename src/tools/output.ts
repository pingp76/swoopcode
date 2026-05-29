/**
 * tools/output.ts — Agent 持久化输出读取工具
 *
 * run_output_read 读取的是 OutputStore 登记过的大输出，而不是任意文件路径。
 * 这样 LLM 可以拿着 output_id 读回 compressor / async run 保存的完整输出，
 * 同时不会突破 projectRoot 或 agentHome 的路径边界。
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { OutputStore } from "../output-store.js";
import type { ToolResult } from "./types.js";

export interface OutputToolProvider {
  toolEntries: Array<{
    definition: ChatCompletionTool;
    execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  }>;
}

export const runOutputReadToolDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_output_read",
    description:
      "Read a persisted agent output by output_id. Only outputs registered by OutputStore can be read; this does not read arbitrary project or agentHome files.",
    parameters: {
      type: "object",
      properties: {
        output_id: {
          type: "string",
          description:
            "The output handle returned in a persisted-output block, such as out_20260528_153000_ab12cd.",
        },
        max_bytes: {
          type: "number",
          description: "Maximum bytes to return. Default 200000.",
        },
        start_byte: {
          type: "number",
          description:
            "Optional byte offset for reading later chunks of a large output.",
        },
      },
      required: ["output_id"],
    },
  },
};

export function createOutputToolProvider(
  outputStore: OutputStore,
): OutputToolProvider {
  // 设计套路：Output 工具是“句柄读取器”，不是文件读取器。
  // LLM 只能提供 output_id，不能提供文件路径。
  //
  // 这样做有两个好处：
  // 1. 安全：不能借 run_output_read 读取任意 projectRoot/agentHome 文件
  // 2. 可控：通过 max_bytes/start_byte 分片读取，避免大输出再次撑爆上下文
  //
  // 常见错误是把完整 outputPath 暴露给模型，再让模型用 run_read 读取。
  // 那会绕开 OutputStore index 校验，也会让不同项目/不同 run 的输出边界变模糊。

  async function executeRead(args: Record<string, unknown>): Promise<ToolResult> {
    // 从参数中提取 output_id，并去除首尾空白
    const outputId = String(args["output_id"] ?? "").trim();
    // 校验 output_id 不能为空，否则直接返回错误
    if (!outputId) {
      return { output: "Error: output_id is required", error: true };
    }

    // 解析可选的 max_bytes 参数，校验其是否为非负数
    const maxBytes = parseOptionalNonNegativeNumber(args["max_bytes"], "max_bytes");
    if (maxBytes instanceof Error) {
      return { output: `Error: ${maxBytes.message}`, error: true };
    }

    // 解析可选的 start_byte 参数，校验其是否为非负数
    const startByte = parseOptionalNonNegativeNumber(
      args["start_byte"],
      "start_byte",
    );
    if (startByte instanceof Error) {
      return { output: `Error: ${startByte.message}`, error: true };
    }

    try {
      // 调用 OutputStore 读取指定 outputId 的内容，仅在参数存在时传入可选限制
      // outputStore.read 内部会再次校验 output_id 格式、index 记录和 relativePath 边界。
      // 工具层校验参数友好性，Store 层守住真实安全边界，这是典型双层校验。
      const result = outputStore.read({
        outputId,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(startByte !== undefined ? { startByte } : {}),
      });
      // 将读取结果组装为结构化 JSON 返回给 LLM
      return {
        output: JSON.stringify(
          {
            type: "output_read",
            output_id: result.id,
            byte_length: result.byteLength,
            start_byte: result.startByte,
            returned_bytes: result.returnedBytes,
            truncated: result.truncated,
            content: result.content,
          },
          null,
          2,
        ),
        error: false,
      };
    } catch (err) {
      // 捕获读取过程中的异常，将错误信息包装后返回
      return {
        output: `Error reading output "${outputId}": ${
          err instanceof Error ? err.message : String(err)
        }`,
        error: true,
      };
    }
  }

  return {
    toolEntries: [
      {
        definition: runOutputReadToolDefinition,
        execute: executeRead,
      },
    ],
  };
}

function parseOptionalNonNegativeNumber(
  value: unknown,
  name: string,
): number | undefined | Error {
  // 工具参数来自 JSON，数字可能被模型写成字符串。
  // 这里允许 Number(value) 转换，是为了提高 LLM 自我修正前的容错；
  // 但仍拒绝 NaN/Infinity/负数，避免读取语义失控。
  // 若参数未传入，直接返回 undefined，表示使用默认值
  if (value === undefined) return undefined;
  // 将传入值转为数字类型
  const numberValue = Number(value);
  // 校验是否为有限数且非负，否则返回 Error 对象
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return new Error(`${name} must be a non-negative number`);
  }
  // 对合法值向下取整，避免传入小数
  return Math.floor(numberValue);
}
