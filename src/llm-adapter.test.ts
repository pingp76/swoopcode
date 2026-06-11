/**
 * llm-adapter.test.ts — LLM Request Adapter 测试
 */

import { describe, expect, it } from "vitest";
import {
  createOpenAIChatCompletionsAdapter,
  createStreamingAccumulator,
} from "./llm-adapter.js";
import { resolveRuntimePolicy } from "./runtime-policy.js";
import { resolveFoundationModelProfile } from "./foundation-models.js";

function createAdapter(profileId: string, provider = "openai_compatible") {
  const profile = resolveFoundationModelProfile({
    provider: provider as import("./llm-providers.js").LLMProviderId,
    model: profileId,
    explicitProfileId: profileId,
  });
  const policy = resolveRuntimePolicy(profile, profileId);
  return createOpenAIChatCompletionsAdapter(policy);
}

describe("OpenAI Chat Completions Adapter", () => {
  describe("prepareMessages", () => {
    it("returns messages unchanged when mustReplayWithToolCalls is false", () => {
      const adapter = createAdapter("generic-openai-compatible");
      const messages = [
        { role: "user", content: "hello" },
        {
          role: "assistant",
          content: "hi",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "run_bash", arguments: "{}" },
            },
          ],
        },
      ] as import("openai/resources/chat/completions").ChatCompletionMessageParam[];
      const result = adapter.prepareMessages(messages);
      expect(result).toEqual(messages);
    });

    it("adds reasoning_content placeholder for assistant with tool_calls when required", () => {
      const adapter = createAdapter("kimi-k2.6", "kimi_platform_cn");
      const messages = [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "run_bash", arguments: "{}" },
            },
          ],
        },
      ] as import("openai/resources/chat/completions").ChatCompletionMessageParam[];
      const result = adapter.prepareMessages(messages);
      const msg = result[0] as unknown as Record<string, unknown>;
      expect(msg.reasoning_content).toBe("");
    });

    it("does not add reasoning_content when assistant already has it", () => {
      const adapter = createAdapter("kimi-k2.6", "kimi_platform_cn");
      const messages = [
        {
          role: "assistant",
          content: "hi",
          reasoning_content: "thinking...",
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "run_bash", arguments: "{}" },
            },
          ],
        },
      ] as unknown as import("openai/resources/chat/completions").ChatCompletionMessageParam[];
      const result = adapter.prepareMessages(messages);
      const msg = result[0] as unknown as Record<string, unknown>;
      expect(msg.reasoning_content).toBe("thinking...");
    });

    it("does not add reasoning_content placeholder when assistant has reasoning_details", () => {
      // MiniMax M3 返回 reasoning_details 而非 reasoning_content
      const adapter = createAdapter("minimax-m3", "minimax_cn");
      const messages = [
        {
          role: "assistant",
          content: null,
          reasoning_details: [{ type: "thinking", text: "..." }],
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "run_bash", arguments: "{}" },
            },
          ],
        },
      ] as unknown as import("openai/resources/chat/completions").ChatCompletionMessageParam[];
      const result = adapter.prepareMessages(messages);
      const msg = result[0] as unknown as Record<string, unknown>;
      expect(msg.reasoning_content).toBeUndefined();
      expect(msg.reasoning_details).toBeDefined();
    });
  });

  describe("buildRequest", () => {
    it("builds correct request for generic profile", () => {
      const adapter = createAdapter("generic-openai-compatible");
      const prepared = adapter.buildRequest({
        messages: [{ role: "user", content: "hello" }],
      });
      expect(prepared.model).toBe("generic-openai-compatible");
      expect(prepared.stream).toBe(false);
      expect(prepared.maxTokensField).toBe("max_tokens");
      expect(prepared.maxOutputTokens).toBe(4096);
    });

    it("uses max_completion_tokens for MiMo", () => {
      const adapter = createAdapter("mimo-v2.5-pro");
      const prepared = adapter.buildRequest({ messages: [] });
      expect(prepared.maxTokensField).toBe("max_completion_tokens");
    });

    it("includes extraBody for thinking-enabled models", () => {
      const adapter = createAdapter("deepseek-v4");
      const prepared = adapter.buildRequest({ messages: [] });
      expect(prepared.extraBody).toBeDefined();
    });
  });

  describe("parseNonStreamingResponse", () => {
    it("parses content and tool_calls", () => {
      const adapter = createAdapter("generic-openai-compatible");
      const response = {
        choices: [
          {
            message: {
              content: "Hello",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "run_bash", arguments: "{}" },
                },
              ],
            },
            finish_reason: "stop",
          },
        ],
      };
      const result = adapter.parseNonStreamingResponse(response);
      expect(result.content).toBe("Hello");
      expect(result.toolCalls).toHaveLength(1);
      expect(result.finishReason).toBe("stop");
      expect(result.assistantMessage).toBeDefined();
      expect(result.assistantMessage.role).toBe("assistant");
    });

    it("parses reasoning_content from response", () => {
      const adapter = createAdapter("deepseek-v4");
      const response = {
        choices: [
          {
            message: {
              content: "answer",
              reasoning_content: "let me think...",
            },
            finish_reason: "stop",
          },
        ],
      };
      const result = adapter.parseNonStreamingResponse(response);
      expect(result.reasoning?.content).toBe("let me think...");
      expect(result.reasoning?.source).toBe("reasoning_content");
      const msg = result.assistantMessage as unknown as Record<string, unknown>;
      expect(msg.reasoning_content).toBe("let me think...");
    });

    it("parses usage from response", () => {
      const adapter = createAdapter("generic-openai-compatible");
      const response = {
        choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      };
      const result = adapter.parseNonStreamingResponse(response);
      expect(result.usage?.promptTokens).toBe(10);
      expect(result.usage?.completionTokens).toBe(5);
      expect(result.usage?.totalTokens).toBe(15);
    });

    it("parses DeepSeek cache usage", () => {
      const adapter = createAdapter("deepseek-v4");
      const response = {
        choices: [{ message: { content: "Hi" }, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 10,
          total_tokens: 110,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
        },
      };
      const result = adapter.parseNonStreamingResponse(response);
      expect(result.usage?.cacheHitTokens).toBe(80);
      expect(result.usage?.cacheMissTokens).toBe(20);
    });

    it("throws on empty choices", () => {
      const adapter = createAdapter("generic-openai-compatible");
      expect(() => adapter.parseNonStreamingResponse({ choices: [] })).toThrow(
        "No response from LLM",
      );
    });
  });

  describe("streaming", () => {
    it("aggregates content chunks", () => {
      const adapter = createAdapter("generic-openai-compatible");
      const acc = createStreamingAccumulator();

      adapter.parseStreamingChunk(
        { choices: [{ delta: { content: "Hello" }, finish_reason: null }] },
        acc,
      );
      adapter.parseStreamingChunk(
        { choices: [{ delta: { content: " world" }, finish_reason: "stop" }] },
        acc,
      );

      const result = adapter.finishStreaming(acc);
      expect(result.content).toBe("Hello world");
      expect(result.finishReason).toBe("stop");
    });

    it("aggregates tool_calls arguments", () => {
      const adapter = createAdapter("generic-openai-compatible");
      const acc = createStreamingAccumulator();

      adapter.parseStreamingChunk(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    type: "function",
                    function: { name: "run_bash", arguments: "" },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        acc,
      );
      adapter.parseStreamingChunk(
        {
          choices: [
            {
              delta: {
                tool_calls: [
                  { index: 0, function: { arguments: '{"cmd":"ls"}' } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        acc,
      );

      const result = adapter.finishStreaming(acc);
      expect(result.toolCalls).toHaveLength(1);
      expect(result.toolCalls[0]!.function.arguments).toBe('{"cmd":"ls"}');
    });

    it("aggregates reasoning_content delta", () => {
      const adapter = createAdapter("deepseek-v4");
      const acc = createStreamingAccumulator();

      adapter.parseStreamingChunk(
        {
          choices: [
            {
              delta: { content: null, reasoning_content: "Step 1: " },
              finish_reason: null,
            },
          ],
        },
        acc,
      );
      adapter.parseStreamingChunk(
        {
          choices: [
            {
              delta: { content: null, reasoning_content: "analyze" },
              finish_reason: "stop",
            },
          ],
        },
        acc,
      );

      const result = adapter.finishStreaming(acc);
      expect(result.reasoning?.content).toBe("Step 1: analyze");
      const msg = result.assistantMessage as unknown as Record<string, unknown>;
      expect(msg.reasoning_content).toBe("Step 1: analyze");
    });

    it("aggregates reasoning_details delta for MiniMax M3", () => {
      const adapter = createAdapter("minimax-m3", "minimax_cn");
      const acc = createStreamingAccumulator();

      adapter.parseStreamingChunk(
        {
          choices: [
            {
              delta: {
                content: null,
                reasoning_details: [{ type: "thinking", text: "Step 1" }],
              },
              finish_reason: null,
            },
          ],
        },
        acc,
      );
      adapter.parseStreamingChunk(
        {
          choices: [
            {
              delta: {
                content: null,
                reasoning_details: [{ type: "thinking", text: "Step 2" }],
              },
              finish_reason: "stop",
            },
          ],
        },
        acc,
      );

      const result = adapter.finishStreaming(acc);
      expect(result.reasoning?.source).toBe("reasoning_details");
      const details = result.reasoning?.details as unknown[];
      expect(details).toHaveLength(2);
      const msg = result.assistantMessage as unknown as Record<string, unknown>;
      expect(msg.reasoning_details).toBeDefined();
    });

    it("throws on empty stream", () => {
      const adapter = createAdapter("generic-openai-compatible");
      const acc = createStreamingAccumulator();
      expect(() => adapter.finishStreaming(acc)).toThrow(
        "No response from LLM",
      );
    });
  });
});
