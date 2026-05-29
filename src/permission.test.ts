/**
 * permission.test.ts — 权限管理器测试
 *
 * 覆盖：默认模式、模式切换、bash 黑名单、文件路径黑名单、
 * 路径越界、plan/auto/default 各模式决策、run_subagent 行为。
 */

import { describe, it, expect } from "vitest";
import { createPermissionManager, createScopedSubagentPermissionManager } from "./permission.js";
import type { PermissionContext } from "./permission.js";
import {
  createDefaultAsyncCommandPolicy,
  type AsyncCommandPolicy,
} from "./execution-policy.js";
import { resolve } from "node:path";

// 测试用的项目目录
const PROJECT_DIR = "/home/user/project";

/** 便捷函数：构造 PermissionContext */
function ctx(
  toolName: string,
  args: Record<string, unknown> = {},
): PermissionContext {
  return { toolName, args };
}

// ---------------------------------------------------------------------------
// 默认模式和模式切换
// ---------------------------------------------------------------------------

describe("mode management", () => {
  it("starts in default mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    expect(pm.getMode()).toBe("default");
  });

  it("switches to plan mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("plan");
    expect(pm.getMode()).toBe("plan");
  });

  it("switches to auto mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("auto");
    expect(pm.getMode()).toBe("auto");
  });

  it("switches back to default mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("auto");
    pm.setMode("default");
    expect(pm.getMode()).toBe("default");
  });

  it("returns project directory", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    expect(pm.getProjectDir()).toBe(resolve(PROJECT_DIR));
  });
});

// ---------------------------------------------------------------------------
// 步骤 1：未知工具放行
// ---------------------------------------------------------------------------

describe("unknown tools", () => {
  it("allows unknown tools", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(ctx("run_unknown_tool"));
    expect(decision.action).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 步骤 2：黑名单
// ---------------------------------------------------------------------------

describe("bash blacklist", () => {
  const pm = createPermissionManager(PROJECT_DIR);

  it("denies rm -rf /", () => {
    const decision = pm.check(ctx("run_bash", { command: "rm -rf /" }));
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.reason).toContain("Dangerous");
    }
  });

  it("denies shutdown", () => {
    const decision = pm.check(ctx("run_bash", { command: "shutdown -h now" }));
    expect(decision.action).toBe("deny");
  });

  it("denies mkfs", () => {
    const decision = pm.check(
      ctx("run_bash", { command: "mkfs.ext4 /dev/sda1" }),
    );
    expect(decision.action).toBe("deny");
  });

  it("allows safe commands in auto mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("auto");
    const decision = pm.check(ctx("run_bash", { command: "ls -la" }));
    expect(decision.action).toBe("allow");
  });
});

describe("file path blacklist", () => {
  it("denies access to /etc/passwd", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(ctx("run_read", { path: "/etc/passwd" }));
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.reason).toContain("system configuration");
    }
  });

  it("denies access to ~/.ssh/id_rsa", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(ctx("run_read", { path: "~/.ssh/id_rsa" }));
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.reason).toContain("SSH");
    }
  });

  it("denies access to credentials file", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(
      ctx("run_read", { path: resolve(PROJECT_DIR, "credentials.json") }),
    );
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.reason).toContain("credentials");
    }
  });
});

// ---------------------------------------------------------------------------
// 步骤 3：路径边界检查
// ---------------------------------------------------------------------------

describe("path boundary", () => {
  it("denies read outside project", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(ctx("run_read", { path: "/tmp/outside.txt" }));
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.reason).toContain("outside project directory");
    }
  });

  it("denies write outside project via traversal", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(
      ctx("run_write", { path: "../../outside.txt", content: "x" }),
    );
    expect(decision.action).toBe("deny");
  });

  it("allows read within project", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(
      ctx("run_read", { path: resolve(PROJECT_DIR, "src/main.ts") }),
    );
    expect(decision.action).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 步骤 4：白名单
// ---------------------------------------------------------------------------

describe("whitelist", () => {
  const pm = createPermissionManager(PROJECT_DIR);

  it("allows run_read for project files", () => {
    const decision = pm.check(
      ctx("run_read", { path: resolve(PROJECT_DIR, "file.txt") }),
    );
    expect(decision.action).toBe("allow");
  });

  it("allows run_todo_* tools", () => {
    const decision = pm.check(ctx("run_todo_create", { tasks: [] }));
    expect(decision.action).toBe("allow");
  });

  it("allows run_todo_list", () => {
    const decision = pm.check(ctx("run_todo_list"));
    expect(decision.action).toBe("allow");
  });

  it("allows run_task_* tools", () => {
    const decision = pm.check(
      ctx("run_task_update", {
        group_id: "tg_20260513_153000_task_system",
        task_id: "task_1",
      }),
    );
    expect(decision.action).toBe("allow");
  });

  it("allows run_skill", () => {
    const decision = pm.check(ctx("run_skill", { name: "code-review" }));
    expect(decision.action).toBe("allow");
  });

  it("allows run_output_read as agent runtime data read", () => {
    const decision = pm.check(
      ctx("run_output_read", {
        output_id: "out_20260528_153000_abc123",
      }),
    );
    expect(decision.action).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 步骤 5 & 6：模式权限检查
// ---------------------------------------------------------------------------

describe("plan mode", () => {
  const pm = createPermissionManager(PROJECT_DIR);
  pm.setMode("plan");

  it("denies run_bash", () => {
    const decision = pm.check(ctx("run_bash", { command: "echo hello" }));
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.reason).toContain("plan mode");
    }
  });

  it("allows run_write to .claude/plans/", () => {
    const plansPath = resolve(PROJECT_DIR, ".claude/plans/plan.md");
    const decision = pm.check(
      ctx("run_write", { path: plansPath, content: "plan" }),
    );
    expect(decision.action).toBe("allow");
  });

  it("denies run_write to project src/", () => {
    const srcPath = resolve(PROJECT_DIR, "src/main.ts");
    const decision = pm.check(
      ctx("run_write", { path: srcPath, content: "code" }),
    );
    expect(decision.action).toBe("deny");
  });

  it("allows run_subagent", () => {
    const decision = pm.check(ctx("run_subagent", { task: "read files" }));
    expect(decision.action).toBe("allow");
  });

  it("allows run_task_group_create in plan mode", () => {
    const decision = pm.check(
      ctx("run_task_group_create", {
        title: "Plan",
        tasks: [{ subject: "draft" }],
      }),
    );
    expect(decision.action).toBe("allow");
  });

  it("allows run_read for project files", () => {
    const decision = pm.check(
      ctx("run_read", { path: resolve(PROJECT_DIR, "file.txt") }),
    );
    expect(decision.action).toBe("allow");
  });
});

describe("auto mode", () => {
  const pm = createPermissionManager(PROJECT_DIR);
  pm.setMode("auto");

  it("allows run_bash with safe command", () => {
    const decision = pm.check(ctx("run_bash", { command: "npm test" }));
    expect(decision.action).toBe("allow");
  });

  it("allows run_write within project", () => {
    const decision = pm.check(
      ctx("run_write", {
        path: resolve(PROJECT_DIR, "output.txt"),
        content: "x",
      }),
    );
    expect(decision.action).toBe("allow");
  });

  it("allows run_edit within project", () => {
    const decision = pm.check(
      ctx("run_edit", {
        path: resolve(PROJECT_DIR, "file.ts"),
        old_string: "a",
        new_string: "b",
      }),
    );
    expect(decision.action).toBe("allow");
  });

  it("allows run_edit_exact within project", () => {
    const decision = pm.check(
      ctx("run_edit_exact", {
        path: resolve(PROJECT_DIR, "file.ts"),
        old_string: "a",
        new_string: "b",
        expected_occurrences: 1,
      }),
    );
    expect(decision.action).toBe("allow");
  });

  it("allows run_subagent", () => {
    const decision = pm.check(ctx("run_subagent", { task: "do stuff" }));
    expect(decision.action).toBe("allow");
  });
});

describe("default mode", () => {
  const pm = createPermissionManager(PROJECT_DIR);

  it("asks for run_bash", () => {
    const decision = pm.check(ctx("run_bash", { command: "ls" }));
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") {
      expect(decision.message).toContain("bash");
    }
  });

  it("asks for run_write", () => {
    const decision = pm.check(
      ctx("run_write", {
        path: resolve(PROJECT_DIR, "file.txt"),
        content: "x",
      }),
    );
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") {
      expect(decision.message).toContain("file.txt");
    }
  });

  it("asks for run_edit", () => {
    const decision = pm.check(
      ctx("run_edit", {
        path: resolve(PROJECT_DIR, "file.ts"),
        old_string: "a",
        new_string: "b",
      }),
    );
    expect(decision.action).toBe("ask");
  });

  it("asks for run_edit_exact", () => {
    const decision = pm.check(
      ctx("run_edit_exact", {
        path: resolve(PROJECT_DIR, "file.ts"),
        old_string: "a",
        new_string: "b",
        expected_occurrences: 1,
      }),
    );
    expect(decision.action).toBe("ask");
  });

  it("asks for run_subagent", () => {
    const decision = pm.check(
      ctx("run_subagent", { task: "analyze code quality" }),
    );
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") {
      expect(decision.message).toContain("analyze code quality");
    }
  });

  it("allows run_read without asking", () => {
    const decision = pm.check(
      ctx("run_read", { path: resolve(PROJECT_DIR, "file.txt") }),
    );
    expect(decision.action).toBe("allow");
  });

  it("allows run_todo_* without asking", () => {
    const decision = pm.check(ctx("run_todo_create", { tasks: [] }));
    expect(decision.action).toBe("allow");
  });

  it("allows run_skill without asking", () => {
    const decision = pm.check(ctx("run_skill", { name: "review" }));
    expect(decision.action).toBe("allow");
  });
});

// ---------------------------------------------------------------------------
// 子智能体权限继承
// ---------------------------------------------------------------------------

describe("subagent permission inheritance", () => {
  it("default mode: subagent triggers ask, but internal bash also asks (no askUserFn → deny)", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    // 父级 default 模式：run_subagent 需要 ask
    const parentDecision = pm.check(ctx("run_subagent", { task: "test" }));
    expect(parentDecision.action).toBe("ask");

    // 子智能体内部遇到 run_bash（假设用户确认了 subagent）
    // 子智能体没有 askUserFn，但检查逻辑相同
    const subDecision = pm.check(ctx("run_bash", { command: "echo hi" }));
    expect(subDecision.action).toBe("ask"); // default 模式下 bash 需要 ask
  });

  it("auto mode: both parent and subagent allow bash", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("auto");

    const parentDecision = pm.check(ctx("run_subagent", { task: "test" }));
    expect(parentDecision.action).toBe("allow");

    const subDecision = pm.check(ctx("run_bash", { command: "echo hi" }));
    expect(subDecision.action).toBe("allow");
  });

  it("plan mode: subagent allowed, but internal bash denied", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("plan");

    const parentDecision = pm.check(
      ctx("run_subagent", { task: "read files" }),
    );
    expect(parentDecision.action).toBe("allow");

    const subDecision = pm.check(ctx("run_bash", { command: "echo hi" }));
    expect(subDecision.action).toBe("deny");
    if (subDecision.action === "deny") {
      expect(subDecision.reason).toContain("plan mode");
    }
  });
});

// ---------------------------------------------------------------------------
// async-run 工具权限
// ---------------------------------------------------------------------------

describe("async-run tools", () => {
  it("categorizes run_async_start as async-run (default mode asks)", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(
      ctx("run_async_start", { executor: "command", title: "test", resources: { read_paths: [], write_paths: [] } }),
    );
    expect(decision.action).toBe("ask");
  });

  it("categorizes run_async_check/list/output_read as async-run (default mode allows)", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    expect(pm.check(ctx("run_async_check", { run_id: "ar_test" })).action).toBe("allow");
    expect(pm.check(ctx("run_async_list")).action).toBe("allow");
    expect(pm.check(ctx("run_async_output_read", { run_id: "ar_test" })).action).toBe("allow");
  });

  it("allows run_async_check in all modes", () => {
    for (const mode of ["default", "auto", "plan"] as const) {
      const pm = createPermissionManager(PROJECT_DIR);
      pm.setMode(mode);
      expect(pm.check(ctx("run_async_check", { run_id: "ar_test" })).action).toBe("allow");
    }
  });

  it("allows run_async_list in all modes", () => {
    for (const mode of ["default", "auto", "plan"] as const) {
      const pm = createPermissionManager(PROJECT_DIR);
      pm.setMode(mode);
      expect(pm.check(ctx("run_async_list")).action).toBe("allow");
    }
  });

  it("allows run_async_output_read in all modes", () => {
    for (const mode of ["default", "auto", "plan"] as const) {
      const pm = createPermissionManager(PROJECT_DIR);
      pm.setMode(mode);
      expect(pm.check(ctx("run_async_output_read", { run_id: "ar_test" })).action).toBe("allow");
    }
  });

  it("plan mode: denies run_async_start with executor=command", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("plan");
    const decision = pm.check(
      ctx("run_async_start", {
        executor: "command",
        title: "Typecheck",
        command: "npm run typecheck",
        resources: { read_paths: ["src"], write_paths: [] },
      }),
    );
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") {
      expect(decision.reason).toContain("plan mode");
    }
  });

  it("plan mode: allows run_async_start with executor=subagent", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("plan");
    const decision = pm.check(
      ctx("run_async_start", {
        executor: "subagent",
        title: "Analyze",
        prompt: "Analyze code",
        resources: { read_paths: ["src"], write_paths: [] },
      }),
    );
    expect(decision.action).toBe("allow");
  });

  it("auto mode: allows run_async_start with executor=command", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("auto");
    const decision = pm.check(
      ctx("run_async_start", {
        executor: "command",
        title: "Typecheck",
        command: "npm run typecheck",
        resources: { read_paths: ["src"], write_paths: [] },
      }),
    );
    expect(decision.action).toBe("allow");
  });

  it("default mode: run_async_start asks with confirmation message", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(
      ctx("run_async_start", {
        executor: "command",
        title: "Typecheck",
        command: "npm run typecheck",
        timeout_ms: 120000,
        resources: { read_paths: ["src", "package.json"], write_paths: [] },
      }),
    );
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") {
      expect(decision.message).toContain("Allow async run: Typecheck");
      expect(decision.message).toContain("executor: command");
      expect(decision.message).toContain("timeout: 120000ms");
      expect(decision.message).toContain("read paths: src, package.json");
      expect(decision.message).toContain("command: npm run typecheck");
    }
  });
});

// ---------------------------------------------------------------------------
// memory 工具权限
// ---------------------------------------------------------------------------

describe("memory tools", () => {
  it("allows run_memory_list in default mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    expect(pm.check(ctx("run_memory_list")).action).toBe("allow");
  });

  it("allows run_memory_read in default mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    expect(pm.check(ctx("run_memory_read", { name: "test" })).action).toBe(
      "allow",
    );
  });

  it("asks for run_memory_create in default mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(ctx("run_memory_create", { name: "test" }));
    expect(decision.action).toBe("ask");
    if (decision.action === "ask") {
      expect(decision.message).toContain("memory");
    }
  });

  it("asks for run_memory_delete in default mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    const decision = pm.check(ctx("run_memory_delete", { name: "test" }));
    expect(decision.action).toBe("ask");
  });

  it("asks for run_memory_create in auto mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("auto");
    const decision = pm.check(ctx("run_memory_create", { name: "test" }));
    expect(decision.action).toBe("ask");
  });

  it("asks for run_memory_delete in auto mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("auto");
    const decision = pm.check(ctx("run_memory_delete", { name: "test" }));
    expect(decision.action).toBe("ask");
  });

  it("asks for run_memory_create in plan mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("plan");
    const decision = pm.check(ctx("run_memory_create", { name: "test" }));
    expect(decision.action).toBe("ask");
  });

  it("allows run_memory_list in plan mode", () => {
    const pm = createPermissionManager(PROJECT_DIR);
    pm.setMode("plan");
    expect(pm.check(ctx("run_memory_list")).action).toBe("allow");
  });
});

// ============================================================================
// Scoped Subagent Permission Manager
// ============================================================================

describe("createScopedSubagentPermissionManager", () => {
  const PROJECT_DIR = "/tmp/test-project";

  /** 创建 mock commandPolicy（允许所有命令，用于测试非 bash 分支） */
  function createMockCommandPolicy(
    allowed = true,
  ): AsyncCommandPolicy {
    return {
      maxTimeoutMs: 300_000,
      validate: () =>
        allowed
          ? { allowed: true }
          : { allowed: false, reason: "Mock policy rejected" },
    };
  }

  it("inherits parent's hard deny (dangerous command)", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    parent.setMode("auto");
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(),
    });

    const decision = scoped.check({
      toolName: "run_bash",
      args: { command: "rm -rf /" },
    });
    expect(decision.action).toBe("deny");
  });

  it("inherits parent's hard deny (path outside project)", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    parent.setMode("auto");
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(),
    });

    const decision = scoped.check({
      toolName: "run_read",
      args: { path: "/etc/passwd" },
    });
    expect(decision.action).toBe("deny");
  });

  it("allows run_read within project", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(),
    });

    expect(
      scoped.check({ toolName: "run_read", args: { path: "src/index.ts" } })
        .action,
    ).toBe("allow");
  });

  it("allows run_skill", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(),
    });

    expect(
      scoped.check({ toolName: "run_skill", args: { name: "review" } }).action,
    ).toBe("allow");
  });

  it("denies run_bash in plan mode", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    parent.setMode("plan");
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(),
    });

    const decision = scoped.check({
      toolName: "run_bash",
      args: { command: "ls" },
    });
    expect(decision.action).toBe("deny");
    expect(decision.action === "deny" && decision.reason).toContain(
      "plan mode",
    );
  });

  it("allows run_bash in default mode when commandPolicy approves", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(true),
    });

    expect(
      scoped.check({ toolName: "run_bash", args: { command: "ls" } }).action,
    ).toBe("allow");
  });

  it("denies run_bash in default mode when commandPolicy rejects", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(false),
    });

    const decision = scoped.check({
      toolName: "run_bash",
      args: { command: "git push" },
    });
    expect(decision.action).toBe("deny");
    expect(decision.action === "deny" && decision.reason).toContain(
      "Mock policy rejected",
    );
  });

  it("uses shared readonly command policy for subagent bash", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createDefaultAsyncCommandPolicy(),
    });

    expect(
      scoped.check({
        toolName: "run_bash",
        args: { command: "npx tsc --noEmit" },
      }).action,
    ).toBe("allow");
    const denied = scoped.check({
      toolName: "run_bash",
      args: { command: "npx eslint --fix" },
    });
    expect(denied.action).toBe("deny");
    expect(denied.action === "deny" && denied.reason).toContain("--fix");
  });

  it("denies write tools inside subagent", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    parent.setMode("auto");
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(),
    });

    const writeTools = [
      "run_write",
      "run_edit",
      "run_edit_exact",
      "run_subagent",
    ];
    for (const toolName of writeTools) {
      const decision = scoped.check({ toolName, args: {} });
      expect(decision.action).toBe("deny");
      expect(
        decision.action === "deny" && decision.reason,
      ).toContain("not allowed inside a subagent");
    }
  });

  it("denies async-run and todo tools inside subagent", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    parent.setMode("auto");
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(),
    });

    const forbiddenTools = [
      "run_async_start",
      "run_todo_add",
      "run_todo_complete",
      "run_todo_list",
    ];
    for (const toolName of forbiddenTools) {
      const decision = scoped.check({ toolName, args: {} });
      expect(decision.action).toBe("deny");
    }
  });

  it("delegates getProjectDir to parent", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(),
    });

    expect(scoped.getProjectDir()).toBe(PROJECT_DIR);
  });

  it("delegates getMode to parent", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    parent.setMode("plan");
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(),
    });

    expect(scoped.getMode()).toBe("plan");
  });

  it("setMode is no-op and does not affect parent", () => {
    const parent = createPermissionManager(PROJECT_DIR);
    parent.setMode("auto");
    const scoped = createScopedSubagentPermissionManager({
      parent,
      commandPolicy: createMockCommandPolicy(),
    });

    scoped.setMode("plan");
    expect(parent.getMode()).toBe("auto");
    expect(scoped.getMode()).toBe("auto");
  });
});
