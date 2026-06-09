/**
 * workspace.ts — Eval 临时工作区管理
 *
 * 职责：为每个 eval case 创建独立的临时目录，管理初始文件和路径安全。
 *
 * 设计原则：
 * - 使用 OS tmp 目录，避免污染仓库
 * - 所有路径操作都做边界检查，防止 `..` 逃逸
 * - 默认 case 结束后自动清理
 */

import { mkdtemp, mkdir, writeFile, readFile, access, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, isAbsolute } from "node:path";
import type { EvalWorkspacePlan } from "./case-schema.js";

/** Eval 工作区接口 */
export interface EvalWorkspace {
  /** 工作区根目录绝对路径 */
  root: string;
  /** 读取文件内容 */
  readFile(path: string): Promise<string>;
  /** 判断文件是否存在 */
  exists(path: string): Promise<boolean>;
  /** 清理工作区（删除临时目录） */
  cleanup(): Promise<void>;
}

/**
 * createEvalWorkspace — 创建 Eval 临时工作区
 *
 * @param plan - 可选的 workspace 计划，包含 initialFiles 等
 * @returns EvalWorkspace 实例
 *
 * 行为要求：
 * 1. 使用 mkdtemp 在 OS tmp 目录创建 case 独立目录
 * 2. initialFiles 中的路径必须是相对路径，拒绝绝对路径和 `..` 逃逸
 * 3. 写入 initial files 时自动创建父目录
 * 4. readFile 和 exists 也必须做路径边界检查
 * 5. 默认 case 结束后 cleanup
 * 6. 如果 case 失败且 keepOnFailure 为 true，则保留目录
 */
export async function createEvalWorkspace(
  plan?: EvalWorkspacePlan,
): Promise<EvalWorkspace> {
  // 在系统临时目录下创建以 "eval-" 为前缀的独立目录
  const root = await mkdtemp(join(tmpdir(), "eval-"));

  // 如果提供了初始文件，逐个写入
  if (plan?.initialFiles) {
    for (const [relativePath, content] of Object.entries(plan.initialFiles)) {
      // 路径安全检查：拒绝绝对路径和目录遍历
      validateWorkspacePath(relativePath);
      const absolutePath = join(root, relativePath);
      // 自动创建父目录，确保嵌套路径能正常写入
      await mkdir(dirname(absolutePath), { recursive: true });
      await writeFile(absolutePath, content, "utf-8");
    }
  }

  return {
    root,

    async readFile(path: string): Promise<string> {
      validateWorkspacePath(path);
      const absolutePath = join(root, path);
      return readFile(absolutePath, "utf-8");
    },

    async exists(path: string): Promise<boolean> {
      validateWorkspacePath(path);
      const absolutePath = join(root, path);
      try {
        await access(absolutePath);
        return true;
      } catch {
        return false;
      }
    },

    async cleanup(): Promise<void> {
      // 递归删除临时目录及其全部内容
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * validateWorkspacePath — 验证路径是否安全
 *
 * 拒绝条件：
 * - 绝对路径（如 /etc/passwd）
 * - 包含 `..` 的相对路径（目录遍历攻击）
 *
 * @param path - 待验证的路径（应为相对路径）
 * @throws Error 如果路径不安全
 */
function validateWorkspacePath(path: string): void {
  if (isAbsolute(path)) {
    throw new Error(`Workspace path must be relative, got absolute: ${path}`);
  }
  // 使用 split 检查路径组件，避免 `a../b` 这类合法路径被误报为目录遍历
  const parts = path.split(/[/\\]/);
  if (parts.some((p) => p === "..")) {
    throw new Error(`Workspace path must not contain '..': ${path}`);
  }
}
