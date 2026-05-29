import { afterEach, beforeEach, describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createLogger } from "./logger.js";

describe("createLogger", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "logger-test-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("logs at or above configured level", () => {
    const logs: string[] = [];
    const originals = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    const capture = (...args: unknown[]) => logs.push(args.join(" "));
    console.log = capture;
    console.warn = capture;
    console.error = capture;

    const logger = createLogger("warn");
    logger.debug("debug msg");
    logger.info("info msg");
    logger.warn("warn msg");
    logger.error("error msg");

    console.log = originals.log;
    console.warn = originals.warn;
    console.error = originals.error;
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain("warn msg");
    expect(logs[1]).toContain("error msg");
  });

  it("rotates file logs when they exceed the configured size", () => {
    const logFile = path.join(tempDir, "agent.log");
    const originals = {
      log: console.log,
      warn: console.warn,
      error: console.error,
    };
    console.log = () => undefined;
    console.warn = () => undefined;
    console.error = () => undefined;

    try {
      const logger = createLogger("debug", logFile, {
        maxFileBytes: 20,
        keepFiles: 2,
      });

      logger.info("first long line");
      logger.info("second long line");
      logger.info("third long line");

      expect(fs.existsSync(logFile)).toBe(true);
      expect(fs.existsSync(`${logFile}.1`)).toBe(true);
      expect(fs.existsSync(`${logFile}.2`)).toBe(true);
      expect(fs.existsSync(`${logFile}.3`)).toBe(false);
      expect(fs.readFileSync(logFile, "utf-8")).toContain("third long line");
    } finally {
      console.log = originals.log;
      console.warn = originals.warn;
      console.error = originals.error;
    }
  });
});
