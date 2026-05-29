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
  const maxFileBytes = Math.max(1, Math.floor(options.maxFileBytes));
  const keepFiles = Math.max(0, Math.floor(options.keepFiles));

  try {
    if (!fs.existsSync(logFile)) return;
    const stat = fs.statSync(logFile);
    if (stat.size < maxFileBytes) return;

    if (keepFiles === 0) {
      fs.rmSync(logFile, { force: true });
      return;
    }

    const oldest = `${logFile}.${keepFiles}`;
    fs.rmSync(oldest, { force: true });

    for (let i = keepFiles - 1; i >= 1; i--) {
      const from = `${logFile}.${i}`;
      const to = `${logFile}.${i + 1}`;
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
      }
    }

    fs.renameSync(logFile, `${logFile}.1`);
  } catch (error) {
    options.onWarning?.(`Log rotation failed for ${logFile}: ${String(error)}`);
  }
}
