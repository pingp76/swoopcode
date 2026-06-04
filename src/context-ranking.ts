/**
 * context-ranking.ts — 通用内容重要性排序与上下文装载优化
 *
 * 职责：为任意项目类型生成稳定、可解释、可测试的文件重要性排序。
 *
 * 核心设计（四层分离）：
 * - FileInventory：收集项目文件事实（路径、大小、mtime、扩展名、角色等）
 * - RepoClassifier：识别项目生态（typescript/python/rust/go/java/infra/docs/mixed/unknown）
 * - TaskIntentClassifier：根据用户 query 和 evidence 判断当前任务意图
 * - ContextRanker：组合通用信号 + 生态信号 + 任务信号 + evidence 信号，输出可解释排序
 *
 * 设计原则：
 * - 不把 JS/TS 规则写成全局默认，只能作为 ecosystem profile
 * - 不让 test file 固定扣分
 * - 每个分数必须可解释（ScoreReason）
 * - 排序必须 deterministic，同分时按 normalized path 排
 * - 保持轻量，第一版不引入外部 parser
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

/** 项目生态类型 */
export type RepoEcosystem =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "kotlin"
  | "cpp"
  | "infra"
  | "docs"
  | "mixed"
  | "unknown";

/** 任务意图类型 */
export type TaskIntent =
  | "orientation"
  | "implementation"
  | "debug"
  | "review"
  | "testing"
  | "documentation"
  | "refactor"
  | "unknown";

/** 文件角色类型 */
export type FileRole =
  | "project_instruction"
  | "readme"
  | "project_summary"
  | "design_doc"
  | "manifest"
  | "lockfile"
  | "build_config"
  | "entrypoint"
  | "source"
  | "test"
  | "schema"
  | "migration"
  | "infra"
  | "ci_config"
  | "generated"
  | "binary"
  | "secret"
  | "unknown";

/** 文件事实：描述一个文件的所有静态和动态属性 */
export interface FileFacts {
  path: string;
  name: string;
  extension: string;
  sizeBytes: number;
  lineCount?: number;
  lastModifiedMs?: number;
  contentHash?: string;
  roles: FileRole[];
  ecosystems: RepoEcosystem[];
  isCurrentlyOpen?: boolean;
  isRecentlyRead?: boolean;
  isGitModified?: boolean;
  isGitStaged?: boolean;
  isIgnored?: boolean;
  imports: string[];
  importedBy: string[];
  pairedFiles: string[];
}

/** 项目分类结果 */
export interface RepoClassification {
  primary: RepoEcosystem;
  all: RepoEcosystem[];
  confidence: number;
  reasons: string[];
  roots: string[];
}

/** 任务上下文 */
export interface TaskContext {
  query: string;
  intent: TaskIntent;
  explicitlyMentionedPaths: string[];
  explicitlyMentionedTerms: string[];
  recentFiles: string[];
  openFiles: string[];
  changedFiles: string[];
  failingFiles: string[];
  stackTraceFiles: string[];
}

/** 分数原因：记录每个信号的贡献 */
export interface ScoreReason {
  signal: string;
  points: number;
  note: string;
}

/** 排序后的文件 */
export interface RankedFile {
  path: string;
  score: number;
  facts: FileFacts;
  reasons: ScoreReason[];
}

/** ContextRanker 接口 */
export interface ContextRanker {
  classifyRepo(files: FileFacts[]): RepoClassification;
  classifyTask(input: {
    query: string;
    recentFiles: string[];
    openFiles: string[];
    changedFiles: string[];
    failingFiles: string[];
    stackTraceFiles: string[];
  }): TaskContext;
  rankFiles(input: {
    files: FileFacts[];
    repo: RepoClassification;
    task: TaskContext;
    maxResults?: number;
  }): RankedFile[];
  scanFileFacts(): FileFacts[];
}

// ---------------------------------------------------------------------------
// 常量：排除规则
// ---------------------------------------------------------------------------

/** 默认排除的目录名 */
const EXCLUDED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  "target",
  "vendor",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".tox",
  ".venv",
  "venv",
  ".eggs",
]);

/** 默认排除的文件扩展名 */
const EXCLUDED_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
  ".woff", ".woff2", ".ttf", ".eot",
  ".mp3", ".mp4", ".avi", ".mov", ".wav",
  ".exe", ".dll", ".so", ".dylib", ".o", ".a",
  ".pyc", ".pyo", ".class",
]);

/** 默认排除的文件名 */
const EXCLUDED_FILENAMES = new Set([
  ".env", ".env.local", ".env.development", ".env.production", ".env.test",
  "package-lock.json", "yarn.lock", "pnpm-lock.yaml",
  "Cargo.lock", "poetry.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock",
]);

/** 永远不自动装载的路径 */
const FORBIDDEN_PATHS = new Set(["doc/todo.md", "docs/todo.md"]);

/** 敏感文件模式（永不自动读取） */
const SECRET_PATTERNS = [
  /\.env(\..*)?$/,
  /\.key$/,
  /\.pem$/,
  /\.p12$/,
  /\.pfx$/,
  /\.jks$/,
  /id_rsa/,
  /id_ed25519/,
  /\.secret$/,
  /credentials/,
  /\.keystore$/,
];

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/** 判断目录是否应被排除 */
function isExcludedDir(dirName: string): boolean {
  return EXCLUDED_DIRS.has(dirName);
}

/** 判断文件是否应被排除（二进制、图片、压缩包等） */
function isExcludedFile(fileName: string): boolean {
  const ext = path.extname(fileName).toLowerCase();
  if (EXCLUDED_EXTENSIONS.has(ext)) return true;
  if (EXCLUDED_FILENAMES.has(fileName)) return true;
  if (fileName.endsWith(".log")) return true;
  if (fileName.endsWith(".lock")) return true;
  return false;
}

/** 判断文件是否为敏感/密钥文件 */
function isSecretFile(fileName: string, relativePath: string): boolean {
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(fileName) || pattern.test(relativePath)) return true;
  }
  return false;
}

/** 判断文件是否为生成物 */
function isGeneratedFile(relativePath: string, fileName: string): boolean {
  if (relativePath.startsWith("dist/") || relativePath.startsWith("build/")) return true;
  if (relativePath.startsWith("target/") || relativePath.startsWith("out/")) return true;
  if (fileName.endsWith(".min.js") || fileName.endsWith(".min.css")) return true;
  if (fileName.includes(".generated.")) return true;
  return false;
}

/** clamp 辅助函数 */
function clamp(min: number, max: number, value: number): number {
  return Math.max(min, Math.min(max, value));
}

// ---------------------------------------------------------------------------
// 文件角色识别
// ---------------------------------------------------------------------------

/** manifest 文件名集合（跨生态） */
const MANIFEST_NAMES = new Set([
  "package.json", "pyproject.toml", "requirements.txt", "setup.py", "setup.cfg",
  "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts",
  "CMakeLists.txt", "Makefile", "Gemfile", "mix.exs", "composer.json",
]);

/** build config 文件名集合 */
const BUILD_CONFIG_NAMES = new Set([
  "tsconfig.json", "tsconfig.build.json",
  "vite.config.ts", "vite.config.js",
  "next.config.js", "next.config.mjs", "next.config.ts",
  "webpack.config.js", "webpack.config.ts",
  "rollup.config.js", "rollup.config.mjs",
  "tsup.config.ts", "esbuild.config.js",
  "jest.config.js", "jest.config.ts",
  "vitest.config.ts", "vitest.config.js",
  ".eslintrc.js", ".eslintrc.cjs", "eslint.config.js", "eslint.config.mjs",
  ".prettierrc", ".prettierrc.js", "prettier.config.js",
  "babel.config.js", "babel.config.json", ".babelrc",
  "postcss.config.js", "tailwind.config.js", "tailwind.config.ts",
  "Makefile", "CMakeLists.txt",
  "build.gradle", "build.gradle.kts",
  "settings.gradle", "settings.gradle.kts",
  "tox.ini", "pytest.ini", "conftest.py",
  ".flake8", "mypy.ini", "ruff.toml", ".ruff.toml",
]);

/** entrypoint 路径模式 */
const ENTRYPOINT_PATTERNS = [
  /^src\/main\./,
  /^src\/index\./,
  /^src\/app\./,
  /^src\/lib\./,
  /^main\./,
  /^index\./,
  /^app\./,
  /^lib\./,
  /^cmd\/[^/]+\/main\.go$/,
  /^src\/bin\//,
];

/** schema 文件名模式 */
const SCHEMA_PATTERNS = [
  /openapi\.(yaml|yml|json)$/i,
  /swagger\.(yaml|yml|json)$/i,
  /\.proto$/,
  /schema\.(graphql|gql|json|yaml|yml)$/i,
  /\.prisma$/,
  /api-spec\.(yaml|yml|json)$/i,
];

/** infra 文件名模式 */
const INFRA_FILE_PATTERNS = [
  /^Dockerfile/,
  /docker-compose\.(yaml|yml)$/i,
  /^compose\.(yaml|yml)$/i,
  /\.tf$/,
  /\.tfvars$/,
  /\.hcl$/,
];

/** infra 路径模式 */
const INFRA_PATH_PATTERNS = [
  /helm\/.*\.yaml$/i,
  /k8s\/.*\.yaml$/i,
  /kubernetes\/.*\.yaml$/i,
];

/** CI config 路径模式 */
const CI_PATTERNS = [
  /^\.github\/workflows\/.*\.ya?ml$/,
  /^\.gitlab-ci\.yml$/,
  /^\.circleci\/config\.yml$/,
  /^Jenkinsfile$/,
  /^\.travis\.yml$/,
  /^azure-pipelines\.yml$/,
  /^bitbucket-pipelines\.yml$/,
];

/**
 * 识别文件角色
 *
 * 一个文件可以有多个角色。例如 package.json 同时是 manifest 和 build_config。
 * 角色识别是通用排序的核心，不依赖特定生态。
 */
export function identifyFileRoles(relativePath: string, fileName: string): FileRole[] {
  const roles: FileRole[] = [];

  if (fileName === "AGENTS.md" || fileName === "CLAUDE.md") {
    roles.push("project_instruction");
  }

  if (/^readme(\.[a-z]+)?$/i.test(fileName)) {
    roles.push("readme");
  }

  if (relativePath === "doc/summary.md" || relativePath === "docs/summary.md") {
    roles.push("project_summary");
  }

  if (
    (/^doc\/pdd/i.test(relativePath) || /^docs\/pdd/i.test(relativePath)) &&
    !FORBIDDEN_PATHS.has(relativePath)
  ) {
    roles.push("design_doc");
  } else if (
    (/^doc\/.*\.md$/i.test(relativePath) || /^docs\/.*\.md$/i.test(relativePath)) &&
    !FORBIDDEN_PATHS.has(relativePath) &&
    !roles.includes("project_summary") &&
    !roles.includes("readme")
  ) {
    roles.push("design_doc");
  }

  if (MANIFEST_NAMES.has(fileName)) {
    roles.push("manifest");
  }

  if (
    fileName.endsWith(".lock") ||
    fileName === "package-lock.json" ||
    fileName === "yarn.lock" ||
    fileName === "pnpm-lock.yaml"
  ) {
    roles.push("lockfile");
  }

  if (BUILD_CONFIG_NAMES.has(fileName) && !roles.includes("manifest")) {
    roles.push("build_config");
  }

  for (const pattern of ENTRYPOINT_PATTERNS) {
    if (pattern.test(relativePath)) {
      roles.push("entrypoint");
      break;
    }
  }

  if (
    /\.test\.[tj]sx?$/.test(fileName) ||
    /\.spec\.[tj]sx?$/.test(fileName) ||
    /^test_.*\.py$/.test(fileName) ||
    /.*_test\.py$/.test(fileName) ||
    /.*_test\.go$/.test(fileName) ||
    /^tests?\//.test(relativePath) ||
    /^src\/test\//.test(relativePath) ||
    /^spec\//.test(relativePath)
  ) {
    roles.push("test");
  }

  for (const pattern of SCHEMA_PATTERNS) {
    if (pattern.test(fileName) || pattern.test(relativePath)) {
      roles.push("schema");
      break;
    }
  }

  if (
    /migration/.test(relativePath) ||
    /migrate/.test(relativePath) ||
    /^db\/migrations\//.test(relativePath)
  ) {
    roles.push("migration");
  }

  for (const pattern of INFRA_FILE_PATTERNS) {
    if (pattern.test(fileName)) {
      roles.push("infra");
      break;
    }
  }
  if (!roles.includes("infra")) {
    for (const pattern of INFRA_PATH_PATTERNS) {
      if (pattern.test(relativePath)) {
        roles.push("infra");
        break;
      }
    }
  }

  for (const pattern of CI_PATTERNS) {
    if (pattern.test(relativePath)) {
      roles.push("ci_config");
      break;
    }
  }

  if (isGeneratedFile(relativePath, fileName)) {
    roles.push("generated");
  }

  if (isSecretFile(fileName, relativePath)) {
    roles.push("secret");
  }

  if (roles.length === 0) {
    const ext = path.extname(fileName).toLowerCase();
    const sourceExts = new Set([
      ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
      ".py", ".rs", ".go", ".java", ".kt", ".kts",
      ".c", ".cc", ".cpp", ".h", ".hpp", ".hxx",
      ".rb", ".php", ".swift", ".scala", ".lua",
      ".sh", ".bash", ".zsh", ".fish",
      ".css", ".scss", ".sass", ".less",
      ".html", ".htm", ".vue", ".svelte",
      ".sql", ".graphql", ".gql",
      ".tf", ".hcl",
      ".yaml", ".yml", ".toml", ".ini", ".cfg",
      ".md", ".rst", ".txt", ".adoc",
    ]);
    if (sourceExts.has(ext)) {
      roles.push("source");
    }
  }

  if (roles.length === 0) {
    roles.push("unknown");
  }

  return roles;
}

/**
 * 识别文件所属生态
 *
 * 基于扩展名做初步判断，后续 RepoClassifier 会结合 manifest 做更精确的分类。
 */
export function identifyFileEcosystems(fileName: string, extension: string): RepoEcosystem[] {
  const ecosystems: RepoEcosystem[] = [];
  const ext = extension.toLowerCase();

  if ([".ts", ".tsx", ".mts", ".cts"].includes(ext)) ecosystems.push("typescript");
  if ([".js", ".jsx", ".mjs", ".cjs"].includes(ext)) ecosystems.push("javascript");
  if (ext === ".py") ecosystems.push("python");
  if (ext === ".rs") ecosystems.push("rust");
  if (ext === ".go") ecosystems.push("go");
  if (ext === ".java") ecosystems.push("java");
  if ([".kt", ".kts"].includes(ext)) ecosystems.push("kotlin");
  if ([".c", ".cc", ".cpp", ".h", ".hpp", ".hxx"].includes(ext)) ecosystems.push("cpp");

  if (fileName === "package.json" || fileName === "tsconfig.json") {
    if (!ecosystems.includes("typescript") && !ecosystems.includes("javascript")) {
      ecosystems.push("typescript");
    }
  }
  if (fileName === "pyproject.toml" || fileName === "requirements.txt" || fileName === "setup.py") {
    if (!ecosystems.includes("python")) ecosystems.push("python");
  }
  if (fileName === "Cargo.toml") {
    if (!ecosystems.includes("rust")) ecosystems.push("rust");
  }
  if (fileName === "go.mod") {
    if (!ecosystems.includes("go")) ecosystems.push("go");
  }
  if (fileName === "pom.xml" || fileName === "build.gradle" || fileName === "build.gradle.kts") {
    if (!ecosystems.includes("java")) ecosystems.push("java");
  }

  return ecosystems;
}

// ---------------------------------------------------------------------------
// FileInventory: 扫描项目文件事实
// ---------------------------------------------------------------------------

/**
 * 扫描项目目录，收集文件事实
 *
 * 排除规则：
 * - node_modules, .git, dist, build, coverage 等目录
 * - 二进制、图片、压缩包
 * - .env 和密钥文件
 * - doc/todo.md
 * - symlink（第一版跳过）
 */
export function scanProjectFiles(projectRoot: string): FileFacts[] {
  const files: FileFacts[] = [];

  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(projectRoot, fullPath);

      if (entry.isSymbolicLink()) continue;

      if (entry.isDirectory()) {
        if (isExcludedDir(entry.name)) continue;
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) continue;
      if (isExcludedFile(entry.name)) continue;
      if (FORBIDDEN_PATHS.has(relativePath)) continue;
      if (isSecretFile(entry.name, relativePath)) continue;

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      const ext = path.extname(entry.name);
      const roles = identifyFileRoles(relativePath, entry.name);
      const ecosystems = identifyFileEcosystems(entry.name, ext);

      let lineCount: number | undefined;
      if (stat.size < 1_000_000 && !roles.includes("binary")) {
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          lineCount = content.split("\n").length;
        } catch {
          // 非文本文件，忽略
        }
      }

      const fileFacts: FileFacts = {
        path: relativePath,
        name: entry.name,
        extension: ext,
        sizeBytes: stat.size,
        roles,
        ecosystems,
        imports: [],
        importedBy: [],
        pairedFiles: [],
      };
      if (lineCount !== undefined) fileFacts.lineCount = lineCount;
      if (stat.mtimeMs !== undefined) fileFacts.lastModifiedMs = stat.mtimeMs;
      files.push(fileFacts);
    }
  }

  walk(projectRoot);
  return files;
}

/**
 * 轻量 import graph 提取（第一版）
 *
 * 只对已知生态做简单字符串匹配，不引入 AST parser。
 */
export function buildImportGraph(files: FileFacts[], projectRoot: string): void {
  const pathSet = new Set(files.map((f) => f.path));

  for (const file of files) {
    if (file.sizeBytes > 500_000) continue;
    if (file.roles.includes("binary") || file.roles.includes("generated")) continue;

    const ext = file.extension.toLowerCase();
    let content: string;
    try {
      content = fs.readFileSync(path.join(projectRoot, file.path), "utf-8");
    } catch {
      continue;
    }

    const rawImports: string[] = [];

    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
      const importRegex = /(?:import|export)\s+.*?from\s+['"](\.[^'"]+)['"]/g;
      const requireRegex = /require\s*\(\s*['"](\.[^'"]+)['"]\s*\)/g;
      let match: RegExpExecArray | null;
      while ((match = importRegex.exec(content)) !== null) {
        rawImports.push(match[1]!);
      }
      while ((match = requireRegex.exec(content)) !== null) {
        rawImports.push(match[1]!);
      }
    }

    if (ext === ".py") {
      const pyImportRegex = /(?:from\s+(\.[\w.]+)\s+import|import\s+(\.[\w.]+))/g;
      let match: RegExpExecArray | null;
      while ((match = pyImportRegex.exec(content)) !== null) {
        const mod = match[1] ?? match[2] ?? "";
        rawImports.push(mod);
      }
    }

    if (ext === ".rs") {
      const rustModRegex = /mod\s+(\w+)\s*;/g;
      let match: RegExpExecArray | null;
      while ((match = rustModRegex.exec(content)) !== null) {
        rawImports.push(match[1]!);
      }
    }

    const dir = path.dirname(file.path);
    for (const imp of rawImports) {
      if (imp.startsWith(".") || imp.startsWith("/")) {
        const resolved = path.normalize(path.join(dir, imp));
        // TypeScript ESM 使用 .js 扩展名导入 .ts 文件，需要额外处理
        const strippedJs = resolved.replace(/\.js$/, "");
        const strippedMjs = resolved.replace(/\.mjs$/, "");
        const candidates = [
          resolved,
          resolved + ".ts", resolved + ".tsx",
          resolved + ".js", resolved + ".jsx",
          resolved + ".py", resolved + ".go", resolved + ".rs",
          strippedJs + ".ts", strippedJs + ".tsx",
          strippedMjs + ".ts", strippedMjs + ".mts",
          resolved + "/index.ts", resolved + "/index.js",
          resolved + "/mod.rs",
        ];
        for (const candidate of candidates) {
          if (pathSet.has(candidate) && candidate !== file.path) {
            if (!file.imports.includes(candidate)) {
              file.imports.push(candidate);
            }
            const target = files.find((f) => f.path === candidate);
            if (target && !target.importedBy.includes(file.path)) {
              target.importedBy.push(file.path);
            }
            break;
          }
        }
      }
    }
  }

  for (const file of files) {
    if (file.roles.includes("test")) {
      const baseName = file.name
        .replace(/\.test\.[tj]sx?$/, "")
        .replace(/\.spec\.[tj]sx?$/, "")
        .replace(/^test_/, "")
        .replace(/_test\.py$/, "")
        .replace(/_test\.go$/, "");
      const dir = path.dirname(file.path);
      const candidates = [
        path.join(dir, baseName + ".ts"),
        path.join(dir, baseName + ".tsx"),
        path.join(dir, baseName + ".js"),
        path.join(dir, baseName + ".py"),
        path.join(dir, baseName + ".go"),
        path.join(dir, baseName + ".rs"),
        path.join(dir.replace(/^tests?\//, "src/"), baseName + ".ts"),
        path.join(dir.replace(/^tests?\//, "src/"), baseName + ".py"),
      ];
      for (const candidate of candidates) {
        if (pathSet.has(candidate)) {
          if (!file.pairedFiles.includes(candidate)) {
            file.pairedFiles.push(candidate);
          }
          const target = files.find((f) => f.path === candidate);
          if (target && !target.pairedFiles.includes(file.path)) {
            target.pairedFiles.push(file.path);
          }
          break;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// RepoClassifier: 项目生态分类
// ---------------------------------------------------------------------------

/** 生态信号定义 */
interface EcosystemSignal {
  name: RepoEcosystem;
  manifests: string[];
  filePatterns: RegExp[];
  dirPatterns: RegExp[];
}

const ECOSYSTEM_SIGNALS: EcosystemSignal[] = [
  {
    name: "typescript",
    manifests: ["package.json"],
    filePatterns: [/\.tsx?$/, /tsconfig\.json$/, /vite\.config\.ts$/, /next\.config\.(ts|mjs|js)$/],
    dirPatterns: [/^src$/],
  },
  {
    name: "javascript",
    manifests: ["package.json"],
    filePatterns: [/\.jsx?$/, /\.mjs$/, /\.cjs$/],
    dirPatterns: [/^src$/],
  },
  {
    name: "python",
    manifests: ["pyproject.toml", "requirements.txt", "setup.py", "setup.cfg"],
    filePatterns: [/\.py$/],
    dirPatterns: [/^tests?$/],
  },
  {
    name: "rust",
    manifests: ["Cargo.toml"],
    filePatterns: [/\.rs$/],
    dirPatterns: [/^src$/],
  },
  {
    name: "go",
    manifests: ["go.mod"],
    filePatterns: [/\.go$/],
    dirPatterns: [/^cmd$/, /^internal$/, /^pkg$/],
  },
  {
    name: "java",
    manifests: ["pom.xml", "build.gradle"],
    filePatterns: [/\.java$/],
    dirPatterns: [/^src\/main\/java/, /^src\/test\/java/],
  },
  {
    name: "kotlin",
    manifests: ["build.gradle.kts"],
    filePatterns: [/\.kt$/, /\.kts$/],
    dirPatterns: [/^src\/main\/kotlin/],
  },
  {
    name: "cpp",
    manifests: ["CMakeLists.txt", "Makefile"],
    filePatterns: [/\.cc$/, /\.cpp$/, /\.h$/, /\.hpp$/, /\.hxx$/],
    dirPatterns: [/^include$/, /^src$/],
  },
  {
    name: "infra",
    manifests: [],
    filePatterns: [/^Dockerfile/, /compose\.ya?ml$/, /\.tf$/, /\.tfvars$/],
    dirPatterns: [/^k8s$/, /^kubernetes$/, /^helm$/, /^\.github\/workflows$/],
  },
  {
    name: "docs",
    manifests: [],
    filePatterns: [/\.md$/, /\.rst$/, /\.adoc$/],
    dirPatterns: [/^docs?$/],
  },
];

/**
 * 分类项目生态
 *
 * 组合 manifest + 文件分布 + 目录结构判断。
 * 如果多个生态 confidence 都很高，primary 为 mixed。
 */
export function classifyRepository(files: FileFacts[]): RepoClassification {
  const scores = new Map<RepoEcosystem, { score: number; reasons: string[] }>();
  const allPaths = files.map((f) => f.path);
  const allNames = new Set(files.map((f) => f.name));

  for (const signal of ECOSYSTEM_SIGNALS) {
    let ecoScore = 0;
    const reasons: string[] = [];

    for (const manifest of signal.manifests) {
      if (allNames.has(manifest)) {
        ecoScore += 3;
        reasons.push(`manifest: ${manifest}`);
      }
    }

    let fileMatchCount = 0;
    for (const fp of allPaths) {
      for (const pattern of signal.filePatterns) {
        if (pattern.test(fp)) {
          fileMatchCount++;
          break;
        }
      }
    }
    if (fileMatchCount > 0) {
      ecoScore += Math.min(fileMatchCount * 0.5, 5);
      reasons.push(`${fileMatchCount} file(s) matching patterns`);
    }

    // 提取目录信号：同时收集顶层目录名和完整 dirname，
    // 前者匹配浅层信号（/^src$/），后者匹配深层信号（/^src\/main\/java/）
    const dirs = new Set<string>();
    for (const p of allPaths) {
      const d = path.dirname(p);
      if (d === ".") {
        dirs.add("");
      } else {
        dirs.add(d.split("/")[0]!);
        dirs.add(d);
      }
    }
    for (const dir of dirs) {
      for (const pattern of signal.dirPatterns) {
        if (pattern.test(dir)) {
          ecoScore += 1;
          reasons.push(`directory: ${dir}`);
          break;
        }
      }
    }

    if (ecoScore > 0) {
      scores.set(signal.name, { score: ecoScore, reasons });
    }
  }

  if (scores.has("typescript") && scores.has("javascript")) {
    const tsScore = scores.get("typescript")!.score;
    const jsScore = scores.get("javascript")!.score;
    if (tsScore >= jsScore) {
      scores.delete("javascript");
    }
  }

  if (scores.has("java") && scores.has("kotlin")) {
    const ktFiles = files.filter((f) => f.extension === ".kt" || f.extension === ".kts");
    if (ktFiles.length === 0) {
      scores.delete("kotlin");
    }
  }

  const sorted = [...scores.entries()].sort((a, b) => b[1].score - a[1].score);

  if (sorted.length === 0) {
    return {
      primary: "unknown",
      all: [],
      confidence: 0,
      reasons: ["no ecosystem signals detected"],
      roots: [],
    };
  }

  const topScore = sorted[0]![1].score;
  const secondScore = sorted.length > 1 ? sorted[1]![1].score : 0;

  const roots: string[] = [];
  const topLevelDirs = new Set(
    allPaths
      .filter((p) => p.includes("/"))
      .map((p) => p.split("/")[0]!),
  );
  for (const dir of topLevelDirs) {
    const dirManifests = files.filter(
      (f) => f.path.startsWith(dir + "/") && f.roles.includes("manifest"),
    );
    if (dirManifests.length > 0) {
      roots.push(dir);
    }
  }

  const isMixed =
    sorted.length >= 2 &&
    secondScore >= topScore * 0.6 &&
    topScore >= 3 &&
    secondScore >= 3;

  if (isMixed) {
    const allEcosystems = sorted
      .filter(([, v]) => v.score >= 3)
      .map(([k]) => k);
    const allReasons = sorted
      .filter(([, v]) => v.score >= 3)
      .flatMap(([k, v]) => v.reasons.map((r) => `${k}: ${r}`));

    return {
      primary: "mixed",
      all: allEcosystems,
      confidence: Math.min(1, (topScore + secondScore) / 16),
      reasons: allReasons,
      roots,
    };
  }

  const primary = sorted[0]![0];
  const allEcosystems = sorted.map(([k]) => k);
  const allReasons = sorted[0]![1].reasons;
  const confidence = Math.min(1, topScore / 8);

  return {
    primary,
    all: allEcosystems,
    confidence,
    reasons: allReasons,
    roots,
  };
}

// ---------------------------------------------------------------------------
// TaskIntentClassifier: 任务意图分类
// ---------------------------------------------------------------------------

/** 意图关键词映射 */
const INTENT_KEYWORDS: Record<Exclude<TaskIntent, "unknown">, string[]> = {
  orientation: [
    "解释", "说明", "介绍", "架构", "怎么运行", "有哪些模块", "项目结构",
    "explain", "describe", "overview", "architecture", "how to run",
    "what is", "tell me about", "walk me through",
  ],
  implementation: [
    "实现", "添加", "新增", "修改", "开发", "创建", "编写",
    "implement", "add", "create", "build", "develop", "write", "modify",
  ],
  debug: [
    "error", "失败", "报错", "异常", "bug", "修复", "fix", "debug",
    "stack trace", "不通过", "crash", "panic", "exception", "traceback",
    "为什么", "why", "broken", "failing",
  ],
  review: [
    "review", "检查", "审查", "有没有问题", "看看", "code review",
    "inspect", "audit", "check", "review this",
  ],
  testing: [
    "测试", "补测试", "修测试", "coverage", "test", "tests",
    "unit test", "integration test", "覆盖率",
  ],
  documentation: [
    "文档", "readme", "pdd", "说明", "docs", "documentation",
    "changelog", "注释", "comment",
  ],
  refactor: [
    "重构", "整理", "拆分", "抽象", "refactor", "cleanup",
    "reorganize", "restructure", "extract",
  ],
};

/**
 * 分类任务意图
 *
 * 基于 query 关键词匹配 + evidence 信号推断。
 */
export function classifyTaskIntent(input: {
  query: string;
  recentFiles: string[];
  openFiles: string[];
  changedFiles: string[];
  failingFiles: string[];
  stackTraceFiles: string[];
}): TaskContext {
  const queryLower = input.query.toLowerCase();

  const intentScores = new Map<TaskIntent, number>();
  for (const [intent, keywords] of Object.entries(INTENT_KEYWORDS)) {
    let score = 0;
    for (const keyword of keywords) {
      if (queryLower.includes(keyword.toLowerCase())) {
        score += 1;
      }
    }
    if (score > 0) {
      intentScores.set(intent as TaskIntent, score);
    }
  }

  if (input.failingFiles.length > 0 || input.stackTraceFiles.length > 0) {
    const current = intentScores.get("debug") ?? 0;
    intentScores.set("debug", current + 3);
  }

  if (input.changedFiles.length > 0) {
    const current = intentScores.get("review") ?? 0;
    intentScores.set("review", current + 1);
  }

  let intent: TaskIntent = "unknown";
  let maxScore = 0;
  for (const [i, s] of intentScores) {
    if (s > maxScore) {
      maxScore = s;
      intent = i;
    }
  }

  const pathPattern = /(?:^|\s)((?:\.\/|\/|[a-zA-Z0-9_-]+\/)[a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+)/g;
  const mentionedPaths: string[] = [];
  let pathMatch: RegExpExecArray | null;
  while ((pathMatch = pathPattern.exec(input.query)) !== null) {
    mentionedPaths.push(pathMatch[1]!);
  }

  const termPattern = /["']([^"']+)["']/g;
  const mentionedTerms: string[] = [];
  let termMatch: RegExpExecArray | null;
  while ((termMatch = termPattern.exec(input.query)) !== null) {
    mentionedTerms.push(termMatch[1]!);
  }

  const pddPattern = /pdd[\d-]+/gi;
  let pddMatch: RegExpExecArray | null;
  while ((pddMatch = pddPattern.exec(input.query)) !== null) {
    mentionedTerms.push(pddMatch[0]!);
  }

  return {
    query: input.query,
    intent,
    explicitlyMentionedPaths: mentionedPaths,
    explicitlyMentionedTerms: mentionedTerms,
    recentFiles: input.recentFiles,
    openFiles: input.openFiles,
    changedFiles: input.changedFiles,
    failingFiles: input.failingFiles,
    stackTraceFiles: input.stackTraceFiles,
  };
}

// ---------------------------------------------------------------------------
// Scoring: 多维度评分
// ---------------------------------------------------------------------------

/** 通用 roleScore 表 */
const ROLE_SCORES: Record<FileRole, number> = {
  project_instruction: 0,
  project_summary: 420,
  readme: 380,
  design_doc: 300,
  manifest: 280,
  entrypoint: 260,
  schema: 240,
  build_config: 220,
  ci_config: 180,
  source: 140,
  test: 120,
  infra: 120,
  migration: 100,
  lockfile: 30,
  unknown: 20,
  generated: -500,
  binary: -800,
  secret: -1200,
};

/** 生态加分 profile */
type EcosystemProfile = Record<string, number>;

const ECOSYSTEM_PROFILES: Record<string, EcosystemProfile> = {
  typescript: {
    "package.json": 250,
    "tsconfig.json": 220,
    "src/main.ts": 220,
    "src/index.ts": 200,
    "vite.config.ts": 180,
    "next.config.ts": 180,
    "next.config.mjs": 180,
    "tsup.config.ts": 160,
    "vitest.config.ts": 160,
    "jest.config.ts": 160,
  },
  javascript: {
    "package.json": 250,
    "src/main.js": 220,
    "src/index.js": 200,
    "vite.config.js": 180,
  },
  python: {
    "pyproject.toml": 250,
    "requirements.txt": 180,
    "app.py": 220,
    "main.py": 220,
    "setup.py": 200,
    "conftest.py": 160,
  },
  rust: {
    "Cargo.toml": 250,
    "src/lib.rs": 240,
    "src/main.rs": 220,
  },
  go: {
    "go.mod": 250,
    "main.go": 220,
  },
  java: {
    "pom.xml": 230,
    "build.gradle": 230,
  },
  kotlin: {
    "build.gradle.kts": 230,
  },
  cpp: {
    "CMakeLists.txt": 230,
    "Makefile": 200,
  },
  infra: {
    "Dockerfile": 220,
    "compose.yaml": 220,
    "compose.yml": 220,
    "docker-compose.yaml": 220,
    "docker-compose.yml": 220,
  },
};

/** 计算 roleScore */
export function computeRoleScore(facts: FileFacts): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];

  let bestRole: FileRole = "unknown";
  let bestScore = ROLE_SCORES["unknown"]!;

  for (const role of facts.roles) {
    const roleScore = ROLE_SCORES[role] ?? 0;
    if (roleScore > bestScore) {
      bestScore = roleScore;
      bestRole = role;
    }
  }

  let penalty = 0;
  for (const role of facts.roles) {
    const roleScore = ROLE_SCORES[role] ?? 0;
    if (roleScore < 0) {
      penalty += roleScore;
      reasons.push({ signal: "role", points: roleScore, note: `${role} penalty` });
    }
  }

  const score = bestScore + penalty;
  if (bestScore > 0) {
    reasons.unshift({ signal: "role", points: bestScore, note: `${bestRole}` });
  }

  return { score: clamp(-1200, 500, score), reasons };
}

/** 计算 ecosystemScore */
export function computeEcosystemScore(
  facts: FileFacts,
  repo: RepoClassification,
): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];
  let score = 0;

  const activeEcosystems = repo.primary === "mixed" ? repo.all : [repo.primary];

  for (const eco of activeEcosystems) {
    const profile = ECOSYSTEM_PROFILES[eco];
    if (!profile) continue;

    // 先按 basename 查，再按完整 path 查（profile 里可能有 "src/main.ts" 等路径键）
    const ecoScore = profile[facts.name] ?? profile[facts.path];
    if (ecoScore !== undefined) {
      score += ecoScore;
      reasons.push({ signal: "ecosystem", points: ecoScore, note: `${eco} ${facts.path}` });
    } else {
      if (eco === "python" && facts.name === "__init__.py") {
        score += 80;
        reasons.push({ signal: "ecosystem", points: 80, note: "python __init__.py" });
      }
      if (eco === "go" && /^cmd\/[^/]+\/main\.go$/.test(facts.path)) {
        score += 220;
        reasons.push({ signal: "ecosystem", points: 220, note: "go cmd entrypoint" });
      }
      if (eco === "java" && facts.path.startsWith("src/main/java/")) {
        score += 160;
        reasons.push({ signal: "ecosystem", points: 160, note: "java source" });
      }
      if (eco === "infra" && facts.roles.includes("ci_config")) {
        score += 170;
        reasons.push({ signal: "ecosystem", points: 170, note: "infra CI config" });
      }
      if (eco === "infra" && facts.path.endsWith(".tf")) {
        score += 180;
        reasons.push({ signal: "ecosystem", points: 180, note: "terraform file" });
      }
    }
  }

  return { score: clamp(0, 350, score), reasons };
}

/** 计算 taskRelevanceScore */
export function computeTaskRelevanceScore(
  facts: FileFacts,
  task: TaskContext,
): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];
  let score = 0;

  for (const mentionedPath of task.explicitlyMentionedPaths) {
    if (facts.path === mentionedPath || facts.path.endsWith(mentionedPath)) {
      score += 1000;
      reasons.push({ signal: "task_relevance", points: 1000, note: `exact path mentioned: ${mentionedPath}` });
    }
  }

  for (const mentionedPath of task.explicitlyMentionedPaths) {
    const baseName = path.basename(mentionedPath);
    if (facts.name === baseName && facts.path !== mentionedPath) {
      score += 600;
      reasons.push({ signal: "task_relevance", points: 600, note: `basename mentioned: ${baseName}` });
    }
  }

  for (const term of task.explicitlyMentionedTerms) {
    const termLower = term.toLowerCase();
    if (facts.name.toLowerCase().includes(termLower) || facts.path.toLowerCase().includes(termLower)) {
      score += 300;
      reasons.push({ signal: "task_relevance", points: 300, note: `term matched: "${term}"` });
    }
  }

  for (const term of task.explicitlyMentionedTerms) {
    if (/^pdd/i.test(term) && facts.roles.includes("design_doc")) {
      if (facts.name.toLowerCase().includes(term.toLowerCase())) {
        score += 800;
        reasons.push({ signal: "task_relevance", points: 800, note: `design doc id mentioned: ${term}` });
      }
    }
  }

  for (const mentionedPath of task.explicitlyMentionedPaths) {
    const dir = path.dirname(mentionedPath);
    if (dir !== "." && facts.path.startsWith(dir + "/") && facts.path !== mentionedPath) {
      score += 250;
      reasons.push({ signal: "task_relevance", points: 250, note: `directory mentioned: ${dir}` });
    }
  }

  if (facts.roles.includes("test")) {
    if (["debug", "testing", "review"].includes(task.intent)) {
      score += 250;
      reasons.push({ signal: "task_relevance", points: 250, note: `test file + ${task.intent} task` });
    } else if (task.intent === "orientation") {
      score -= 120;
      reasons.push({ signal: "task_relevance", points: -120, note: "test file - orientation task" });
    }
  }

  return { score: clamp(0, 700, score), reasons };
}

/** 计算 evidenceScore */
export function computeEvidenceScore(
  facts: FileFacts,
  task: TaskContext,
): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];
  let score = 0;

  if (task.stackTraceFiles.includes(facts.path)) {
    score += 900;
    reasons.push({ signal: "evidence", points: 900, note: "stack trace file" });
  }

  if (task.failingFiles.includes(facts.path)) {
    score += 850;
    reasons.push({ signal: "evidence", points: 850, note: "failing test file" });
  }

  if (facts.isGitStaged) {
    score += 720;
    reasons.push({ signal: "evidence", points: 720, note: "git staged file" });
  }

  if (facts.isGitModified) {
    score += 700;
    reasons.push({ signal: "evidence", points: 700, note: "git modified file" });
  }

  if (task.recentFiles.includes(facts.path)) {
    score += 500;
    reasons.push({ signal: "evidence", points: 500, note: "recently read file" });
  }

  if (facts.isCurrentlyOpen || task.openFiles.includes(facts.path)) {
    score += 450;
    reasons.push({ signal: "evidence", points: 450, note: "currently open file" });
  }

  if (task.changedFiles.includes(facts.path)) {
    score += 700;
    reasons.push({ signal: "evidence", points: 700, note: "changed file" });
  }

  return { score: clamp(0, 900, score), reasons };
}

/** 计算 graphScore */
export function computeGraphScore(
  facts: FileFacts,
  task: TaskContext,
): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];
  let score = 0;

  const importedByCount = Math.min(facts.importedBy.length, 8);
  if (importedByCount > 0) {
    const pts = importedByCount * 35;
    score += pts;
    reasons.push({ signal: "graph", points: pts, note: `imported by ${importedByCount} file(s)` });
  }

  const importsCount = Math.min(facts.imports.length, 8);
  if (importsCount > 0) {
    const pts = importsCount * 10;
    score += pts;
    reasons.push({ signal: "graph", points: pts, note: `imports ${importsCount} file(s)` });
  }

  if (facts.pairedFiles.length > 0) {
    const needsTests = ["debug", "testing", "review"].includes(task.intent);
    if (needsTests) {
      score += 160;
      reasons.push({ signal: "graph", points: 160, note: "paired test/source relation" });
    }
  }

  if (
    (facts.roles.includes("manifest") || facts.roles.includes("build_config")) &&
    facts.importedBy.length >= 3
  ) {
    score += 160;
    reasons.push({ signal: "graph", points: 160, note: "central config referenced by many" });
  }

  return { score: clamp(0, 400, score), reasons };
}

/** 计算 recencyScore */
export function computeRecencyScore(facts: FileFacts): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];

  if (facts.isGitModified || facts.isGitStaged) {
    return { score: 0, reasons };
  }

  if (facts.lastModifiedMs === undefined) {
    return { score: 0, reasons };
  }

  const hours = (Date.now() - facts.lastModifiedMs) / 3_600_000;
  const score = clamp(0, 180, Math.round(180 - hours * 4));

  if (score > 0) {
    reasons.push({ signal: "recency", points: score, note: `modified ${hours.toFixed(1)}h ago` });
  }

  return { score, reasons };
}

/** 计算 userSignalScore */
export function computeUserSignalScore(
  facts: FileFacts,
  task: TaskContext,
): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];
  let score = 0;

  if (facts.isCurrentlyOpen) {
    score += 500;
    reasons.push({ signal: "user_signal", points: 500, note: "currently open by user" });
  }

  if (facts.isRecentlyRead) {
    score += 300;
    reasons.push({ signal: "user_signal", points: 300, note: "recently read by user" });
  }

  const queryLower = task.query.toLowerCase();
  if (queryLower.includes(facts.name.toLowerCase()) && facts.name.length > 3) {
    score += 400;
    reasons.push({ signal: "user_signal", points: 400, note: `filename mentioned in query: ${facts.name}` });
  }

  return { score: clamp(0, 1000, score), reasons };
}

/** 计算 noisePenalty */
export function computeNoisePenalty(facts: FileFacts): { score: number; reasons: ScoreReason[] } {
  const reasons: ScoreReason[] = [];
  let penalty = 0;

  if (facts.roles.includes("generated")) {
    penalty -= 800;
    reasons.push({ signal: "noise", points: -800, note: "generated file" });
  }

  if (facts.name.endsWith(".min.js") || facts.name.endsWith(".min.css")) {
    penalty -= 700;
    reasons.push({ signal: "noise", points: -700, note: "minified file" });
  }

  if (facts.roles.includes("binary")) {
    penalty -= 1000;
    reasons.push({ signal: "noise", points: -1000, note: "binary file" });
  }

  if (facts.roles.includes("secret")) {
    penalty -= 1200;
    reasons.push({ signal: "noise", points: -1200, note: "secret/env file" });
  }

  if (facts.sizeBytes > 1_000_000) {
    penalty -= 300;
    reasons.push({ signal: "noise", points: -300, note: "very large file (>1MB)" });
  }

  if (FORBIDDEN_PATHS.has(facts.path)) {
    penalty -= 1000;
    reasons.push({ signal: "noise", points: -1000, note: "forbidden path" });
  }

  return { score: clamp(-1200, 0, penalty), reasons };
}

// ---------------------------------------------------------------------------
// 排序
// ---------------------------------------------------------------------------

/**
 * 排序文件
 *
 * 组合所有信号分数，输出可解释排序。
 * 排序 deterministic：score desc → normalized path asc。
 */
export function rankAllFiles(input: {
  files: FileFacts[];
  repo: RepoClassification;
  task: TaskContext;
  maxResults?: number;
}): RankedFile[] {
  const { files, repo, task, maxResults } = input;
  const ranked: RankedFile[] = [];

  for (const facts of files) {
    if (facts.roles.includes("secret") || facts.roles.includes("binary")) continue;

    const allReasons: ScoreReason[] = [];

    const roleResult = computeRoleScore(facts);
    const ecoResult = computeEcosystemScore(facts, repo);
    const taskResult = computeTaskRelevanceScore(facts, task);
    const evidenceResult = computeEvidenceScore(facts, task);
    const graphResult = computeGraphScore(facts, task);
    const recencyResult = computeRecencyScore(facts);
    const userResult = computeUserSignalScore(facts, task);
    const noiseResult = computeNoisePenalty(facts);

    const totalScore =
      roleResult.score +
      ecoResult.score +
      taskResult.score +
      evidenceResult.score +
      graphResult.score +
      recencyResult.score +
      userResult.score +
      noiseResult.score;

    allReasons.push(...roleResult.reasons);
    allReasons.push(...ecoResult.reasons);
    allReasons.push(...taskResult.reasons);
    allReasons.push(...evidenceResult.reasons);
    allReasons.push(...graphResult.reasons);
    allReasons.push(...recencyResult.reasons);
    allReasons.push(...userResult.reasons);
    allReasons.push(...noiseResult.reasons);

    ranked.push({
      path: facts.path,
      score: totalScore,
      facts,
      reasons: allReasons,
    });
  }

  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path.localeCompare(b.path);
  });

  if (maxResults !== undefined && maxResults > 0) {
    return ranked.slice(0, maxResults);
  }

  return ranked;
}

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createContextRanker — 创建上下文排序器
 *
 * @param projectRoot - 项目根目录
 * @returns ContextRanker 实例
 */
export function createContextRanker(projectRoot: string): ContextRanker {
  return {
    scanFileFacts(): FileFacts[] {
      const files = scanProjectFiles(projectRoot);
      buildImportGraph(files, projectRoot);
      return files;
    },

    classifyRepo(files: FileFacts[]): RepoClassification {
      return classifyRepository(files);
    },

    classifyTask(input): TaskContext {
      return classifyTaskIntent(input);
    },

    rankFiles(input): RankedFile[] {
      return rankAllFiles(input);
    },
  };
}
