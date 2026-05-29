/**
 * task-store.test.ts — 持久化 TaskStore 测试
 *
 * 覆盖：group id 目录布局、reader/writer 对称校验、跨项目索引重建、
 * 临时文件清理边界。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLogger } from "./logger.js";
import { createTaskStore } from "./task-store.js";
import type { TaskGroupFile } from "./task-store.js";

const logger = createLogger("error");
const PROJECT_ROOT = resolve("/tmp/project-a");
let tempDir: string;

function makeGroup(id: string, projectRoots = [PROJECT_ROOT]): TaskGroupFile {
  return {
    version: 1,
    kind: "task_group",
    id,
    scope: projectRoots.length > 1 ? "multi_project" : "project",
    projectRoots,
    title: "Task Store Test",
    status: "active",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    tasks: [
      {
        id: "task_1",
        subject: "First task",
        status: "pending",
        blockedBy: [],
        owner: "main",
        createdAt: "2026-05-13T00:00:00.000Z",
        updatedAt: "2026-05-13T00:00:00.000Z",
      },
    ],
    events: [],
  };
}

describe("TaskStore", () => {
  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "task-store-test-"));
  });

  afterEach(() => {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("writes task groups under groups/<group_id>/group.json", () => {
    const store = createTaskStore({
      tasksDir: tempDir,
      projectRoot: PROJECT_ROOT,
      logger,
    });
    const group = makeGroup("tg_20260513_000000_task_store");

    store.save(group);

    const filePath = join(
      tempDir,
      "groups",
      "tg_20260513_000000_task_store",
      "group.json",
    );
    expect(existsSync(filePath)).toBe(true);
    expect(JSON.parse(readFileSync(filePath, "utf-8"))).toMatchObject({
      id: group.id,
      kind: "task_group",
    });
  });

  it("skips a group when directory id and content id do not match", () => {
    const groupDir = join(tempDir, "groups", "tg_20260513_000000_outer");
    mkdirSync(groupDir, { recursive: true });
    writeFileSync(
      join(groupDir, "group.json"),
      JSON.stringify(makeGroup("tg_20260513_000000_inner"), null, 2),
    );
    const store = createTaskStore({
      tasksDir: tempDir,
      projectRoot: PROJECT_ROOT,
      logger,
    });

    expect(store.scan()).toEqual([]);
  });

  it("rebuilds index.json from projectRoots", () => {
    const projectB = resolve("/tmp/project-b");
    const store = createTaskStore({
      tasksDir: tempDir,
      projectRoot: PROJECT_ROOT,
      logger,
    });
    store.save(
      makeGroup("tg_20260513_000000_multi_project", [PROJECT_ROOT, projectB]),
    );

    const index = JSON.parse(
      readFileSync(join(tempDir, "index.json"), "utf-8"),
    );
    expect(index.allGroups).toContain("tg_20260513_000000_multi_project");
    expect(Object.values(index.byProjectKey).flat()).toContain(
      "tg_20260513_000000_multi_project",
    );
  });

  it("cleanupTempFiles only removes stale files under .tmp", () => {
    const oldDate = new Date("2026-05-01T00:00:00.000Z");
    const store = createTaskStore({
      tasksDir: tempDir,
      projectRoot: PROJECT_ROOT,
      logger,
      now: () => new Date("2026-05-13T00:00:00.000Z"),
    });
    store.save(makeGroup("tg_20260513_000000_cleanup"));
    const tmpDir = join(
      tempDir,
      "groups",
      "tg_20260513_000000_cleanup",
      ".tmp",
    );
    const tmpFile = join(tmpDir, "old.tmp");
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(tmpFile, "stale");
    utimesSync(tmpFile, oldDate, oldDate);

    store.cleanupTempFiles();

    expect(existsSync(tmpFile)).toBe(false);
    expect(
      existsSync(
        join(tempDir, "groups", "tg_20260513_000000_cleanup", "group.json"),
      ),
    ).toBe(true);
  });
});
