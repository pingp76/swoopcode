/**
 * skills.test.ts — Skill 系统测试
 *
 * 覆盖范围：
 * - parseFrontmatter：YAML frontmatter 解析（3 个测试）
 * - createSkillManager.scan()：目录扫描（4 个测试）
 * - createSkillManager.invoke()：skill 触发（3 个测试）
 * - createSkillManager.remove()：skill 删除（2 个测试）
 *
 * 使用 mkdtempSync 创建临时目录作为 skills/ 目录，
 * afterEach 自动清理，不影响真实文件系统。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseFrontmatter,
  createSkillManager,
  createSkillToolProvider,
  buildSkillToolDescription,
  SKILL_SYSTEM_PROMPT_HINT,
} from "./skills.js";

// ============================================================
// parseFrontmatter 测试
// ============================================================

describe("parseFrontmatter", () => {
  it("应该正确解析合法的 frontmatter", () => {
    const content = `---
name: code-review
description: Review code for quality issues.
---

# Code Review Skill

Use run_read to read files.
`;

    const result = parseFrontmatter(content);

    expect(result).not.toBeNull();
    expect(result!.meta["name"]).toBe("code-review");
    expect(result!.meta["description"]).toBe("Review code for quality issues.");
    expect(result!.body).toBe("# Code Review Skill\n\nUse run_read to read files.\n");
  });

  it("没有 --- 分隔符时应返回 null", () => {
    const content = `name: code-review
description: Some description.

# Body content
`;

    const result = parseFrontmatter(content);
    expect(result).toBeNull();
  });

  it("只有第二个 --- 时应返回 null", () => {
    const content = `name: code-review
---

# Body content
`;

    const result = parseFrontmatter(content);
    expect(result).toBeNull();
  });

  it("应该忽略注释行和空行", () => {
    const content = `---
# 这是注释
name: test-skill

description: A test skill.
---

Body here.
`;

    const result = parseFrontmatter(content);

    expect(result).not.toBeNull();
    expect(result!.meta["name"]).toBe("test-skill");
    expect(result!.meta["description"]).toBe("A test skill.");
    expect(result!.body).toBe("Body here.\n");
  });

  it("应该正确处理 value 中包含冒号的情况", () => {
    const content = `---
name: my-skill
description: Use this when: code review is needed.
---

Body.
`;

    const result = parseFrontmatter(content);

    expect(result).not.toBeNull();
    expect(result!.meta["description"]).toBe("Use this when: code review is needed.");
  });
});

// ============================================================
// createSkillManager 测试
// ============================================================

describe("createSkillManager", () => {
  let tempDir: string;

  beforeEach(() => {
    // 创建临时目录作为 skills 根目录
    tempDir = mkdtempSync(join(tmpdir(), "skills-test-"));
  });

  afterEach(() => {
    // 清理临时目录
    rmSync(tempDir, { recursive: true, force: true });
  });

  // 辅助函数：在临时目录下创建一个 skill
  function createSkill(name: string, description: string, body: string): string {
    const skillDir = join(tempDir, name);
    mkdirSync(skillDir, { recursive: true });
    const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`;
    writeFileSync(join(skillDir, "SKILL.md"), content, "utf-8");
    return skillDir;
  }

  // --- scan() 测试 ---

  describe("scan", () => {
    it("应该扫描到有效的 skill 目录", () => {
      createSkill("code-review", "Review code quality.", "# Code Review");
      createSkill("explain-code", "Explain code.", "# Explain");

      const manager = createSkillManager(tempDir);
      manager.scan();

      const metas = manager.listMeta();
      expect(metas).toHaveLength(2);
      expect(metas.map((m) => m.name)).toContain("code-review");
      expect(metas.map((m) => m.name)).toContain("explain-code");
    });

    it("目录不存在时应返回空列表", () => {
      const manager = createSkillManager(join(tempDir, "nonexistent"));
      manager.scan();

      expect(manager.listMeta()).toEqual([]);
    });

    it("空目录时应返回空列表", () => {
      const manager = createSkillManager(tempDir);
      manager.scan();

      expect(manager.listMeta()).toEqual([]);
    });

    it("应该跳过无效的 SKILL.md（缺少必填字段）", () => {
      // 创建有效的 skill
      createSkill("valid-skill", "A valid skill.", "# Valid");

      // 创建无效的 skill（只有 name，没有 description）
      const invalidDir = join(tempDir, "invalid-skill");
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(
        join(invalidDir, "SKILL.md"),
        "---\nname: invalid-skill\n---\n\nBody",
        "utf-8",
      );

      // 创建无效的 skill（没有 frontmatter）
      const noFrontDir = join(tempDir, "no-frontmatter");
      mkdirSync(noFrontDir, { recursive: true });
      writeFileSync(join(noFrontDir, "SKILL.md"), "Just some text", "utf-8");

      const manager = createSkillManager(tempDir);
      manager.scan();

      const metas = manager.listMeta();
      expect(metas).toHaveLength(1);
      expect(metas[0]!.name).toBe("valid-skill");
    });

    it("重新扫描时应替换旧缓存", () => {
      createSkill("skill-a", "Skill A.", "# A");

      const manager = createSkillManager(tempDir);
      manager.scan();
      expect(manager.listMeta()).toHaveLength(1);

      // 新增一个 skill
      createSkill("skill-b", "Skill B.", "# B");

      // 重新扫描
      manager.scan();
      const metas = manager.listMeta();
      expect(metas).toHaveLength(2);
      expect(metas.map((m) => m.name)).toContain("skill-a");
      expect(metas.map((m) => m.name)).toContain("skill-b");
    });

    it("应该跳过文件（非目录）", () => {
      // 在 skills 根目录下创建一个文件（不是目录）
      writeFileSync(join(tempDir, "not-a-dir.txt"), "some content", "utf-8");

      // 创建一个有效的 skill
      createSkill("valid-skill", "A valid skill.", "# Valid");

      const manager = createSkillManager(tempDir);
      manager.scan();

      expect(manager.listMeta()).toHaveLength(1);
    });

    it("应该跳过没有 SKILL.md 的目录", () => {
      // 创建一个没有 SKILL.md 的目录
      mkdirSync(join(tempDir, "empty-dir"), { recursive: true });

      // 创建一个有效的 skill
      createSkill("valid-skill", "A valid skill.", "# Valid");

      const manager = createSkillManager(tempDir);
      manager.scan();

      expect(manager.listMeta()).toHaveLength(1);
    });
  });

  // --- invoke() 测试 ---

  describe("invoke", () => {
    it("应该返回 base path + body 内容", () => {
      const skillDir = createSkill(
        "code-review",
        "Review code.",
        "# Code Review\n\nUse run_read.",
      );

      const manager = createSkillManager(tempDir);
      manager.scan();

      const result = manager.invoke("code-review");

      expect(result).toContain(`Base Path: ${skillDir}`);
      expect(result).toContain("# Code Review");
      expect(result).toContain("Use run_read.");
    });

    it("skill 不存在时应返回错误字符串", () => {
      const manager = createSkillManager(tempDir);
      manager.scan();

      const result = manager.invoke("nonexistent");

      expect(result).toContain("[Skill Error]");
      expect(result).toContain("nonexistent");
    });

    it("body 不应包含 frontmatter", () => {
      createSkill("test-skill", "A test.", "# Body Title\n\nBody paragraph.");

      const manager = createSkillManager(tempDir);
      manager.scan();

      const result = manager.invoke("test-skill");

      // body 部分不应包含 frontmatter 的字段
      expect(result).not.toContain("name: test-skill");
      expect(result).not.toContain("description: A test.");
      // 但应包含 body 内容
      expect(result).toContain("# Body Title");
    });
  });

  // --- remove() 测试 ---

  describe("remove", () => {
    it("应该删除 skill 目录并从缓存移除", () => {
      const skillDir = createSkill("to-remove", "Will be removed.", "# Remove");

      const manager = createSkillManager(tempDir);
      manager.scan();
      expect(manager.listMeta()).toHaveLength(1);

      const result = manager.remove("to-remove");

      expect(result).toBe(true);
      expect(manager.listMeta()).toHaveLength(0);
      // 目录应该已被删除
      expect(existsSync(skillDir)).toBe(false);
    });

    it("删除不存在的 skill 应返回 false", () => {
      const manager = createSkillManager(tempDir);
      manager.scan();

      const result = manager.remove("nonexistent");

      expect(result).toBe(false);
    });
  });
});

// ============================================================
// buildSkillToolDescription 测试
// ============================================================

describe("buildSkillToolDescription", () => {
  it("没有 skill 时应返回最小描述", () => {
    const desc = buildSkillToolDescription([]);

    expect(desc).toContain("No skills are currently available");
  });

  it("有 skill 时应包含完整段落", () => {
    const metas = [
      { name: "code-review", description: "Review code for issues." },
      { name: "explain-code", description: "Explain code in detail." },
    ];

    const desc = buildSkillToolDescription(metas);

    // 应包含四个段落
    expect(desc).toContain("Available skills:");
    expect(desc).toContain("When to use:");
    expect(desc).toContain("What happens:");
    expect(desc).toContain("Examples:");
    // 应包含每个 skill
    expect(desc).toContain("code-review");
    expect(desc).toContain("explain-code");
  });
});

// ============================================================
// createSkillToolProvider 测试
// ============================================================

describe("createSkillToolProvider", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "skills-provider-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("应该提供 run_skill 工具定义和执行函数", () => {
    const manager = createSkillManager(tempDir);
    manager.scan();

    const provider = createSkillToolProvider(manager);

    expect(provider.toolEntries).toHaveLength(1);
    expect(provider.toolEntries[0]!.definition.function?.name).toBe("run_skill");
    expect(typeof provider.toolEntries[0]!.execute).toBe("function");
  });

  it("执行时应该返回 skill 的 body + base path", async () => {
    const skillDir = join(tempDir, "test-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: test-skill\ndescription: A test.\n---\n\n# Test Body",
      "utf-8",
    );

    const manager = createSkillManager(tempDir);
    manager.scan();
    const provider = createSkillToolProvider(manager);

    const result = await provider.toolEntries[0]!.execute({ name: "test-skill" });

    expect(result.error).toBe(false);
    expect(result.output).toContain("Base Path:");
    expect(result.output).toContain("# Test Body");
  });

  it("skill 不存在时应返回错误 ToolResult", async () => {
    const manager = createSkillManager(tempDir);
    manager.scan();
    const provider = createSkillToolProvider(manager);

    const result = await provider.toolEntries[0]!.execute({ name: "nonexistent" });

    expect(result.error).toBe(true);
    expect(result.output).toContain("[Skill Error]");
  });

  it("name 参数为空时应返回错误", async () => {
    const manager = createSkillManager(tempDir);
    manager.scan();
    const provider = createSkillToolProvider(manager);

    const result = await provider.toolEntries[0]!.execute({ name: "" });

    expect(result.error).toBe(true);
    expect(result.output).toContain("required");
  });
});

// ============================================================
// SKILL_SYSTEM_PROMPT_HINT 测试
// ============================================================

describe("SKILL_SYSTEM_PROMPT_HINT", () => {
  it("应该是一个非空字符串", () => {
    expect(typeof SKILL_SYSTEM_PROMPT_HINT).toBe("string");
    expect(SKILL_SYSTEM_PROMPT_HINT.length).toBeGreaterThan(0);
  });

  it("应该提到 run_skill 工具", () => {
    expect(SKILL_SYSTEM_PROMPT_HINT).toContain("run_skill");
  });
});
