/**
 * message-block.test.ts — 消息块模块测试
 *
 * 测试覆盖：
 * - estimateTokens：token 估算准确性
 * - truncateToTokens：文本截断
 * - groupToBlocks：各种消息序列的分组
 * - flattenToMessages：还原 + _round 清除
 * - round-trip：groupToBlocks → flattenToMessages 一致性
 */

import { describe, it, expect } from "vitest";
import {
  estimateTokens,
  truncateToTokens,
  groupToBlocks,
  flattenToMessages,
  estimateBlockTokens,
  estimateMessagesTokens,
} from "./message-block.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

// ---------------------------------------------------------------------------
// estimateTokens
// ---------------------------------------------------------------------------

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates ASCII text (1 char ≈ 0.25 token)", () => {
    // "hello" = 5 chars → max(0, 5 * 0.25) = 1.25
    const result = estimateTokens("hello");
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(5);
  });

  it("estimates Chinese text (1 char ≈ 1.5 token)", () => {
    // "你好世界" = 4 个中文字符 → max(4 * 1.5, 4 * 0.25) = max(6, 1) = 6
    const result = estimateTokens("你好世界");
    expect(result).toBe(6);
  });

  it("estimates mixed Chinese/English text using the larger estimate", () => {
    // "hello你好" = 2 中文字 + 5 英文字 = 7 chars
    // chinese: 2 * 1.5 = 3, total: 7 * 0.25 = 1.75
    // max(3, 1.75) = 3
    const result = estimateTokens("hello你好");
    expect(result).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// truncateToTokens
// ---------------------------------------------------------------------------

describe("truncateToTokens", () => {
  it("returns empty string for empty input", () => {
    expect(truncateToTokens("", 100)).toBe("");
  });

  it("returns full text if within limit", () => {
    // 10 chars → ~2.5 tokens, limit 100 tokens → ~400 chars allowed
    expect(truncateToTokens("short text", 100)).toBe("short text");
  });

  it("truncates text exceeding limit", () => {
    const longText = "a".repeat(1000);
    // 100 tokens / 0.25 = 400 chars
    const result = truncateToTokens(longText, 100);
    expect(result.length).toBe(400);
    expect(result).toBe("a".repeat(400));
  });
});

// ---------------------------------------------------------------------------
// groupToBlocks
// ---------------------------------------------------------------------------

describe("groupToBlocks", () => {
  it("skips system messages", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "system", content: "You are a helper" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const blocks = groupToBlocks(messages);
    // system 被跳过，user + assistant 组成 1 个 text block
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
  });

  it("groups user + assistant into text block", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "What is 1+1?" },
      { role: "assistant", content: "1+1 equals 2" },
    ];
    const blocks = groupToBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({
      type: "text",
      user: { role: "user", content: "What is 1+1?" },
      assistant: { role: "assistant", content: "1+1 equals 2" },
      round: undefined,
    });
  });

  it("groups assistant tool_calls + tool results into tool_use block", () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "run_bash", arguments: '{"command":"ls"}' } },
        ],
      } as ChatCompletionMessageParam,
      {
        role: "tool",
        tool_call_id: "tc1",
        content: "file1.txt\nfile2.txt",
      } as ChatCompletionMessageParam,
    ];
    const blocks = groupToBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("tool_use");
    if (blocks[0]!.type === "tool_use") {
      expect(blocks[0]!.toolResults).toHaveLength(1);
    }
  });

  it("groups multiple tool results in one tool_use block", () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "run_bash", arguments: '{"command":"ls"}' } },
          { id: "tc2", type: "function", function: { name: "run_read", arguments: '{"path":"f.txt"}' } },
        ],
      } as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "tc1", content: "file1.txt" } as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "tc2", content: "file content" } as ChatCompletionMessageParam,
    ];
    const blocks = groupToBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("tool_use");
    if (blocks[0]!.type === "tool_use") {
      expect(blocks[0]!.toolResults).toHaveLength(2);
    }
  });

  it("groups mixed sequences correctly", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "check files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "run_bash", arguments: '{"command":"ls"}' } },
        ],
      } as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "tc1", content: "file1.txt" } as ChatCompletionMessageParam,
      { role: "assistant", content: "Here are the files." },
    ];
    const blocks = groupToBlocks(messages);
    // block 1: tool_use (user "check files" is buffered but assistant has tool_calls)
    // block 2: text (no pending user, just assistant text)
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("tool_use");
    expect(blocks[1]!.type).toBe("text");
  });

  it("recognizes summary blocks", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "[Context Summary]\nPrevious work: fixed bug" },
    ];
    const blocks = groupToBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("summary");
  });

  it("preserves _round metadata as block.round", () => {
    const messages = [
      { role: "user", content: "hello", _round: 1 },
      { role: "assistant", content: "hi", _round: 1 },
    ] as unknown as ChatCompletionMessageParam[];
    const blocks = groupToBlocks(messages);
    expect(blocks[0]!.round).toBe(1);
  });

  it("uses min round for multi-message blocks", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        _round: 3,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "run_bash", arguments: "{}" } },
        ],
      } as ChatCompletionMessageParam,
      {
        role: "tool",
        tool_call_id: "tc1",
        content: "result",
        _round: 3,
      } as ChatCompletionMessageParam,
    ];
    const blocks = groupToBlocks(messages);
    expect(blocks[0]!.round).toBe(3);
  });

  it("handles assistant text without preceding user", () => {
    // 直接出现的 assistant（无前置 user）
    const messages: ChatCompletionMessageParam[] = [
      { role: "assistant", content: "I can help." },
    ];
    const blocks = groupToBlocks(messages);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.type).toBe("text");
    if (blocks[0]!.type === "text") {
      expect(blocks[0]!.user).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// flattenToMessages
// ---------------------------------------------------------------------------

describe("flattenToMessages", () => {
  it("round-trips text block", () => {
    const original: ChatCompletionMessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const blocks = groupToBlocks(original);
    const result = flattenToMessages(blocks);
    expect(result).toEqual(original);
  });

  it("round-trips tool_use block", () => {
    const original: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "tc1", type: "function", function: { name: "run_bash", arguments: "{}" } },
        ],
      } as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "tc1", content: "output" } as ChatCompletionMessageParam,
    ];
    const blocks = groupToBlocks(original);
    const result = flattenToMessages(blocks);
    expect(result).toEqual(original);
  });

  it("strips _round from output messages", () => {
    const annotated = [
      { role: "user", content: "hello", _round: 5 },
      { role: "assistant", content: "hi", _round: 5 },
    ] as unknown as ChatCompletionMessageParam[];
    const blocks = groupToBlocks(annotated);
    const result = flattenToMessages(blocks);
    for (const msg of result) {
      expect(msg).not.toHaveProperty("_round");
    }
  });

  it("preserves tool_call_id after round-trip", () => {
    const original: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_abc123", type: "function", function: { name: "run_bash", arguments: '{"command":"pwd"}' } },
        ],
      } as ChatCompletionMessageParam,
      { role: "tool", tool_call_id: "call_abc123", content: "/home/user" } as ChatCompletionMessageParam,
    ];
    const blocks = groupToBlocks(original);
    const result = flattenToMessages(blocks);
    // 找到 tool 消息
    const toolMsg = result.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect((toolMsg as { tool_call_id: string }).tool_call_id).toBe("call_abc123");
  });

  it("handles summary block", () => {
    const blocks = [
      {
        type: "summary" as const,
        user: { role: "user" as const, content: "[Context Summary]\nDone." },
        round: 1,
      },
    ];
    const result = flattenToMessages(blocks);
    expect(result).toHaveLength(1);
    expect(result[0]!.role).toBe("user");
    expect((result[0]! as { content: string }).content).toContain("[Context Summary]");
  });

  it("preserves trailing user message (latest query)", () => {
    // 模拟对话历史末尾有一条未配对的 user 消息（新一轮的用户 query）
    const messages: ChatCompletionMessageParam[] = [
      { role: "user" as const, content: "Previous question" },
      { role: "assistant" as const, content: "Previous answer" },
      { role: "user" as const, content: "Latest query" },
    ];
    const blocks = groupToBlocks(messages);
    // 应该生成两个 text 块，最后一个是只有 user 的块
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("text");
    expect(blocks[1]!.type).toBe("text");
    expect((blocks[1]! as { user?: { content?: string } }).user?.content).toBe("Latest query");

    // round-trip 也应该保留末尾的 user 消息
    const result = flattenToMessages(blocks);
    const lastMsg = result[result.length - 1];
    expect(lastMsg!.role).toBe("user");
    expect((lastMsg as { content: string }).content).toBe("Latest query");
  });
});

// ---------------------------------------------------------------------------
// estimateBlockTokens / estimateMessagesTokens
// ---------------------------------------------------------------------------

describe("estimateBlockTokens", () => {
  it("estimates text block tokens", () => {
    const block = {
      type: "text" as const,
      user: { role: "user" as const, content: "What is 1+1?" },
      assistant: { role: "assistant" as const, content: "1+1 equals 2" },
    };
    const tokens = estimateBlockTokens(block);
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates tool_use block tokens including arguments", () => {
    const block = {
      type: "tool_use" as const,
      assistant: {
        role: "assistant" as const,
        content: null,
        tool_calls: [
          { id: "tc1", type: "function" as const, function: { name: "run_bash", arguments: '{"command":"ls -la"}' } },
        ],
      },
      toolResults: [
        { role: "tool" as const, tool_call_id: "tc1", content: "file1.txt\nfile2.txt" },
      ],
    };
    const tokens = estimateBlockTokens(block);
    expect(tokens).toBeGreaterThan(0);
  });
});

describe("estimateMessagesTokens", () => {
  it("estimates total tokens for message list", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    const tokens = estimateMessagesTokens(messages);
    expect(tokens).toBeGreaterThan(0);
  });
});
