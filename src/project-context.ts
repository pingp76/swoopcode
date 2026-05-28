/**
 * project-context.ts — 项目上下文模块
 *
 * 职责：在组装根中一次性确定项目根目录和 Agent 自身的全局运行目录。
 *
 * 为什么需要 ProjectContext？
 * - 之前多个模块直接使用 process.cwd()，路径边界是隐式的。
 * - 权限边界需要知道“当前项目是谁”，但 memory、skills、日志、临时输出
 *   属于 Agent 自身，不应该默认写进被操作项目。
 * - 将这些路径集中到一个对象中，后续支持 CLI 参数或环境变量时只需要改这里。
 * - 第一版不创建 .agent-data，不把 session/transcript 持久化写入项目目录。
 */

import { homedir } from "node:os";
import { resolve } from "node:path";

/**
 * ProjectContext — 当前运行绑定的项目路径集合
 *
 * projectRoot 是 Agent 正在操作的代码项目。
 * agentHome 是 Agent 自己的全局运行根目录，承载 skills、memory、日志和大输出。
 */
export interface ProjectContext {
  /** 被 Agent 操作的项目根目录 */
  projectRoot: string;
  /** Agent 全局运行根目录，不随 projectRoot 切换 */
  agentHome: string;
  /** 项目级 AGENTS.md，存在时进入稳定 system prompt 头部 */
  agentsFile: string;
  /** 当前进程扫描的全局 skills 目录 */
  skillsDir: string;
  /** 当前进程扫描和写入的全局 memory 目录 */
  memoryDir: string;
  /** LLM 通信日志目录，放在 Agent 全局运行根目录下 */
  logsDir: string;
  /** 大工具输出目录，放在 Agent 全局运行根目录下 */
  taskOutputsDir: string;
  /** 持久化 Task Group 目录，放在 Agent 全局运行根目录下 */
  tasksDir: string;
  /** Schedule 定时规则目录，放在 Agent 全局运行根目录下 */
  schedulesDir: string;
}

/**
 * createProjectContext — 创建项目上下文
 *
 * 第一版默认 projectRoot = process.cwd()，保持现有启动行为不变。
 * AGENT_PROJECT_ROOT 是启动时切换项目根目录的扩展点，不支持运行中切换。
 *
 * Agent 自身数据默认放到 ~/.learn-claude-code-ts，也可以通过 AGENT_HOME 覆盖。
 * 这样切换项目时不会在目标项目里散落 skills、memory、logs 或 .task_outputs。
 */
export function createProjectContext(options?: {
  projectRoot?: string;
  agentHome?: string;
  memoryDirName?: string;
}): ProjectContext {
  const projectRoot = resolve(
    options?.projectRoot ?? process.env["AGENT_PROJECT_ROOT"] ?? process.cwd(),
  );
  const agentHome = resolve(
    options?.agentHome ??
      process.env["AGENT_HOME"] ??
      resolve(homedir(), ".learn-claude-code-ts"),
  );
  const memoryDirName =
    options?.memoryDirName ?? process.env["MEMORY_DIR"] ?? "memory";

  return {
    projectRoot,
    agentHome,
    agentsFile: resolve(projectRoot, "AGENTS.md"),
    skillsDir: resolve(agentHome, "skills"),
    memoryDir: resolve(agentHome, memoryDirName),
    logsDir: resolve(agentHome, "logs"),
    taskOutputsDir: resolve(agentHome, ".task_outputs"),
    tasksDir: resolve(agentHome, "tasks"),
    schedulesDir: resolve(agentHome, "schedules"),
  };
}
