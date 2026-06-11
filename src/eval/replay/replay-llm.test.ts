/**
 * replay-llm.test.ts — Replay LLM Client 单元测试
 *
 * 职责：验证 fixture 读取、校验和错误处理路径。
 */

import { describe, it, expect } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplayLLMClient } from "./replay-llm.js";

async function makeTempFixture(content: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "eval-replay-test-"));
  const filePath = join(dir, "fixture.json");
  await writeFile(filePath, JSON.stringify(content), "utf-8");
  return filePath;
}

describe("createReplayLLMClient", () => {
  it("throws on version mismatch", async () => {
    const filePath = await makeTempFixture({
      version: 2,
      caseId: "test-case",
      responses: [],
    });

    await expect(
      createReplayLLMClient({
        caseId: "test-case",
        replayFile: filePath,
        emitEvent: () => {},
      }),
    ).rejects.toThrow(/version mismatch/);

    await rm(join(filePath, ".."), { recursive: true, force: true });
  });

  it("throws on caseId mismatch", async () => {
    const filePath = await makeTempFixture({
      version: 1,
      caseId: "fixture-case",
      responses: [],
    });

    await expect(
      createReplayLLMClient({
        caseId: "different-case",
        replayFile: filePath,
        emitEvent: () => {},
      }),
    ).rejects.toThrow(/caseId mismatch/);

    await rm(join(filePath, ".."), { recursive: true, force: true });
  });

  it("throws with contextual message when fixture file is missing", async () => {
    await expect(
      createReplayLLMClient({
        caseId: "missing-fixture",
        replayFile: "/nonexistent/path/fixture.json",
        emitEvent: () => {},
      }),
    ).rejects.toThrow(/missing-fixture.*\/nonexistent\/path\/fixture\.json/);
  });

  it("throws with contextual message when fixture JSON is invalid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eval-replay-test-"));
    const filePath = join(dir, "bad.json");
    await writeFile(filePath, "{ not valid json", "utf-8");

    await expect(
      createReplayLLMClient({
        caseId: "bad-json",
        replayFile: filePath,
        emitEvent: () => {},
      }),
    ).rejects.toThrow(/bad-json.*bad\.json/);

    await rm(dir, { recursive: true, force: true });
  });
});
