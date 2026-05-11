import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import { createProjectContext } from "./project-context.js";

describe("createProjectContext", () => {
  it("derives project paths and agent runtime paths separately", () => {
    const ctx = createProjectContext({
      projectRoot: "/tmp/demo",
      agentHome: "/tmp/agent-home",
    });

    expect(ctx.projectRoot).toBe(resolve("/tmp/demo"));
    expect(ctx.agentHome).toBe(resolve("/tmp/agent-home"));
    expect(ctx.agentsFile).toBe(resolve("/tmp/demo/AGENTS.md"));
    expect(ctx.skillsDir).toBe(resolve("/tmp/agent-home/skills"));
    expect(ctx.memoryDir).toBe(resolve("/tmp/agent-home/memory"));
    expect(ctx.logsDir).toBe(resolve("/tmp/agent-home/logs"));
    expect(ctx.taskOutputsDir).toBe(resolve("/tmp/agent-home/.task_outputs"));
  });

  it("allows memory directory name override under agentHome", () => {
    const ctx = createProjectContext({
      projectRoot: "/tmp/demo",
      agentHome: "/tmp/agent-home",
      memoryDirName: "project-memory",
    });

    expect(ctx.memoryDir).toBe(resolve("/tmp/agent-home/project-memory"));
  });
});
