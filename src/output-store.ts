/**
 * output-store.ts — Agent 大输出登记与读取
 *
 * 职责：管理 Agent 自身保存的大输出文件，并给 LLM 暴露稳定的 output_id。
 *
 * 这个模块刻意不复用 run_read：
 * - run_read 读取的是 projectRoot 内的用户项目文件。
 * - OutputStore 读取的是 agentHome 下由 Agent 自己登记过的运行输出。
 *
 * 因此安全边界不是“路径在项目内”，而是“output_id 必须存在于 index，
 * 且 index 记录的 relativePath 仍然落在 outputDir 内”。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, sep } from "node:path";
import { atomicWriteJsonFile, atomicWriteTextFile } from "./atomic-write.js";

// ---------------------------------------------------------------------------
// 类型定义
// ---------------------------------------------------------------------------

export type OutputSourceKind =
  | "tool_result"
  | "async_run"
  | "schedule_occurrence";

export interface OutputRecord {
  version: 1;
  kind: "output_record";
  id: string;
  sourceKind: OutputSourceKind;
  sourceId: string;
  createdAt: string;
  relativePath: string;
  byteLength: number;
  contentType: "text/plain";
  projectRoot?: string;
  toolName?: string;
  runId?: string;
  scheduleId?: string;
  occurrenceId?: string;
}

export interface WriteTextOutputInput {
  sourceKind: OutputSourceKind;
  sourceId: string;
  content: string;
  projectRoot?: string;
  toolName?: string;
  runId?: string;
  scheduleId?: string;
  occurrenceId?: string;
}

export interface ReadOutputInput {
  outputId: string;
  maxBytes?: number;
  startByte?: number;
}

export interface ReadOutputResult {
  id: string;
  content: string;
  byteLength: number;
  startByte: number;
  returnedBytes: number;
  truncated: boolean;
}

export interface OutputStore {
  writeText(input: WriteTextOutputInput): OutputRecord;
  read(input: ReadOutputInput): ReadOutputResult;
  get(outputId: string): OutputRecord | null;
}

export interface OutputStoreOptions {
  outputDir: string;
  clock?: () => Date;
  idGenerator?: () => string;
  maxReadBytes?: number;
}

interface OutputIndexFile {
  version: 1;
  kind: "output_index";
  records: OutputRecord[];
}

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

export const OUTPUT_ID_REGEX = /^out_[0-9]{8}_[0-9]{6}_[a-z0-9]{6}$/;

const DEFAULT_MAX_READ_BYTES = 200_000;
const HARD_MAX_READ_BYTES = 1_000_000;
const INDEX_FILE_NAME = "index.json";
const OUTPUTS_DIR_NAME = "outputs";

// ---------------------------------------------------------------------------
// 工厂函数
// ---------------------------------------------------------------------------

/**
 * createOutputStore — 创建输出存储
 *
 * @param options.outputDir - Agent 全局大输出目录，通常是 ProjectContext.taskOutputsDir
 */
export function createOutputStore(options: OutputStoreOptions): OutputStore {
  const outputDir = resolve(options.outputDir);
  const outputsDir = resolve(outputDir, OUTPUTS_DIR_NAME);
  const indexPath = resolve(outputDir, INDEX_FILE_NAME);
  const clock = options.clock ?? (() => new Date());
  const maxReadBytes = Math.min(
    options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
    HARD_MAX_READ_BYTES,
  );

  function loadRecords(): Map<string, OutputRecord> {
    const index = readIndex(indexPath);
    const records = new Map<string, OutputRecord>();
    for (const record of index.records) {
      validateRecord(record);
      ensureRelativePathWithinOutputDir(record.relativePath, outputDir);
      records.set(record.id, cloneRecord(record));
    }
    return records;
  }

  function saveRecords(records: Map<string, OutputRecord>): void {
    const index: OutputIndexFile = {
      version: 1,
      kind: "output_index",
      records: Array.from(records.values()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
    };
    atomicWriteJsonFile(indexPath, index);
  }

  function createOutputId(existing: Map<string, OutputRecord>): string {
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = formatOutputId(
        clock(),
        options.idGenerator?.() ?? randomBytes(3).toString("hex"),
      );
      if (!existing.has(candidate)) return candidate;
    }
    throw new Error("Unable to generate unique output_id");
  }

  return {
    writeText(input: WriteTextOutputInput): OutputRecord {
      const records = loadRecords();
      const id = createOutputId(records);
      const relativePath = `${OUTPUTS_DIR_NAME}/${id}.txt`;
      const filePath = ensureRelativePathWithinOutputDir(relativePath, outputDir);

      const record: OutputRecord = {
        version: 1,
        kind: "output_record",
        id,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        createdAt: clock().toISOString(),
        relativePath,
        byteLength: Buffer.byteLength(input.content, "utf-8"),
        contentType: "text/plain",
      };

      if (input.projectRoot !== undefined) record.projectRoot = input.projectRoot;
      if (input.toolName !== undefined) record.toolName = input.toolName;
      if (input.runId !== undefined) record.runId = input.runId;
      if (input.scheduleId !== undefined) record.scheduleId = input.scheduleId;
      if (input.occurrenceId !== undefined) record.occurrenceId = input.occurrenceId;

      try {
        mkdirSync(outputsDir, { recursive: true });
        atomicWriteTextFile(filePath, input.content);
        records.set(id, record);
        saveRecords(records);
        return cloneRecord(record);
      } catch (err) {
        rmSync(filePath, { force: true });
        throw err;
      }
    },

    read(input: ReadOutputInput): ReadOutputResult {
      const outputId = input.outputId;
      if (!OUTPUT_ID_REGEX.test(outputId)) {
        throw new Error(`Invalid output_id format: ${outputId}`);
      }

      const record = loadRecords().get(outputId);
      if (!record) {
        throw new Error(`Output not found: ${outputId}`);
      }

      const filePath = ensureRelativePathWithinOutputDir(
        record.relativePath,
        outputDir,
      );
      if (!existsSync(filePath)) {
        throw new Error(`Output file missing for output_id: ${outputId}`);
      }

      const startByte = normalizeStartByte(input.startByte);
      const requestedMax = normalizeMaxBytes(input.maxBytes, maxReadBytes);
      const content = readFileSync(filePath);
      const safeStart = Math.min(startByte, content.length);
      const end = Math.min(content.length, safeStart + requestedMax);
      const slice = content.subarray(safeStart, end);

      return {
        id: outputId,
        content: slice.toString("utf-8"),
        byteLength: content.length,
        startByte: safeStart,
        returnedBytes: slice.length,
        truncated: end < content.length,
      };
    },

    get(outputId: string): OutputRecord | null {
      if (!OUTPUT_ID_REGEX.test(outputId)) return null;
      return loadRecords().get(outputId) ?? null;
    },
  };
}

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

function readIndex(indexPath: string): OutputIndexFile {
  if (!existsSync(indexPath)) {
    return { version: 1, kind: "output_index", records: [] };
  }

  const raw = readFileSync(indexPath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    (parsed as { version?: unknown }).version !== 1 ||
    (parsed as { kind?: unknown }).kind !== "output_index" ||
    !Array.isArray((parsed as { records?: unknown }).records)
  ) {
    throw new Error("Invalid output index file");
  }

  return parsed as OutputIndexFile;
}

function validateRecord(record: OutputRecord): void {
  if (record.version !== 1 || record.kind !== "output_record") {
    throw new Error(`Invalid output record kind/version: ${record.id}`);
  }
  if (!OUTPUT_ID_REGEX.test(record.id)) {
    throw new Error(`Invalid output_id in index: ${record.id}`);
  }
  if (
    record.sourceKind !== "tool_result" &&
    record.sourceKind !== "async_run" &&
    record.sourceKind !== "schedule_occurrence"
  ) {
    throw new Error(`Invalid output sourceKind: ${record.sourceKind}`);
  }
  if (typeof record.sourceId !== "string" || record.sourceId.length === 0) {
    throw new Error(`Invalid output sourceId: ${record.id}`);
  }
  if (typeof record.relativePath !== "string" || record.relativePath.length === 0) {
    throw new Error(`Invalid output relativePath: ${record.id}`);
  }
  if (!Number.isInteger(record.byteLength) || record.byteLength < 0) {
    throw new Error(`Invalid output byteLength: ${record.id}`);
  }
}

function ensureRelativePathWithinOutputDir(
  relativePath: string,
  outputDir: string,
): string {
  if (relativePath.startsWith("/") || relativePath.includes("..")) {
    throw new Error(`Output relativePath is not safe: ${relativePath}`);
  }

  const resolvedPath = resolve(outputDir, relativePath);
  if (resolvedPath !== outputDir && !resolvedPath.startsWith(outputDir + sep)) {
    throw new Error(`Output path escapes output directory: ${relativePath}`);
  }
  return resolvedPath;
}

function formatOutputId(date: Date, suffix: string): string {
  const safeSuffix = suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 6);
  if (safeSuffix.length !== 6) {
    throw new Error("output id suffix must contain 6 alphanumeric characters");
  }

  const yyyy = String(date.getFullYear()).padStart(4, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mi = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `out_${yyyy}${mm}${dd}_${hh}${mi}${ss}_${safeSuffix}`;
}

function normalizeMaxBytes(value: number | undefined, defaultValue: number): number {
  if (value === undefined) return defaultValue;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("max_bytes must be a positive number");
  }
  return Math.min(Math.floor(value), HARD_MAX_READ_BYTES);
}

function normalizeStartByte(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("start_byte must be a non-negative number");
  }
  return Math.floor(value);
}

function cloneRecord(record: OutputRecord): OutputRecord {
  return { ...record };
}
