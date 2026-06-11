import { describe, expect, it } from "vitest";
import {
  createDefaultAsyncCommandPolicy,
  createExecutionPolicy,
  createReadonlyCommandPolicy,
} from "./execution-policy.js";

describe("ExecutionPolicy command validation", () => {
  const policy = createExecutionPolicy();

  it("allows readonly diagnostic commands", () => {
    expect(policy.validateCommand({ command: "git status" }).allowed).toBe(
      true,
    );
    expect(
      policy.validateCommand({ command: "npm run typecheck" }).allowed,
    ).toBe(true);
    expect(
      policy.validateCommand({ command: "npx vitest run src/foo.test.ts" })
        .allowed,
    ).toBe(true);
  });

  it("allows npx tsc only with --noEmit in readonly profile", () => {
    expect(
      policy.validateCommand({ command: "npx tsc --noEmit" }).allowed,
    ).toBe(true);
    const result = policy.validateCommand({ command: "npx tsc" });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("--noEmit");
  });

  it("rejects write/fix flags in readonly profile", () => {
    expect(
      policy.validateCommand({ command: "npx eslint --fix" }).allowed,
    ).toBe(false);
    expect(
      policy.validateCommand({ command: "npm run lint -- --fix" }).allowed,
    ).toBe(false);
  });

  it("rejects build in readonly but allows it in ci", () => {
    expect(policy.validateCommand({ command: "npm run build" }).allowed).toBe(
      false,
    );
    expect(
      policy.validateCommand({ command: "npm run build", profile: "ci" })
        .allowed,
    ).toBe(true);
  });

  it("still rejects fix flags in ci", () => {
    expect(
      policy.validateCommand({ command: "npx eslint src --fix", profile: "ci" })
        .allowed,
    ).toBe(false);
  });

  it("rejects shell operators", () => {
    for (const command of [
      "git status; touch x",
      "git status && touch x",
      "git status || touch x",
      "cat file | grep hello",
      "git status > out.txt",
      "echo $(pwd)",
    ]) {
      const result = policy.validateCommand({ command });
      expect(result.allowed, command).toBe(false);
      expect(result.reason).toContain("Shell operators");
    }
  });

  it("keeps AsyncCommandPolicy compatibility adapter readonly", () => {
    const adapter = createReadonlyCommandPolicy(policy);
    expect(adapter.maxTimeoutMs).toBe(300_000);
    expect(adapter.validate("git status").allowed).toBe(true);
    expect(adapter.validate("npm run build").allowed).toBe(false);
    expect(
      createDefaultAsyncCommandPolicy().validate("git status").allowed,
    ).toBe(true);
  });
});

describe("ExecutionPolicy resource validation", () => {
  const policy = createExecutionPolicy();
  const projectRoot = "/tmp/project";

  it("allows readonly read paths within project", () => {
    expect(
      policy.validateResources({
        projectRoot,
        readPaths: ["src", "package.json"],
        writePaths: [],
      }).allowed,
    ).toBe(true);
  });

  it("rejects read paths outside project", () => {
    const result = policy.validateResources({
      projectRoot,
      readPaths: ["../outside"],
      writePaths: [],
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("outside project directory");
  });

  it("rejects non-array resource fields", () => {
    expect(
      policy.validateResources({
        projectRoot,
        readPaths: "src" as unknown as string[],
        writePaths: [],
      }).allowed,
    ).toBe(false);
    expect(
      policy.validateResources({
        projectRoot,
        readPaths: [],
        writePaths: "dist" as unknown as string[],
      }).allowed,
    ).toBe(false);
  });

  it("rejects write paths for readonly and ci profiles", () => {
    expect(
      policy.validateResources({
        projectRoot,
        readPaths: ["src"],
        writePaths: ["src/out.txt"],
      }).allowed,
    ).toBe(false);
    expect(
      policy.validateResources({
        projectRoot,
        readPaths: ["src"],
        writePaths: ["coverage"],
        profile: "ci",
      }).allowed,
    ).toBe(false);
  });

  it("keeps workspace_write reserved", () => {
    const result = policy.validateResources({
      projectRoot,
      readPaths: ["src"],
      writePaths: ["src/out.txt"],
      profile: "workspace_write",
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("reserved");
  });
});
