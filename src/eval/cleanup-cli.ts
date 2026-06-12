/**
 * cleanup-cli.ts — Eval 临时产物清理命令
 *
 * 职责：把 temp-cleanup.ts 暴露成 npm 脚本入口，便于本地和 CI 定期执行。
 *
 * 用法：
 * - npm run eval:cleanup
 * - npm run eval:cleanup -- --older-than 24h
 * - npm run eval:cleanup -- --dry-run
 */

import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  cleanupEvalArtifacts,
  DEFAULT_EVAL_ARTIFACT_TTL_MS,
  parseEvalCleanupDuration,
} from "./core/temp-cleanup.js";

interface CleanupCliOptions {
  rootDir: string;
  olderThanMs: number;
  dryRun: boolean;
}

async function main(argv: string[]): Promise<void> {
  const options = parseArgs(argv);
  const result = await cleanupEvalArtifacts(options);

  console.log(
    [
      `Eval cleanup root: ${result.rootDir}`,
      `Mode: ${result.dryRun ? "dry-run" : "delete"}`,
      `Scanned: ${result.scanned}`,
      `Deleted: ${result.deleted.length}`,
      `Kept: ${result.kept.length}`,
      `Errors: ${result.errors.length}`,
    ].join("\n"),
  );

  for (const entry of result.deleted) {
    console.log(`[deleted] ${entry.path} (${entry.reason})`);
  }
  for (const error of result.errors) {
    console.error(`[error] ${error.path}: ${error.message}`);
  }

  if (result.errors.length > 0) {
    process.exitCode = 1;
  }
}

function parseArgs(argv: string[]): CleanupCliOptions {
  const options: CleanupCliOptions = {
    rootDir: process.env["EVAL_TEMP_ROOT"] ?? tmpdir(),
    olderThanMs: DEFAULT_EVAL_ARTIFACT_TTL_MS,
    dryRun: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    if (arg === "--root") {
      options.rootDir = readNextArg(argv, i, "--root");
      i++;
      continue;
    }
    if (arg.startsWith("--root=")) {
      options.rootDir = arg.slice("--root=".length);
      continue;
    }
    if (arg === "--older-than") {
      options.olderThanMs = parseEvalCleanupDuration(
        readNextArg(argv, i, "--older-than"),
      );
      i++;
      continue;
    }
    if (arg.startsWith("--older-than=")) {
      options.olderThanMs = parseEvalCleanupDuration(
        arg.slice("--older-than=".length),
      );
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readNextArg(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}

function printHelp(): void {
  console.log(`Usage: npm run eval:cleanup -- [options]

Options:
  --older-than <duration>  Delete artifacts older than this duration. Default: 7d.
                           Supported units: ms, s, m, h, d.
  --dry-run               Print what would be deleted without deleting.
  --root <path>           Scan this directory instead of EVAL_TEMP_ROOT or OS tmpdir.
  -h, --help              Show this help.
`);
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] === currentFile) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}
