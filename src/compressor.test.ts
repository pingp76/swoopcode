/**
 * compressor.test.ts — 上下文压缩器测试
 *
 * 测试覆盖：
 * - P0 衰减压缩：旧工具结果截断、近期不修改、边界值
 * - P1 即时压缩：小输出通过、大输出存文件、写入失败降级
 * - P2 全量压缩：摘要生成、保留 recent 块、连续压缩、降级
 * - 状态管理：getState 正确反映内部状态
 * - cleanup：清理临时文件
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createContextCompressor } from "./compressor.js";
import type { MessageBlock } from "./message-block.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOutputStore } from "./output-store.js";

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

/** 为需要落盘的压缩测试创建独立临时目录，避免写入项目目录或真实 agentHome。 */
function makeTempOutputDir(): string {
  return mkdtempSync(join(tmpdir(), "compressor-test-"));
}

/** 创建一个 text 类型的消息块 */
function makeTextBlock(
  userContent: string,
  assistantContent: string,
  round?: number,
): MessageBlock {
  const block: MessageBlock = {
    type: "text",
    user: { role: "user", content: userContent },
    assistant: { role: "assistant", content: assistantContent },
  };
  if (round !== undefined) block.round = round;
  return block;
}

/** 创建一个 tool_use 类型的消息块 */
function makeToolUseBlock(
  toolName: string,
  args: string,
  resultContent: string,
  round?: number,
  toolCallId?: string,
): MessageBlock {
  const tcId = toolCallId ?? `tc_${Math.random().toString(36).slice(2, 8)}`;
  const block: MessageBlock = {
    type: "tool_use",
    assistant: {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: tcId,
          type: "function" as const,
          function: { name: toolName, arguments: args },
        },
      ],
    } as ChatCompletionMessageParam,
    toolResults: [
      {
        role: "tool",
        tool_call_id: tcId,
        content: resultContent,
      } as ChatCompletionMessageParam,
    ],
  };
  if (round !== undefined) block.round = round;
  return block;
}

/** 创建一个 summary 类型的消息块 */
function makeSummaryBlock(summaryText: string, round?: number): MessageBlock {
  const block: MessageBlock = {
    type: "summary",
    user: {
      role: "user",
      content: `[Context Summary]\n${summaryText}`,
    } as ChatCompletionMessageParam,
  };
  if (round !== undefined) block.round = round;
  return block;
}

/** 统计子串出现次数，用于断言 P2 不会把同一段摘要重复拼接。 */
function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// P0 衰减压缩
// ---------------------------------------------------------------------------

describe("decayOldBlocks (P0)", () => {
  const compressor = createContextCompressor({
    decayThreshold: 3,
    decayPreviewTokens: 100,
  });

  it("does not modify recent tool_use blocks (within threshold)", () => {
    const block = makeToolUseBlock(
      "run_bash",
      '{"command":"ls"}',
      "file1.txt\nfile2.txt",
      5,
    );
    const result = compressor.decayOldBlocks([block], 7); // age = 7 - 5 = 2 < 3
    expect(result[0]).toEqual(block);
  });

  it("does not modify blocks at exact threshold boundary", () => {
    const block = makeToolUseBlock(
      "run_bash",
      '{"command":"ls"}',
      "file1.txt",
      4,
    );
    const result = compressor.decayOldBlocks([block], 7); // age = 7 - 4 = 3 <= 3
    expect(result[0]).toEqual(block);
  });

  it("truncates old tool_use block tool result content", () => {
    // 创建一个很长的输出（超过 100 token）
    const longOutput = "x".repeat(1000);
    const block = makeToolUseBlock(
      "run_bash",
      '{"command":"ls"}',
      longOutput,
      1,
    );
    const result = compressor.decayOldBlocks([block], 10); // age = 10 - 1 = 9 > 3

    expect(result[0]!.type).toBe("tool_use");
    if (result[0]!.type === "tool_use") {
      const toolResult = result[0]!.toolResults[0]!;
      // 内容应该被截断（远短于原始 1000 字符）
      expect((toolResult as { content: string }).content.length).toBeLessThan(
        longOutput.length,
      );
      // tool_call_id 必须保留
      expect(
        (toolResult as { tool_call_id: string }).tool_call_id,
      ).toBeDefined();
    }
  });

  it("uses loopIndex as the primary age for decay", () => {
    const longOutput = "x".repeat(1000);
    const block = makeToolUseBlock(
      "run_bash",
      '{"command":"ls"}',
      longOutput,
      1,
    );
    block.loopRound = 1;
    block.loopIndex = 2;

    const result = compressor.decayOldBlocks([block], 7);

    expect(result[0]!.type).toBe("tool_use");
    if (result[0]!.type === "tool_use") {
      const content = (result[0]!.toolResults[0]! as { content: string })
        .content;
      expect(content.length).toBeLessThan(longOutput.length);
    }
  });

  it("keeps legacy round fallback for blocks without loopIndex", () => {
    const longOutput = "x".repeat(1000);
    const block = makeToolUseBlock(
      "run_bash",
      '{"command":"ls"}',
      longOutput,
      1,
    );

    const result = compressor.decayOldBlocks([block], 10);

    expect(result[0]!.type).toBe("tool_use");
    if (result[0]!.type === "tool_use") {
      const content = (result[0]!.toolResults[0]! as { content: string })
        .content;
      expect(content.length).toBeLessThan(longOutput.length);
    }
  });

  it("preserves tool_call_id in truncated results", () => {
    const block = makeToolUseBlock(
      "run_bash",
      '{"command":"pwd"}',
      "output",
      1,
      "my_call_id_123",
    );
    const result = compressor.decayOldBlocks([block], 10);
    if (result[0]!.type === "tool_use") {
      expect(
        (result[0]!.toolResults[0]! as { tool_call_id: string }).tool_call_id,
      ).toBe("my_call_id_123");
    }
  });

  it("does not modify text blocks regardless of age", () => {
    const block = makeTextBlock("hello", "hi", 1);
    const result = compressor.decayOldBlocks([block], 100);
    expect(result[0]).toEqual(block);
  });

  it("does not modify summary blocks regardless of age", () => {
    const block = makeSummaryBlock("Previous work: fixed bug", 1);
    const result = compressor.decayOldBlocks([block], 100);
    expect(result[0]).toEqual(block);
  });

  it("does not modify blocks without round info", () => {
    const block = makeToolUseBlock("run_bash", '{"command":"ls"}', "output");
    // round is undefined
    const result = compressor.decayOldBlocks([block], 100);
    expect(result[0]).toEqual(block);
  });

  it("appends persisted file path after truncating tool results", () => {
    const outputDir = makeTempOutputDir();
    // 使用同一个 compressor 实例：先 P1 存文件，再 P0 衰减
    const comp = createContextCompressor({
      thresholdToolOutput: 100, // 降低阈值，确保 1000 字符的输出会触发存文件
      decayThreshold: 3,
      decayPreviewTokens: 100,
      outputDir,
    });
    const tcId = "tc_persist_test";

    // P1: 即时压缩，存文件并注册到 persistedToolOutputs
    const longOutput = "a".repeat(1000);
    comp.compressToolResult("run_bash", tcId, longOutput);

    // 构造包含该 toolCallId 的 tool_use 块
    const block = makeToolUseBlock(
      "run_bash",
      '{"command":"ls"}',
      longOutput,
      1,
      tcId,
    );
    const result = comp.decayOldBlocks([block], 10); // age = 9 > 3

    if (result[0]!.type === "tool_use") {
      const content = (result[0]!.toolResults[0]! as { content: string })
        .content;
      // 截断后应该追加了文件路径引用
      expect(content).toContain(
        "[Full output: .task_outputs/tc_persist_test.txt]",
      );
    }

    // 清理
    comp.cleanup();
  });

  it("does not append file path for non-persisted tool results", () => {
    const comp = createContextCompressor({
      decayThreshold: 3,
      decayPreviewTokens: 100,
    });
    // 这个 toolCallId 从未被 compressToolResult 存过文件
    const block = makeToolUseBlock(
      "run_bash",
      '{"command":"ls"}',
      "short output",
      1,
      "tc_no_persist",
    );
    const result = comp.decayOldBlocks([block], 10);

    if (result[0]!.type === "tool_use") {
      const content = (result[0]!.toolResults[0]! as { content: string })
        .content;
      // 不应包含文件路径引用
      expect(content).not.toContain("[Full output:");
    }
  });

  it("handles multiple tool results in one block", () => {
    const tcId1 = "tc1";
    const tcId2 = "tc2";
    const block: MessageBlock = {
      type: "tool_use",
      assistant: {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: tcId1,
            type: "function" as const,
            function: { name: "run_bash", arguments: '{"command":"ls"}' },
          },
          {
            id: tcId2,
            type: "function" as const,
            function: { name: "run_read", arguments: '{"path":"f.txt"}' },
          },
        ],
      } as ChatCompletionMessageParam,
      toolResults: [
        {
          role: "tool",
          tool_call_id: tcId1,
          content: "file1.txt",
        } as ChatCompletionMessageParam,
        {
          role: "tool",
          tool_call_id: tcId2,
          content: "content",
        } as ChatCompletionMessageParam,
      ],
      round: 1,
    };
    const result = compressor.decayOldBlocks([block], 10);
    if (result[0]!.type === "tool_use") {
      // 两个 tool result 都应该被截断
      expect(result[0]!.toolResults).toHaveLength(2);
      expect(
        (result[0]!.toolResults[0]! as { tool_call_id: string }).tool_call_id,
      ).toBe(tcId1);
      expect(
        (result[0]!.toolResults[1]! as { tool_call_id: string }).tool_call_id,
      ).toBe(tcId2);
    }
  });
});

// ---------------------------------------------------------------------------
// P1 即时压缩
// ---------------------------------------------------------------------------

describe("compressToolResult (P1)", () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = makeTempOutputDir();
  });

  afterEach(() => {
    // 清理测试产生的临时文件
    if (existsSync(outputDir)) {
      rmSync(outputDir, { recursive: true, force: true });
    }
  });

  it("passes through small output unchanged", () => {
    const compressor = createContextCompressor({
      thresholdToolOutput: 2000,
      outputDir,
    });
    const result = compressor.compressToolResult(
      "run_bash",
      "tc1",
      "small output",
    );
    expect(result.content).toBe("small output");
    expect(result.persistedPath).toBeUndefined();
  });

  it("passes through output from non-compressible tools", () => {
    const compressor = createContextCompressor({
      thresholdToolOutput: 50,
      outputDir,
    });
    const largeOutput = "x".repeat(500);
    // run_read 不在 compressibleTools 列表中，即使输出很大也不压缩
    const result = compressor.compressToolResult(
      "run_read",
      "tc_nocomp",
      largeOutput,
    );
    expect(result.content).toBe(largeOutput);
    expect(result.persistedPath).toBeUndefined();
  });

  it("persists large output and returns preview with toolCallId", () => {
    const compressor = createContextCompressor({
      thresholdToolOutput: 100,
      outputDir,
    });
    // 生成超过 100 token 的输出（100 / 0.25 = 400 字符）
    const largeOutput = "a".repeat(1000);
    const result = compressor.compressToolResult(
      "run_bash",
      "tc_test_large",
      largeOutput,
    );

    // 内容应该包含 persisted-output 标记，且嵌入 toolCallId
    expect(result.content).toContain(
      `<persisted-output tool-call-id="tc_test_large">`,
    );
    expect(result.content).toContain(".task_outputs/tc_test_large.txt");
    expect(result.persistedPath).toBeDefined();

    // 文件应该存在
    expect(existsSync(result.persistedPath!)).toBe(true);
  });

  it("persists large output through OutputStore when provided", () => {
    const outputStore = createOutputStore({
      outputDir,
      clock: () => new Date("2026-05-28T15:30:00.000"),
      idGenerator: () => "abc123",
    });
    const compressor = createContextCompressor({
      thresholdToolOutput: 100,
      outputDir,
      outputStore,
    });
    const largeOutput = "a".repeat(1000);

    const result = compressor.compressToolResult(
      "run_bash",
      "tc_output_store",
      largeOutput,
    );

    expect(result.outputId).toBe("out_20260528_153000_abc123");
    expect(result.content).toContain('output-id="out_20260528_153000_abc123"');
    expect(result.content).toContain("run_output_read");
    expect(outputStore.read({ outputId: result.outputId! }).content).toBe(
      largeOutput,
    );
  });

  it("preview is shorter than original output", () => {
    const compressor = createContextCompressor({
      thresholdToolOutput: 100,
      outputDir,
    });
    const largeOutput = "hello world ".repeat(200);
    const result = compressor.compressToolResult(
      "run_bash",
      "tc_preview_test",
      largeOutput,
    );

    expect(result.content.length).toBeLessThan(largeOutput.length);
  });

  it("decayOldBlocks appends output id when OutputStore persisted the result", () => {
    const outputStore = createOutputStore({
      outputDir,
      clock: () => new Date("2026-05-28T15:30:00.000"),
      idGenerator: () => "def456",
    });
    const comp = createContextCompressor({
      thresholdToolOutput: 100,
      decayThreshold: 3,
      decayPreviewTokens: 100,
      outputDir,
      outputStore,
    });
    const tcId = "tc_output_id_decay";
    const longOutput = "a".repeat(1000);
    comp.compressToolResult("run_bash", tcId, longOutput);

    const block = makeToolUseBlock(
      "run_bash",
      '{"command":"ls"}',
      longOutput,
      1,
      tcId,
    );
    const result = comp.decayOldBlocks([block], 10);

    if (result[0]!.type === "tool_use") {
      const content = (result[0]!.toolResults[0]! as { content: string })
        .content;
      expect(content).toContain("output_id out_20260528_153000_def456");
      expect(content).toContain("run_output_read");
    }
  });
});

// ---------------------------------------------------------------------------
// P2 全量压缩
// ---------------------------------------------------------------------------

describe("compactHistory (P2)", () => {
  it("does not compact when blocks are fewer than keepRecent", () => {
    const compressor = createContextCompressor({ compactKeepRecent: 4 });
    const blocks = [makeTextBlock("q1", "a1", 1), makeTextBlock("q2", "a2", 2)];
    const result = compressor.compactHistory(blocks);
    // 没有旧块需要压缩，直接返回
    expect(result.blocks).toEqual(blocks);
    expect(result.summary).toBe("");
  });

  it("produces summary block and keeps recent blocks", () => {
    const compressor = createContextCompressor({ compactKeepRecent: 2 });
    const blocks: MessageBlock[] = [
      makeTextBlock("old q1", "old a1", 1),
      makeTextBlock("old q2", "old a2", 2),
      makeTextBlock("recent q1", "recent a1", 3),
      makeTextBlock("recent q2", "recent a2", 4),
    ];
    const result = compressor.compactHistory(blocks);

    // 应该有 1 个 summary + 2 个 recent
    expect(result.blocks.length).toBe(3);
    expect(result.blocks[0]!.type).toBe("summary");
    expect(result.blocks[1]).toEqual(blocks[2]);
    expect(result.blocks[2]).toEqual(blocks[3]);

    // summary 内容应该包含压缩信息
    const summaryBlock = result.blocks[0]!;
    if (summaryBlock.type === "summary") {
      const content = (summaryBlock.user as { content: string }).content;
      expect(content).toContain("[Context Summary]");
      expect(content).toContain("old q1");
    }
  });

  it("includes tool_use blocks in summary", () => {
    const compressor = createContextCompressor({ compactKeepRecent: 1 });
    const blocks: MessageBlock[] = [
      makeToolUseBlock(
        "run_bash",
        '{"command":"ls"}',
        "file1.txt\nfile2.txt",
        1,
      ),
      makeTextBlock("recent", "reply", 2),
    ];
    const result = compressor.compactHistory(blocks);

    const summaryBlock = result.blocks[0]!;
    if (summaryBlock.type === "summary") {
      const content = (summaryBlock.user as { content: string }).content;
      expect(content).toContain("run_bash");
    }
  });

  it("merges previous summary in consecutive compactions", () => {
    const compressor = createContextCompressor({ compactKeepRecent: 1 });

    // 第一次压缩
    const blocks1: MessageBlock[] = [
      makeTextBlock("q1", "a1", 1),
      makeTextBlock("q2", "a2", 2),
    ];
    const result1 = compressor.compactHistory(blocks1);

    // 第二次压缩（包含第一次的 summary）
    const blocks2: MessageBlock[] = [
      result1.blocks[0]!, // summary from first compaction
      makeTextBlock("q3", "a3", 3),
      makeTextBlock("q4", "a4", 4),
    ];
    const result2 = compressor.compactHistory(blocks2);

    const summaryBlock = result2.blocks[0]!;
    if (summaryBlock.type === "summary") {
      const content = (summaryBlock.user as { content: string }).content;
      // 第二次 summary 应该包含第一次 summary 的内容
      expect(content).toContain("[Context Summary]");
      // 但不能同时从 lastSummary 闭包和 summary block 各拼一次。
      expect(countOccurrences(content, "User: q1")).toBe(1);
    }
  });

  it("does not duplicate cached summary when raw history is compacted again", () => {
    const compressor = createContextCompressor({ compactKeepRecent: 1 });

    // prepareMessages 路径只压缩本次请求视图，不会把 summary 写回 history。
    // 因此第二次压缩时传入的仍是完整原始 history；如果再拼 lastSummary，
    // q1/q2 会既来自闭包摘要，又来自原始 oldBlocks，造成重复膨胀。
    compressor.compactHistory([
      makeTextBlock("q1", "a1", 1),
      makeTextBlock("q2", "a2", 2),
    ]);

    const result = compressor.compactHistory([
      makeTextBlock("q1", "a1", 1),
      makeTextBlock("q2", "a2", 2),
      makeTextBlock("q3", "a3", 3),
    ]);

    const summaryBlock = result.blocks[0]!;
    if (summaryBlock.type === "summary") {
      const content = (summaryBlock.user as { content: string }).content;
      expect(countOccurrences(content, "User: q1")).toBe(1);
      expect(countOccurrences(content, "User: q2")).toBe(1);
    }
  });

  it("updates compressor state after compaction", () => {
    const compressor = createContextCompressor({ compactKeepRecent: 1 });
    const blocks: MessageBlock[] = [
      makeTextBlock("q1", "a1", 1),
      makeTextBlock("q2", "a2", 2),
    ];

    expect(compressor.getState().hasCompacted).toBe(false);
    compressor.compactHistory(blocks);
    expect(compressor.getState().hasCompacted).toBe(true);
    expect(compressor.getState().lastSummary).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 状态管理
// ---------------------------------------------------------------------------

describe("getState", () => {
  it("returns initial state", () => {
    const compressor = createContextCompressor();
    const state = compressor.getState();
    expect(state.hasCompacted).toBe(false);
    expect(state.lastSummary).toBeUndefined();
    expect(state.recentFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cleanup
// ---------------------------------------------------------------------------

describe("cleanup", () => {
  it("removes .task_outputs directory", () => {
    const outputDir = makeTempOutputDir();
    const compressor = createContextCompressor({
      thresholdToolOutput: 50,
      outputDir,
    });
    // 触发一次文件写入
    compressor.compressToolResult("run_bash", "tc_cleanup", "x".repeat(500));
    expect(existsSync(outputDir)).toBe(true);

    compressor.cleanup();
    expect(existsSync(outputDir)).toBe(false);
  });

  it("does not remove OutputStore managed directory", () => {
    const outputDir = makeTempOutputDir();
    const outputStore = createOutputStore({
      outputDir,
      clock: () => new Date("2026-05-28T15:30:00.000"),
      idGenerator: () => "abc123",
    });
    const compressor = createContextCompressor({
      thresholdToolOutput: 50,
      outputDir,
      outputStore,
    });
    compressor.compressToolResult(
      "run_bash",
      "tc_cleanup_store",
      "x".repeat(500),
    );

    compressor.cleanup();
    expect(existsSync(outputDir)).toBe(true);
    rmSync(outputDir, { recursive: true, force: true });
  });
});
