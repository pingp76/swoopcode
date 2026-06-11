import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createOutputStore } from "../output-store.js";
import { createOutputToolProvider } from "./output.js";

describe("OutputToolProvider", () => {
  const outputDir = join(tmpdir(), "agent-output-tool-test");

  beforeEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
    await mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  function createProvider() {
    const store = createOutputStore({
      outputDir,
      clock: () => new Date("2026-05-28T15:30:00.000"),
      idGenerator: () => "abc123",
    });
    return { store, provider: createOutputToolProvider(store) };
  }

  it("exposes run_output_read", () => {
    const { provider } = createProvider();
    expect(provider.toolEntries).toHaveLength(1);
    expect(provider.toolEntries[0]!.definition.function.name).toBe(
      "run_output_read",
    );
  });

  it("reads a registered output", async () => {
    const { store, provider } = createProvider();
    const record = store.writeText({
      sourceKind: "tool_result",
      sourceId: "call_1",
      content: "hello from output store",
    });

    const result = await provider.toolEntries[0]!.execute({
      output_id: record.id,
    });

    expect(result.error).toBe(false);
    expect(result.output).toContain('"type": "output_read"');
    expect(result.output).toContain(
      '"output_id": "out_20260528_153000_abc123"',
    );
    expect(result.output).toContain("hello from output store");
  });

  it("returns tool error for invalid output id", async () => {
    const { provider } = createProvider();

    const result = await provider.toolEntries[0]!.execute({
      output_id: "../secret",
    });

    expect(result.error).toBe(true);
    expect(result.output).toContain("Invalid output_id");
  });

  it("validates numeric chunk options", async () => {
    const { provider } = createProvider();

    const result = await provider.toolEntries[0]!.execute({
      output_id: "out_20260528_153000_abc123",
      start_byte: -1,
    });

    expect(result.error).toBe(true);
    expect(result.output).toContain("start_byte");
  });
});
