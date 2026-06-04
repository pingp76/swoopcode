/**
 * context-ranking.test.ts — 通用内容重要性排序测试
 *
 * 测试覆盖：
 * - 文件角色识别（跨生态）
 * - Repo 分类（typescript/python/rust/go/docs/infra/mixed）
 * - 任务意图分类
 * - 多维度评分
 * - 确定性排序
 * - 安全边界（secret/binary/forbidden 排除）
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  createContextRanker,
  identifyFileRoles,
  identifyFileEcosystems,
  classifyRepository,
  classifyTaskIntent,
  computeRoleScore,
  computeEcosystemScore,
  computeTaskRelevanceScore,
  computeEvidenceScore,
  rankAllFiles,
  scanProjectFiles,
  buildImportGraph,
  type FileFacts,
  type RepoClassification,
  type TaskContext,
} from "./context-ranking.js";

// ---------------------------------------------------------------------------
// 辅助函数
// ---------------------------------------------------------------------------

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ctx-rank-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function writeFile(dir: string, relativePath: string, content: string): void {
  const fullPath = path.join(dir, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content);
}

function makeFacts(overrides: Partial<FileFacts> & { path: string }): FileFacts {
  return {
    name: path.basename(overrides.path),
    extension: path.extname(overrides.path),
    sizeBytes: 100,
    roles: overrides.roles ?? ["source"],
    ecosystems: overrides.ecosystems ?? [],
    imports: [],
    importedBy: [],
    pairedFiles: [],
    ...overrides,
  };
}

function makeEmptyTask(overrides?: Partial<TaskContext>): TaskContext {
  return {
    query: "",
    intent: "unknown",
    explicitlyMentionedPaths: [],
    explicitlyMentionedTerms: [],
    recentFiles: [],
    openFiles: [],
    changedFiles: [],
    failingFiles: [],
    stackTraceFiles: [],
    ...overrides,
  };
}

function makeEmptyRepo(overrides?: Partial<RepoClassification>): RepoClassification {
  return {
    primary: "unknown",
    all: [],
    confidence: 0,
    reasons: [],
    roots: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 文件角色识别
// ---------------------------------------------------------------------------

describe("identifyFileRoles", () => {
  it("identifies AGENTS.md as project_instruction", () => {
    expect(identifyFileRoles("AGENTS.md", "AGENTS.md")).toContain("project_instruction");
  });

  it("identifies README.md as readme", () => {
    expect(identifyFileRoles("README.md", "README.md")).toContain("readme");
  });

  it("identifies doc/summary.md as project_summary", () => {
    expect(identifyFileRoles("doc/summary.md", "summary.md")).toContain("project_summary");
  });

  it("identifies package.json as manifest", () => {
    expect(identifyFileRoles("package.json", "package.json")).toContain("manifest");
  });

  it("identifies Cargo.toml as manifest", () => {
    expect(identifyFileRoles("Cargo.toml", "Cargo.toml")).toContain("manifest");
  });

  it("identifies pyproject.toml as manifest", () => {
    expect(identifyFileRoles("pyproject.toml", "pyproject.toml")).toContain("manifest");
  });

  it("identifies go.mod as manifest", () => {
    expect(identifyFileRoles("go.mod", "go.mod")).toContain("manifest");
  });

  it("identifies tsconfig.json as build_config", () => {
    const roles = identifyFileRoles("tsconfig.json", "tsconfig.json");
    expect(roles).toContain("build_config");
  });

  it("identifies src/index.ts as entrypoint", () => {
    expect(identifyFileRoles("src/index.ts", "index.ts")).toContain("entrypoint");
  });

  it("identifies *.test.ts as test", () => {
    expect(identifyFileRoles("src/foo.test.ts", "foo.test.ts")).toContain("test");
  });

  it("identifies test_*.py as test", () => {
    expect(identifyFileRoles("tests/test_main.py", "test_main.py")).toContain("test");
  });

  it("identifies *_test.go as test", () => {
    expect(identifyFileRoles("main_test.go", "main_test.go")).toContain("test");
  });

  it("identifies Dockerfile as infra", () => {
    expect(identifyFileRoles("Dockerfile", "Dockerfile")).toContain("infra");
  });

  it("identifies .github/workflows/*.yml as ci_config", () => {
    expect(identifyFileRoles(".github/workflows/ci.yml", "ci.yml")).toContain("ci_config");
  });

  it("identifies openapi.yaml as schema", () => {
    expect(identifyFileRoles("openapi.yaml", "openapi.yaml")).toContain("schema");
  });

  it("identifies .env as secret", () => {
    expect(identifyFileRoles(".env", ".env")).toContain("secret");
  });

  it("does not identify doc/todo.md as design_doc", () => {
    const roles = identifyFileRoles("doc/todo.md", "todo.md");
    expect(roles).not.toContain("design_doc");
  });
});

// ---------------------------------------------------------------------------
// 文件生态识别
// ---------------------------------------------------------------------------

describe("identifyFileEcosystems", () => {
  it("identifies .ts as typescript", () => {
    expect(identifyFileEcosystems("foo.ts", ".ts")).toContain("typescript");
  });

  it("identifies .py as python", () => {
    expect(identifyFileEcosystems("foo.py", ".py")).toContain("python");
  });

  it("identifies .rs as rust", () => {
    expect(identifyFileEcosystems("foo.rs", ".rs")).toContain("rust");
  });

  it("identifies .go as go", () => {
    expect(identifyFileEcosystems("foo.go", ".go")).toContain("go");
  });

  it("identifies .java as java", () => {
    expect(identifyFileEcosystems("Foo.java", ".java")).toContain("java");
  });
});

// ---------------------------------------------------------------------------
// Repo 分类
// ---------------------------------------------------------------------------

describe("classifyRepository", () => {
  it("classifies typescript project", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "package.json", roles: ["manifest"], ecosystems: ["typescript"] }),
      makeFacts({ path: "tsconfig.json", roles: ["build_config"], ecosystems: ["typescript"] }),
      makeFacts({ path: "src/index.ts", roles: ["entrypoint", "source"], ecosystems: ["typescript"] }),
      makeFacts({ path: "src/agent.ts", roles: ["source"], ecosystems: ["typescript"] }),
      makeFacts({ path: "src/agent.test.ts", roles: ["test"], ecosystems: ["typescript"] }),
    ];
    const result = classifyRepository(files);
    expect(result.primary).toBe("typescript");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("classifies python project", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "pyproject.toml", roles: ["manifest"], ecosystems: ["python"] }),
      makeFacts({ path: "requirements.txt", roles: ["manifest"], ecosystems: ["python"] }),
      makeFacts({ path: "app.py", roles: ["source"], ecosystems: ["python"] }),
      makeFacts({ path: "tests/test_app.py", roles: ["test"], ecosystems: ["python"] }),
    ];
    const result = classifyRepository(files);
    expect(result.primary).toBe("python");
  });

  it("classifies rust project", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "Cargo.toml", roles: ["manifest"], ecosystems: ["rust"] }),
      makeFacts({ path: "src/main.rs", roles: ["entrypoint", "source"], ecosystems: ["rust"] }),
      makeFacts({ path: "src/lib.rs", roles: ["source"], ecosystems: ["rust"] }),
    ];
    const result = classifyRepository(files);
    expect(result.primary).toBe("rust");
  });

  it("classifies go project", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "go.mod", roles: ["manifest"], ecosystems: ["go"] }),
      makeFacts({ path: "main.go", roles: ["entrypoint", "source"], ecosystems: ["go"] }),
      makeFacts({ path: "main_test.go", roles: ["test"], ecosystems: ["go"] }),
    ];
    const result = classifyRepository(files);
    expect(result.primary).toBe("go");
  });

  it("classifies java project with deep directory patterns", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "pom.xml", roles: ["manifest"], ecosystems: ["java"] }),
      makeFacts({ path: "src/main/java/com/example/App.java", roles: ["source"], ecosystems: ["java"] }),
      makeFacts({ path: "src/main/java/com/example/Service.java", roles: ["source"], ecosystems: ["java"] }),
      makeFacts({ path: "src/test/java/com/example/AppTest.java", roles: ["test"], ecosystems: ["java"] }),
    ];
    const result = classifyRepository(files);
    expect(result.primary).toBe("java");
    expect(result.confidence).toBeGreaterThan(0);
  });

  it("classifies docs-only project", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "README.md", roles: ["readme"] }),
      makeFacts({ path: "docs/guide.md", roles: ["design_doc"] }),
      makeFacts({ path: "docs/api.md", roles: ["design_doc"] }),
      makeFacts({ path: "docs/faq.md", roles: ["design_doc"] }),
    ];
    const result = classifyRepository(files);
    expect(result.primary).toBe("docs");
  });

  it("classifies infra project", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "Dockerfile", roles: ["infra"] }),
      makeFacts({ path: "compose.yaml", roles: ["infra"] }),
      makeFacts({ path: "main.tf", roles: ["infra"] }),
      makeFacts({ path: ".github/workflows/deploy.yml", roles: ["ci_config"] }),
    ];
    const result = classifyRepository(files);
    expect(result.primary).toBe("infra");
  });

  it("classifies mixed monorepo", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "frontend/package.json", roles: ["manifest"], ecosystems: ["typescript"] }),
      makeFacts({ path: "frontend/tsconfig.json", roles: ["build_config"], ecosystems: ["typescript"] }),
      makeFacts({ path: "frontend/src/index.ts", roles: ["entrypoint"], ecosystems: ["typescript"] }),
      makeFacts({ path: "frontend/src/app.ts", roles: ["source"], ecosystems: ["typescript"] }),
      makeFacts({ path: "backend/pyproject.toml", roles: ["manifest"], ecosystems: ["python"] }),
      makeFacts({ path: "backend/requirements.txt", roles: ["manifest"], ecosystems: ["python"] }),
      makeFacts({ path: "backend/app.py", roles: ["source"], ecosystems: ["python"] }),
      makeFacts({ path: "backend/main.py", roles: ["source"], ecosystems: ["python"] }),
    ];
    const result = classifyRepository(files);
    expect(result.primary).toBe("mixed");
    expect(result.all).toContain("typescript");
    expect(result.all).toContain("python");
    expect(result.roots).toContain("frontend");
    expect(result.roots).toContain("backend");
  });

  it("returns unknown for empty project", () => {
    const result = classifyRepository([]);
    expect(result.primary).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 任务意图分类
// ---------------------------------------------------------------------------

describe("classifyTaskIntent", () => {
  it("classifies orientation intent", () => {
    const result = classifyTaskIntent({
      query: "解释这个项目的架构",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    expect(result.intent).toBe("orientation");
  });

  it("classifies implementation intent", () => {
    const result = classifyTaskIntent({
      query: "实现一个新的排序功能",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    expect(result.intent).toBe("implementation");
  });

  it("classifies debug intent", () => {
    const result = classifyTaskIntent({
      query: "修复这个 error",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    expect(result.intent).toBe("debug");
  });

  it("classifies debug intent from failing files", () => {
    const result = classifyTaskIntent({
      query: "看看这个",
      recentFiles: [], openFiles: [], changedFiles: [],
      failingFiles: ["src/foo.test.ts"], stackTraceFiles: [],
    });
    expect(result.intent).toBe("debug");
  });

  it("classifies review intent", () => {
    const result = classifyTaskIntent({
      query: "review 一下这段代码",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    expect(result.intent).toBe("review");
  });

  it("classifies testing intent", () => {
    const result = classifyTaskIntent({
      query: "补测试",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    expect(result.intent).toBe("testing");
  });

  it("classifies documentation intent", () => {
    const result = classifyTaskIntent({
      query: "更新 README 文档",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    expect(result.intent).toBe("documentation");
  });

  it("classifies refactor intent", () => {
    const result = classifyTaskIntent({
      query: "重构这个模块",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    expect(result.intent).toBe("refactor");
  });

  it("extracts mentioned paths", () => {
    const result = classifyTaskIntent({
      query: "看看 src/foo.ts 这个文件",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    expect(result.explicitlyMentionedPaths).toContain("src/foo.ts");
  });

  it("extracts design doc IDs", () => {
    const result = classifyTaskIntent({
      query: "按照 pdd21-1 实现",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    expect(result.explicitlyMentionedTerms).toContain("pdd21-1");
  });

  it("returns unknown for empty query", () => {
    const result = classifyTaskIntent({
      query: "",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    expect(result.intent).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// 评分
// ---------------------------------------------------------------------------

describe("computeRoleScore", () => {
  it("gives high score to project_summary", () => {
    const facts = makeFacts({ path: "doc/summary.md", roles: ["project_summary"] });
    expect(computeRoleScore(facts).score).toBe(420);
  });

  it("gives high score to readme", () => {
    const facts = makeFacts({ path: "README.md", roles: ["readme"] });
    expect(computeRoleScore(facts).score).toBe(380);
  });

  it("gives negative score to generated", () => {
    const facts = makeFacts({ path: "dist/bundle.js", roles: ["generated"] });
    expect(computeRoleScore(facts).score).toBeLessThan(0);
  });

  it("gives very negative score to secret", () => {
    const facts = makeFacts({ path: ".env", roles: ["secret"] });
    expect(computeRoleScore(facts).score).toBeLessThan(-500);
  });

  it("does not penalize test files by default", () => {
    const facts = makeFacts({ path: "src/foo.test.ts", roles: ["test"] });
    expect(computeRoleScore(facts).score).toBe(120);
  });
});

describe("computeEcosystemScore", () => {
  it("gives typescript bonus to package.json", () => {
    const facts = makeFacts({ path: "package.json", name: "package.json", roles: ["manifest"] });
    const repo = makeEmptyRepo({ primary: "typescript" });
    expect(computeEcosystemScore(facts, repo).score).toBe(250);
  });

  it("gives python bonus to pyproject.toml", () => {
    const facts = makeFacts({ path: "pyproject.toml", name: "pyproject.toml", roles: ["manifest"] });
    const repo = makeEmptyRepo({ primary: "python" });
    expect(computeEcosystemScore(facts, repo).score).toBe(250);
  });

  it("gives rust bonus to Cargo.toml", () => {
    const facts = makeFacts({ path: "Cargo.toml", name: "Cargo.toml", roles: ["manifest"] });
    const repo = makeEmptyRepo({ primary: "rust" });
    expect(computeEcosystemScore(facts, repo).score).toBe(250);
  });

  it("gives no bonus for wrong ecosystem", () => {
    const facts = makeFacts({ path: "package.json", name: "package.json", roles: ["manifest"] });
    const repo = makeEmptyRepo({ primary: "python" });
    expect(computeEcosystemScore(facts, repo).score).toBe(0);
  });

  it("matches path-based profile keys (e.g. src/index.ts)", () => {
    const facts = makeFacts({ path: "src/index.ts", name: "index.ts", roles: ["entrypoint", "source"] });
    const repo = makeEmptyRepo({ primary: "typescript" });
    expect(computeEcosystemScore(facts, repo).score).toBe(200);
  });

  it("matches src/main.ts path-based key", () => {
    const facts = makeFacts({ path: "src/main.ts", name: "main.ts", roles: ["entrypoint", "source"] });
    const repo = makeEmptyRepo({ primary: "typescript" });
    expect(computeEcosystemScore(facts, repo).score).toBe(220);
  });

  it("matches rust src/lib.rs path-based key", () => {
    const facts = makeFacts({ path: "src/lib.rs", name: "lib.rs", roles: ["source"] });
    const repo = makeEmptyRepo({ primary: "rust" });
    expect(computeEcosystemScore(facts, repo).score).toBe(240);
  });
});

describe("computeTaskRelevanceScore", () => {
  it("gives bonus for exact path match", () => {
    const facts = makeFacts({ path: "src/foo.ts" });
    const task = makeEmptyTask({ explicitlyMentionedPaths: ["src/foo.ts"] });
    const result = computeTaskRelevanceScore(facts, task);
    expect(result.score).toBeGreaterThanOrEqual(700);
  });

  it("gives bonus for design doc ID match", () => {
    const facts = makeFacts({ path: "doc/pdd21-1.md", roles: ["design_doc"] });
    const task = makeEmptyTask({ explicitlyMentionedTerms: ["pdd21-1"] });
    const result = computeTaskRelevanceScore(facts, task);
    expect(result.score).toBeGreaterThanOrEqual(700);
  });

  it("gives bonus to test files in debug intent", () => {
    const facts = makeFacts({ path: "src/foo.test.ts", roles: ["test"] });
    const task = makeEmptyTask({ intent: "debug" });
    const result = computeTaskRelevanceScore(facts, task);
    expect(result.score).toBe(250);
  });

  it("penalizes test files in orientation intent", () => {
    const facts = makeFacts({ path: "src/foo.test.ts", roles: ["test"] });
    const task = makeEmptyTask({ intent: "orientation" });
    const result = computeTaskRelevanceScore(facts, task);
    expect(result.score).toBe(0);
  });

  it("does not give fixed penalty to test files", () => {
    const facts = makeFacts({ path: "src/foo.test.ts", roles: ["test"] });
    const task = makeEmptyTask({ intent: "implementation" });
    const result = computeTaskRelevanceScore(facts, task);
    expect(result.score).toBe(0);
  });
});

describe("computeEvidenceScore", () => {
  it("gives high score to stack trace files", () => {
    const facts = makeFacts({ path: "src/foo.ts" });
    const task = makeEmptyTask({ stackTraceFiles: ["src/foo.ts"] });
    expect(computeEvidenceScore(facts, task).score).toBe(900);
  });

  it("gives high score to failing test files", () => {
    const facts = makeFacts({ path: "src/foo.test.ts", roles: ["test"] });
    const task = makeEmptyTask({ failingFiles: ["src/foo.test.ts"] });
    expect(computeEvidenceScore(facts, task).score).toBe(850);
  });

  it("gives score to git modified files", () => {
    const facts = makeFacts({ path: "src/foo.ts", isGitModified: true });
    const task = makeEmptyTask();
    expect(computeEvidenceScore(facts, task).score).toBe(700);
  });

  it("gives score to recently read files", () => {
    const facts = makeFacts({ path: "src/foo.ts" });
    const task = makeEmptyTask({ recentFiles: ["src/foo.ts"] });
    expect(computeEvidenceScore(facts, task).score).toBe(500);
  });
});

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

describe("rankAllFiles", () => {
  it("sorts by score descending", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "src/low.ts", roles: ["source"] }),
      makeFacts({ path: "README.md", roles: ["readme"] }),
      makeFacts({ path: "package.json", roles: ["manifest"] }),
    ];
    const repo = makeEmptyRepo({ primary: "typescript" });
    const task = makeEmptyTask();
    const ranked = rankAllFiles({ files, repo, task });
    // package.json: role(280) + ecosystem(250) = 530
    // README.md: role(380) = 380
    // src/low.ts: role(140) = 140
    expect(ranked[0]!.path).toBe("package.json");
    expect(ranked[1]!.path).toBe("README.md");
    expect(ranked[2]!.path).toBe("src/low.ts");
  });

  it("breaks ties by path ascending", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "src/b.ts", roles: ["source"] }),
      makeFacts({ path: "src/a.ts", roles: ["source"] }),
    ];
    const repo = makeEmptyRepo();
    const task = makeEmptyTask();
    const ranked = rankAllFiles({ files, repo, task });
    expect(ranked[0]!.path).toBe("src/a.ts");
    expect(ranked[1]!.path).toBe("src/b.ts");
  });

  it("excludes secret and binary files", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "src/foo.ts", roles: ["source"] }),
      makeFacts({ path: ".env", roles: ["secret"] }),
      makeFacts({ path: "app.exe", roles: ["binary"] }),
    ];
    const repo = makeEmptyRepo();
    const task = makeEmptyTask();
    const ranked = rankAllFiles({ files, repo, task });
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.path).toBe("src/foo.ts");
  });

  it("respects maxResults", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "a.ts", roles: ["source"] }),
      makeFacts({ path: "b.ts", roles: ["source"] }),
      makeFacts({ path: "c.ts", roles: ["source"] }),
    ];
    const repo = makeEmptyRepo();
    const task = makeEmptyTask();
    const ranked = rankAllFiles({ files, repo, task, maxResults: 2 });
    expect(ranked).toHaveLength(2);
  });

  it("every ranked file has reasons", () => {
    const files: FileFacts[] = [
      makeFacts({ path: "README.md", roles: ["readme"] }),
    ];
    const repo = makeEmptyRepo();
    const task = makeEmptyTask();
    const ranked = rankAllFiles({ files, repo, task });
    expect(ranked[0]!.reasons.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 文件扫描
// ---------------------------------------------------------------------------

describe("scanProjectFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it("scans typescript project files", () => {
    writeFile(tempDir, "package.json", '{"name":"test"}');
    writeFile(tempDir, "tsconfig.json", "{}");
    writeFile(tempDir, "src/index.ts", "export const a = 1;");
    writeFile(tempDir, "src/agent.ts", "export function run() {}");
    writeFile(tempDir, "README.md", "# Test");

    const files = scanProjectFiles(tempDir);
    const names = files.map((f) => f.name);
    expect(names).toContain("package.json");
    expect(names).toContain("tsconfig.json");
    expect(names).toContain("index.ts");
    expect(names).toContain("README.md");
  });

  it("excludes node_modules and .git", () => {
    writeFile(tempDir, "package.json", "{}");
    writeFile(tempDir, "node_modules/foo/index.js", "module.exports = {}");
    writeFile(tempDir, ".git/config", "");

    const files = scanProjectFiles(tempDir);
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain("node_modules/foo/index.js");
    expect(paths).not.toContain(".git/config");
  });

  it("excludes .env files", () => {
    writeFile(tempDir, ".env", "SECRET=123");
    writeFile(tempDir, ".env.local", "SECRET=456");
    writeFile(tempDir, "src/app.ts", "export {}");

    const files = scanProjectFiles(tempDir);
    const names = files.map((f) => f.name);
    expect(names).not.toContain(".env");
    expect(names).not.toContain(".env.local");
  });

  it("excludes doc/todo.md", () => {
    writeFile(tempDir, "doc/todo.md", "# TODO");
    writeFile(tempDir, "doc/summary.md", "# Summary");

    const files = scanProjectFiles(tempDir);
    const paths = files.map((f) => f.path);
    expect(paths).not.toContain("doc/todo.md");
    expect(paths).toContain("doc/summary.md");
  });

  it("excludes binary files", () => {
    writeFile(tempDir, "image.png", "fake");
    writeFile(tempDir, "archive.zip", "fake");
    writeFile(tempDir, "src/app.ts", "export {}");

    const files = scanProjectFiles(tempDir);
    const names = files.map((f) => f.name);
    expect(names).not.toContain("image.png");
    expect(names).not.toContain("archive.zip");
  });
});

// ---------------------------------------------------------------------------
// Import Graph
// ---------------------------------------------------------------------------

describe("buildImportGraph", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tempDir);
  });

  it("builds import graph for typescript files", () => {
    writeFile(tempDir, "src/index.ts", 'import { foo } from "./foo.js";\n');
    writeFile(tempDir, "src/foo.ts", "export const foo = 1;\n");

    const files = scanProjectFiles(tempDir);
    buildImportGraph(files, tempDir);

    const indexFile = files.find((f) => f.path === "src/index.ts");
    const fooFile = files.find((f) => f.path === "src/foo.ts");
    expect(indexFile?.imports).toContain("src/foo.ts");
    expect(fooFile?.importedBy).toContain("src/index.ts");
  });

  it("builds test/source pairing", () => {
    writeFile(tempDir, "src/foo.ts", "export const foo = 1;\n");
    writeFile(tempDir, "src/foo.test.ts", 'import { foo } from "./foo.js";\n');

    const files = scanProjectFiles(tempDir);
    buildImportGraph(files, tempDir);

    const fooFile = files.find((f) => f.path === "src/foo.ts");
    const testFile = files.find((f) => f.path === "src/foo.test.ts");
    expect(fooFile?.pairedFiles).toContain("src/foo.test.ts");
    expect(testFile?.pairedFiles).toContain("src/foo.ts");
  });
});

// ---------------------------------------------------------------------------
// 完整 fixture 测试
// ---------------------------------------------------------------------------

describe("full fixture: typescript project", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeFile(tempDir, "package.json", '{"name":"test"}');
    writeFile(tempDir, "tsconfig.json", "{}");
    writeFile(tempDir, "README.md", "# Test Project");
    writeFile(tempDir, "src/index.ts", 'import { agent } from "./agent.js";\n');
    writeFile(tempDir, "src/agent.ts", "export function run() {}\n");
    writeFile(tempDir, "src/agent.test.ts", 'import { run } from "./agent.js";\n');
  });

  afterEach(() => cleanup(tempDir));

  it("ranks README and manifest high", () => {
    const ranker = createContextRanker(tempDir);
    const files = ranker.scanFileFacts();
    const repo = ranker.classifyRepo(files);
    const task = ranker.classifyTask({
      query: "",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    const ranked = ranker.rankFiles({ files, repo, task });

    const readmeRank = ranked.findIndex((r) => r.path === "README.md");
    const agentRank = ranked.findIndex((r) => r.path === "src/agent.ts");
    expect(readmeRank).toBeLessThan(agentRank);
  });
});

describe("full fixture: python project", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeFile(tempDir, "pyproject.toml", '[project]\nname = "test"');
    writeFile(tempDir, "requirements.txt", "flask==2.0");
    writeFile(tempDir, "app.py", "from flask import Flask\n");
    writeFile(tempDir, "main.py", "import app\n");
    writeFile(tempDir, "tests/conftest.py", "import pytest\n");
    writeFile(tempDir, "tests/test_app.py", "def test_app(): pass\n");
  });

  afterEach(() => cleanup(tempDir));

  it("ranks pyproject.toml and app.py high", () => {
    const ranker = createContextRanker(tempDir);
    const files = ranker.scanFileFacts();
    const repo = ranker.classifyRepo(files);
    expect(repo.primary).toBe("python");

    const task = ranker.classifyTask({
      query: "",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    const ranked = ranker.rankFiles({ files, repo, task });

    const pyprojectRank = ranked.findIndex((r) => r.path === "pyproject.toml");
    const conftestRank = ranked.findIndex((r) => r.path === "tests/conftest.py");
    expect(pyprojectRank).toBeLessThan(conftestRank);
  });

  it("does not assume package.json exists", () => {
    const ranker = createContextRanker(tempDir);
    const files = ranker.scanFileFacts();
    const names = files.map((f) => f.name);
    expect(names).not.toContain("package.json");
  });
});

describe("full fixture: rust project", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeFile(tempDir, "Cargo.toml", '[package]\nname = "test"');
    writeFile(tempDir, "src/main.rs", "fn main() {}\n");
    writeFile(tempDir, "src/lib.rs", "pub fn hello() {}\n");
    writeFile(tempDir, "src/utils.rs", "pub fn util() {}\n");
  });

  afterEach(() => cleanup(tempDir));

  it("ranks Cargo.toml and src/lib.rs high", () => {
    const ranker = createContextRanker(tempDir);
    const files = ranker.scanFileFacts();
    const repo = ranker.classifyRepo(files);
    expect(repo.primary).toBe("rust");

    const task = ranker.classifyTask({
      query: "",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    const ranked = ranker.rankFiles({ files, repo, task });

    const cargoRank = ranked.findIndex((r) => r.path === "Cargo.toml");
    const libRank = ranked.findIndex((r) => r.path === "src/lib.rs");
    const utilsRank = ranked.findIndex((r) => r.path === "src/utils.rs");
    expect(cargoRank).toBeLessThan(utilsRank);
    expect(libRank).toBeLessThan(utilsRank);
  });
});

describe("full fixture: go project", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeFile(tempDir, "go.mod", "module example.com/test\n");
    writeFile(tempDir, "main.go", "package main\n");
    writeFile(tempDir, "main_test.go", "package main\n");
    writeFile(tempDir, "internal/handler.go", "package internal\n");
  });

  afterEach(() => cleanup(tempDir));

  it("ranks go.mod and main.go high", () => {
    const ranker = createContextRanker(tempDir);
    const files = ranker.scanFileFacts();
    const repo = ranker.classifyRepo(files);
    expect(repo.primary).toBe("go");

    const task = ranker.classifyTask({
      query: "",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    const ranked = ranker.rankFiles({ files, repo, task });

    const goModRank = ranked.findIndex((r) => r.path === "go.mod");
    const handlerRank = ranked.findIndex((r) => r.path === "internal/handler.go");
    expect(goModRank).toBeLessThan(handlerRank);
  });
});

describe("full fixture: docs-only project", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeFile(tempDir, "README.md", "# Documentation Project");
    writeFile(tempDir, "docs/guide.md", "# Guide");
    writeFile(tempDir, "docs/api.md", "# API Reference");
    writeFile(tempDir, "docs/faq.md", "# FAQ");
  });

  afterEach(() => cleanup(tempDir));

  it("ranks README and docs high", () => {
    const ranker = createContextRanker(tempDir);
    const files = ranker.scanFileFacts();
    const repo = ranker.classifyRepo(files);
    expect(repo.primary).toBe("docs");

    const task = ranker.classifyTask({
      query: "",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    const ranked = ranker.rankFiles({ files, repo, task });

    expect(ranked.length).toBeGreaterThan(0);
    const readmeRank = ranked.findIndex((r) => r.path === "README.md");
    expect(readmeRank).toBe(0);
  });
});

describe("full fixture: infra project", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeFile(tempDir, "Dockerfile", "FROM node:20\n");
    writeFile(tempDir, "compose.yaml", "services:\n  app:\n");
    writeFile(tempDir, "main.tf", 'resource "aws_instance" "example" {}\n');
    writeFile(tempDir, ".github/workflows/deploy.yml", "name: deploy\n");
  });

  afterEach(() => cleanup(tempDir));

  it("identifies infra files", () => {
    const ranker = createContextRanker(tempDir);
    const files = ranker.scanFileFacts();
    const repo = ranker.classifyRepo(files);
    expect(repo.primary).toBe("infra");

    const dockerFile = files.find((f) => f.path === "Dockerfile");
    expect(dockerFile?.roles).toContain("infra");

    const composeFile = files.find((f) => f.path === "compose.yaml");
    expect(composeFile?.roles).toContain("infra");

    const tfFile = files.find((f) => f.path === "main.tf");
    expect(tfFile?.roles).toContain("infra");
  });
});

describe("full fixture: mixed monorepo", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
    writeFile(tempDir, "frontend/package.json", '{"name":"frontend"}');
    writeFile(tempDir, "frontend/tsconfig.json", "{}");
    writeFile(tempDir, "frontend/src/index.ts", "export {}");
    writeFile(tempDir, "frontend/src/app.ts", "export {}");
    writeFile(tempDir, "backend/pyproject.toml", '[project]\nname = "backend"');
    writeFile(tempDir, "backend/app.py", "from flask import Flask");
    writeFile(tempDir, "backend/main.py", "import app");
  });

  afterEach(() => cleanup(tempDir));

  it("classifies as mixed", () => {
    const ranker = createContextRanker(tempDir);
    const files = ranker.scanFileFacts();
    const repo = ranker.classifyRepo(files);
    expect(repo.primary).toBe("mixed");
    expect(repo.all).toContain("typescript");
    expect(repo.all).toContain("python");
  });

  it("deep package entrypoint is not penalized by path depth", () => {
    const ranker = createContextRanker(tempDir);
    const files = ranker.scanFileFacts();
    const repo = ranker.classifyRepo(files);
    const task = ranker.classifyTask({
      query: "",
      recentFiles: [], openFiles: [], changedFiles: [], failingFiles: [], stackTraceFiles: [],
    });
    const ranked = ranker.rankFiles({ files, repo, task });

    const frontendIndex = ranked.find((r) => r.path === "frontend/src/index.ts");
    expect(frontendIndex).toBeDefined();
    expect(frontendIndex!.score).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// review intent 下 test files 不被惩罚
// ---------------------------------------------------------------------------

describe("review intent test file handling", () => {
  it("does not penalize test files in review intent", () => {
    const facts = makeFacts({ path: "src/foo.test.ts", roles: ["test"] });
    const task = makeEmptyTask({ intent: "review" });
    const result = computeTaskRelevanceScore(facts, task);
    expect(result.score).toBe(250);
  });

  it("gives bonus to changed test files in review intent", () => {
    const facts = makeFacts({ path: "src/foo.test.ts", roles: ["test"], isGitModified: true });
    const task = makeEmptyTask({
      intent: "review",
      changedFiles: ["src/foo.test.ts"],
    });
    const evidence = computeEvidenceScore(facts, task);
    const relevance = computeTaskRelevanceScore(facts, task);
    expect(evidence.score).toBeGreaterThan(0);
    expect(relevance.score).toBeGreaterThan(0);
  });
});
