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
  async function executeRead(args: Record<string, unknown>): Promise<ToolResult> {
    const outputId = String(args["output_id"] ?? "").trim();
    if (!outputId) {
      return { output: "Error: output_id is required", error: true };
    }

    const maxBytes = parseOptionalNonNegativeNumber(args["max_bytes"], "max_bytes");
    if (maxBytes instanceof Error) {
      return { output: `Error: ${maxBytes.message}`, error: true };
    }

    const startByte = parseOptionalNonNegativeNumber(
      args["start_byte"],
      "start_byte",
    );
    if (startByte instanceof Error) {
      return { output: `Error: ${startByte.message}`, error: true };
    }

    try {
      const result = outputStore.read({
        outputId,
        ...(maxBytes !== undefined ? { maxBytes } : {}),
        ...(startByte !== undefined ? { startByte } : {}),
      });
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
  if (value === undefined) return undefined;
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue) || numberValue < 0) {
    return new Error(`${name} must be a non-negative number`);
  }
  return Math.floor(numberValue);
}
