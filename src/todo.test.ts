/**
 * todo.test.ts — TodoManager 模块的单元测试
 *
 * 覆盖内容：
 * - 创建 todo list（run_todo_create）
 * - 更新 task 状态（run_todo_update：in_progress / completed / skipped）
 * - 自动中断之前的 in_progress task
 * - 添加/删除 task（run_todo_add / run_todo_remove）
 * - 查看列表（run_todo_list）
 * - 取消列表（run_todo_cancel）
 * - 所有 task 完成后自动标记 list 为 completed
 * - tickRound 轮次计数与中断机制
 * - 中断后的恢复流程
 * - 格式化输出
 */

import { describe, it, expect } from "vitest";
import { createTodoManager } from "./todo.js";

/**
 * 辅助函数：从 tool entry 中按工具名获取 execute 函数
 *
 * 因为 createTodoManager 返回的 toolEntries 数组包含 6 个工具，
 * 这个函数通过名称找到对应的 executor，方便在测试中调用。
 */
function getExecutor(
  manager: ReturnType<typeof createTodoManager>,
  name: string,
) {
  const entry = manager.toolEntries.find(
    (e) => e.definition.function.name === name,
  );
  if (!entry) throw new Error(`Tool "${name}" not found`);
  return entry.execute;
}

describe("TodoManager", () => {
  // ================================================================
  // run_todo_create — 创建 todo list
  // ================================================================
  describe("create", () => {
    it("应该创建包含多个 task 的 todo list", async () => {
      const manager = createTodoManager();
      const exec = getExecutor(manager, "run_todo_create");

      const result = await exec({
        tasks: ["分析需求", "设计模型", "实现代码"] as unknown as string,
      });

      expect(result.error).toBe(false);
      // 验证格式化输出包含所有 task
      expect(result.output).toContain("[ ] task_1: 分析需求");
      expect(result.output).toContain("[ ] task_2: 设计模型");
      expect(result.output).toContain("[ ] task_3: 实现代码");
      // 验证统计行
      expect(result.output).toContain("(0/3 completed)");
    });

    it("创建新 list 时应自动取消已有的活跃 list", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");

      // 创建第一个 list
      await create({
        tasks: ["任务A", "任务B"] as unknown as string,
      });

      // 创建第二个 list（应自动取消第一个）
      const result = await create({
        tasks: ["任务C"] as unknown as string,
      });

      expect(result.error).toBe(false);
      // 第二个 list 只有一个 task
      expect(result.output).toContain("[ ] task_3: 任务C");
      expect(result.output).toContain("(0/1 completed)");
      // 不应该包含第一个 list 的 task
      expect(result.output).not.toContain("任务A");
    });
  });

  // ================================================================
  // run_todo_update — 更新 task 状态
  // ================================================================
  describe("update", () => {
    it("应该将 task 标记为 in_progress", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A"] as unknown as string,
      });

      const result = await update({
        task_id: "task_1",
        status: "in_progress",
      });

      expect(result.error).toBe(false);
      expect(result.output).toContain("[>] task_1: 任务A");
    });

    it("应该将 task 标记为 completed", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A"] as unknown as string,
      });
      await update({ task_id: "task_1", status: "in_progress" });

      const result = await update({
        task_id: "task_1",
        status: "completed",
      });

      expect(result.error).toBe(false);
      expect(result.output).toContain("[x] task_1: 任务A");
      // 所有 task 完成后，list 自动变为 completed
      expect(result.output).toContain("(1/1 completed)");
    });

    it("应该将 task 标记为 skipped", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A", "任务B"] as unknown as string,
      });

      const result = await update({
        task_id: "task_1",
        status: "skipped",
      });

      expect(result.error).toBe(false);
      expect(result.output).toContain("[-] task_1: 任务A");
      expect(result.output).toContain("1 skipped");
    });

    it("标记 in_progress 时应自动中断之前的 in_progress task", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A", "任务B"] as unknown as string,
      });

      // 先把 task_1 设为 in_progress
      await update({ task_id: "task_1", status: "in_progress" });

      // 再把 task_2 设为 in_progress，task_1 应自动变为 interrupted
      const result = await update({
        task_id: "task_2",
        status: "in_progress",
      });

      expect(result.error).toBe(false);
      // task_1 应该被自动中断
      expect(result.output).toContain("[!] task_1: 任务A");
      // task_2 应该是 in_progress
      expect(result.output).toContain("[>] task_2: 任务B");
    });

    it("应该支持附带 note", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A"] as unknown as string,
      });

      const result = await update({
        task_id: "task_1",
        status: "in_progress",
        note: "正在分析需求",
      });

      expect(result.error).toBe(false);
      expect(result.output).toContain("(正在分析需求)");
    });

    it("没有活跃 list 时应返回错误", async () => {
      const manager = createTodoManager();
      const update = getExecutor(manager, "run_todo_update");

      const result = await update({
        task_id: "task_1",
        status: "in_progress",
      });

      expect(result.error).toBe(true);
      expect(result.output).toContain("No active todo list");
    });

    it("task 不存在时应返回错误", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A"] as unknown as string,
      });

      const result = await update({
        task_id: "task_999",
        status: "in_progress",
      });

      expect(result.error).toBe(true);
      expect(result.output).toContain("not found");
    });

    it("无效状态应返回错误", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A"] as unknown as string,
      });

      const result = await update({
        task_id: "task_1",
        status: "invalid_status",
      });

      expect(result.error).toBe(true);
      expect(result.output).toContain("Invalid status");
    });

    it("所有 task 完成后 list 应自动变为 completed", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A", "任务B"] as unknown as string,
      });

      await update({ task_id: "task_1", status: "completed" });
      const result = await update({
        task_id: "task_2",
        status: "completed",
      });

      expect(result.error).toBe(false);
      expect(result.output).toContain("(2/2 completed)");

      // list 已完成，再 update 应该报错
      const updateResult = await update({
        task_id: "task_1",
        status: "in_progress",
      });
      expect(updateResult.error).toBe(true);
    });
  });

  // ================================================================
  // run_todo_add — 添加新 task
  // ================================================================
  describe("add", () => {
    it("应该追加新 task 到末尾", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const add = getExecutor(manager, "run_todo_add");

      await create({
        tasks: ["任务A"] as unknown as string,
      });

      const result = await add({ task: "新增任务" });

      expect(result.error).toBe(false);
      expect(result.output).toContain("[ ] task_1: 任务A");
      expect(result.output).toContain("[ ] task_2: 新增任务");
      expect(result.output).toContain("(0/2 completed)");
    });

    it("应该在指定 task 之后插入", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const add = getExecutor(manager, "run_todo_add");

      await create({
        tasks: ["任务A", "任务C"] as unknown as string,
      });

      // 在 task_1（任务A）之后插入
      const result = await add({
        task: "任务B",
        after_task_id: "task_1",
      });

      expect(result.error).toBe(false);
      // 验证输出中的顺序：A, B, C
      const lines = result.output.split("\n").filter((l) => l.startsWith("["));
      expect(lines[0]).toContain("任务A");
      expect(lines[1]).toContain("任务B");
      expect(lines[2]).toContain("任务C");
    });

    it("没有活跃 list 时应返回错误", async () => {
      const manager = createTodoManager();
      const add = getExecutor(manager, "run_todo_add");

      const result = await add({ task: "新任务" });

      expect(result.error).toBe(true);
      expect(result.output).toContain("No active todo list");
    });

    it("after_task_id 不存在时应返回错误", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const add = getExecutor(manager, "run_todo_add");

      await create({
        tasks: ["任务A"] as unknown as string,
      });

      const result = await add({
        task: "新任务",
        after_task_id: "task_999",
      });

      expect(result.error).toBe(true);
      expect(result.output).toContain("not found");
    });
  });

  // ================================================================
  // run_todo_remove — 删除 task
  // ================================================================
  describe("remove", () => {
    it("应该删除 pending 状态的 task", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const remove = getExecutor(manager, "run_todo_remove");

      await create({
        tasks: ["任务A", "任务B"] as unknown as string,
      });

      const result = await remove({ task_id: "task_1" });

      expect(result.error).toBe(false);
      expect(result.output).not.toContain("任务A");
      expect(result.output).toContain("任务B");
      expect(result.output).toContain("(0/1 completed)");
    });

    it("不能删除非 pending 状态的 task", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");
      const remove = getExecutor(manager, "run_todo_remove");

      await create({
        tasks: ["任务A"] as unknown as string,
      });
      await update({ task_id: "task_1", status: "in_progress" });

      const result = await remove({ task_id: "task_1" });

      expect(result.error).toBe(true);
      expect(result.output).toContain("Can only remove pending tasks");
    });

    it("task 不存在时应返回错误", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const remove = getExecutor(manager, "run_todo_remove");

      await create({
        tasks: ["任务A"] as unknown as string,
      });

      const result = await remove({ task_id: "task_999" });

      expect(result.error).toBe(true);
      expect(result.output).toContain("not found");
    });
  });

  // ================================================================
  // run_todo_list — 查看 todo list
  // ================================================================
  describe("list", () => {
    it("idle 状态应返回提示信息", async () => {
      const manager = createTodoManager();
      const list = getExecutor(manager, "run_todo_list");

      const result = await list({});

      expect(result.error).toBe(false);
      expect(result.output).toContain("No todo list active");
    });

    it("应该返回格式化的任务列表", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const list = getExecutor(manager, "run_todo_list");

      await create({
        tasks: ["任务A", "任务B"] as unknown as string,
      });

      const result = await list({});

      expect(result.error).toBe(false);
      expect(result.output).toContain("[ ] task_1: 任务A");
      expect(result.output).toContain("[ ] task_2: 任务B");
      expect(result.output).toContain("(0/2 completed)");
    });
  });

  // ================================================================
  // run_todo_cancel — 取消 todo list
  // ================================================================
  describe("cancel", () => {
    it("应该取消所有未完成的 task", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");
      const cancel = getExecutor(manager, "run_todo_cancel");

      await create({
        tasks: ["任务A", "任务B"] as unknown as string,
      });
      // 先完成 task_1
      await update({ task_id: "task_1", status: "completed" });

      const result = await cancel({});

      expect(result.error).toBe(false);
      // 已完成的不受影响
      expect(result.output).toContain("[x] task_1: 任务A");
      // 未完成的被取消
      expect(result.output).toContain("[_] task_2: 任务B");
    });

    it("没有活跃 list 时应返回错误", async () => {
      const manager = createTodoManager();
      const cancel = getExecutor(manager, "run_todo_cancel");

      const result = await cancel({});

      expect(result.error).toBe(true);
      expect(result.output).toContain("No active todo list");
    });
  });

  // ================================================================
  // tickRound — 轮次计数与中断
  // ================================================================
  describe("tickRound", () => {
    it("没有 active list 时应返回 null", () => {
      const manager = createTodoManager();
      expect(manager.tickRound()).toBeNull();
    });

    it("没有 in_progress task 时应返回 null", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");

      await create({
        tasks: ["任务A"] as unknown as string,
      });

      // task 是 pending 状态，tickRound 应该无操作
      expect(manager.tickRound()).toBeNull();
    });

    it("应该递增 roundCount", async () => {
      const manager = createTodoManager(10);
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A"] as unknown as string,
      });
      await update({ task_id: "task_1", status: "in_progress" });

      // 前 9 次应该返回 null（未达上限）
      for (let i = 0; i < 9; i++) {
        expect(manager.tickRound()).toBeNull();
      }

      // 第 10 次应该触发中断
      const msg = manager.tickRound();
      expect(msg).not.toBeNull();
      expect(msg).toContain("已达到轮次上限");
      expect(msg).toContain("10/10");
    });

    it("达到上限时应中断 task 和 list", async () => {
      // maxRounds = 3，方便测试
      const manager = createTodoManager(3);
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A"] as unknown as string,
      });
      await update({ task_id: "task_1", status: "in_progress" });

      // tick 3 次，第 3 次触发中断
      manager.tickRound(); // 1
      manager.tickRound(); // 2
      const msg = manager.tickRound(); // 3 → 中断

      expect(msg).toContain("任务A");
      expect(msg).toContain("run_todo_update");

      // 验证 task 状态
      const task = manager.getActiveTask();
      expect(task).toBeUndefined(); // 被中断了，不再是 in_progress

      // list 被中断后，应该可以恢复
      const result = await update({
        task_id: "task_1",
        status: "in_progress",
      });
      expect(result.error).toBe(false);
      expect(result.output).toContain("[>] task_1: 任务A");
    });

    it("中断消息应包含恢复选项", async () => {
      const manager = createTodoManager(1);
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["测试任务"] as unknown as string,
      });
      await update({ task_id: "task_1", status: "in_progress" });

      const msg = manager.tickRound();
      expect(msg).toContain('run_todo_update("task_1", "in_progress")');
      expect(msg).toContain('run_todo_update("task_1", "skipped")');
      expect(msg).toContain('run_todo_update("task_1", "completed")');
      expect(msg).toContain("run_todo_cancel");
    });
  });

  // ================================================================
  // getActiveTask — 获取活跃 task
  // ================================================================
  describe("getActiveTask", () => {
    it("没有 in_progress task 时应返回 undefined", () => {
      const manager = createTodoManager();
      expect(manager.getActiveTask()).toBeUndefined();
    });

    it("应该返回当前 in_progress 的 task", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A"] as unknown as string,
      });
      await update({ task_id: "task_1", status: "in_progress" });

      const task = manager.getActiveTask();
      expect(task).toBeDefined();
      expect(task?.id).toBe("task_1");
      expect(task?.status).toBe("in_progress");
    });
  });

  describe("tool descriptions", () => {
    it("distinguishes temporary TODO lists from persistent Task Groups", () => {
      const manager = createTodoManager();
      const createDef = manager.toolEntries.find(
        (entry) => entry.definition.function.name === "run_todo_create",
      )?.definition.function.description;
      const updateDef = manager.toolEntries.find(
        (entry) => entry.definition.function.name === "run_todo_update",
      )?.definition.function.description;

      expect(createDef).toContain("temporary TODO list");
      expect(createDef).toContain("run_task_group_create");
      expect(updateDef).toContain("run_task_update");
    });
  });

  // ================================================================
  // 格式化输出
  // ================================================================
  describe("formatting", () => {
    it("idle 状态应显示提示信息", async () => {
      const manager = createTodoManager();
      const list = getExecutor(manager, "run_todo_list");

      const result = await list({});
      expect(result.output).toBe(
        "No todo list active. Use run_todo_create to create one.",
      );
    });

    it("应该正确显示所有状态的符号", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");
      const list = getExecutor(manager, "run_todo_list");

      await create({
        tasks: ["任务A", "任务B", "任务C", "任务D"] as unknown as string,
      });

      // task_1: completed
      await update({ task_id: "task_1", status: "completed" });
      // task_2: in_progress with note
      await update({
        task_id: "task_2",
        status: "in_progress",
        note: "进行中",
      });
      // task_3: skipped
      await update({ task_id: "task_3", status: "skipped" });
      // task_4: pending (默认)

      const result = await list({});
      expect(result.output).toContain("[x] task_1: 任务A");
      expect(result.output).toContain("[>] task_2: 任务B (进行中)");
      expect(result.output).toContain("[-] task_3: 任务C");
      expect(result.output).toContain("[ ] task_4: 任务D");
      expect(result.output).toContain("(1/4 completed, 1 skipped)");
    });
  });

  // ================================================================
  // 完整流程测试
  // ================================================================
  describe("完整流程", () => {
    it("创建 → 执行 → 完成的完整流程", async () => {
      const manager = createTodoManager();
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      // 创建
      await create({
        tasks: ["分析需求", "编写代码", "测试"] as unknown as string,
      });

      // 第一个 task
      await update({
        task_id: "task_1",
        status: "in_progress",
        note: "开始分析",
      });
      await update({
        task_id: "task_1",
        status: "completed",
        note: "分析完成",
      });

      // 第二个 task
      await update({
        task_id: "task_2",
        status: "in_progress",
        note: "编写中",
      });
      await update({
        task_id: "task_2",
        status: "completed",
      });

      // 第三个 task
      await update({ task_id: "task_3", status: "in_progress" });
      const result = await update({
        task_id: "task_3",
        status: "completed",
      });

      expect(result.error).toBe(false);
      expect(result.output).toContain("[x] task_1: 分析需求");
      expect(result.output).toContain("[x] task_2: 编写代码");
      expect(result.output).toContain("[x] task_3: 测试");
      expect(result.output).toContain("(3/3 completed)");
    });

    it("中断 → 恢复的完整流程", async () => {
      const manager = createTodoManager(2);
      const create = getExecutor(manager, "run_todo_create");
      const update = getExecutor(manager, "run_todo_update");

      await create({
        tasks: ["任务A", "任务B"] as unknown as string,
      });
      await update({ task_id: "task_1", status: "in_progress" });

      // tick 到上限
      manager.tickRound(); // 1
      const msg = manager.tickRound(); // 2 → 中断
      expect(msg).toContain("已达到轮次上限");

      // 恢复 task_1
      const resumeResult = await update({
        task_id: "task_1",
        status: "in_progress",
      });
      expect(resumeResult.error).toBe(false);
      expect(resumeResult.output).toContain("[>] task_1: 任务A");

      // roundCount 应该已重置，可以继续 tick
      expect(manager.tickRound()).toBeNull(); // roundCount = 1, 1 < 2 → null

      // 第二次 tick，roundCount = 2 >= maxRounds(2)，触发中断
      const msg2 = manager.tickRound();
      expect(msg2).not.toBeNull();
      expect(msg2).toContain("已达到轮次上限");
    });
  });
});
