/**
 * cli-driver.ts — CLI 黑盒 Driver
 *
 * 职责：通过 child_process.spawn 启动外部命令，向 stdin 发送 query，
 * 从 stdout/stderr 收集输出，并包装为 CodingAgentDriver 接口。
 *
 * 设计决策：
 * - 使用 spawn 而非 exec，因为 spawn 支持流式输出和更大的数据量
 * - send() 写入 stdin 后等待固定时间（100ms）收集输出，适用于简单 echo 类命令
 * - 复杂交互式 CLI（如 REPL）需要更完善的 readyPattern / prompt 匹配，属于后续增强
 * - CLI driver 的 send() 返回的事件和 readEvents() 返回的事件可能有重叠；
 *   runner 的 seenEventIds 去重机制会自动处理
 * - 每个事件自带唯一 id，不依赖 runner"只调用一次 readEvents()"的隐含假设
 * - spawn 时设置 cwd 为 eval 临时 workspace，确保黑盒命令也在隔离目录内运行
 */

import { spawn, type ChildProcess } from "node:child_process";
import type {
  CodingAgentDriver,
  AgentCaseContext,
  AgentInput,
  AgentTurnResult,
} from "../../core/driver.js";
import type {
  AgentRuntimeEvent,
  CliDriverPlan,
} from "../../core/case-schema.js";

/**
 * makeEventId — 生成稳定的事件唯一标识
 *
 * 使用自增序号 + 时间戳，确保同一 driver 实例内的事件不会重复。
 */
function makeEventId(): string {
  return `cli-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * createCliDriver — 创建 CLI 黑盒 driver
 *
 * @param plan - CLI driver 计划配置
 * @returns CodingAgentDriver 实例
 */
export function createCliDriver(plan: CliDriverPlan): CodingAgentDriver {
  let child: ChildProcess | undefined;
  let stdoutChunks: string[] = [];
  let stderrChunks: string[] = [];
  let exitCode: number | undefined;
  let killed = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  // 记录已消费的输出长度，用于 send()/readEvents() 只返回增量内容
  let consumedStdoutLen = 0;
  let consumedStderrLen = 0;

  return {
    async startCase(context: AgentCaseContext): Promise<void> {
      // spawn 子进程，在 eval 临时 workspace 内运行，传入可选的环境变量
      child = spawn(plan.command, plan.args ?? [], {
        cwd: context.workspaceRoot,
        env: { ...process.env, ...plan.env },
      });

      // 收集 stdout 输出
      child.stdout?.on("data", (chunk: Buffer) => {
        stdoutChunks.push(String(chunk));
      });

      // 收集 stderr 输出
      child.stderr?.on("data", (chunk: Buffer) => {
        stderrChunks.push(String(chunk));
      });

      // 记录进程退出码
      // 如果被 signal 终止（如 timeout kill），code 为 null，此时设为 1 表示异常退出
      child.on("exit", (code, signal) => {
        if (signal) {
          exitCode = 1;
          stderrChunks.push(
            `[cli-driver] Process terminated by signal: ${signal}`,
          );
        } else {
          exitCode = code ?? 0;
        }
      });

      // 记录错误事件（如命令不存在）
      child.on("error", (err) => {
        stderrChunks.push(`[cli-driver error] ${err.message}`);
      });

      // timeoutMs 是 per-case 语义：从 startCase 开始计时，超时后 kill 进程
      const timeoutMs = plan.timeoutMs;
      if (timeoutMs !== undefined && timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (child && !killed) {
            stderrChunks.push("[cli-driver] Timeout reached, killing process");
            child.kill();
            killed = true;
          }
        }, timeoutMs);
      }
    },

    async send(input: AgentInput): Promise<AgentTurnResult> {
      if (!child || !child.stdin) {
        throw new Error("CLI driver not started. Call startCase() first.");
      }

      // 向子进程 stdin 写入 query
      child.stdin.write(input.query + "\n");

      // 等待一小段时间让子进程处理并输出
      // 对于 cat 这类即时 echo 命令，100ms 足够
      const waitMs = 100;
      await new Promise((resolve) => setTimeout(resolve, waitMs));

      // 只返回本次 send() 新增的 stdout 内容（增量输出）
      const fullStdout = stdoutChunks.join("");
      const stepOutput = fullStdout.slice(consumedStdoutLen);
      consumedStdoutLen = fullStdout.length;

      // 收集本次 send() 新增的 stderr 内容
      const fullStderr = stderrChunks.join("");
      const stepStderr = fullStderr.slice(consumedStderrLen);
      consumedStderrLen = fullStderr.length;

      // 为本步输出构造 runtime events，让 runner 能记录到 trace 中
      const stepEvents: AgentRuntimeEvent[] = [];
      if (stepOutput.length > 0) {
        stepEvents.push({
          id: makeEventId(),
          timestamp: new Date().toISOString(),
          kind: "agent_output",
          source: "driver",
          text: stepOutput,
        } as AgentRuntimeEvent);
      }
      if (stepStderr.length > 0) {
        stepEvents.push({
          id: makeEventId(),
          timestamp: new Date().toISOString(),
          kind: "log",
          source: "driver",
          level: "error",
          message: stepStderr,
        } as AgentRuntimeEvent);
      }

      const result: AgentTurnResult = {
        stepId: input.stepId,
        finalOutput: stepOutput,
        events: stepEvents,
      };
      if (exitCode !== undefined) {
        result.exitCode = exitCode;
      }
      return result;
    },

    async readEvents(): Promise<AgentRuntimeEvent[]> {
      const events: AgentRuntimeEvent[] = [];

      // 只返回未消费过的 stdout 内容
      const fullStdout = stdoutChunks.join("");
      const newStdout = fullStdout.slice(consumedStdoutLen);
      if (newStdout.length > 0) {
        events.push({
          id: makeEventId(),
          timestamp: new Date().toISOString(),
          kind: "agent_output",
          source: "driver",
          text: newStdout,
        } as AgentRuntimeEvent);
        consumedStdoutLen = fullStdout.length;
      }

      // 只返回未消费过的 stderr 内容
      const fullStderr = stderrChunks.join("");
      const newStderr = fullStderr.slice(consumedStderrLen);
      if (newStderr.length > 0) {
        events.push({
          id: makeEventId(),
          timestamp: new Date().toISOString(),
          kind: "log",
          source: "driver",
          level: "error",
          message: newStderr,
        } as AgentRuntimeEvent);
        consumedStderrLen = fullStderr.length;
      }

      return events;
    },

    async close(): Promise<void> {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (child && !killed) {
        child.kill();
        killed = true;
      }
      // 清空收集的缓冲区
      stdoutChunks = [];
      stderrChunks = [];
      consumedStdoutLen = 0;
      consumedStderrLen = 0;
    },
  };
}
