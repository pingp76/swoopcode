/**
 * skills.ts — Skill（技能）系统核心模块
 *
 * 职责：管理可按需加载的 prompt 扩展——Skill。
 *
 * Skill 的工作原理（参考 Anthropic 官方 Skill 规范）：
 *
 *   ┌───────────────────────────────────────────────────┐
 *   │ 1. 启动时：scan() 扫描 skills/ 目录              │
 *   │    只解析 SKILL.md 的 YAML frontmatter（元数据）  │
 *   │    → 缓存 { name, description }，不加载 body      │
 *   ├───────────────────────────────────────────────────┤
 *   │ 2. 注册时：将 skill 列表嵌入 run_skill 工具描述   │
 *   │    LLM 看到工具列表，据此判断是否调用             │
 *   ├───────────────────────────────────────────────────┤
 *   │ 3. 触发时：LLM 通过 function call 调用 run_skill  │
 *   │    invoke() 读取 SKILL.md 的 body + base path     │
 *   │    → 注入上下文，LLM 按指示继续工作               │
 *   └───────────────────────────────────────────────────┘
 *
 * 关键洞察：Skill 不是新工具、不是子进程——它是按需注入的 prompt 扩展。
 * 触发后 LLM 拿到详细指示，继续用 run_bash、run_read 等现有工具执行。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { ToolResult } from "./tools/types.js";

// ============================================================
// 类型定义
// ============================================================

/**
 * SkillMeta — SKILL.md 的 YAML frontmatter 元数据
 *
 * 这些元数据在启动时被解析，用于：
 * 1. 构建 run_skill 工具的 description（告诉 LLM 有哪些 skill 可用）
 * 2. 作为 skill 的唯一标识和简要说明
 */
export interface SkillMeta {
  /** 唯一标识，小写字母 + 连字符，最长 64 字符 */
  name: string;
  /** 单行描述，告诉 LLM 何时使用此 skill */
  description: string;
}

/**
 * SkillEntry — 已发现的完整 Skill 条目
 *
 * 除了元数据，还保留了文件系统路径信息，
 * 用于 invoke() 时读取 body 和 remove() 时删除目录。
 */
export interface SkillEntry {
  /** Skill 的元数据（name + description） */
  meta: SkillMeta;
  /** SKILL.md 文件的绝对路径 */
  skillFilePath: string;
  /** skill 目录的绝对路径（用于返回给 LLM 作为 base path） */
  basePath: string;
}

/**
 * SkillManager — Skill 管理器接口
 *
 * 提供扫描、查询、触发、删除四个核心操作。
 * 遵循项目的工厂函数模式，通过 createSkillManager() 创建。
 */
export interface SkillManager {
  /** 扫描 skills/ 目录，解析所有 SKILL.md 的 frontmatter，刷新缓存 */
  scan(): void;
  /** 获取所有已发现的 skill 元数据 */
  listMeta(): SkillMeta[];
  /** 触发指定 skill：读取 SKILL.md body，返回 body + base path */
  invoke(name: string): string;
  /** 删除指定 skill（删除整个目录并从缓存移除） */
  remove(name: string): boolean;
}

/**
 * SkillToolProvider — Skill 工具提供者接口
 *
 * 与 TodoToolProvider、SubagentToolProvider 模式一致：
 * 提供 toolEntries 数组，由 createToolRegistry 批量注册。
 */
export interface SkillToolProvider {
  /** run_skill 工具的定义和执行函数 */
  toolEntries: Array<{
    definition: ChatCompletionTool;
    execute: (args: Record<string, unknown>) => Promise<ToolResult>;
  }>;
}

// ============================================================
// parseFrontmatter — YAML frontmatter 解析器
// ============================================================

/**
 * parseFrontmatter — 解析 SKILL.md 的 YAML frontmatter
 *
 * SKILL.md 的格式：
 * ```
 * ---
 * name: code-review
 * description: Review code for quality issues...
 * ---
 * (body content — 触发时才读取的部分)
 * ```
 *
 * 解析规则：
 * 1. 文件必须以 `---\n` 开头
 * 2. 到第二个 `---` 之间的内容是 frontmatter
 * 3. 每行格式为 `key: value`，忽略空行和 `#` 开头的注释行
 * 4. 第二个 `---` 之后的所有内容作为 body
 *
 * 不引入 YAML 库——skill 的 frontmatter 字段简单，正则足够处理。
 *
 * @param content - SKILL.md 文件的完整内容
 * @returns 解析结果 { meta, body }，格式无效时返回 null
 */
export function parseFrontmatter(content: string): {
  meta: Record<string, string>;
  body: string;
} | null {
  // 检查是否以 --- 开头
  if (!content.startsWith("---")) {
    return null;
  }

  // 查找第二个 --- 的位置（从第一个 --- 之后开始搜索）
  // frontmatter 的结束标记必须在新行的开头
  const rest = content.slice(3);
  const endMarker = rest.indexOf("\n---");

  if (endMarker === -1) {
    return null;
  }

  // 提取 frontmatter 文本（两个 --- 之间的内容）
  const frontmatter = rest.slice(0, endMarker);
  // body 是第二个 --- 之后的所有内容
  // rest 中 \n--- 匹配的位置是 endMarker，\n--- 共 4 个字符
  // 所以在 rest 中 body 从 endMarker + 4 开始
  // 在原始 content 中 body 从 3 + endMarker + 4 开始
  const bodyStart = 3 + endMarker + 4;
  const body = content.slice(bodyStart).trimStart();

  // 逐行解析 key: value
  const meta: Record<string, string> = {};
  for (const line of frontmatter.split("\n")) {
    const trimmed = line.trim();
    // 跳过空行和注释行
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    // 匹配 key: value 格式（value 可能包含冒号，所以只分割第一个冒号）
    const colonIndex = trimmed.indexOf(":");
    if (colonIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 1).trim();
    if (key) {
      meta[key] = value;
    }
  }

  return { meta, body };
}

// ============================================================
// buildSkillToolDescription — 构建增强版工具描述
// ============================================================

/**
 * buildSkillToolDescription — 为 run_skill 工具动态生成 description
 *
 * 采用"增强版"格式（策略 1），不仅列出 skill 名称和描述，
 * 还包含触发规则、执行说明和具体示例，帮助 weaker model 正确使用。
 *
 * description 分为四个段落：
 * 1. Available skills — 列出所有 skill 的 name + description
 * 2. When to use — 基于每个 skill 的 description 生成触发规则
 * 3. What happens — 解释调用后会收到什么、应该怎么做
 * 4. Examples — 具体的触发示例
 *
 * @param metas - 当前所有可用 skill 的元数据列表
 * @returns 格式化的工具描述字符串
 */
export function buildSkillToolDescription(metas: SkillMeta[]): string {
  // 没有 skill 时返回最小描述
  if (metas.length === 0) {
    return "Load a skill to get specialized instructions for a task. No skills are currently available.";
  }

  // 构建 skill 列表
  const skillList = metas
    .map((m) => `- ${m.name}: ${m.description}`)
    .join("\n");

  // 构建触发规则（从每个 skill 的 description 提取第一句话作为匹配依据）
  const whenToUse = metas
    .map(
      (m) =>
        `- When user's request relates to "${m.description.split(".")[0]}" → call run_skill({ name: "${m.name}" })`,
    )
    .join("\n");

  return [
    "Load a skill to get specialized instructions for a task.",
    "",
    "Available skills:",
    skillList,
    "",
    "When to use:",
    whenToUse,
    "",
    "What happens:",
    "- You will receive detailed step-by-step instructions",
    "- Then follow those instructions using other tools (run_read, run_bash, etc.)",
    "- Do NOT try to complete the task directly — load the skill first",
    "",
    "Examples:",
    `- User: "review this code" → run_skill({ name: "${metas[0]!.name}" })`,
  ].join("\n");
}

// ============================================================
// SKILL_SYSTEM_PROMPT_HINT — 系统提示常量
// ============================================================

/**
 * SKILL_SYSTEM_PROMPT_HINT — Skill 系统提示（策略 2）
 *
 * 这段短文本会被设置为 system prompt，让 LLM 在看到工具列表之前
 * 就理解 skill 的存在和用途。配合 run_skill 工具的增强描述（策略 1），
 * 形成双保险，帮助 weaker model 正确使用 skill。
 *
 * 约 40 个词，不会显著增加上下文开销。
 */
export const SKILL_SYSTEM_PROMPT_HINT = [
  "You have access to skills via the run_skill tool.",
  "Skills provide specialized instructions for certain tasks.",
  "When a user's request matches an available skill,",
  "call run_skill first to load detailed instructions,",
  "then follow those instructions using other tools.",
].join(" ");

// ============================================================
// createSkillManager — Skill 管理器工厂函数
// ============================================================

/**
 * createSkillManager — 创建 Skill 管理器实例
 *
 * @param skillsDir - 全局 skills 根目录的绝对路径（不随被操作项目切换）
 * @returns SkillManager 接口的实现
 *
 * 使用 Map 存储已发现的 skill，以 skill name 为 key。
 * 闭包保护内部状态，外部只能通过接口方法操作。
 */
export function createSkillManager(skillsDir: string): SkillManager {
  // skill 映射表：skill name → SkillEntry
  const entries = new Map<string, SkillEntry>();

  return {
    /**
     * scan — 扫描 skills/ 目录，解析所有 SKILL.md 的 frontmatter
     *
     * 流程：
     * 1. 列出 skillsDir 下的所有子目录
     * 2. 对每个子目录，检查是否包含 SKILL.md
     * 3. 读取并解析 frontmatter
     * 4. 校验 name + description 必填字段
     * 5. 存入 entries map（清空旧缓存）
     *
     * 目录不存在时静默处理（不报错），返回空列表。
     */
    scan() {
      // 清空旧缓存，准备重新扫描
      entries.clear();

      // 目录不存在时直接返回（不报错）
      if (!fs.existsSync(skillsDir)) {
        return;
      }

      // 列出 skills/ 下的所有条目
      let subdirs: fs.Dirent[];
      try {
        subdirs = fs.readdirSync(skillsDir, { withFileTypes: true });
      } catch {
        // 读取失败（权限等），静默返回
        return;
      }

      for (const dirent of subdirs) {
        // 只处理目录（跳过文件）
        if (!dirent.isDirectory()) {
          continue;
        }

        const skillDir = path.join(skillsDir, dirent.name);
        const skillFilePath = path.join(skillDir, "SKILL.md");

        // 跳过没有 SKILL.md 的目录
        if (!fs.existsSync(skillFilePath)) {
          continue;
        }

        // 读取 SKILL.md 内容
        const content = fs.readFileSync(skillFilePath, "utf-8");
        const parsed = parseFrontmatter(content);

        if (!parsed) {
          // frontmatter 格式无效，跳过
          continue;
        }

        // 校验必填字段：name 和 description
        const name = parsed.meta["name"];
        const description = parsed.meta["description"];
        if (!name || !description) {
          // 缺少必填字段，跳过
          continue;
        }

        // 创建并缓存 SkillEntry
        entries.set(name, {
          meta: { name, description },
          skillFilePath,
          basePath: skillDir,
        });
      }
    },

    /**
     * listMeta — 获取所有已发现的 skill 元数据
     *
     * @returns SkillMeta 数组（用于构建 run_skill 工具描述和 /skill list 命令）
     */
    listMeta() {
      return [...entries.values()].map((e) => e.meta);
    },

    /**
     * invoke — 触发指定 skill
     *
     * 读取 SKILL.md 的 body 部分（跳过 frontmatter），
     * 连同 base path 一起返回，作为 tool_result 注入上下文。
     *
     * @param name - 要触发的 skill 名称
     * @returns base path + body 文本，或 "[Skill Error] ..." 错误字符串
     */
    invoke(name: string): string {
      const entry = entries.get(name);
      if (!entry) {
        return `[Skill Error] Skill not found: ${name}`;
      }

      // 重新读取文件（body 不在启动时缓存，实现懒加载）
      let content: string;
      try {
        content = fs.readFileSync(entry.skillFilePath, "utf-8");
      } catch {
        return `[Skill Error] Skill file missing: ${entry.skillFilePath}`;
      }

      const parsed = parseFrontmatter(content);
      if (!parsed) {
        return `[Skill Error] Invalid SKILL.md format: ${entry.skillFilePath}`;
      }

      // 返回 base path + body（这是 Anthropic Skill 规范的核心格式）
      return `Base Path: ${entry.basePath}\n\n${parsed.body}`;
    },

    /**
     * remove — 删除指定 skill
     *
     * 删除 skill 目录，并从缓存中移除。
     *
     * @param name - 要删除的 skill 名称
     * @returns 是否成功删除
     */
    remove(name: string): boolean {
      const entry = entries.get(name);
      if (!entry) {
        return false;
      }

      // 删除整个 skill 目录
      try {
        fs.rmSync(entry.basePath, { recursive: true, force: true });
      } catch {
        return false;
      }

      // 从缓存中移除
      entries.delete(name);
      return true;
    },
  };
}

// ============================================================
// createSkillToolProvider — Skill 工具提供者工厂函数
// ============================================================

/**
 * createSkillToolProvider — 创建 Skill 工具提供者
 *
 * 遵循与 SubagentToolProvider、TodoToolProvider 相同的模式：
 * 返回 { toolEntries } 数组，由 createToolRegistry 批量注册。
 *
 * @param manager - SkillManager 实例
 * @returns SkillToolProvider，包含 run_skill 的定义和执行函数
 */
export function createSkillToolProvider(
  manager: SkillManager,
): SkillToolProvider {
  /**
   * run_skill 的工具定义
   *
   * 【静态快照语义】
   * description 在创建时一次性生成（buildSkillToolDescription(manager.listMeta())），
   * 后续通过 /skill load 添加或删除 skill 不会更新此 description。
   * LLM 看到的永远是启动时的 skill 列表。
   *
   * 这是一个明确的设计决策（路线 A）：
   * - 保持实现简单，不做热更新架构
   * - 如果需要刷新 skill 列表，重启 agent 即可
   * - /skill load 只更新本地缓存，不影响 LLM 可见范围
   */
  const skillToolDefinition: ChatCompletionTool = {
    type: "function",
    function: {
      name: "run_skill",
      description: buildSkillToolDescription(manager.listMeta()),
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              'The skill name to invoke (e.g., "code-review", "explain-code")',
          },
        },
        required: ["name"],
      },
    },
  };

  /**
   * executeSkill — run_skill 的执行函数
   *
   * 当 LLM 决定使用某个 skill 时，会调用此函数。
   * 函数调用 manager.invoke() 读取 SKILL.md body，
   * 将结果作为 tool_result 返回给 LLM。
   */
  async function executeSkill(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const name = String(args["name"] ?? "");
    if (!name.trim()) {
      return { output: "Error: 'name' parameter is required.", error: true };
    }

    const result = manager.invoke(name);
    // invoke() 返回 "[Skill Error]..." 开头的字符串表示错误
    const isError = result.startsWith("[Skill Error]");
    return { output: result, error: isError };
  }

  return {
    toolEntries: [
      {
        definition: skillToolDefinition,
        execute: executeSkill,
      },
    ],
  };
}
