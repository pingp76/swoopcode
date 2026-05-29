/**
 * command-safety.ts — shell 命令硬性安全黑名单
 *
 * 这是普通 run_bash 和非交互 ExecutionPolicy 共同依赖的底层安全判断。
 * 它只负责拦截明显危险的命令，不表达 readonly / ci 等能力 profile。
 */

const DANGEROUS_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|.*--no-preserve-root)/,
  /\bmkfs\b/,
  /\bdd\s+.*of=\/dev\//,
  /:\(\)\{\s*:\|:&\s*\}/,
  /\bchmod\s+(-R\s+)?000\s+\//,
  /\bchown\b.*\b-R\b.*\//,
  />\s*\/dev\/sda/,
  /\bshutdown\b/,
  /\breboot\b/,
  /\bpoweroff\b/,
  /\biptables\b/,
  /\bufw\b/,
];

export function isDangerousCommand(command: string): boolean {
  return DANGEROUS_PATTERNS.some((pattern) => pattern.test(command));
}
