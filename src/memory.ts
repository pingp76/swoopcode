/**
 * memory.ts — 长期记忆管理模块
 *
 * 职责：为 Agent 提供跨会话的长期记忆存储，保存少量对未来很多会话仍有价值的信息。
 *
 * 设计思路：
 * - 每条 memory 是一个独立 Markdown 文件，存放在 memory/ 目录
 * - 文件格式：frontmatter（name/description/type/createdAt/updatedAt）+ body
 * - MEMORY.md 是自动生成的索引，不手写维护
 * - 通过工厂函数 createMemoryManager() 创建，内部状态通过闭包保护
 * - 复用 skills.ts 的 parseFrontmatter() 解析器，不引入 YAML 依赖
 *
 * 与其他模块的关系：
 * - memory.ts 只负责读写文件和解析数据
 * - tools/memory.ts 负责把 MemoryManager 包装成 LLM 可调用的工具
 * - system-prompt.ts 负责把 memory 摘要注入 system prompt
 * - cli-commands.ts 负责提供 /memory CLI 命令
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { parseFrontmatter } from "./skills.js";
import type { Logger } from "./logger.js";

// ============================================================================
// 类型定义
// ============================================================================

/** Memory 的四种类型 */
export type MemoryType = "user" | "feedback" | "project" | "reference";

/** Memory 的元数据（frontmatter 部分） */
export interface MemoryMeta {
  /** 唯一标识，只允许小写字母、数字、下划线、短横线 */
  name: string;
  /** 一句话摘要，用于索引和 system prompt */
  description: string;
  /** memory 类型 */
  type: MemoryType;
  /** 创建时间，ISO 字符串 */
  createdAt: string;
  /** 更新时间，ISO 字符串 */
  updatedAt: string;
}

/** 完整的 Memory 条目（元数据 + 正文） */
export interface MemoryEntry {
  meta: MemoryMeta;
  body: string;
}

/** 创建 Memory 的输入参数 */
export interface CreateMemoryInput {
  name: string;
  description: string;
  type: MemoryType;
  body: string;
}

/** Memory 相似项，用于创建前做教学版去重提示 */
export interface MemorySimilarity {
  /** 已存在的 memory 条目 */
  entry: MemoryEntry;
  /** 相似原因，返回给工具调用方阅读 */
  reason: string;
}

/** MemoryManager 接口 — 供外部使用的类型 */
export interface MemoryManager {
  /** 从磁盘扫描所有 memory 文件 */
  scan(): MemoryEntry[];
  /** 获取按 type、name 稳定排序的 meta 列表 */
  list(): MemoryMeta[];
  /** 读取单条 memory 的完整内容 */
  read(name: string): MemoryEntry | null;
  /** 创建或更新一条 memory */
  create(input: CreateMemoryInput): MemoryEntry;
  /** 查找可能重复或相近的 memory */
  findSimilar(input: CreateMemoryInput): MemorySimilarity[];
  /** 删除一条 memory */
  delete(name: string): boolean;
  /** 生成注入 system prompt 的短文本 */
  buildPromptSection(): string | null;
  /** 重建 MEMORY.md 索引 */
  rebuildIndex(): void;
  /** 获取 memory 目录路径 */
  getMemoryDir(): string;
}

// ============================================================================
// 常量
// ============================================================================

/** name 合法字符：小写字母、数字、下划线、短横线 */
const VALID_NAME_REGEX = /^[a-z0-9_-]+$/;

/** 合法的 MemoryType 集合 */
const VALID_TYPES: ReadonlySet<string> = new Set([
  "user",
  "feedback",
  "project",
  "reference",
]);

/** frontmatter 中的必填字段 */
const REQUIRED_FIELDS = [
  "name",
  "description",
  "type",
  "createdAt",
  "updatedAt",
] as const;

/** 索引文件名（扫描时跳过） */
const INDEX_FILE = "MEMORY.md";

// ============================================================================
// 辅助函数
// ============================================================================

/**
 * isValidName — 校验 memory name 是否合法
 *
 * name 只允许小写字母、数字、下划线和短横线，
 * 避免路径穿越、隐藏文件写入和特殊字符覆盖问题。
 */
export function isValidName(name: string): boolean {
  return VALID_NAME_REGEX.test(name);
}

/**
 * isValidType — 校验 memory type 是否合法
 */
export function isValidType(type: string): boolean {
  return VALID_TYPES.has(type);
}

/**
 * serializeMemory — 将 MemoryEntry 序列化为 Markdown 文件内容
 *
 * 格式：
 * ---
 * name: xxx
 * description: xxx
 * type: user
 * createdAt: 2026-04-30T12:00:00.000Z
 * updatedAt: 2026-04-30T12:00:00.000Z
 * ---
 * body content here
 */
export function serializeMemory(entry: MemoryEntry): string {
  const lines = [
    "---",
    `name: ${entry.meta.name}`,
    `description: ${entry.meta.description}`,
    `type: ${entry.meta.type}`,
    `createdAt: ${entry.meta.createdAt}`,
    `updatedAt: ${entry.meta.updatedAt}`,
    "---",
    entry.body,
  ];
  return lines.join("\n");
}

/**
 * parseMemoryFile — 解析单个 memory 文件
 *
 * 复用 skills.ts 的 parseFrontmatter() 解析 frontmatter，
 * 然后校验必填字段和 type 合法性。
 * 无效文件返回 null 并记录 warn 日志。
 */
export function parseMemoryFile(
  content: string,
  fileName: string,
  logger: Logger,
): MemoryEntry | null {
  // 复用 skills.ts 的通用 frontmatter 解析器分离 meta 和 body
  const parsed = parseFrontmatter(content);
  if (!parsed) {
    // frontmatter 格式不合法，无法解析，记录警告后跳过
    logger.warn("Memory file %s: invalid frontmatter format", fileName);
    return null;
  }

  // 校验必填字段：遍历 REQUIRED_FIELDS，任何一项缺失都视为无效文件
  for (const field of REQUIRED_FIELDS) {
    if (!parsed.meta[field]) {
      logger.warn(
        "Memory file %s: missing required field '%s'",
        fileName,
        field,
      );
      return null;
    }
  }

  // 校验 type 合法性：必须是四种预定义类型之一
  const type = parsed.meta["type"]!;
  if (!isValidType(type)) {
    logger.warn("Memory file %s: invalid type '%s'", fileName, type);
    return null;
  }

  // 校验 frontmatter 字段不含换行（parser 只支持单行 key: value）
  const name = parsed.meta["name"]!;
  const description = parsed.meta["description"]!;
  if (name.includes("\n") || description.includes("\n")) {
    logger.warn(
      "Memory file %s: frontmatter fields must not contain line breaks",
      fileName,
    );
    return null;
  }

  // 所有校验通过，组装并返回 MemoryEntry
  return {
    meta: {
      name,
      description,
      type: type as MemoryType,
      createdAt: parsed.meta["createdAt"]!,
      updatedAt: parsed.meta["updatedAt"]!,
    },
    body: parsed.body,
  };
}

/**
 * buildIndexContent — 生成 MEMORY.md 索引内容
 *
 * 格式：
 * - [type] name: description
 */
function buildIndexContent(entries: MemoryEntry[]): string {
  const header = "# Memory Index\n";
  const lines = entries.map(
    (e) => `- [${e.meta.type}] ${e.meta.name}: ${e.meta.description}`,
  );
  return header + "\n" + lines.join("\n") + "\n";
}

/**
 * getStableSortKey — 返回用于稳定排序的 key
 *
 * 先按 type 排序，再按 name 排序，保证输出顺序一致。
 */
function getStableSortKey(entry: MemoryEntry): string {
  return `${entry.meta.type}:${entry.meta.name}`;
}

/**
 * normalizeForSimilarity — 将文本转成适合粗略比较的形式
 *
 * 这是教学版相似度算法，不做 embedding 或向量数据库：
 * - 英文统一小写
 * - 标点符号变成空格
 * - 连续空白压缩
 *
 * 目标不是精确语义匹配，而是在创建 memory 前拦住明显重复项。
 */
function normalizeForSimilarity(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * tokenizeForSimilarity — 提取粗粒度 token
 *
 * 只保留长度 >= 2 的 token，避免 "a"、"I" 之类短词让相似度虚高。
 */
function tokenizeForSimilarity(text: string): Set<string> {
  return new Set(
    normalizeForSimilarity(text)
      .split(" ")
      .filter((token) => token.length >= 2),
  );
}

/**
 * calculateTokenOverlap — 计算两个 token 集合的 Jaccard 相似度
 *
 * Jaccard = 交集大小 / 并集大小。
 * 它非常容易讲清楚，适合教学版去重逻辑。
 */
function calculateTokenOverlap(a: Set<string>, b: Set<string>): number {
  // 任一空集之间无重叠
  if (a.size === 0 || b.size === 0) {
    return 0;
  }

  // 遍历较小集合的 token，统计同时出现在另一个集合中的数量
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection++;
    }
  }

  // 并集 = A + B - 交集，最后计算 Jaccard 系数
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * buildSimilarityText — 拼出用于相似度比较的文本
 *
 * description 是最重要的摘要，body 提供补充语义，type 用来降低跨类型误判。
 */
function buildSimilarityText(input: {
  description: string;
  body: string;
  type: MemoryType;
}): string {
  return `${input.type} ${input.description} ${input.body}`;
}

// ============================================================================
// 工厂函数
// ============================================================================

/**
 * createMemoryManager — 创建 MemoryManager 实例
 *
 * @param options.memoryDir - memory 文件目录的绝对路径
 * @param options.logger - 日志器
 * @returns MemoryManager 接口的实现
 */
export function createMemoryManager(options: {
  memoryDir: string;
  logger: Logger;
}): MemoryManager {
  const { memoryDir, logger } = options;

  /** 内部缓存的 memory 条目列表 */
  let cachedEntries: MemoryEntry[] = [];

  /**
   * scan — 从磁盘读取所有 memory 文件
   *
   * 读取 memoryDir 下所有 .md 文件（跳过 MEMORY.md），
   * 解析 frontmatter 并校验必填字段，跳过无效文件。
   * 目录不存在时自动创建。
   */
  function scan(): MemoryEntry[] {
    // 每次扫描前清空缓存，确保结果反映磁盘最新状态
    cachedEntries = [];

    // 目录不存在时自动创建（mkdirSync + recursive 等价于 mkdir -p）
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
      return cachedEntries;
    }

    // 读取目录下所有文件和子目录的 Dirent 信息
    let files: fs.Dirent[];
    try {
      files = fs.readdirSync(memoryDir, { withFileTypes: true });
    } catch {
      // 目录读取失败（如权限不足），记录警告并返回空列表
      logger.warn("Failed to read memory directory: %s", memoryDir);
      return cachedEntries;
    }

    // 逐个遍历目录中的文件
    for (const dirent of files) {
      // 只处理 .md 文件，跳过子目录和其他类型文件
      if (!dirent.isFile() || !dirent.name.endsWith(".md")) {
        continue;
      }
      // 跳过自动生成的索引文件，避免把索引当数据解析
      if (dirent.name === INDEX_FILE) {
        continue;
      }

      const filePath = path.join(memoryDir, dirent.name);
      try {
        // 读取文件内容并解析 frontmatter
        const content = fs.readFileSync(filePath, "utf-8");
        const entry = parseMemoryFile(content, dirent.name, logger);
        if (entry) {
          // 校验 frontmatter name 的安全格式（防止恶意或损坏数据）
          if (!isValidName(entry.meta.name)) {
            logger.warn(
              "Memory file %s: name '%s' does not match required format, skipping",
              dirent.name,
              entry.meta.name,
            );
            continue;
          }
          // 校验 frontmatter name 和文件名一致（文件名 = `${name}.md`）
          const expectedFileName = `${entry.meta.name}.md`;
          if (dirent.name !== expectedFileName) {
            logger.warn(
              "Memory file %s: frontmatter name '%s' does not match file name, skipping",
              dirent.name,
              entry.meta.name,
            );
            continue;
          }
          // 通过所有校验，加入缓存
          cachedEntries.push(entry);
        }
      } catch (err) {
        // 单个文件读取或解析失败，记录警告但不中断整个扫描流程
        logger.warn(
          "Failed to read memory file %s: %s",
          dirent.name,
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    // 稳定排序：先按 type，再按 name，保证输出顺序一致且可预测
    cachedEntries.sort((a, b) =>
      getStableSortKey(a).localeCompare(getStableSortKey(b)),
    );

    return cachedEntries;
  }

  /**
   * list — 获取按 type、name 稳定排序的 meta 列表
   */
  function list(): MemoryMeta[] {
    return cachedEntries.map((e) => e.meta);
  }

  /**
   * read — 读取单条 memory 的完整内容
   *
   * @returns 完整的 MemoryEntry，找不到或 name 非法时返回 null
   */
  function read(name: string): MemoryEntry | null {
    // 先校验 name 格式，防止路径穿越攻击
    if (!isValidName(name)) {
      return null;
    }

    // 优先从内存缓存中查找，避免不必要的磁盘 I/O
    const cached = cachedEntries.find((e) => e.meta.name === name);
    if (cached) {
      return cached;
    }

    // 缓存中没有，尝试从磁盘读取（可能是 scan 未覆盖的最新状态）
    const filePath = path.join(memoryDir, `${name}.md`);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      return parseMemoryFile(content, `${name}.md`, logger);
    } catch {
      // 磁盘读取失败时静默返回 null，由调用方处理
      return null;
    }
  }

  /**
   * create — 创建或更新一条 memory
   *
   * 校验 name 格式和 type 合法性后写入文件。
   * 如果同名 memory 已存在，保留原 createdAt，更新 updatedAt。
   * 写入后自动重建索引。
   */
  function create(input: CreateMemoryInput): MemoryEntry {
    // 校验 name 格式，防止非法字符和路径穿越
    if (!isValidName(input.name)) {
      throw new Error(
        `Invalid memory name: "${input.name}". Only lowercase letters, numbers, underscores, and hyphens are allowed.`,
      );
    }

    // 校验 type 是否属于预定义四种类型之一
    if (!isValidType(input.type)) {
      throw new Error(
        `Invalid memory type: "${input.type}". Must be one of: user, feedback, project, reference.`,
      );
    }

    // 校验 frontmatter 字段不含换行（parser 只支持 key: value 单行格式）
    if (input.description.includes("\n")) {
      throw new Error("Memory description must not contain line breaks.");
    }

    const now = new Date().toISOString();
    const filePath = path.join(memoryDir, `${input.name}.md`);

    // 检查是否已存在同名 memory，保留原 createdAt 以维持时间线
    let createdAt = now;
    if (fs.existsSync(filePath)) {
      try {
        const existing = fs.readFileSync(filePath, "utf-8");
        const parsed = parseMemoryFile(existing, `${input.name}.md`, logger);
        if (parsed) {
          // 复用旧记录的创建时间
          createdAt = parsed.meta.createdAt;
        }
      } catch {
        // 读取旧文件失败时使用当前时间作为创建时间
      }
    }

    const entry: MemoryEntry = {
      meta: {
        name: input.name,
        description: input.description,
        type: input.type,
        createdAt,
        updatedAt: now,
      },
      body: input.body,
    };

    // 确保 memory 目录存在（可能被手动删除或首次使用）
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    // 将 entry 序列化为 Markdown 并写入磁盘
    fs.writeFileSync(filePath, serializeMemory(entry), "utf-8");

    // 重建索引并刷新缓存，使新数据立即对外可见
    scan();
    rebuildIndex();

    return entry;
  }

  /**
   * findSimilar — 查找可能重复或相近的 memory
   *
   * 教学版只做三类简单检查：
   * 1. name 完全相同：这是更新，不算重复候选。
   * 2. description 完全相同：高度疑似重复。
   * 3. description + body token overlap 较高：可能是换了名字的相同记忆。
   *
   * 这个函数不自动删除任何内容，只给调用方提示，让 LLM 复用旧 name、
   * 询问用户是否删除旧 memory，或在用户明确要求时允许保留重复。
   */
  function findSimilar(input: CreateMemoryInput): MemorySimilarity[] {
    // 预处理输入描述，用于精确比对
    const inputDescription = normalizeForSimilarity(input.description);
    // 拼接 type + description + body 作为相似度比较的完整文本
    const inputText = buildSimilarityText(input);
    // 将输入文本拆分为 token 集合，供 Jaccard 计算使用
    const inputTokens = tokenizeForSimilarity(inputText);
    const similarities: MemorySimilarity[] = [];

    // 遍历所有已缓存的 memory 条目
    for (const existing of cachedEntries) {
      // 同名是有意更新，不作为重复阻塞项
      if (existing.meta.name === input.name) {
        continue;
      }

      // 第一层检查：规范化后的 description 完全相同，属于高度疑似重复
      const existingDescription = normalizeForSimilarity(
        existing.meta.description,
      );
      if (existingDescription === inputDescription) {
        similarities.push({
          entry: existing,
          reason: "same description",
        });
        continue;
      }

      // 第二层检查：计算 token 集合的 Jaccard 相似度
      const existingText = buildSimilarityText({
        description: existing.meta.description,
        body: existing.body,
        type: existing.meta.type,
      });
      const existingTokens = tokenizeForSimilarity(existingText);
      const overlap = calculateTokenOverlap(inputTokens, existingTokens);

      // 阈值故意偏高：只拦明显重复，减少误伤相似但不同的长期记忆
      if (overlap >= 0.55) {
        similarities.push({
          entry: existing,
          reason: `high token overlap (${overlap.toFixed(2)})`,
        });
      }
    }

    return similarities;
  }

  /**
   * delete — 删除一条 memory
   *
   * 删除对应的 .md 文件后重建索引。
   *
   * @returns 是否成功删除
   */
  function delete_(name: string): boolean {
    // 先校验 name 格式，防止路径穿越
    if (!isValidName(name)) {
      return false;
    }

    const filePath = path.join(memoryDir, `${name}.md`);
    // 文件不存在则无需删除
    if (!fs.existsSync(filePath)) {
      return false;
    }

    try {
      // 删除对应的 .md 文件
      fs.unlinkSync(filePath);
    } catch {
      // 删除失败（如权限不足）返回 false
      return false;
    }

    // 删除成功后刷新缓存并重建索引，保持数据一致性
    scan();
    rebuildIndex();

    return true;
  }

  /**
   * buildPromptSection — 生成注入 system prompt 的短文本
   *
   * 默认只注入 description（不注入完整正文），控制上下文长度。
   * LLM 需要完整内容时可以调用 run_memory_read。
   * 没有 memory 时返回 null。
   */
  function buildPromptSection(): string | null {
    // 没有任何记忆时返回 null，避免向 system prompt 注入空内容
    if (cachedEntries.length === 0) {
      return null;
    }

    // 为每条 memory 生成一行摘要，格式为 "- [type] name: description"
    const lines = cachedEntries.map(
      (e) => `- [${e.meta.type}] ${e.meta.name}: ${e.meta.description}`,
    );

    // 拼接完整 prompt 文本，包含免责声明提醒 LLM 不要过度信任旧记忆
    return [
      "Long-term memory:",
      ...lines,
      "",
      "Use memory as a hint, not as proof. If memory conflicts with current files or observed facts, trust the current observation.",
    ].join("\n");
  }

  /**
   * rebuildIndex — 重建 MEMORY.md 索引
   *
   * 索引是派生数据，每次 create/delete 后自动重建。
   * 如果索引丢失，可以通过 scan() + rebuildIndex() 恢复。
   */
  function rebuildIndex(): void {
    const indexPath = path.join(memoryDir, INDEX_FILE);
    // 根据当前缓存的所有 entry 生成索引文本
    const content = buildIndexContent(cachedEntries);

    // 确保目录存在后再写入索引文件
    if (!fs.existsSync(memoryDir)) {
      fs.mkdirSync(memoryDir, { recursive: true });
    }

    // 将索引内容写入 MEMORY.md，供人类快速浏览
    fs.writeFileSync(indexPath, content, "utf-8");
  }

  return {
    scan,
    list,
    read,
    create,
    findSimilar,
    delete: delete_,
    buildPromptSection,
    rebuildIndex,
    getMemoryDir: () => memoryDir,
  };
}
