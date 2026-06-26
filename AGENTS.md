# CLAUDE.md

This file is the project-level instruction file for coding agents working in this repository.

## Project Identity

This is a teaching-purpose TypeScript coding agent. The goal is to demonstrate how a coding agent works internally with clear, well-documented code that prioritizes readability over production complexity.

Design documents live in `doc/`. The current project state lives in `doc/summary.md`.

## Required Startup Context

Before working in this repository:

1. Read `AGENTS.md` (and `CLAUDE.md`, which is a mirror of this file for Claude Code compatibility).
2. Read `doc/summary.md` to understand the current implemented state.
3. If the task references a design document, read that document before changing code.
4. If the task is to write or rewrite a tutorial chapter (`tutorial/chapters/*.html`), read `doc/tutorial_guide.md` first and follow its workflow and checklist.

Do not read `TODO.md`, `doc/todo.md`. It contains future feature ideas and should not influence current work.

If the user asks to review, analyze, or optimize a design document, do not start coding unless the user explicitly asks for implementation.

## External Documentation

When implementing code that depends on external libraries, frameworks, SDKs, APIs, CLI tools, or cloud services, use Context7 to fetch current documentation before coding.

Do not use Context7 for ordinary refactors, business logic debugging, code review, or general TypeScript concepts.

## Commands

```bash
npm run build          # Compile TS to dist/
npm run dev            # Run with tsx watch
npm test               # Run all tests once
npm run test:watch     # Run tests in watch mode
npm run test:coverage  # Run tests with coverage
npm run typecheck      # Type-check without emitting
npm run lint           # Run eslint
npm run format         # Format with prettier
npm run format:check   # Check formatting
```

Run one test file:

```bash
npx vitest run src/path/to/file.test.ts
```

Run eslint on one file:

```bash
npx eslint src/path/to/file.ts
```

## TypeScript Rules

- ESM only: `"type": "module"` in `package.json`, `module: "NodeNext"`.
- Use `.js` extensions in local imports: `import { foo } from "./foo.js"`.
- Strict mode is enabled, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Path alias: `@/*` maps to `src/*`.
- Target: ES2022 / Node.js >= 20.
- Use named exports. Avoid default exports.
- Use `interface` for object shapes and `type` for unions/intersections.
- Prefer `async/await` over raw promise chains.

## Code Style

- All source code lives in `src/`.
- Tests are co-located as `*.test.ts`.
- All generated or modified code must include detailed Chinese comments explaining the purpose and principle of each important block. This is a teaching project.
- Keep changes surgical. Do not refactor unrelated code.
- Match existing local style even if a different style would also work.
- Do not introduce speculative abstractions or configurability.

## Architecture Pointers

Use `doc/summary.md` as the source of truth for the current architecture and implemented modules. Do not duplicate the full module list here, because it changes after each lesson.

Stable architectural conventions:

- `index.ts` is the composition root. Create shared instances there and pass them by dependency injection.
- `agent.ts` owns the main think-act-observe loop.
- Tools are registered through `tools/registry.ts`.
- Tool names use the `run_` prefix and lowercase names.
- State-bearing modules use `createXxx()` factory functions and keep internal state in closures.
- Permission checks happen before tool execution.
- Subagents must inherit shared dependencies intentionally, not recreate them by accident.

## Design-Doc Workflow

When implementing from a design document:

1. Extract every concrete requirement into a checklist before coding.
2. Implement against that checklist.
3. After coding, verify each item line by line against the design document.
4. Update `doc/summary.md` when the implemented project state changes.

Common failure mode: reading a design document once, then implementing from memory. Do not do that.

## Tutorial Writing Workflow

When writing or rewriting a tutorial chapter (`tutorial/chapters/*.html`), follow `doc/tutorial_guide.md` as the authoritative style guide. The guide encodes conventions built up over many chapter rewrites and is updated when new anti-patterns are discovered.

The guide covers:

- 4-section structure per chapter (5-piece opening, real-failure story, N technical sections, closing).
- Per-section 4-segment pattern: scenario → naive ideas (with why each fails) → correct approach → design / implementation.
- 3-figure system (`flow-stack`, `flow-compare`, `flow-tree`) with consistent color semantics.
- Chinese/English spacing, bullet-vs-paragraph decision rules, block vs 块 consistency.
- GitHub permanent link format for every code snippet.
- 10 common anti-patterns (e.g. abstract purpose/scenario/design pile-up, multi-item paragraphs joined by semicolons, 块 vs block mixing, factually wrong "calls LLM" claims).
- Validation checklist including the 0-PDD-residue rule and the `node --check` JS syntax gate.

Common failure modes the guide addresses:

- Starting a section with `<strong>用途</strong>` before establishing the problem. The student has no motivation to read.
- Listing N items in one paragraph separated by semicolons. Unreadable. Use `<ul>` instead.
- Claiming a layer "调 LLM" / "调用 LLM" when the code actually does string concatenation. Always verify against the source with `rg` before writing.
- Mixing 块 and block in the same chapter. Pick one and stick to it.

When in doubt, run the guide's validation checklist before committing.

## Cache-Friendly Design Constraints

When adding new features, prioritize prompt cache prefix stability:

- Do not modify system prompt mid-session.
- Do not change tool definitions mid-session.
- Express dynamic state changes via message reminders, not system prompt rewrites.
- Fork-style requests (subagents, future compaction) should reuse the parent's stable prefix.

## Validation Rules

Reader and writer rules must be symmetric:

- If a parser rejects a format, the writer must reject or normalize that format before saving.
- If a file name and file content share an identity field, one module must explicitly verify they match.
- If a feature is wired into the main agent path, also check secondary paths: subagents, hooks, permissions, CLI commands, system prompt composition, and filtered tool registries.

Shared instances must be literally shared:

- Create shared dependencies once in `index.ts`.
- Pass the same object to every consumer that should share state.
- Do not call the same factory twice just because the arguments are identical.

For functions with multiple return paths:

- Walk every branch.
- Check what state is left behind.
- Ask what happens if the function is called again immediately.

## Completion Gates

For code changes, run the smallest useful verification first, then broaden:

1. `npm run typecheck`
2. Relevant `npx vitest run ...` test files
3. `npm test` when the change touches shared behavior
4. `npx eslint <changed-files>` or `npm run lint`

Do not mark a changed file as done while it still has eslint errors introduced by the change.

For tutorial chapter changes (`tutorial/chapters/*.html`):

1. `rg "PDD-\d+" tutorial/chapters/<file>.html` returns 0 matches (no internal design-doc references leak into the tutorial).
2. `node --check tutorial/assets/content.js && node --check tutorial/assets/app.js` exits 0.
3. Spot-check that any code example still matches current source via `rg` (descriptions like "调 LLM 总结" or "throw 异常" must match the actual code).
4. Spot-check that all `tutorial/chapters/XX.html#yy` cross-references point to anchors that actually exist.

If repository-wide lint has pre-existing failures, report them separately and make clear whether the changed files are clean.
