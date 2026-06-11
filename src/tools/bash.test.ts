import { describe, it, expect } from "vitest";
import {
  isDangerousCommand,
  executeBash,
  createDefaultAsyncCommandPolicy,
} from "./bash.js";

describe("isDangerousCommand", () => {
  it("blocks rm -rf", () => {
    expect(isDangerousCommand("rm -rf /")).toBe(true);
    expect(isDangerousCommand("rm -rf /home/user")).toBe(true);
    expect(isDangerousCommand("rm -fr /tmp")).toBe(true);
  });

  it("allows safe rm", () => {
    expect(isDangerousCommand("rm file.txt")).toBe(false);
    expect(isDangerousCommand("rm -r ./build")).toBe(false);
  });

  it("blocks mkfs", () => {
    expect(isDangerousCommand("mkfs.ext4 /dev/sda1")).toBe(true);
  });

  it("blocks fork bomb", () => {
    expect(isDangerousCommand(":(){ :|:& };:")).toBe(true);
  });

  it("blocks shutdown/reboot", () => {
    expect(isDangerousCommand("shutdown now")).toBe(true);
    expect(isDangerousCommand("reboot")).toBe(true);
  });

  it("allows safe commands", () => {
    expect(isDangerousCommand("ls -la")).toBe(false);
    expect(isDangerousCommand("echo hello")).toBe(false);
    expect(isDangerousCommand("cat file.txt")).toBe(false);
    expect(isDangerousCommand("git status")).toBe(false);
  });
});

describe("executeBash", () => {
  it("executes a simple command", async () => {
    const result = await executeBash("echo hello");
    expect(result.error).toBe(false);
    expect(result.output.trim()).toBe("hello");
  });

  it("captures stderr on failure", async () => {
    const result = await executeBash("ls /nonexistent_directory_xyz");
    expect(result.error).toBe(true);
    expect(result.output).toContain("nonexistent_directory_xyz");
  });

  it("blocks dangerous commands", async () => {
    const result = await executeBash("rm -rf /");
    expect(result.error).toBe(true);
    expect(result.output).toContain("blocked");
  });

  it("supports custom timeout", async () => {
    // sleep 2 在 500ms 超时内应被终止
    const result = await executeBash("sleep 2", undefined, 500);
    expect(result.error).toBe(true);
  });

  it("uses default 30s timeout when timeout is not provided", async () => {
    const result = await executeBash("echo hello");
    expect(result.error).toBe(false);
    expect(result.output.trim()).toBe("hello");
  });
});

describe("createDefaultAsyncCommandPolicy", () => {
  const policy = createDefaultAsyncCommandPolicy();

  it("rejects shell operators ;", () => {
    const result = policy.validate("git status; touch x");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Shell operators");
  });

  it("rejects shell operators &&", () => {
    const result = policy.validate("git status && touch x");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Shell operators");
  });

  it("rejects shell operators |", () => {
    const result = policy.validate("cat file | grep hello");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Shell operators");
  });

  it("rejects write commands like git add", () => {
    const result = policy.validate("git add file.ts");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Write command");
  });

  it("rejects write commands like git commit", () => {
    const result = policy.validate('git commit -m "test"');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Write command");
  });

  it("allows whitelisted commands like git status", () => {
    const result = policy.validate("git status");
    expect(result.allowed).toBe(true);
  });

  it("allows whitelisted commands like npm run typecheck", () => {
    const result = policy.validate("npm run typecheck");
    expect(result.allowed).toBe(true);
  });

  it("allows npx tsc only with noEmit", () => {
    expect(policy.validate("npx tsc --noEmit").allowed).toBe(true);
    expect(policy.validate("npx tsc").allowed).toBe(false);
  });

  it("rejects fix flags", () => {
    expect(policy.validate("npx eslint --fix").allowed).toBe(false);
    expect(policy.validate("npm run lint -- --fix").allowed).toBe(false);
  });

  it("rejects non-whitelisted bare commands", () => {
    const result = policy.validate("echo hello");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not in allowed list");
  });

  it("rejects bare find", () => {
    const result = policy.validate("find . -name '*.ts'");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not in allowed list");
  });

  it("rejects dangerous commands via isDangerousCommand", () => {
    const result = policy.validate("rm -rf /");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Dangerous");
  });

  it("has maxTimeoutMs of 300000", () => {
    expect(policy.maxTimeoutMs).toBe(300_000);
  });
});
