/**
 * team-schema.ts — Agent Team eval 扩展类型入口
 *
 * 职责：把 Team 专用的 judge 输入类型放在 team 目录下，避免 Eval Core
 * 被 team-specific 报告结构继续膨胀。
 */

export type { TeamJudgeInput } from "./team-trace.js";
