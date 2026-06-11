/**
 * files.ts — 文件操作工具实现
 *
 * 职责：提供三个文件操作工具，让 Agent 能够读写和编辑文件。
 *
 * 三个工具：
 * - run_read：读取文件内容
 * - run_write：写入文件（覆盖已有内容）
 * - run_edit：编辑文件（查找并替换）
 * - run_edit_exact：安全编辑文件（只有匹配次数符合预期才替换）
 *
 * 安全设计：
 * - 所有文件操作都限制在当前工作目录（process.cwd()）内
 * - 通过 path.resolve() 解析路径后，检查是否以 cwd 开头
 * - 防止路径穿越攻击（如 "../../etc/passwd"）
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname, sep } from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolResult } from "./types.js";

/**
 * isPathSafe — 检查文件路径是否在当前工作目录内
 *
 * 安全检查的核心逻辑：
 * 1. 使用 path.resolve() 将相对路径转为绝对路径
 *    - resolve("../../../etc/passwd") → "/etc/passwd"
 *    - resolve("src/file.ts") → "/Users/.../project/src/file.ts"
 * 2. 检查解析后的路径是否以 process.cwd() 开头
 *    - process.cwd() 是程序启动时的工作目录
 *
 * 为什么要用 resolve + startsWith？
 * - 单纯检查 ".." 不够，路径可能编码或嵌套
 * - resolve 会自动处理 ".." 和 "."，得到真实的绝对路径
 * - startsWith 确保不会逃逸到上级目录
 *
 * @param filePath - 要检查的文件路径（可以是相对路径或绝对路径）
 * @param baseDir - 基准目录（默认为 process.cwd()），路径必须在此目录内
 * @returns true 表示路径安全（在工作目录内），false 表示不安全
 */
export function isPathSafe(filePath: string, baseDir?: string): boolean {
  const cwd = baseDir ?? process.cwd();
  const resolved = resolve(cwd, filePath);
  // 路径必须以 cwd + sep 开头（确保是 cwd 的子路径，而不是恰好前缀匹配）
  // 例如 cwd = "/home/user"，不匹配 "/home/userdata"
  return resolved === cwd || resolved.startsWith(cwd + sep);
}

/**
 * resolveSafePath — 按项目根目录解析实际读写路径
 *
 * 相对路径会相对 baseDir 解析；绝对路径保持自身语义。
 */
function resolveSafePath(filePath: string, baseDir?: string): string {
  // 使用 path.resolve 将传入路径解析为绝对路径，baseDir 缺省时使用当前工作目录
  return resolve(baseDir ?? process.cwd(), filePath);
}

/**
 * runReadToolDefinition — run_read 工具的 OpenAI function calling 定义
 *
 * 告诉 LLM：有一个名为 "run_read" 的工具，可以读取文件内容。
 */
export const runReadToolDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_read",
    description:
      "Read the contents of a file. The file path must be within the current working directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The path of the file to read, relative to the current working directory.",
        },
      },
      required: ["path"],
    },
  },
};

/**
 * runWriteToolDefinition — run_write 工具的 OpenAI function calling 定义
 */
export const runWriteToolDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_write",
    description:
      "Write content to a file, creating it if it doesn't exist. Will overwrite existing content. The file path must be within the current working directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The path of the file to write, relative to the current working directory.",
        },
        content: {
          type: "string",
          description: "The content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
  },
};

/**
 * runEditToolDefinition — run_edit 工具的 OpenAI function calling 定义
 */
export const runEditToolDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_edit",
    description:
      "Legacy edit tool: replace all occurrences of old_string with new_string. Prefer run_edit_exact for source changes when you expect a specific number of matches. The file path must be within the current working directory.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The path of the file to edit, relative to the current working directory.",
        },
        old_string: {
          type: "string",
          description: "The text to find and replace.",
        },
        new_string: {
          type: "string",
          description: "The text to replace old_string with.",
        },
      },
      required: ["path", "old_string", "new_string"],
    },
  },
};

/**
 * runEditExactToolDefinition — run_edit_exact 工具的 OpenAI function calling 定义
 */
export const runEditExactToolDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_edit_exact",
    description:
      "Safely edit a file by replacing old_string only when the occurrence count matches expected_occurrences. Prefer this over run_edit for source changes.",
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "The path of the file to edit, relative to the current working directory.",
        },
        old_string: {
          type: "string",
          description: "The exact non-empty text to find and replace.",
        },
        new_string: {
          type: "string",
          description: "The text to replace old_string with.",
        },
        expected_occurrences: {
          type: "number",
          description:
            "Required expected occurrence count. Use 1 for an exact single edit.",
        },
      },
      required: ["path", "old_string", "new_string", "expected_occurrences"],
    },
  },
};

/**
 * executeRead — 执行文件读取
 *
 * 工作流程：
 * 1. 检查路径安全性（防止读取工作目录外的文件）
 * 2. 使用 Node.js 的 fs.readFile 读取文件内容
 * 3. 如果文件不存在，返回友好的错误信息
 *
 * @param filePath - 要读取的文件路径
 * @returns ToolResult - 文件内容或错误信息
 */
export async function executeRead(
  filePath: string,
  baseDir?: string,
): Promise<ToolResult> {
  // 教学导读：
  // 文件工具是 LLM 改代码的基础能力，但它不能直接信任模型给出的 path。
  // 每个文件操作都先做同一个边界检查：目标路径必须落在 baseDir/projectRoot 内。
  // 这样即使模型尝试读取 "../" 或系统文件，也会在工具层被挡住。

  // 安全检查：路径必须在工作目录内
  if (!isPathSafe(filePath, baseDir)) {
    return {
      output: `Error: Path "${filePath}" is outside the working directory. File operations are restricted to the current working directory.`,
      error: true,
    };
  }

  try {
    // 将相对路径解析为可用于 fs 操作的绝对路径
    const targetPath = resolveSafePath(filePath, baseDir);
    // 使用 utf-8 编码读取文件，返回字符串
    const content = await readFile(targetPath, "utf-8");
    return { output: content, error: false };
  } catch (err) {
    // 文件不存在是最常见的错误，给出明确的提示
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {
        output: `Error: File not found: "${filePath}"`,
        error: true,
      };
    }
    // 其他错误（权限不足、是目录等）
    return {
      output: `Error reading file "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  }
}

/**
 * executeWrite — 执行文件写入
 *
 * 工作流程：
 * 1. 检查路径安全性
 * 2. 自动创建父目录（如果不存在）
 * 3. 写入文件内容（覆盖已有内容）
 *
 * @param filePath - 要写入的文件路径
 * @param content - 要写入的内容
 * @returns ToolResult - 成功确认或错误信息
 */
export async function executeWrite(
  filePath: string,
  content: string,
  baseDir?: string,
): Promise<ToolResult> {
  // executeWrite 是“覆盖写”，不是 patch。
  // 这对教学很直观：给定完整内容，写入完整文件；
  // 但真实使用时风险也更大，所以权限层通常会要求用户确认。

  // 安全检查：路径必须在工作目录内
  if (!isPathSafe(filePath, baseDir)) {
    return {
      output: `Error: Path "${filePath}" is outside the working directory. File operations are restricted to the current working directory.`,
      error: true,
    };
  }

  try {
    // 确保父目录存在（相当于 mkdir -p）
    // 例如写入 "src/new-dir/file.ts" 时，自动创建 "src/new-dir/"
    const targetPath = resolveSafePath(filePath, baseDir);
    // 提取文件所在目录路径，用于后续递归创建
    const dir = dirname(targetPath);
    // 只有当目录路径非空时才创建，避免对根目录调用 mkdir
    if (dir) {
      await mkdir(dir, { recursive: true });
    }

    // 写入文件内容，utf-8 编码
    await writeFile(targetPath, content, "utf-8");
    return {
      output: `Successfully wrote to "${filePath}" (${content.length} bytes)`,
      error: false,
    };
  } catch (err) {
    return {
      output: `Error writing to "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  }
}

/**
 * executeEdit — 执行文件编辑（查找替换）
 *
 * 工作流程：
 * 1. 检查路径安全性
 * 2. 读取文件当前内容
 * 3. 检查 old_string 是否存在于文件中
 * 4. 将所有 old_string 替换为 new_string（replaceAll）
 * 5. 写回文件
 *
 * @param filePath - 要编辑的文件路径
 * @param oldString - 要查找的文本
 * @param newString - 替换后的文本
 * @returns ToolResult - 编辑结果或错误信息
 */
export async function executeEdit(
  filePath: string,
  oldString: string,
  newString: string,
  baseDir?: string,
): Promise<ToolResult> {
  // executeEdit 保留早期课程的简单语义：replaceAll。
  // 它容易理解，但如果 old_string 出现多次，就会全部替换。
  // 后续的 executeEditExact 正是为了解决这个教学阶段留下的风险。

  // 安全检查：路径必须在工作目录内
  if (!isPathSafe(filePath, baseDir)) {
    return {
      output: `Error: Path "${filePath}" is outside the working directory. File operations are restricted to the current working directory.`,
      error: true,
    };
  }

  try {
    // 将相对路径解析为绝对路径，确保后续 fs 操作指向正确位置
    const targetPath = resolveSafePath(filePath, baseDir);
    // 先读取文件当前内容
    const content = await readFile(targetPath, "utf-8");

    // 检查 old_string 是否存在于文件中
    // 若不存在则提前返回错误，避免无意义写回
    if (!content.includes(oldString)) {
      return {
        output: `Error: old_string not found in "${filePath}". No changes made.`,
        error: true,
      };
    }

    // 执行全部替换：将文件中所有 oldString 替换为 newString
    const newContent = content.replaceAll(oldString, newString);

    // 将修改后的内容写回文件，完成编辑
    await writeFile(targetPath, newContent, "utf-8");

    return {
      output: `Successfully edited "${filePath}" (${oldString.length} → ${newString.length} chars)`,
      error: false,
    };
  } catch (err) {
    // 捕获文件不存在的错误，给出明确提示
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {
        output: `Error: File not found: "${filePath}"`,
        error: true,
      };
    }
    return {
      output: `Error editing "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  }
}

/**
 * executeEditExact — 执行安全文件编辑
 *
 * 与 executeEdit 的 replaceAll 教学语义不同，这个工具要求调用方显式声明
 * old_string 预期出现次数。只有实际次数完全一致时才写文件，避免模型误把
 * 重复片段全部替换掉。
 */
export async function executeEditExact(
  filePath: string,
  oldString: string,
  newString: string,
  expectedOccurrences: number,
  baseDir?: string,
): Promise<ToolResult> {
  // 这个工具体现了“让模型先声明预期，再执行写入”的安全思路。
  // 如果模型以为 old_string 只出现 1 次，但实际出现 3 次，工具会拒绝写入，
  // 让模型重新读取上下文后再选择更精确的 old_string。

  // 安全检查：路径必须在工作目录内，防止路径穿越
  if (!isPathSafe(filePath, baseDir)) {
    return {
      output: `Error: Path "${filePath}" is outside the working directory. File operations are restricted to the current working directory.`,
      error: true,
    };
  }

  // 校验 oldString 非空：空字符串无法定位替换位置，且会导致无限循环
  if (oldString.length === 0) {
    return {
      output: "Error: old_string must be non-empty. No changes made.",
      error: true,
    };
  }

  // 校验 expectedOccurrences 必须是正整数，确保调用方明确知道预期匹配次数
  if (!Number.isInteger(expectedOccurrences) || expectedOccurrences <= 0) {
    return {
      output:
        "Error: expected_occurrences must be a positive integer. No changes made.",
      error: true,
    };
  }

  try {
    // 解析目标文件的绝对路径
    const targetPath = resolveSafePath(filePath, baseDir);
    // 读取文件当前完整内容
    const content = await readFile(targetPath, "utf-8");
    // 统计 oldString 在文件中实际出现的次数
    const actualOccurrences = countOccurrences(content, oldString);

    // 只有实际出现次数与预期完全一致时才执行替换，防止误替换
    if (actualOccurrences !== expectedOccurrences) {
      return {
        output:
          `Error: expected ${expectedOccurrences} occurrence(s) of old_string in "${filePath}", ` +
          `but found ${actualOccurrences}. No changes made.`,
        error: true,
      };
    }

    // 使用 split + join 进行精确替换（效果等同于 replaceAll，但语义更清晰）
    const newContent = content.split(oldString).join(newString);
    // 将替换后的内容写回文件
    await writeFile(targetPath, newContent, "utf-8");

    return {
      output:
        `Successfully edited "${filePath}" (${actualOccurrences} replacement(s), ` +
        `${content.length} → ${newContent.length} chars)`,
      error: false,
    };
  } catch (err) {
    // 文件不存在时单独处理，返回友好错误
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      return {
        output: `Error: File not found: "${filePath}"`,
        error: true,
      };
    }
    return {
      output: `Error editing "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
      error: true,
    };
  }
}

/**
 * countOccurrences — 统计子串在字符串中出现的次数
 *
 * 采用滑动窗口方式遍历，不重叠计数。
 */
function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = 0;
  // 无限循环，通过内部 break/return 退出
  for (;;) {
    // 从当前 index 位置开始查找 needle
    const foundAt = content.indexOf(needle, index);
    // 未找到则返回累计次数
    if (foundAt === -1) return count;
    // 找到一次，计数器加一
    count++;
    // 将搜索起点移动到已匹配片段之后，避免重叠匹配
    index = foundAt + needle.length;
  }
}
