/**
 * log-rotation.ts — 简单日志轮转工具
 *
 * 职责：在日志文件超过大小上限时，把当前文件依次移动为 `.1`、`.2`……
 * 防止长期运行的 Agent 因为 append-only 日志无限增长。
 *
 * 这个模块刻意保持很轻：不压缩、不按日期切分、不做后台清理任务。
 * 对教学 Agent 来说，固定大小 + 固定份数已经足够表达运行态保留策略。
 */

import * as fs from "node:fs";

export interface LogRotationOptions {
  maxFileBytes: number;
  keepFiles: number;
  onWarning?: (message: string) => void;
}

/**
 * rotateLogFileIfNeeded — 如果日志文件超过阈值则执行轮转
 *
 * 轮转顺序从旧到新倒着移动，避免先覆盖较新的 `.1`。
 * 例如 keepFiles=3 时：
 * - 删除 file.3
 * - file.2 -> file.3
 * - file.1 -> file.2
 * - file   -> file.1
 */
export function rotateLogFileIfNeeded(
  logFile: string,
  options: LogRotationOptions,
): void {
  // 对配置做最小归一化：大小至少 1 byte，保留份数不能为负。
  // 这让调用方即使传入异常值，也不会让轮转逻辑进入奇怪状态。
  const maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes));
  const keepFiles = Math.max(0, Math.floor(options.keepFiles));

  try {
    if (!fs.existsSync(logFile)) return;
    const stat = fs.statSync(logFile);
    // 未达到阈值时直接返回，避免每条日志都触发文件重命名。
    if (stat.size < maxFileBytes) return;

    if (keepFiles === 0) {
      // keepFiles=0 表示不保留历史，超限时直接删除当前日志。
      fs.rmSync(logFile, { force: true });
      return;
    }

    // 先删除最老的一份，为后续 .(n-1) -> .n 腾出位置。
    const oldest = `${logFile}.${keepFiles}`;
    fs.rmSync(oldest, { force: true });

    // 从旧到新倒序移动，避免 file.1 过早覆盖 file.2。
    for (let i = keepFiles - 1; i >= 1; i--) {
      const from = `${logFile}.${i}`;
      const to = `${logFile}.${i + 1}`;
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    }

    // 最后把当前日志移动成 .1；调用方随后 append 时会自动创建新的 logFile。
    fs.renameSync(logFile, `${logFile}.1`);
  } catch (error) {
    // 日志轮转失败不应让主功能失败，只通过 warning 暴露给调用方。
    options.onWarning?.(`Log rotation failed for ${logFile}: ${String(error)}`);
  }
}
