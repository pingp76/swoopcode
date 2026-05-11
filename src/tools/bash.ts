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

/**
 * DANGEROUS_PATTERNS — 危险命令的正则表达式列表
 *
 * 每个正则匹配一类危险操作。这里的策略是"黑名单"模式：
 * 列出已知的危险模式，匹配到的就拒绝。
 *
 * \b 表示单词边界，防止误匹配（比如 "reboot" 不应匹配 "myreboot"）
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  // rm -rf：递归强制删除，尤其是 rm -rf / 会删除整个文件系统
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--no-preserve-root)/,
  // mkfs：格式化文件系统
  /\bmkfs\b/,
  // dd 写入块设备：可以直接覆盖硬盘数据
  /\bdd\s+.*of=\/dev\//,
  // fork bomb：fork 炸弹，会耗尽系统资源
  /:\(\)\{\s*:\|:&\s*\}/,
  // chmod 000 根目录：会锁死整个系统
  /\bchmod\s+(-R\s+)?000\s+\//,
  // 递归 chown 根目录：修改所有文件的 ownership
  /\bchown\b.*\b-R\b.*\//,
  // 重定向到块设备：覆盖硬盘
  />\s*\/dev\/sda/,
  // 系统电源命令
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpoweroff\b/,
  // 防火墙操作：可能导致网络断开
  /\biptables\b/,
  /\bufw\b/,
];

import { ToolResult } from "./types.js";

// 重新导出 ToolResult，保持向后兼容
// 其他已经 import { ToolResult } from "./bash.js" 的文件不需要修改
export type { ToolResult } from "./types.js";

/**
 * isDangerousCommand — 检查命令是否危险
 *
 * 遍历所有危险模式，只要有一个匹配就返回 true。
 *
 * @param command - 要检查的命令字符串
 * @returns true 表示命令危险，应该被拒绝
 */
export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}

/**
 * executeBash — 执行 bash 命令
 *
 * 工作流程：
 * 1. 先检查命令是否危险，如果是则直接返回拒绝信息
 * 2. 使用 Node.js 的 child_process.exec() 执行命令
 * 3. 设置了超时（30秒）和最大缓冲区（1MB）限制
 * 4. 返回执行结果（标准输出或错误信息）
 *
 * @param command - 要执行的 bash 命令
 * @returns Promise<ToolResult> - 命令执行的结果
 */
export function executeBash(
  command: string,
  cwd?: string,
): Promise<ToolResult> {
  // 安全检查：危险命令直接拒绝，不执行
  if (isDangerousCommand(command)) {
    return Promise.resolve({
      output: `Command blocked for safety: "${command}" contains a potentially dangerous operation.`,
      error: true,
    });
  }

  // 使用 Promise 包装 Node.js 的回调式 API
  return new Promise((resolve) => {
    exec(
      command,
      {
        cwd,
        timeout: 30_000, // 超时时间 30 秒，防止命令无限运行
        maxBuffer: 1024 * 1024, // 最大输出 1MB，防止内存溢出
      },
      (err, stdout, stderr) => {
        if (err) {
          // 命令执行失败（非零退出码或被信号终止）
          // 优先返回 stderr（命令自身的错误输出），否则返回 Node.js 的错误消息
          resolve({ output: stderr || err.message, error: true });
        } else {
          // 命令成功执行，返回标准输出
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
