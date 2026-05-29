/**
 * normalize.ts — 消息标准化模块
 *
 * 职责：在将消息发送给 LLM API 之前，对消息列表进行标准化处理。
 *
 * 为什么需要标准化？
 * - Agent 循环中可能产生不符合 API 要求的消息格式
 * - 某些消息可能包含内部元数据（以 "_" 开头的字段），API 无法识别
 * - 工具调用可能缺少对应的结果消息，导致 API 报错
 * - 连续同角色消息不符合 OpenAI API 的严格交替要求
 *
 * 标准化做三件事：
 * 1. 过滤 content block 内的元数据字段（顶层 _round 仍保留给压缩管线）
 * 2. 补全或移动缺失的 tool_result，让它紧跟对应 assistant tool_call
 * 3. 合并连续同角色消息（只合并普通 user/assistant 文本，不合并 tool_call）
 */

import type { ChatCompletionMessageParam } from "openai/resources/chat/completions";

/**
 * normalizeMessages — 消息标准化主函数
 *
 * @param messages - 原始消息列表（可能包含不规范的格式）
 * @returns 标准化后的消息列表（符合 OpenAI API 要求）
 */
export function normalizeMessages(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  // 教学导读：
  // History 中保存的是 Agent 运行时积累的消息，它可能包含：
  // - 内部元数据（如 _turnIndex、_loopRound）
  // - 被 Hook / recovery 插入的连续 user 消息
  // - 因工具调用失败或中断导致缺失的 tool_result
  //
  // LLM API 对消息格式很严格，尤其是 tool_calls 必须和 tool_result 配对。
  // normalize 的目标不是改变语义，而是把“运行时消息流”整理成
  // provider 可以接受的“协议合法消息流”。

  // 步骤 1：过滤 content block 内的元数据字段（顶层 _round 仍保留给压缩管线）
  const cleaned = cleanMetadata(messages);

  // 步骤 2：补全或移动缺失的 tool_result，让它紧跟对应 assistant tool_call
  const withToolResults = ensureToolResults(cleaned);

  // 步骤 3：合并连续同角色消息（只合并普通 user/assistant 文本，不合并 tool_call）
  const merged = mergeConsecutiveRoles(withToolResults);

  return merged;
}

/**
 * cleanMetadata — 过滤消息中的元数据字段
 *
 * 处理规则：
 * - content 是字符串 → clone 消息后保留（最常见的格式）
 * - content 是数组 → 过滤每个 block 中以 "_" 开头的键（如 _timestamp、_id）
 * - content 是 null/undefined → 保留不变
 *
 * 元数据字段（如 _timestamp）是内部系统使用的，LLM API 无法识别，
 * 发送过去可能导致 API 报错或行为异常。
 *
 * 注意：顶层 _round 是 prepareMessages → message-block 的内部协议字段，
 * normalize 阶段必须保留，最终由 flattenToMessages() 清除。
 */
function cleanMetadata(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  return messages.map(cloneMessage);
}

/**
 * ensureToolResults — 确保每个 tool_call 都有对应的 tool 消息
 *
 * OpenAI API 的要求：
 * - assistant 消息中的每个 tool_call（通过 tool_call_id 标识）
 *   都必须有且仅有一条 role="tool" 的消息作为回应
 * - 如果缺少 tool 消息，API 会报错
 *
 * 这个函数会按 assistant tool_calls 原始顺序重建 tool block：
 * 1. 先收集所有已有 tool 消息
 * 2. 遇到 assistant(tool_calls) 时，立即补上对应 tool 消息
 * 3. 已消费的 tool 消息在原位置跳过，孤立 tool 消息不发送给 LLM
 */
function ensureToolResults(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  // 学习重点：
  // tool 消息在 History 中可能不紧挨 assistant tool_calls。
  // 例如 Hook 或恢复逻辑插入了 user reminder，或者旧实现保存顺序有偏差。
  // 这里的做法是“按 tool_call_id 重建局部顺序”，而不是信任原始位置。

  // 第一遍遍历：按 tool_call_id 收集所有 tool 消息，建立 id → 消息的映射
  const toolMessagesById = new Map<string, ChatCompletionMessageParam>();
  for (const msg of messages) {
    // 只收集 tool 角色消息，跳过其他角色
    if (msg.role !== "tool") continue;
    const toolCallId = readToolCallId(msg);
    // 同一 id 只保留第一条（正常情况下不会出现重复）
    if (toolCallId && !toolMessagesById.has(toolCallId)) {
      toolMessagesById.set(toolCallId, msg);
    }
  }

  // 第二遍遍历：按原始顺序重建消息流，在 assistant tool_calls 后立即插入对应的 tool 消息
  const result: ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    // 跳过原位置的 tool 消息（它们会被归并到对应的 assistant 后面）
    // 已经被归入 assistant tool block 的 tool 消息，在原位置跳过；
    // 没有 assistant 引用的孤立 tool 消息也跳过，避免发送非法 provider 输入。
    if (msg.role === "tool") {
      continue;
    }

    // 复制当前非 tool 消息到结果中
    result.push(cloneMessage(msg));
    // 当前消息不是 assistant tool_calls，无需补全 tool 结果
    if (!hasToolCalls(msg)) continue;

    const toolCalls = (msg as { tool_calls: Array<{ id?: string }> })
      .tool_calls;
    // 注意：插入顺序必须使用 assistant.tool_calls 的顺序，
    // 不能使用 toolMessagesById 的 Map 顺序。模型生成 tool_calls 时的顺序，
    // 就是 provider 期望后续 tool result 对应的顺序。
    // 按 assistant 中 tool_calls 的原始顺序，逐一查找或补全对应的 tool 消息
    for (const toolCall of toolCalls) {
      // tool_call 必须有 id 才能匹配 tool 消息
      if (!toolCall.id) continue;
      const existing = toolMessagesById.get(toolCall.id);
      if (existing) {
        // 找到已存在的 tool 消息，复制后加入结果
        result.push(cloneMessage(existing));
      } else {
        // 未找到对应 tool 消息（可能调用被取消或尚未执行），生成占位消息避免 API 报错
        // 这里用 "(cancelled)" 而不是空字符串，是为了让模型明确知道：
        // 这个工具调用没有真实结果，不应该假装已经成功执行。
        result.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: "(cancelled)",
        } as unknown as ChatCompletionMessageParam);
      }
    }
  }

  return result;
}

/**
 * mergeConsecutiveRoles — 合并连续同角色消息
 *
 * OpenAI API 要求消息角色严格交替（user → assistant → tool → assistant → ...）。
 * 如果出现连续两条同角色消息（如 user + user），API 会报错。
 *
 * 合并策略：
 * - 只合并 user 和 assistant 角色（tool 角色有 tool_call_id，不能合并）
 * - 两条都是 string content → 拼接字符串
 * - 任一条是数组 content → 统一转为数组格式后拼接
 * - 不同角色 → 直接追加为新消息
 */
function mergeConsecutiveRoles(
  messages: ChatCompletionMessageParam[],
): ChatCompletionMessageParam[] {
  // 学习重点：
  // Agent 会把 system-reminder、Hook 补充消息等都作为 user 消息追加。
  // 如果这些 user 消息连续出现，某些 provider 会拒绝或表现不稳定。
  // 合并连续同角色文本消息，可以减少 provider 方言差异。

  // 空输入直接返回空数组
  if (messages.length === 0) return [];

  // 用第一条消息初始化结果数组，后续消息尝试与前一条合并
  const merged: ChatCompletionMessageParam[] = [cloneMessage(messages[0]!)];

  // 从第二条消息开始遍历，每条消息尝试与结果数组的最后一条合并
  for (let i = 1; i < messages.length; i++) {
    const msg = cloneMessage(messages[i]!);
    const last = merged[merged.length - 1]!;

    // 角色相同且可合并 → 将两条消息的 content 拼接为一条
    if (canMergeMessages(last, msg)) {
      // 将两条消息的 content 都转为数组格式后拼接
      // 统一成数组格式是为了兼容多模态 message content。
      // 即使当前教学项目主要用文本，也保留这个处理可以说明 OpenAI 消息结构的通用形态。
      const prevContent = toArrayContent(last.content);
      const currContent = toArrayContent(msg.content);

      const mergedMsg = {
        ...last,
        content: prevContent.concat(currContent),
      } as unknown as ChatCompletionMessageParam;
      merged[merged.length - 1] = mergedMsg;
    } else {
      // 角色不同或不可合并（如 assistant 含 tool_calls）→ 作为独立消息追加
      merged.push(msg);
    }
  }

  return merged;
}

/**
 * toArrayContent — 将消息 content 统一转为数组格式
 *
 * OpenAI 消息的 content 有两种格式：
 * - 字符串：普通文本，如 "hello"
 * - 数组：多部分内容（文本 + 图片等），如 [{type: "text", text: "hello"}]
 *
 * 为了合并消息，需要统一为数组格式再拼接。
 *
 * @param content - 原始 content（string、数组、或 null）
 * @returns 数组格式的 content
 */
function toArrayContent(
  content: string | unknown[] | null | undefined,
): Array<Record<string, unknown>> {
  // 已是数组格式：浅拷贝每个 block，确保合并时不污染原数据
  if (Array.isArray(content)) {
    return content.map((block) => ({
      ...(block as Record<string, unknown>),
    }));
  }

  // 字符串格式：包装为标准文本数组格式
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  // null 或 undefined → 返回空数组，避免合并时出现 null 项
  return [];
}

function canMergeMessages(
  last: ChatCompletionMessageParam,
  msg: ChatCompletionMessageParam,
): boolean {
  // 合并规则要非常保守：
  // user 文本可以合并，因为它们只是连续输入/提醒；
  // assistant 如果包含 tool_calls，则不能合并，因为 tool_calls 后面必须精确配对 tool 消息；
  // tool 消息也不能合并，因为每条都有自己的 tool_call_id。

  // 不同角色的消息不能合并
  if (last.role !== msg.role) return false;
  // user 消息只要角色相同即可合并
  if (msg.role === "user") return true;
  // tool 角色有 tool_call_id，不允许合并
  if (msg.role !== "assistant") return false;
  // assistant 消息：只有当两条都不含 tool_calls 时才能合并（含 tool_calls 的需要严格配对）
  return !hasToolCalls(last) && !hasToolCalls(msg);
}

// 检查 assistant 消息是否包含非空的 tool_calls 数组
function hasToolCalls(msg: ChatCompletionMessageParam): boolean {
  return (
    msg.role === "assistant" &&
    "tool_calls" in msg &&
    Array.isArray(msg.tool_calls) &&
    msg.tool_calls.length > 0
  );
}

// 从 tool 消息中提取 tool_call_id，类型不安全因此需要显式断言
function readToolCallId(msg: ChatCompletionMessageParam): string | undefined {
  if (msg.role !== "tool") return undefined;
  const toolCallId = (msg as unknown as { tool_call_id?: unknown })
    .tool_call_id;
  return typeof toolCallId === "string" ? toolCallId : undefined;
}

function cloneMessage(
  msg: ChatCompletionMessageParam,
): ChatCompletionMessageParam {
  // cloneMessage 的职责不是深拷贝整个 OpenAI 对象，
  // 而是清理 content block 中 provider 不认识的 "_" 元数据字段，
  // 并复制 tool_calls 这种容易被后续流程修改的嵌套对象。
  // 顶层 timing 字段会保留到 message-block 阶段再统一清除。

  // 浅拷贝顶层字段
  const cloned = { ...(msg as unknown as Record<string, unknown>) };
  // content 需要深拷贝（尤其是数组格式时），避免修改影响原消息
  if ("content" in cloned) {
    cloned.content = cloneContent(cloned.content);
  }
  // tool_calls 数组及其内部 function 对象也需要深拷贝
  if (Array.isArray(cloned.tool_calls)) {
    cloned.tool_calls = cloned.tool_calls.map((toolCall) => ({
      ...(toolCall as Record<string, unknown>),
      function: {
        ...((toolCall as { function?: Record<string, unknown> }).function ??
          {}),
      },
    }));
  }
  return cloned as unknown as ChatCompletionMessageParam;
}

function cloneContent(content: unknown): unknown {
  // content 为数组时：过滤掉非对象项，并移除每个 block 中以 "_" 开头的内部元数据键
  if (Array.isArray(content)) {
    return content
      .filter((block) => typeof block === "object" && block !== null)
      .map((block) =>
        Object.fromEntries(
          Object.entries(block as Record<string, unknown>).filter(
            ([key]) => !key.startsWith("_"),
          ),
        ),
      );
  }
  // 字符串或 null 保持原样
  return content;
}
