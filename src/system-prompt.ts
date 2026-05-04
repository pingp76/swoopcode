/**
 * system-prompt.ts — System Prompt 组合器
 *
 * 职责：将多个 system prompt 片段（Skill hint、Memory hint 等）组合成最终的 system prompt。
 *
 * 为什么需要组合器？
 * - 之前 system prompt 只包含 Skill hint，直接在 index.ts 中通过 history.setSystemPrompt() 设置
 * - 新增 Memory 后，system prompt 需要同时包含 Skill hint 和 Memory hint
 * - Memory hint 可能需要按用户请求动态排除（用户说"忽略 memory"时）
 * - 组合器统一管理这些片段的拼接逻辑
 *
 * 设计模式：
 * - SystemPromptProvider 每轮调用 build(query) 时重新生成 system prompt
 * - 这样 memory 文件在运行时新增/删除后，下一轮就能反映变化
 * - 比启动时写死静态 system prompt 更灵活
 */

// ============================================================================
// 类型定义
// ============================================================================

/** System prompt 的各个片段 */
export interface SystemPromptParts {
  /** Skill 提示（有可用 skill 时注入） */
  skillHint?: string | null;
  /** Memory 摘要提示（有 memory 时注入） */
  memoryHint?: string | null;
}

/** System Prompt 提供者接口 */
export interface SystemPromptProvider {
  /**
   * 根据当前用户查询构建 system prompt
   *
   * @param query - 用户当前输入
   * @returns 组合后的 system prompt，没有片段时返回 null
   */
  build(query: string): string | null;
}

// ============================================================================
// 组合函数
// ============================================================================

/**
 * buildSystemPrompt — 将多个片段组合成最终 system prompt
 *
 * 规则：
 * 1. 没有任何片段时返回 null
 * 2. 有多个片段时用空行分隔
 * 3. Skill hint 在前，Memory hint 在后
 */
export function buildSystemPrompt(parts: SystemPromptParts): string | null {
  const segments: string[] = [];
  if (parts.skillHint) segments.push(parts.skillHint);
  if (parts.memoryHint) segments.push(parts.memoryHint);
  if (segments.length === 0) return null;
  return segments.join("\n\n");
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * createSystemPromptProvider — 创建 SystemPromptProvider 实例
 *
 * @param deps.getSkillHint - 返回当前 Skill hint 的函数
 * @param deps.getMemoryHint - 返回当前 Memory hint 的函数
 *
 * build(query) 会检测用户输入中是否包含"忽略 memory"的关键词，
 * 如果匹配则省略 memory hint，只保留其他片段。
 */
export function createSystemPromptProvider(deps: {
  getSkillHint: () => string | null;
  getMemoryHint: () => string | null;
}): SystemPromptProvider {
  // 匹配用户要求忽略 memory 的各种表达：
  // "忽略 memory"、"不要使用 memory"、"本轮不要使用 memory"、
  // "ignore memory"、"don't use memory"、"do not use memory"
  const IGNORE_MEMORY_PATTERN = /(?:忽略|不使用|不要使用|don'?t use|do not use|ignore)\s*memory/i;

  return {
    build(query: string): string | null {
      // 检测用户是否要求本轮忽略 memory
      const ignoreMemory = IGNORE_MEMORY_PATTERN.test(query);
      return buildSystemPrompt({
        skillHint: deps.getSkillHint(),
        memoryHint: ignoreMemory ? null : deps.getMemoryHint(),
      });
    },
  };
}
