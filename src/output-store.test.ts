import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOutputStore } from "./output-store.js";

describe("OutputStore", () => {
  const outputDir = join(tmpdir(), "agent-output-store-test");
  const now = new Date("2026-05-28T15:30:00.000");

  beforeEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  function createTestStore() {
    return createOutputStore({
      outputDir,
      clock: () => now,
      idGenerator: () => "abc123",
    });
  }

  it("writes text output and reads it back by output id", () => {
    const store = createTestStore();
    const record = store.writeText({
      sourceKind: "tool_result",
      sourceId: "call_1",
      toolName: "run_bash",
      projectRoot: "/project",
      content: "hello output",
    });

    expect(record.id).toBe("out_20260528_153000_abc123");
    expect(record.relativePath).toBe("outputs/out_20260528_153000_abc123.txt");
    expect(record.byteLength).toBe(Buffer.byteLength("hello output", "utf-8"));

    const result = store.read({ outputId: record.id });
    expect(result.content).toBe("hello output");
    expect(result.truncated).toBe(false);
  });

  it("persists source metadata in index", async () => {
    const store = createTestStore();
    const record = store.writeText({
      sourceKind: "async_run",
      sourceId: "ar_1",
      runId: "ar_1",
      content: "async output",
    });

    const raw = await readFile(join(outputDir, "index.json"), "utf-8");
    expect(raw).toContain(record.id);
    expect(raw).toContain('"sourceKind": "async_run"');
    expect(raw).toContain('"runId": "ar_1"');
  });

  it("supports maxBytes truncation", () => {
    const store = createTestStore();
    const record = store.writeText({
      sourceKind: "tool_result",
      sourceId: "call_1",
      content: "abcdef",
    });

    const result = store.read({ outputId: record.id, maxBytes: 3 });
    expect(result.content).toBe("abc");
    expect(result.returnedBytes).toBe(3);
    expect(result.truncated).toBe(true);
  });

  it("supports startByte for reading later chunks", () => {
    const store = createTestStore();
    const record = store.writeText({
      sourceKind: "tool_result",
      sourceId: "call_1",
      content: "abcdef",
    });

    const result = store.read({
      outputId: record.id,
      startByte: 2,
      maxBytes: 3,
    });
    expect(result.content).toBe("cde");
    expect(result.startByte).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it("rejects invalid output id", () => {
    const store = createTestStore();
    expect(() => store.read({ outputId: "../secret" })).toThrow(
      "Invalid output_id",
    );
  });

  it("rejects index records whose path escapes output directory", async () => {
    const id = "out_20260528_153000_abc123";
    await writeFile(
      join(outputDir, "index.json"),
      JSON.stringify(
        {
          version: 1,
          kind: "output_index",
          records: [
            {
              version: 1,
              kind: "output_record",
              id,
              sourceKind: "tool_result",
              sourceId: "call_1",
              createdAt: now.toISOString(),
              relativePath: "../secret.txt",
              byteLength: 6,
              contentType: "text/plain",
            },
          ],
        },
        null,
        2,
      ),
    );

    const store = createTestStore();
    expect(() => store.read({ outputId: id })).toThrow("not safe");
  });

  it("reports a missing registered output file", async () => {
    const id = "out_20260528_153000_abc123";
    await writeFile(
      join(outputDir, "index.json"),
      JSON.stringify(
        {
          version: 1,
          kind: "output_index",
          records: [
            {
              version: 1,
              kind: "output_record",
              id,
              sourceKind: "tool_result",
              sourceId: "call_1",
              createdAt: now.toISOString(),
              relativePath: "outputs/out_20260528_153000_abc123.txt",
              byteLength: 6,
              contentType: "text/plain",
            },
          ],
        },
        null,
        2,
      ),
    );

    const store = createTestStore();
    expect(() => store.read({ outputId: id })).toThrow("Output file missing");
  });
});
