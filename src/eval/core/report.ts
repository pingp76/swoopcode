/**
 * report.ts — Eval Suite Report 聚合与输出
 *
 * 职责：运行多个 eval case，聚合结果，输出 JSON 和 Markdown 报告。
 *
 * 设计决策：
 * - runEvalSuite 顺序执行 case，保持 workspace 隔离简单。
 * - 报告格式遵循 PDD22：JSON（机器读取）+ Markdown（人读）。
 * - 不实现复杂 dashboard，保持最小可用。
 */

import { writeFile } from "node:fs/promises";
import type { LLMClient } from "../../llm.js";
import type { EvalCase, EvalSuiteReport, EvalRunResult } from "./case-schema.js";
import type { CodingAgentDriver } from "./driver.js";
import { runEvalCase } from "./runner.js";

/**
 * runEvalSuite — 顺序运行多个 eval case，聚合结果
 *
 * @param cases - eval case 列表
 * @param createDriver - driver 工厂函数
 * @param judgeLLM - 可选的 judge LLM
 * @returns 聚合后的 suite report
 */
export async function runEvalSuite(
  cases: EvalCase[],
  createDriver: (plan: EvalCase["driver"]) => Promise<CodingAgentDriver>,
  judgeLLM?: LLMClient,
): Promise<EvalSuiteReport> {
  const startedAt = new Date().toISOString();
  const results: EvalRunResult[] = [];

  for (const evalCase of cases) {
    const result = await runEvalCase(evalCase, createDriver, judgeLLM);
    results.push(result);
  }

  const endedAt = new Date().toISOString();

  // 推断 mode
  const modes = new Set(cases.map((c) => c.mode ?? "scripted"));
  let mode: EvalSuiteReport["mode"];
  if (modes.size === 1) {
    const single = [...modes][0]!;
    mode = single as EvalSuiteReport["mode"];
  } else {
    mode = "mixed";
  }

  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed && r.status !== "skipped").length;
  const skipped = results.filter((r) => r.status === "skipped").length;

  const reportCases = results.map((r) => {
    const hardPassed = r.assertions.every((a) => a.passed);
    const failedAssertions = r.assertions.filter((a) => !a.passed);
    const failureSummary =
      failedAssertions.length > 0
        ? failedAssertions.map((a) => `${a.kind}: ${a.message}`).join("; ")
        : undefined;

    const caseEntry: EvalSuiteReport["cases"][number] = {
      id: r.caseId,
      title: r.title,
      passed: r.passed,
      hardPassed,
    };
    if (r.judge !== undefined) {
      caseEntry.judgePassed = r.judge.passed;
    }
    if (r.tracePath !== undefined) {
      caseEntry.tracePath = r.tracePath;
    }
    if (failureSummary !== undefined) {
      caseEntry.failureSummary = failureSummary;
    }
    return caseEntry;
  });

  return {
    version: 1,
    startedAt,
    endedAt,
    mode,
    total: cases.length,
    passed,
    failed,
    skipped,
    judgeEnabled: judgeLLM !== undefined,
    cases: reportCases,
  };
}

/**
 * writeJsonReport — 将 suite report 写入 JSON 文件
 *
 * @param report - suite report
 * @param filePath - 目标文件路径
 */
export async function writeJsonReport(report: EvalSuiteReport, filePath: string): Promise<void> {
  await writeFile(filePath, JSON.stringify(report, null, 2), "utf-8");
}

/**
 * writeMarkdownReport — 将 suite report 写入 Markdown 文件
 *
 * @param report - suite report
 * @param filePath - 目标文件路径
 */
export async function writeMarkdownReport(
  report: EvalSuiteReport,
  filePath: string,
): Promise<void> {
  const lines: string[] = [
    "# Eval Report",
    "",
    `- total: ${report.total}`,
    `- passed: ${report.passed}`,
    `- failed: ${report.failed}`,
    `- skipped: ${report.skipped}`,
    `- judge enabled: ${report.judgeEnabled}`,
    `- mode: ${report.mode}`,
    "",
  ];

  const failedCases = report.cases.filter((c) => !c.passed);
  if (failedCases.length > 0) {
    lines.push("## Failed", "");
    for (const c of failedCases) {
      lines.push(`### ${c.id}`, "");
      if (!c.hardPassed) {
        lines.push(`- hard assertion failed: ${c.failureSummary ?? "unknown"}`);
      }
      if (c.judgePassed === false) {
        lines.push(`- judge failed`);
      }
      if (c.tracePath) {
        lines.push(`- trace: ${c.tracePath}`);
      }
      lines.push("");
    }
  }

  const passedCases = report.cases.filter((c) => c.passed);
  if (passedCases.length > 0) {
    lines.push("## Passed", "");
    for (const c of passedCases) {
      let entry = `- ${c.id}: ${c.title}`;
      if (report.judgeEnabled && c.judgePassed === false) {
        entry += " (judge failed)";
      }
      lines.push(entry);
    }
    lines.push("");
  }

  await writeFile(filePath, lines.join("\n"), "utf-8");
}
