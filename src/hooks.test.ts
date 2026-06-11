import { describe, it, expect, vi } from "vitest";
import { createHookRunner, createNoopHookRunner } from "./hooks.js";
import type { HookEvent, HookHandler } from "./hooks.js";
import type { Logger } from "./logger.js";

// ============================================================
// Mock 工具
// ============================================================

/**
 * createMockLogger — 创建 mock 日志器
 *
 * 使用 vi.fn() 创建 spy，便于验证日志调用
 */
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

/**
 * makeEvent — 创建测试用的 HookEvent
 *
 * 默认创建 PreToolUse 事件，可传入部分 payload 覆盖
 */
function makeEvent(
  overrides?: Partial<HookEvent["payload"]> & { name?: HookEvent["name"] },
): HookEvent {
  return {
    name: overrides?.name ?? "PreToolUse",
    payload: {
      toolCallId: "call_001",
      toolName: "run_bash",
      args: { command: "ls" },
      round: 1,
      ...overrides,
    },
  } as HookEvent;
}

// ============================================================
// HookRunner 单元测试
// ============================================================

describe("createHookRunner", () => {
  it("没有 handler 时返回 exitCode 0", async () => {
    const logger = createMockLogger();
    const runner = createHookRunner({}, logger);

    const result = await runner.run(makeEvent());

    expect(result.exitCode).toBe(0);
    expect(result.message).toBeUndefined();
  });

  it("单个 handler 返回 0 时，结果为 exitCode 0", async () => {
    const logger = createMockLogger();
    const handler: HookHandler = () => ({ exitCode: 0 });
    const runner = createHookRunner({ PreToolUse: [handler] }, logger);

    const result = await runner.run(makeEvent());

    expect(result.exitCode).toBe(0);
  });

  it("单个 handler 返回 1 时短路，结果为 exitCode 1", async () => {
    const logger = createMockLogger();
    const handler: HookHandler = () => ({
      exitCode: 1,
      message: "blocked",
    });
    const runner = createHookRunner({ PreToolUse: [handler] }, logger);

    const result = await runner.run(makeEvent());

    expect(result.exitCode).toBe(1);
    expect(result.message).toBe("blocked");
  });

  it("多个 handler 返回 2 时，消息用空行拼接", async () => {
    const logger = createMockLogger();
    const handler1: HookHandler = () => ({
      exitCode: 2,
      message: "提示 A",
    });
    const handler2: HookHandler = () => ({
      exitCode: 2,
      message: "提示 B",
    });
    const runner = createHookRunner(
      { PreToolUse: [handler1, handler2] },
      logger,
    );

    const result = await runner.run(makeEvent());

    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("提示 A\n\n提示 B");
  });

  it("handler 返回 1 后，后续 handler 不执行", async () => {
    const logger = createMockLogger();
    const handler1 = vi.fn<HookHandler>().mockReturnValue({ exitCode: 0 });
    const handler2 = vi
      .fn<HookHandler>()
      .mockReturnValue({ exitCode: 1, message: "stop" });
    const handler3 = vi.fn<HookHandler>().mockReturnValue({ exitCode: 0 });

    const runner = createHookRunner(
      { PreToolUse: [handler1, handler2, handler3] },
      logger,
    );

    const result = await runner.run(makeEvent());

    expect(result.exitCode).toBe(1);
    // handler1 和 handler2 被调用，handler3 因为短路未被调用
    expect(handler1).toHaveBeenCalledTimes(1);
    expect(handler2).toHaveBeenCalledTimes(1);
    expect(handler3).not.toHaveBeenCalled();
  });

  it("handler 抛异常时记录 warn，继续执行后续 handler", async () => {
    const logger = createMockLogger();
    const badHandler: HookHandler = () => {
      throw new Error("handler crash");
    };
    const goodHandler: HookHandler = () => ({
      exitCode: 2,
      message: "正常消息",
    });

    const runner = createHookRunner(
      { PreToolUse: [badHandler, goodHandler] },
      logger,
    );

    const result = await runner.run(makeEvent());

    // 异常 handler 的结果被忽略，正常 handler 的结果被保留
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("正常消息");
    // warn 日志被调用
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      "Hook %s failed: %s",
      "PreToolUse",
      "handler crash",
    );
  });

  it("handler 返回 2 但没有 message 时，不累积空消息", async () => {
    const logger = createMockLogger();
    const handler: HookHandler = () => ({ exitCode: 2 });
    const runner = createHookRunner({ PreToolUse: [handler] }, logger);

    const result = await runner.run(makeEvent());

    // 没有实际 message 时，等价于 continue
    expect(result.exitCode).toBe(0);
  });

  it("支持异步 handler", async () => {
    const logger = createMockLogger();
    const handler: HookHandler = async () => ({
      exitCode: 2,
      message: "异步结果",
    });
    const runner = createHookRunner({ PreToolUse: [handler] }, logger);

    const result = await runner.run(makeEvent());

    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("异步结果");
  });

  it("不同事件名使用各自的 handler 列表", async () => {
    const logger = createMockLogger();
    const preHandler: HookHandler = () => ({ exitCode: 1, message: "pre" });
    const runner = createHookRunner({ PreToolUse: [preHandler] }, logger);

    // SessionStart 事件没有注册 handler，应返回 0
    const sessionEvent: HookEvent = {
      name: "SessionStart",
      payload: { query: "hello" },
    };
    const result = await runner.run(sessionEvent);

    expect(result.exitCode).toBe(0);
  });
});

describe("createNoopHookRunner", () => {
  it("对任意事件都返回 exitCode 0", async () => {
    const runner = createNoopHookRunner();

    const result = await runner.run(makeEvent());

    expect(result.exitCode).toBe(0);
    expect(result.message).toBeUndefined();
  });

  it("对 SessionStart 事件也返回 exitCode 0", async () => {
    const runner = createNoopHookRunner();

    const result = await runner.run({
      name: "SessionStart",
      payload: { query: "test" },
    });

    expect(result.exitCode).toBe(0);
  });
});
