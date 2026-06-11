/**
 * normalize.test.ts — 消息标准化模块测试
 *
 * 测试三个标准化功能：
 * 1. 元数据字段过滤（_ 开头的键）
 * 2. 缺失 tool_result 的补全
 * 3. 连续同角色消息的合并
 */

import { describe, it, expect } from "vitest";
import { normalizeMessages } from "./normalize.js";
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * 元数据过滤测试
 */
describe("normalizeMessages - metadata filtering", () => {
  it("keeps string content unchanged", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hello" },
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ role: "user", content: "hello" });
  });

  it("removes underscore-prefixed keys from array content", () => {
    // 使用 unknown 中转来构造带 _timestamp 的测试数据
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello", _timestamp: 123 }],
      },
    ] as unknown as ChatCompletionMessageParam[];

    const result = normalizeMessages(messages);
    // content 数组中的 _timestamp 字段应该被移除
    const content = result[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "hello" });
    expect(content[0]).not.toHaveProperty("_timestamp");
  });

  it("handles null content without errors", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "assistant", content: null },
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0]!.content).toBeNull();
  });
});

/**
 * tool_result 补全测试
 */
describe("normalizeMessages - tool result completion", () => {
  it("inserts missing tool result immediately after its assistant tool call", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_123",
            type: "function",
            function: { name: "run_bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      // 缺少 role: "tool", tool_call_id: "call_123" 的消息
      { role: "user", content: "next question" },
    ];

    const result = normalizeMessages(messages);
    expect(result.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    expect((result[2] as unknown as Record<string, unknown>).tool_call_id).toBe(
      "call_123",
    );
    expect((result[2] as unknown as Record<string, unknown>).content).toBe(
      "(cancelled)",
    );
  });

  it("does not add tool result when it already exists", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "list files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_456",
            type: "function",
            function: { name: "run_bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_456",
        content: "file1.txt\nfile2.txt",
      } as unknown as ChatCompletionMessageParam,
    ];

    const result = normalizeMessages(messages);
    // 不应该追加额外的 tool 消息
    const toolMsgs = result.filter((m) => m.role === "tool");
    expect(toolMsgs).toHaveLength(1);
  });

  it("keeps multiple tool results adjacent and ordered by tool_calls", () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "run_bash", arguments: '{"command":"pwd"}' },
          },
          {
            id: "call_2",
            type: "function",
            function: { name: "run_bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_2",
        content: "file1.txt",
      } as unknown as ChatCompletionMessageParam,
    ];

    const result = normalizeMessages(messages);
    expect(result.map((m) => m.role)).toEqual(["assistant", "tool", "tool"]);
    expect((result[1] as unknown as Record<string, unknown>).tool_call_id).toBe(
      "call_1",
    );
    expect((result[1] as unknown as Record<string, unknown>).content).toBe(
      "(cancelled)",
    );
    expect((result[2] as unknown as Record<string, unknown>).tool_call_id).toBe(
      "call_2",
    );
  });

  it("moves existing out-of-place tool result back into the assistant tool block", () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_late",
            type: "function",
            function: { name: "run_bash", arguments: '{"command":"pwd"}' },
          },
        ],
      },
      { role: "user", content: "next question" },
      {
        role: "tool",
        tool_call_id: "call_late",
        content: "/tmp/project",
      } as unknown as ChatCompletionMessageParam,
    ];

    const result = normalizeMessages(messages);
    expect(result.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect((result[1] as unknown as Record<string, unknown>).tool_call_id).toBe(
      "call_late",
    );
    expect((result[1] as unknown as Record<string, unknown>).content).toBe(
      "/tmp/project",
    );
  });

  it("drops orphan tool result without an assistant tool call", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "hello" },
      {
        role: "tool",
        tool_call_id: "orphan",
        content: "orphaned output",
      } as unknown as ChatCompletionMessageParam,
      { role: "assistant", content: "hi" },
    ];

    const result = normalizeMessages(messages);
    expect(result.some((m) => m.role === "tool")).toBe(false);
    expect(result.map((m) => m.role)).toEqual(["user", "assistant"]);
  });
});

/**
 * 连续同角色消息合并测试
 */
describe("normalizeMessages - consecutive role merging", () => {
  it("merges consecutive user messages", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "first message" },
      { role: "user", content: "second message" },
    ];

    const result = normalizeMessages(messages);
    expect(result).toHaveLength(1);
    // 合并后的 content 应该是数组格式，包含两条消息
    const content = result[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: "text", text: "first message" });
    expect(content[1]).toEqual({ type: "text", text: "second message" });
  });

  it("merges consecutive assistant messages", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "assistant", content: "part 1" },
      { role: "assistant", content: "part 2" },
    ];

    const result = normalizeMessages(messages);
    expect(result).toHaveLength(1);
    const content = result[0]!.content as unknown as Array<Record<string, unknown>>;
    expect(content).toHaveLength(2);
  });

  it("does not merge assistant messages when either side has tool calls", () => {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_789",
            type: "function",
            function: { name: "run_bash", arguments: '{"command":"pwd"}' },
          },
        ],
      },
      { role: "assistant", content: "plain text" },
    ];

    const result = normalizeMessages(messages);
    expect(result.map((m) => m.role)).toEqual([
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("does not merge different roles", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ];

    const result = normalizeMessages(messages);
    expect(result).toHaveLength(2);
  });

  it("handles empty message list", () => {
    const result = normalizeMessages([]);
    expect(result).toHaveLength(0);
  });

  it("handles single message", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "only one" },
    ];
    const result = normalizeMessages(messages);
    expect(result).toHaveLength(1);
  });
});

describe("normalizeMessages - purity", () => {
  it("does not mutate input messages", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "hello", _timestamp: 123 }],
        _round: 7,
      },
      { role: "user", content: "second" },
    ] as unknown as ChatCompletionMessageParam[];
    const before = JSON.parse(JSON.stringify(messages)) as unknown;

    normalizeMessages(messages);

    expect(messages).toEqual(before);
  });

  it("does not share merged content array with input messages", () => {
    const messages: ChatCompletionMessageParam[] = [
      { role: "user", content: "first message" },
      { role: "user", content: "second message" },
    ];

    const result = normalizeMessages(messages);
    const content = result[0]!.content as unknown as Array<
      Record<string, unknown>
    >;
    content[0]!.text = "changed";

    expect(messages[0]!.content).toBe("first message");
  });

  it("preserves top-level _round metadata for message-block grouping", () => {
    const messages = [
      { role: "user", content: "hello", _round: 3 },
    ] as unknown as ChatCompletionMessageParam[];

    const result = normalizeMessages(messages);

    expect(result[0]).toHaveProperty("_round", 3);
  });
});

describe("normalizeMessages - provider field preservation", () => {
  it("preserves reasoning_content on assistant messages", () => {
    const messages = [
      {
        role: "assistant",
        content: "The answer is 42",
        reasoning_content: "Let me think step by step...",
      },
    ] as unknown as ChatCompletionMessageParam[];

    const result = normalizeMessages(messages);

    expect(result).toHaveLength(1);
    expect(result[0]).toHaveProperty("reasoning_content", "Let me think step by step...");
  });

  it("preserves reasoning_content on assistant messages with tool_calls", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        reasoning_content: "I need to run a command",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "run_bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
    ] as unknown as ChatCompletionMessageParam[];

    const result = normalizeMessages(messages);

    // ensureToolResults 会补全缺失的 tool 消息
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("reasoning_content", "I need to run a command");
    const toolCalls = (result[0] as unknown as { tool_calls: unknown[] }).tool_calls;
    expect(toolCalls).toHaveLength(1);
  });

  it("preserves provider fields through ensureToolResults", () => {
    const messages = [
      {
        role: "assistant",
        content: null,
        reasoning_content: "Thinking...",
        tool_calls: [
          {
            id: "call_1",
            type: "function",
            function: { name: "run_bash", arguments: '{"command":"ls"}' },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "call_1",
        content: "file.txt",
      },
    ] as unknown as ChatCompletionMessageParam[];

    const result = normalizeMessages(messages);

    // ensureToolResults 跳过原始 tool 位置，在 assistant 后重新插入，仍是 2 条
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveProperty("reasoning_content", "Thinking...");
  });
});
