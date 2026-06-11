/**
 * judge.ts — LLM Judge 实现
 *
 * 职责：在 hard assertions 执行后，用另一个 LLM 对 case 结果做开放式质量评价。
 *
 * 设计决策：
 * - Judge 不覆盖 hard assertion 的结果，只做补充评分。
 * - Judge 的输入是结构化 trace 摘要，不暴露整份 llm.log。
 * - JSON 解析采用三层降级：直接 parse → 正则提取 code block → 返回 judge_failed。
 * - Judge prompt 是独立 LLM 调用，不进入 Agent system prompt。
 * - 支持 scripted judge LLM（测试用）和真实 judge LLM（生产用）。
 */

import type { LLMClient } from "../../llm.js";
import type { EvalJudgeInput, EvalJudgeResult } from "../core/case-schema.js";

/**
 * buildJudgePrompt — 构建 judge 的完整 prompt
 *
 * 包含 system instruction + user input（rubric、trace 摘要、hard assertion 结果）。
 * 要求 judge 输出固定格式的 JSON。
 */
export function buildJudgePrompt(input: EvalJudgeInput): {
  system: string;
  user: string;
} {
  const system = `You are an eval judge for a coding agent system. Your job is to review the agent's execution trace and provide a structured quality assessment.

Rules:
1. Hard assertions have already been executed. Your score is a supplementary evaluation, not an override.
2. Review the runtime events, final outputs, and rubric carefully.
3. Output MUST be valid JSON in the following exact structure:
{
  "passed": boolean,
  "score": number (0-10),
  "summary": string (1-2 sentences),
  "strengths": string[] (max 3),
  "problems": string[] (max 3),
  "evidence": [
    { "kind": "runtime_event" | "final_output" | "assertion" | "workspace", "ref": string, "note": string }
  ],
  "needsHumanReview": boolean
}
4. Prefer plain JSON without markdown wrapping, but if you must wrap it, we can parse markdown code blocks.`;

  // 截断 runtimeEvents 到前 50 条，防止 token 超限
  // 为关键事件类型附加内容预览，帮助 judge 理解 agent 行为
  const eventsSummary = input.runtimeEvents
    .slice(0, 50)
    .map((e) => {
      let preview = "";
      if (e.kind === "agent_output" && "text" in e) {
        preview = `: ${(e as { text: string }).text.slice(0, 100)}`;
      } else if (e.kind === "llm_response" && "contentPreview" in e) {
        preview = `: ${(e as { contentPreview?: string }).contentPreview ?? ""}`;
      } else if (
        (e.kind === "tool_call" || e.kind === "tool_result") &&
        "toolName" in e
      ) {
        const toolName = (e as { toolName: string }).toolName;
        const result =
          "result" in e
            ? `: ${String((e as { result?: unknown }).result).slice(0, 100)}`
            : "";
        preview = ` (${toolName})${result}`;
      }
      return `- [${e.source}] ${e.kind}${preview}`;
    })
    .join("\n");

  // 列出所有 hard assertions 及其结果，让 judge 看到完整 picture
  const assertionsSummary =
    input.hardAssertionResults
      .map((r) => `- [${r.passed ? "PASS" : "FAIL"}] ${r.kind}: ${r.message}`)
      .join("\n") || "None";

  const userParts: string[] = [
    `## Case: ${input.caseId}`,
    `Title: ${input.title}`,
    input.description ? `Description: ${input.description}` : "",
    "",
    "## Rubric",
    `Goal: ${input.rubric.goal}`,
    "Pass criteria:",
    ...input.rubric.passCriteria.map((c) => `- ${c}`),
    "Fail criteria:",
    ...input.rubric.failCriteria.map((c) => `- ${c}`),
    input.rubric.scoring
      ? `Scoring: ${input.rubric.scoring.minPassingScore} / ${input.rubric.scoring.maxScore} to pass`
      : "",
    "",
    "## User Queries",
    ...input.userQueries.map((q, i) => `${i + 1}. ${q}`),
    "",
    "## Final Outputs",
    ...input.finalOutputs.map((o, i) => `Step ${i + 1}: ${o.slice(0, 500)}`),
    "",
    "## Runtime Events (first 50)",
    eventsSummary,
    "",
    "## Hard Assertions",
    assertionsSummary,
  ];

  const user = userParts.filter(Boolean).join("\n");

  return { system, user };
}

/**
 * parseJudgeResponse — 鲁棒 JSON 解析器
 *
 * 三层降级：
 * 1. 直接 JSON.parse()
 * 2. 正则提取 ```json ... ``` 代码块
 * 3. 返回 null（调用方负责构造 judge_failed 结果）
 */
export function parseJudgeResponse(text: string): unknown | null {
  // 第一层：直接解析
  try {
    return JSON.parse(text.trim());
  } catch {
    // 继续第二层
  }

  // 第二层：提取 markdown json code block
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) {
    try {
      return JSON.parse(codeBlockMatch[1]!.trim());
    } catch {
      // 继续第三层
    }
  }

  // 第三层：用括号深度计数器提取最外层完整 JSON 对象
  // 比正则更鲁棒：能正确处理嵌套对象（如 evidence: [{...}]）和字符串内的括号
  const extracted = extractJsonObject(text);
  if (extracted) {
    try {
      return JSON.parse(extracted);
    } catch {
      // 放弃解析
    }
  }

  return null;
}

/**
 * extractJsonObject — 从文本中提取第一个最外层完整的 JSON 对象
 *
 * 算法：找到第一个 `{` 后，维护括号深度计数器，忽略字符串内的括号，
 * 当深度回到 0 时返回完整片段。
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escapeNext = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (ch === "\\") {
      escapeNext = true;
      continue;
    }

    if (ch === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (ch === "{") {
        depth++;
      } else if (ch === "}") {
        depth--;
        if (depth === 0) {
          return text.slice(start, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * validateJudgeResult — 验证解析后的 judge JSON 是否包含必要字段
 */
function validateJudgeResult(raw: unknown): EvalJudgeResult | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  if (typeof obj.passed !== "boolean") return null;
  if (typeof obj.score !== "number") return null;
  if (typeof obj.summary !== "string") return null;

  const strengths = Array.isArray(obj.strengths)
    ? obj.strengths.filter((s): s is string => typeof s === "string")
    : [];
  const problems = Array.isArray(obj.problems)
    ? obj.problems.filter((p): p is string => typeof p === "string")
    : [];
  const VALID_EVIDENCE_KINDS = new Set<string>([
    "runtime_event",
    "final_output",
    "assertion",
    "workspace",
  ]);
  const evidence = Array.isArray(obj.evidence)
    ? obj.evidence
        .filter(
          (e): e is { kind: string; ref: string; note: string } =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as Record<string, unknown>).kind === "string" &&
            typeof (e as Record<string, unknown>).ref === "string" &&
            typeof (e as Record<string, unknown>).note === "string" &&
            VALID_EVIDENCE_KINDS.has(
              (e as Record<string, unknown>).kind as string,
            ),
        )
        .map((e) => ({
          kind: e.kind as
            | "runtime_event"
            | "final_output"
            | "assertion"
            | "workspace",
          ref: e.ref,
          note: e.note,
        }))
    : [];

  return {
    enabled: true,
    passed: obj.passed,
    score: obj.score,
    summary: obj.summary,
    strengths,
    problems,
    evidence,
    needsHumanReview:
      typeof obj.needsHumanReview === "boolean" ? obj.needsHumanReview : false,
  };
}

/**
 * runJudge — 执行 judge 评价
 *
 * @param input - judge 输入
 * @param llmClient - judge LLM 客户端（可以是 scripted 或真实 LLM）
 * @returns EvalJudgeResult
 */
export async function runJudge(
  input: EvalJudgeInput,
  llmClient: LLMClient,
): Promise<EvalJudgeResult> {
  const prompt = buildJudgePrompt(input);

  // 调用 judge LLM
  const response = await llmClient.chat(
    [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    [], // judge 不需要工具
  );

  const rawText = response.content ?? "";
  const parsed = parseJudgeResponse(rawText);

  if (parsed === null) {
    return {
      enabled: true,
      passed: false,
      score: 0,
      summary: "Judge JSON parse failed",
      strengths: [],
      problems: ["Judge returned invalid JSON"],
      evidence: [
        {
          kind: "runtime_event",
          ref: "judge-raw-response",
          note: rawText.slice(0, 200),
        },
      ],
      needsHumanReview: true,
    };
  }

  const validated = validateJudgeResult(parsed);
  if (validated === null) {
    return {
      enabled: true,
      passed: false,
      score: 0,
      summary: "Judge result validation failed: missing required fields",
      strengths: [],
      problems: ["Judge JSON missing required fields (passed, score, summary)"],
      evidence: [],
      needsHumanReview: true,
    };
  }

  // 后处理：截断 score 到合法范围，并根据 rubric 重新计算 passed
  if (input.rubric.scoring) {
    const { minPassingScore, maxScore } = input.rubric.scoring;
    validated.score = Math.max(0, Math.min(maxScore, validated.score));
    validated.passed = validated.score >= minPassingScore;
  }

  return validated;
}
