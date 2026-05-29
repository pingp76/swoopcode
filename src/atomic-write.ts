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
  // 先把调用方传入的路径规范成绝对路径。
  // 后续 dirname/basename 都基于 finalPath，避免相对路径受 cwd 变化影响。
  const finalPath = path.resolve(filePath);
  const dir = path.dirname(finalPath);
  fs.mkdirSync(dir, { recursive: true });

  const tmpPath = createTempPath(finalPath);
  try {
    // 先写临时文件，再 rename 到正式文件名。
    // 在同一目录内 rename 通常是原子的：读者要么看到旧文件，要么看到新文件。
    fs.writeFileSync(tmpPath, content, "utf-8");
    fs.renameSync(tmpPath, finalPath);
  } catch (error) {
    // 如果写入或 rename 中途失败，尽力删除临时文件。
    // 这里不吞掉原始错误，调用方仍然需要知道保存失败。
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
    // 读回并 parse 一次，是为了发现“序列化结果不是合法 JSON 文件”的底层问题。
    // 业务字段是否合理仍然由 TaskStore/ScheduleStore/OutputStore 自己检查。
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
  // pid + 随机后缀降低并发写同一文件时临时文件名碰撞概率。
  const suffix = randomBytes(4).toString("hex");
  return path.join(dir, `.tmp-${base}-${process.pid}-${suffix}`);
}
