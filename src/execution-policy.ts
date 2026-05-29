/**
 * execution-policy.ts — 非交互执行边界
 *
 * 职责：统一描述 Async Run、Schedule、子智能体等“确认一次后内部不再 ask”
 * 的执行能力边界。PermissionManager 仍负责 plan/default/auto 的交互模式，
 * 本模块只回答：某个已授权的后台/子流程能不能执行这条命令、声明这些资源。
 */

import { resolve, sep } from "node:path";
import { isDangerousCommand } from "./command-safety.js";

export type ExecutionProfile = "readonly" | "ci" | "workspace_write";

export interface PolicyValidation {
  allowed: boolean;
  reason?: string;
}

export interface CommandValidationInput {
  command: string;
  profile?: ExecutionProfile;
}

export interface ResourceValidationInput {
  projectRoot: string;
  readPaths: string[];
  writePaths: string[];
  profile?: ExecutionProfile;
}

export interface ExecutionPolicy {
  maxTimeoutMs: number;
  validateCommand(input: CommandValidationInput): PolicyValidation;
  validateResources(input: ResourceValidationInput): PolicyValidation;
}

/**
 * 兼容旧接口：Async Run / 子智能体已有多处只需要 command validate。
 * 第三轮先保留这个窄接口，内部统一转发到 ExecutionPolicy。
 */
export interface AsyncCommandPolicy {
  maxTimeoutMs: number;
  validate(command: string): PolicyValidation;
}

const MAX_TIMEOUT_MS = 300_000;

const SHELL_OPERATOR_CHARS = /[;&|`$<>()]/;

const GIT_WRITE_COMMANDS = new Set([
  "add",
  "commit",
  "push",
  "reset",
  "checkout",
  "switch",
  "restore",
  "clean",
]);

export function createExecutionPolicy(): ExecutionPolicy {
  return {
    maxTimeoutMs: MAX_TIMEOUT_MS,

    validateCommand(input: CommandValidationInput): PolicyValidation {
      const profile = input.profile ?? "readonly";
      if (profile === "workspace_write") {
        // workspace_write 是给后续课程预留的概念。
        // 现在显式拒绝，比“类型上支持但运行时悄悄放行”更安全，也更适合教学。
        return {
          allowed: false,
          reason: "workspace_write execution profile is reserved for a later lesson",
        };
      }

      return validateCommandForProfile(input.command, profile);
    },

    validateResources(input: ResourceValidationInput): PolicyValidation {
      const profile = input.profile ?? "readonly";
      if (profile === "workspace_write") {
        return {
          allowed: false,
          reason: "workspace_write execution profile is reserved for a later lesson",
        };
      }

      const projectRoot = resolve(input.projectRoot);
      // read_paths / write_paths 来自 LLM tool 参数，必须当作不可信输入处理。
      // 先校验数组形状，再逐个校验元素类型和路径边界。
      if (!Array.isArray(input.readPaths)) {
        return { allowed: false, reason: "read_paths must be an array" };
      }
      if (!Array.isArray(input.writePaths)) {
        return { allowed: false, reason: "write_paths must be an array" };
      }

      for (const p of input.readPaths) {
        if (typeof p !== "string") {
          return { allowed: false, reason: "read_paths must contain only strings" };
        }
        // read path 必须落在当前 projectRoot 下，避免后台任务读取用户未授权目录。
        if (!isPathWithin(p, projectRoot)) {
          return {
            allowed: false,
            reason: `read_paths entry "${p}" is outside project directory`,
          };
        }
      }

      for (const p of input.writePaths) {
        if (typeof p !== "string") {
          return { allowed: false, reason: "write_paths must contain only strings" };
        }
      }

      if (input.writePaths.length > 0) {
        // readonly/ci 在当前阶段都不允许后台写。
        // ci 只表示允许更宽的诊断命令（如 build），不表示允许修改 workspace。
        return {
          allowed: false,
          reason: `${profile} execution profile does not allow write_paths`,
        };
      }

      return { allowed: true };
    },
  };
}

export function createReadonlyCommandPolicy(
  policy: ExecutionPolicy = createExecutionPolicy(),
): AsyncCommandPolicy {
  return {
    maxTimeoutMs: policy.maxTimeoutMs,
    validate(command: string): PolicyValidation {
      return policy.validateCommand({ command, profile: "readonly" });
    },
  };
}

export function createDefaultAsyncCommandPolicy(): AsyncCommandPolicy {
  return createReadonlyCommandPolicy();
}

function validateCommandForProfile(
  command: string,
  profile: Exclude<ExecutionProfile, "workspace_write">,
): PolicyValidation {
  const trimmed = command.trim();
  if (!trimmed) {
    return { allowed: false, reason: "Command is empty" };
  }

  if (isDangerousCommand(trimmed)) {
    // 危险命令黑名单是硬边界，优先于 allowlist。
    // 即使命令后面看起来像只读，也不能继续解析。
    return { allowed: false, reason: "Dangerous command blocked" };
  }

  if (SHELL_OPERATOR_CHARS.test(trimmed)) {
    // 这个教学实现只接受简单 argv。
    // 管道、重定向、命令替换等 shell 语法很难可靠静态判断副作用，所以直接拒绝。
    return {
      allowed: false,
      reason: "Shell operators are not allowed in non-interactive commands",
    };
  }

  const argv = parseSimpleArgv(trimmed);
  if (!argv) {
    return {
      allowed: false,
      reason: "Command could not be parsed safely",
    };
  }

  if (isGitWriteCommand(argv)) {
    // Git 写命令在后台非交互路径中全部拒绝。
    // 代码提交、切分分支等操作应由前台 Agent 在用户可见上下文里完成。
    return {
      allowed: false,
      reason: "Write command is not allowed in non-interactive commands",
    };
  }

  return profile === "ci"
    ? validateCiCommand(argv)
    : validateReadonlyCommand(argv);
}

function validateReadonlyCommand(argv: string[]): PolicyValidation {
  // readonly profile 只允许“观察型”命令和不会写文件的检查命令。
  // 这里的 allowlist 故意短，便于学生逐项理解每个命令为什么安全。
  if (allowsCommonReadonlyCommand(argv)) return { allowed: true };

  if (isNpmRun(argv, "typecheck")) return { allowed: true };
  if (isNpmRun(argv, "lint")) return rejectFixFlag(argv);
  if (isNpmRun(argv, "format:check")) return { allowed: true };
  if (argv.length === 2 && argv[0] === "npm" && argv[1] === "test") {
    return { allowed: true };
  }

  if (isNpx(argv, "vitest") && argv[2] === "run") return { allowed: true };
  if (isNpx(argv, "eslint")) return rejectFixFlag(argv);
  if (isNpx(argv, "tsc")) {
    return argv.includes("--noEmit")
      ? { allowed: true }
      : { allowed: false, reason: "npx tsc must include --noEmit in readonly profile" };
  }

  if (isNpmRun(argv, "build")) {
    return {
      allowed: false,
      reason: "npm run build requires ci execution profile",
    };
  }

  return {
    allowed: false,
    reason: `Command not in allowed list: ${argv.slice(0, 3).join(" ")}`,
  };
}

function validateCiCommand(argv: string[]): PolicyValidation {
  // ci profile 在 readonly 基础上允许更重的验证命令。
  // 它仍然不允许修复、格式化写回或任意 shell。
  const readonly = validateReadonlyCommand(argv);
  if (readonly.allowed) return readonly;

  if (isNpmRun(argv, "build")) return { allowed: true };
  if (isNpmRun(argv, "test")) return { allowed: true };
  if (isNpmRun(argv, "test:coverage")) return { allowed: true };

  return readonly;
}

function allowsCommonReadonlyCommand(argv: string[]): boolean {
  const [cmd, sub] = argv;
  if (!cmd) return false;
  // 这些命令默认被视为只读观察命令。
  // 注意 sed 只允许 -n，因为普通 sed 也可以配合 -i 写文件。
  if (cmd === "pwd" || cmd === "ls" || cmd === "rg" || cmd === "cat") {
    return true;
  }
  if (cmd === "head" || cmd === "tail") return true;
  if (cmd === "sed") return sub === "-n";
  if (cmd === "git") {
    if (!sub) return false;
    if (GIT_WRITE_COMMANDS.has(sub)) return false;
    return sub === "status" || sub === "diff" || sub === "log" || sub === "show";
  }
  if (cmd === "find") return false;
  return false;
}

function isGitWriteCommand(argv: string[]): boolean {
  const [cmd, sub] = argv;
  return cmd === "git" && sub !== undefined && GIT_WRITE_COMMANDS.has(sub);
}

function rejectFixFlag(argv: string[]): PolicyValidation {
  if (argv.includes("--fix")) {
    return { allowed: false, reason: "--fix is not allowed in non-interactive commands" };
  }
  return { allowed: true };
}

function isNpmRun(argv: string[], script: string): boolean {
  return argv[0] === "npm" && argv[1] === "run" && argv[2] === script;
}

function isNpx(argv: string[], binary: string): boolean {
  return argv[0] === "npx" && argv[1] === binary;
}

function isPathWithin(filePath: string, baseDir: string): boolean {
  // 统一 resolve 后再比较前缀，避免 "../" 这类路径穿越绕过字符串检查。
  const resolved = resolve(baseDir, filePath);
  return resolved === baseDir || resolved.startsWith(baseDir + sep);
}

/**
 * parseSimpleArgv — 保守 argv 解析
 *
 * 只支持普通空白分隔和简单单/双引号。更复杂的 shell 语法在前面的
 * SHELL_OPERATOR_CHARS 阶段已经被拒绝；如果这里仍无法可靠解析，就返回 null。
 */
function parseSimpleArgv(command: string): string[] | null {
  const result: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      // 引号内只做字符累加，不解释转义和变量。
      // 复杂 shell 能力已经在更前面被拒绝，这是一个“够用但保守”的解析器。
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        result.push(current);
        current = "";
      }
      continue;
    }

    current += ch;
  }

  if (quote) return null;
  if (current) result.push(current);
  return result;
}
