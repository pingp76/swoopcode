/**
 * bash.ts — Bash 工具实现
 *
 * 职责：让 Agent 能够执行 shell 命令，同时过滤掉危险操作。
 *
 * 这是 Coding Agent 最核心的能力之一：通过执行命令来与系统交互，
 * 例如运行代码、安装依赖、查看文件等。
 *
 * 安全设计：
 * - 在执行前，用正则表达式检查命令是否匹配已知的危险模式
 * - 如果匹配，直接拒绝执行并返回错误信息
 * - 这不是完美的安全方案（复杂的命令可能绕过），但对于教学目的足够了
 *
 * 工具调用流程（从 LLM 的角度）：
 * 1. LLM 决定需要执行一个 bash 命令
 * 2. LLM 返回一个 tool_calls 响应，包含工具名 "bash" 和参数 { "command": "..." }
 * 3. Agent 调用本模块的 executeBash() 执行命令
 * 4. 执行结果作为 tool 角色的消息返回给 LLM
 */

import { exec } from "node:child_process";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import {
  createDefaultAsyncCommandPolicy as createDefaultExecutionAsyncCommandPolicy,
  type AsyncCommandPolicy,
} from "../execution-policy.js";
import { isDangerousCommand } from "../command-safety.js";

import { ToolResult } from "./types.js";

// 重新导出 ToolResult，保持向后兼容
// 其他已经 import { ToolResult } from "./bash.js" 的文件不需要修改
export type { ToolResult } from "./types.js";

export { isDangerousCommand } from "../command-safety.js";

export type { AsyncCommandPolicy } from "../execution-policy.js";

/**
 * createDefaultAsyncCommandPolicy — 创建默认的异步命令策略
 *
 * 验证逻辑（按顺序）：
 * 1. 先拒绝 shell control operators
 * 2. 再拒绝写入命令（git add/commit/push 等）
 * 3. 再拒绝裸 find
 * 4. 最后检查白名单前缀
 */
export function createDefaultAsyncCommandPolicy(): AsyncCommandPolicy {
  return createDefaultExecutionAsyncCommandPolicy();
}

/**
 * executeBash — 执行 bash 命令
 *
 * 工作流程：
 * 1. 先检查命令是否危险，如果是则直接返回拒绝信息
 * 2. 使用 Node.js 的 child_process.exec() 执行命令
 * 3. 设置了超时（默认 30 秒）和最大缓冲区（1MB）限制
 * 4. 返回执行结果（标准输出或错误信息）
 *
 * @param command - 要执行的 bash 命令
 * @param cwd - 可选，执行命令的工作目录
 * @param timeout - 可选，自定义超时时间（毫秒），默认 30 秒
 * @returns Promise<ToolResult> - 命令执行的结果
 */
export function executeBash(
  command: string,
  cwd?: string,
  timeout?: number,
): Promise<ToolResult> {
  // 教学导读：
  // bash 工具是最危险、也最能体现 Agent 能力的工具。
  // 这里实现的是“最小可用版本”：它能执行 shell 命令，但先经过硬性危险命令检查；
  // 更细的策略（比如只读白名单）由 PermissionManager / ExecutionPolicy / ToolRegistry options
  // 在调用这个函数之前完成。

  // 安全检查：危险命令直接拒绝，不执行
  // 使用正则匹配已知危险模式，命中则立即返回错误结果，避免调用 exec
  if (isDangerousCommand(command)) {
    return Promise.resolve({
      output: `Command blocked for safety: "${command}" contains a potentially dangerous operation.`,
      error: true,
    });
  }

  // 使用 Promise 包装 Node.js 的回调式 API
  // child_process.exec 基于回调，包装为 Promise 便于在 async/await 流程中使用
  // 注意：exec 会通过 shell 执行命令，这比 spawn(argv) 更灵活但也更危险。
  // 教学项目先保留 exec 以便理解工具调用闭环，后续可演进到更严格的 argv 执行模型。
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd, // 指定命令执行的工作目录，未指定时在 Node.js 当前进程目录执行
        // 超时时间：如果调用方传入了合法正数则使用，否则默认 30 秒
        timeout: timeout !== undefined && timeout > 0 ? timeout : 30_000,
        // 最大输出缓冲区 1MB，防止子进程产生海量输出导致主进程内存溢出
        maxBuffer: 1024 * 1024,
      },
      // exec 的回调在命令执行完毕（无论成功或失败）后被调用
      (err, stdout, stderr) => {
        if (err) {
          // 命令执行失败（非零退出码或被信号终止）
          // 优先返回 stderr（命令自身的错误输出），否则返回 Node.js 的错误消息
          resolve({ output: stderr || err.message, error: true });
        } else {
          // 命令成功执行，返回标准输出
          // stdout 可能为空字符串，属于正常情况（如无输出的命令）
          resolve({ output: stdout, error: false });
        }
      },
    );
  });
}

/**
 * bashToolDefinition — bash 工具的 OpenAI function calling 定义
 *
 * 这个对象会传给 LLM API，告诉模型有一个名为 "bash" 的工具可用。
 * LLM 会根据这个描述决定何时调用这个工具，以及如何构造参数。
 *
 * 结构遵循 OpenAI 的 function calling 规范：
 * - type: "function" 表示这是一个函数调用类型的工具
 * - function.name: 工具名称，模型返回的 tool_call 中会引用这个名字
 * - function.description: 工具描述，帮助模型理解何时应该使用此工具
 * - function.parameters: 参数的 JSON Schema 定义
 */
export const bashToolDefinition: ChatCompletionTool = {
  type: "function",
  function: {
    name: "run_bash",
    description:
      "Execute a bash shell command and return its output. Commands are validated for safety before execution.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The bash command to execute",
        },
      },
      required: ["command"],
    },
  },
};
