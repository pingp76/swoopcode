/**
 * atomic-write.ts — 运行态文件的原子写入工具
 *
 * 职责：为 TaskStore、ScheduleStore、OutputStore 等持久化模块提供统一的
 * “先写临时文件、再 rename 覆盖正式文件”能力。
 *
 * 为什么单独抽出这个小模块？
 * - 这些 store 的业务校验各不相同，不适合过早抽成通用 JsonEntityStore。
 * - 但它们都有同一个底层风险：进程在写 JSON 中途退出，留下半截文件。
 * - 将原子写入收敛到这里，可以让教学代码保留各 store 的清晰边界，
 *   同时避免每个模块重复实现易错的临时文件流程。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomBytes } from "node:crypto";

/**
 * atomicWriteTextFile — 原子写入文本文件
 *
 * 临时文件放在目标文件同一目录下，确保 rename 尽可能发生在同一个文件系统内。
 * 失败时会尽力删除临时文件，避免长期运行后留下越来越多的写入残片。
 */
export function atomicWriteTextFile(filePath: string, content: string): void {
  const finalPath = path.resolve(filePath);
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = createTempPath(finalPath);
  try {
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

/**
 * atomicWriteJsonFile — 原子写入 JSON 文件
 *
 * 写入临时文件后会重新读取并 JSON.parse 一次，再 rename 到正式路径。
 * 这一步不是业务 schema 校验；业务校验仍由调用方负责。它只保证“即将落盘的
 * JSON 至少是语法完整的”，避免 writer 写出自己下一次连 parse 都 parse 不了的文件。
 */
export function atomicWriteJsonFile(filePath: string, value: unknown): void {
  const finalPath = path.resolve(filePath);
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = createTempPath(finalPath);
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    JSON.parse(fs.readFileSync(tmpPath, "utf-8")) as unknown;
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}

function createTempPath(finalPath: string): string {
  const dir = path.dirname(finalPath);
  const base = path.basename(finalPath);
  const suffix = randomBytes(4).toString("hex");
  return path.join(dir, `.tmp-${base}-${process.pid}-${suffix}`);
}
