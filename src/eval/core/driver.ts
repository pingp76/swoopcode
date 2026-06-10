/**
 * driver.ts — CodingAgentDriver 中立接口
 *
 * 职责：定义 Eval Core 与被测 Agent 之间的边界契约。
 *
 * 设计原则：
 * - Eval Core 只认识这个接口，不认识 agent.ts、llm.ts、ToolRegistry 等内部类型
 * - Runner 只知道：startCase → send → readEvents → close
 * - 同一 case 内多个 step 复用同一个 driver 实例
 */

import type { AgentRuntimeEvent, EvalRunStatus } from "./case-schema.js";

/** Driver 启动 case 时传入的上下文 */
export interface AgentCaseContext {
  /** 当前 case 的唯一标识 */
  caseId: string;
  /** 临时 workspace 的根目录绝对路径 */
  workspaceRoot: string;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/** 发送给 Agent 的单步输入 */
export interface AgentInput {
  /** 步骤标识 */
  stepId: string;
  /** 用户 query */
  query: string;
}

/** Agent 单步执行结果 */
export interface AgentTurnResult {
  /** 步骤标识 */
  stepId: string;
  /** Agent 的最终文本输出 */
  finalOutput: string;
  /** 可选的退出码（CLI driver 用） */
  exitCode?: number;
  /** 本步产生的标准化运行时事件 */
  events?: AgentRuntimeEvent[];
}

/** Driver 关闭时的上下文，用于决定是否保留调试产物 */
export interface DriverCloseOptions {
  /** case 最终状态 */
  status?: EvalRunStatus;
  /** 是否保留 driver 自己创建的临时产物（如 full-tools agentHome） */
  keepArtifacts?: boolean;
}

/**
 * CodingAgentDriver — 被测 Coding Agent 的抽象接口
 *
 * 为什么需要这个抽象层？
 * - 当前项目 driver 可以把 createAgent() 包装进来
 * - 未来 CLI driver 只需要 spawn 进程 + stdin/stdout
 * - 外部 coding agent 也可以按这个接口接入
 */
export interface CodingAgentDriver {
  /** 启动一个 case，传入 workspace 等上下文 */
  startCase(context: AgentCaseContext): Promise<void>;
  /** 发送用户输入，返回 Agent 最终输出 */
  send(input: AgentInput): Promise<AgentTurnResult>;
  /** 读取全部运行时事件（可选，黑盒 driver 可能不支持） */
  readEvents?(): Promise<AgentRuntimeEvent[]>;
  /** 关闭 driver，释放资源 */
  close(options?: DriverCloseOptions): Promise<void>;
}
