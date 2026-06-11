import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 这个脚本是教程内容的“批量生成器”，不是运行时依赖。
//
// 教程页的视觉和导航由 assets/app.js / assets/styles.css 负责；章节正文则是
// chapters/*.html 片段。直接手写十几章 HTML 很容易出现结构漂移：某一章忘了
// Prompt Card，另一章缺少验证清单，第三章源码链接格式又不一致。这里把章节写成
// 数据，再用同一套模板生成 HTML，让“内容厚度”和“章节节奏”保持稳定。
//
// 这也符合本项目的教学目标：学生读完教程后，要能提炼出一张可以交给 coding agent
// 的 Prompt Card。因此脚本里每章都显式保留 prompt、trap、validation、sourceMap
// 等字段，方便后续导出 prompt-pack 或做内容质量检查。

const __dirname = dirname(fileURLToPath(import.meta.url));
const tutorialRoot = resolve(__dirname, "..");
const chaptersDir = resolve(tutorialRoot, "chapters");
const githubBase =
  "https://github.com/pingp76/learning-claude-code-ts/blob/main";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function inlineCode(value) {
  return `<code>${escapeHtml(value)}</code>`;
}

function paragraphList(paragraphs) {
  return paragraphs.map((text) => `<p>${text}</p>`).join("\n");
}

function definitionList(items) {
  return `<dl class="defs">
${items
  .map(
    (item) => `  <dt>${item.term}</dt>
  <dd>${item.description}</dd>`,
  )
  .join("\n\n")}
</dl>`;
}

function orderedList(items) {
  return `<ol>
${items.map((item) => `  <li>${item}</li>`).join("\n")}
</ol>`;
}

function unorderedList(items) {
  return `<ul>
${items.map((item) => `  <li>${item}</li>`).join("\n")}
</ul>`;
}

function sourceLinks(links, label = "源码阅读路线") {
  return `<div class="source-links" aria-label="${escapeHtml(label)}">
${links
  .map(
    (link) => `  <a
    class="source-link"
    href="${githubBase}/${escapeHtml(link.path)}"
    target="_blank"
    rel="noreferrer"
  >
    ${inlineCode(link.path)} · ${link.note}
  </a>`,
  )
  .join("\n")}
</div>`;
}

function flowFigure(chapter) {
  return `<figure class="figure">
  <div class="flow-map" role="img" aria-label="${escapeHtml(chapter.figure.alt)}">
${chapter.figure.rows
  .map(
    (row) => `    <div class="flow-row">
${row
  .map((item, index) => {
    if (item === "→" || item === "↔") {
      return `      <span class="flow-arrow">${item}</span>`;
    }
    const accent =
      index === 0 || item.includes(chapter.figure.accent ?? "__never__")
        ? " flow-node--accent"
        : "";
    return `      <span class="flow-node${accent}">${item}</span>`;
  })
  .join("\n")}
    </div>`,
  )
  .join("\n")}
  </div>
  <figcaption>${chapter.figure.caption}</figcaption>
</figure>`;
}

function card(className, tag, body, copy = false) {
  return `<div class="card ${className}">
  <div class="card__head">
    <span class="card__tag">${tag}</span>
    ${copy ? '<button class="card__copy" data-copy-card>复制</button>' : ""}
  </div>
  <div class="card__body">
${body}
  </div>
</div>`;
}

function promptCard(chapter) {
  return card(
    "card--prompt",
    "Prompt Card",
    `<p><strong>目标：</strong>${chapter.prompt.goal}</p>
<p><strong>场景：</strong>${chapter.prompt.scene}</p>
<p><strong>模块：</strong>${chapter.prompt.modules}</p>
<p><strong>接线：</strong>${chapter.prompt.wiring}</p>
<p><strong>边界：</strong>${chapter.prompt.boundary}</p>
<p><strong>例外和 corner case：</strong>${chapter.prompt.cases}</p>
<p><strong>验证：</strong>${chapter.prompt.validation}</p>
<p><strong>源码入口：</strong>${chapter.prompt.sources}</p>
<p><strong>文档同步：</strong>${chapter.prompt.docs}</p>`,
    true,
  );
}

function trapCard(chapter) {
  return card(
    "card--trap",
    "Design Trap",
    `<p><strong>常见错误：</strong>${chapter.trap.mistake}</p>
<p><strong>为什么错：</strong>${chapter.trap.why}</p>
<p><strong>正确做法：</strong>${chapter.trap.fix}</p>
<p><strong>怎么验证：</strong>${chapter.trap.verify}</p>`,
  );
}

function validationCard(chapter) {
  return card(
    "card--validation",
    "Validation",
    `<p><strong>手工 query：</strong>${chapter.validation.manual}</p>
<p><strong>确定性测试：</strong>${chapter.validation.deterministic}</p>
<p><strong>集成观察：</strong>${chapter.validation.integration}</p>
<p><strong>失败信号：</strong>${chapter.validation.failure}</p>`,
  );
}

function codeBlock(code) {
  return `<pre class="code-block"><code>${escapeHtml(code)}</code></pre>`;
}

function renderExtraSections(chapter) {
  if (!chapter.extraSections?.length) return "";

  return chapter.extraSections
    .map(
      (section) => `<h2 id="${section.id}">${section.title}</h2>
${section.body}`,
    )
    .join("\n\n");
}

function renderSourceNote(chapter) {
  if (!chapter.sourceNote) return "";

  return `<div class="note">
  <p class="note__title">${chapter.sourceNote.title}</p>
  ${paragraphList(chapter.sourceNote.paragraphs)}
</div>`;
}

function studyPath(chapter) {
  if (chapter.studyPath?.length) return chapter.studyPath;

  return [
    "先从本章场景和朴素方案进入问题，不急着记函数名。",
    "再用 loop 位置和架构图建立心智模型：新增模块到底改变了哪条数据流或状态流。",
    "最后再看接口、源码地图和验证方法，把概念压缩成能交给 coding agent 的 Prompt Card。",
  ];
}

function implementationBridge(chapter) {
  if (chapter.implementationBridge?.length) return chapter.implementationBridge;

  return [
    "到这里已经有了场景、失败原因和架构图。下面才进入实现层：只抓住接口形状、状态边界和源码入口。",
    "读源码时先找入口函数，再找它读写的状态，最后看测试如何证明这些状态变化是真的发生了。",
  ];
}

function renderChapter(chapter) {
  return `<p class="article__eyebrow">${chapter.eyebrow}</p>
<h1 class="article__title">${chapter.title}</h1>
<p class="article__lede">
  ${chapter.lede}
</p>

<nav id="article-inline-toc" class="article__meta" aria-label="页内小节"></nav>

<hr class="rule" />

<h2 id="known-and-unknown">你已经知道什么，还不知道什么</h2>
${paragraphList(chapter.known)}

<h2 id="study-path">本章怎么学</h2>
${paragraphList(studyPath(chapter))}

<h2 id="scene">本章场景</h2>
${paragraphList(chapter.scene)}

<h2 id="naive">先试一个朴素方案</h2>
${paragraphList(chapter.naive)}
${chapter.naiveCode ? codeBlock(chapter.naiveCode) : ""}

<h2 id="why-naive-fails">朴素方案为什么不够</h2>
${definitionList(chapter.whyNaiveFails)}

<h2 id="loop">回到 Agent Loop</h2>
${paragraphList(chapter.loop)}

<h2 id="architecture">架构图解</h2>
${flowFigure(chapter)}

${renderExtraSections(chapter)}

<h2 id="from-principle-to-code">从原理落到代码</h2>
${paragraphList(implementationBridge(chapter))}

<h2 id="walkthrough">一次真实运行 walkthrough</h2>
${orderedList(chapter.walkthrough)}

<h2 id="interfaces">关键接口和伪码</h2>
${paragraphList(chapter.interfacesIntro)}
${codeBlock(chapter.interfaceCode)}

<h2 id="source-map">源码地图</h2>
${paragraphList(chapter.sourceIntro)}
${sourceLinks(chapter.sources, `${chapter.number} 章源码阅读路线`)}
${renderSourceNote(chapter)}

<h2 id="design">设计直觉</h2>
${paragraphList(chapter.design)}

<h2 id="split">架构拆分</h2>
${definitionList(chapter.split)}

<h2 id="state-boundary">状态与边界</h2>
${definitionList(chapter.stateBoundary)}

<h2 id="prompt">Prompt Card</h2>
${promptCard(chapter)}

<h2 id="trap">容易踩坑</h2>
${trapCard(chapter)}
${unorderedList(chapter.traps)}

<h2 id="validate">如何验证</h2>
${validationCard(chapter)}
${unorderedList(chapter.verifyItems)}

<h2 id="debug">如果实现失败，先查哪里</h2>
${unorderedList(chapter.debug)}

<h2 id="practice">本章练习</h2>
${paragraphList(chapter.practice)}

<h2 id="summary">本章小结</h2>
${paragraphList(chapter.summary)}

<h2 id="next">下一章伏笔</h2>
${paragraphList(chapter.next)}
`;
}

const chapters = [
  {
    id: "02-tools",
    number: "02",
    filename: "02-tools.html",
    eyebrow: "第 02 章 · 让模型提出动作",
    title: "给 Agent 一双手：工具调用",
    lede: "最小 Agent Loop 只能聊天，不能读文件、跑测试或修改代码。这一章把 tool call 接进 loop：模型只提出结构化动作请求，真正执行动作的是 harness。",
    known: [
      `你已经有了 ${inlineCode("agent.run(query)")}、History 和 LLM Client。现在要面对第一个 coding agent 的分水岭：模型不能直接碰你的文件系统，它只能通过工具协议说“我想读这个文件”或“我想运行这个命令”。`,
      `本章不会追求完整工具生态，只实现最小的 bash / read / write / edit / editExact 思路。重点是理解 tool schema、tool registry、tool call 和 tool result 如何进入同一个 loop。`,
    ],
    scene: [
      `用户输入：“帮我看看 ${inlineCode("src/agent.ts")} 里主循环怎么写。”如果 agent 只是把这句话交给 LLM，模型只能猜。真正的 coding agent 必须先读取文件，再基于观察结果回答。`,
      `于是 LLM 返回的不是最终答案，而是一个结构化 tool call：调用 ${inlineCode("run_read")}，参数是目标路径。Harness 检查权限、执行工具、把 tool result 写回 History，然后再把新 messages 发给 LLM。`,
    ],
    naive: [
      `最朴素的想法是让模型输出一段 shell 命令，然后本地直接执行。比如模型说“cat src/agent.ts”，harness 就调用 shell。这个方案很诱人，因为看起来不需要 schema、registry 和参数校验。`,
      `但这相当于把你的终端交给了模型。模型生成的文本可能包含危险命令，也可能因为格式不稳定导致解析失败。更糟的是，工具结果没有结构化写回，下一轮模型不知道刚才到底执行了什么。`,
    ],
    naiveCode: `const answer = await llm.chat(messages);
const command = extractShell(answer.content);
const output = await exec(command);
messages.push({ role: "user", content: output });`,
    whyNaiveFails: [
      {
        term: "安全边界消失",
        description:
          "自然语言和 shell 字符串混在一起，harness 很难稳定判断哪些命令可执行、哪些路径越界、哪些操作需要用户确认。",
      },
      {
        term: "模型看不到稳定能力菜单",
        description:
          "没有 tool schema 时，模型只能猜工具名字和参数格式。一次叫 read_file，下一次叫 cat_file，tool registry 无法可靠匹配。",
      },
      {
        term: "tool_call / tool_result 无法配对",
        description:
          "LLM 协议要求工具调用和工具结果按顺序成对出现。把输出伪装成普通 user message，会让后续 normalize、compress、replay 都失去事实边界。",
      },
    ],
    loop: [
      `工具调用插在 “LLM 返回后” 和 “下一次 LLM 调用前”。Agent 先把 assistant message 写入 History；如果其中包含 tool calls，就逐个查 registry、做权限检查、执行工具，再把 tool results 写回 History。`,
      `这一步完成后，loop 不结束。Agent 会带着新观察结果再次调用 LLM，让模型基于真实文件内容或命令输出生成下一步动作或最终回答。`,
    ],
    figure: {
      alt: "工具调用接入 Agent Loop 的数据流",
      accent: "Tool Registry",
      rows: [
        ["LLM", "→", "assistant tool_call", "→", "Tool Registry"],
        ["Permission", "→", "run_read / run_bash", "→", "tool_result"],
        ["History", "→", "messages with observation", "→", "LLM"],
      ],
      caption:
        "图 02-1 · 模型只提出动作，工具执行、权限和结果写回都属于 harness。",
    },
    walkthrough: [
      `用户要求解释某个源码文件，REPL 把 query 交给 ${inlineCode("agent.run()")}。`,
      `Agent 写入 user message，并把当前 messages 与工具定义一起发给 LLM。`,
      `LLM 返回 assistant message，其中包含 ${inlineCode("run_read")} 的 tool call。`,
      `Agent 先把 assistant message 追加到 History，保留模型提出动作的事实。`,
      `Agent 根据工具名从 ${inlineCode("ToolRegistry")} 找到实现，并把参数交给对应工具。`,
      `工具在 projectRoot 边界内读取文件，返回 ${inlineCode("ToolResult")}。`,
      `Agent 把 tool result 追加到 History，形成 tool_call / tool_result 配对。`,
      `下一轮 LLM 看到文件内容后，才能给出基于事实的解释。`,
    ],
    interfacesIntro: [
      `最关键的接口不是某个具体工具，而是“模型可见 schema”和“harness 内部执行函数”的分离。schema 稳定给模型看，handler 稳定给 Agent 调用。`,
    ],
    interfaceCode: `interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

interface ToolHandler {
  (args: unknown): Promise<ToolResult>;
}

interface ToolRegistry {
  definitions(): ToolDefinition[];
  execute(name: string, args: unknown): Promise<ToolResult>;
}

while (true) {
  const assistant = await llm.chat(messages, registry.definitions());
  history.add(assistant);
  if (!assistant.toolCalls?.length) return assistant.content;

  for (const call of assistant.toolCalls) {
    const result = await registry.execute(call.name, call.arguments);
    history.addToolResult(call.id, result);
  }
}`,
    sourceIntro: [
      `读源码时不要先陷进每个文件工具的所有细节。先看 registry 如何稳定注册工具，再看 Agent 如何在 tool call 和 tool result 之间保持消息顺序。`,
    ],
    sources: [
      { path: "src/tools/registry.ts", note: "工具注册表和稳定顺序" },
      { path: "src/tools/bash.ts", note: "bash 工具与命令安全边界" },
      {
        path: "src/tools/files.ts",
        note: "文件读写编辑工具与 projectRoot 限制",
      },
      { path: "src/tools/types.ts", note: "ToolResult 的共享形状" },
      { path: "src/agent.ts", note: "tool call 执行循环" },
      { path: "src/tools/registry.test.ts", note: "重复注册和过滤测试" },
    ],
    design: [
      `Tool Registry 是 agent 的“手册柜台”：模型只知道菜单，Agent 只通过柜台执行动作。这个边界让工具名、参数 schema、权限检查和执行结果都能被测试。`,
      `工具结果不是给用户看的日志，而是下一轮 LLM 的观察材料。它必须进入 History，且必须以 tool result 的身份进入，否则后续压缩、回放和错误恢复都会失去结构。`,
    ],
    split: [
      {
        term: "tools/*",
        description:
          "每个工具模块只关心自己的参数校验、业务执行和 ToolResult 输出。",
      },
      {
        term: "ToolRegistry",
        description:
          "集中维护工具名、schema、handler 和过滤规则，保证模型看到的工具顺序稳定。",
      },
      {
        term: "Agent Loop",
        description:
          "负责识别 assistant tool calls、执行工具、把 tool results 写回 History 并继续下一轮。",
      },
    ],
    stateBoundary: [
      {
        term: "进入 LLM messages",
        description: "工具定义、assistant tool_call、tool_result 的可见内容。",
      },
      {
        term: "不直接暴露给 LLM",
        description:
          "本地绝对路径、内部 handler、权限实现细节和未登记的大输出文件。",
      },
      {
        term: "session-local",
        description:
          "本轮工具调用顺序和临时执行结果；后续 Transcript 会记录审计事实。",
      },
    ],
    prompt: {
      goal: "实现最小工具调用闭环，让 agent 能通过 run_bash/run_read/run_write/run_edit/run_edit_exact 观察和修改项目。",
      scene:
        "用户要求读取文件或运行测试时，模型必须先提出结构化 tool call，再由 harness 执行并写回 tool result。",
      modules:
        "新增 tools/registry.ts、tools/types.ts、tools/bash.ts、tools/files.ts，并扩展 agent.ts 的 tool call 分支。",
      wiring:
        "在 composition root 创建一次 ToolRegistry，把工具定义传给 LLM，把 registry 注入 Agent。",
      boundary:
        "不要绕过 registry 执行模型生成的自然语言命令；文件工具必须限制在 projectRoot。",
      cases:
        "未知工具、非法参数、路径越界、工具抛错、大输出都要变成可恢复 ToolResult。",
      validation:
        "用 fake LLM 触发 tool call，断言 tool_call/tool_result 顺序、路径拒绝和工具不存在错误。",
      sources:
        "src/agent.ts、src/tools/registry.ts、src/tools/files.ts、src/tools/bash.ts。",
      docs: "更新 summary 和教程章节，说明工具是 harness 动作，不是模型自己执行。",
    },
    trap: {
      mistake: "把模型输出的 shell 文本直接执行。",
      why: "自然语言不是稳定协议，无法可靠做权限、参数、审计和回放。",
      fix: "模型只能返回结构化 tool call；所有执行都经过 registry 和权限层。",
      verify:
        "测试未知工具和路径越界时，Agent 应返回 tool_result 错误而不是崩溃或执行危险命令。",
    },
    traps: [
      "工具名随意变化会破坏模型习惯，也会让测试难以稳定。",
      "tool_result 不能插入到错误位置，否则后续消息标准化会被迫修复甚至无法修复。",
      "文件工具必须先 normalize 路径再检查边界，不能只做字符串前缀判断。",
    ],
    validation: {
      manual:
        "让 agent 读取一个存在文件、读取一个不存在文件、尝试读取 ../AGENTS.md 之外路径。",
      deterministic:
        "fake LLM 返回固定 tool call，测试 Agent 是否执行 registry 并继续下一轮。",
      integration:
        "运行 files/bash/registry/agent 相关测试，观察工具错误是否回到 LLM 可见消息。",
      failure:
        "模型直接输出命令文本却被执行，或 tool_result 没有对应 tool_call。",
    },
    verifyItems: [
      `${inlineCode("src/tools/files.test.ts")} 覆盖 read/write/edit/editExact 的成功和拒绝路径。`,
      `${inlineCode("src/tools/bash.test.ts")} 覆盖危险命令和命令输出。`,
      `${inlineCode("src/agent.test.ts")} 覆盖 tool call 进入 loop 后的消息顺序。`,
    ],
    debug: [
      "先看 LLM 返回的是不是结构化 tool call，而不是普通文本。",
      "再看 registry 是否注册了同名工具，名称大小写是否一致。",
      "检查 tool result 是否带着正确 call id 写回 History。",
      "路径问题先看 projectRoot 和 normalize 后的绝对路径。",
    ],
    practice: [
      "不看 Prompt Card，自己写一段任务 prompt：只实现 read/write 两个工具，要求 agent 能通过 fake LLM 读取文件并回答。然后对照本章卡片补齐你遗漏的权限和错误路径。",
    ],
    summary: [
      "本章让 agent 第一次拥有“手”。但这双手还没有工作节奏：遇到一个多步骤任务时，它可能知道能读写文件，却不知道如何持续维护计划。",
    ],
    next: [
      "下一章引入 TODO Manager，让 agent 在多轮执行中显式维护短期计划，而不是只靠自然语言说“我接下来会做”。",
    ],
  },
  {
    id: "03-todo",
    number: "03",
    filename: "03-todo.html",
    eyebrow: "第 03 章 · 让执行有节奏",
    title: "让多轮执行有节奏：TODO Manager",
    lede: "工具让 agent 能行动，但多步骤任务会让行动顺序变得混乱。TODO Manager 给本轮 session 一个结构化执行清单，让模型、用户和测试都能看到任务进度。",
    known: [
      `你已经有工具调用闭环：模型提出动作，harness 执行工具并写回观察。现在的问题是：用户给一个“修 bug、加测试、更新文档”的复合任务时，agent 如何避免走一步忘一步？`,
      `本章的 TODO 是短期计划，只服务当前 session。它不是项目管理系统，也不是跨会话 Task。这个边界非常重要，因为第 12 章会单独引入 Persistent Task。`,
    ],
    scene: [
      `用户输入：“修复权限测试失败，补一个回归测试，然后更新 summary。”如果 agent 只是立即执行第一个工具调用，很可能修完代码就忘了文档，或者同时声明多个任务都在进行。`,
      `TODO Manager 的作用是把这类任务拆成结构化状态：pending、in_progress、completed。每一次行动前后，agent 都能更新状态，并在被打断时告诉用户现在卡在哪里。`,
    ],
    naive: [
      `朴素做法是在 assistant 回复里写一段自然语言计划：“我会先看测试，再改代码，最后更新文档。”这看起来足够友好，许多聊天机器人都这么做。`,
      `问题是自然语言计划无法被 harness 检查。它不能保证只有一个 in_progress，不能在轮次上限时稳定恢复，也不能被工具或测试读取。`,
    ],
    naiveCode: `assistant: 我会：
1. 查看失败测试
2. 修改权限逻辑
3. 更新文档

// 之后这些步骤只存在于自然语言里，harness 看不见。`,
    whyNaiveFails: [
      {
        term: "状态不可机器检查",
        description:
          "自然语言里写了三个步骤，但测试无法断言哪个任务正在执行，Agent 也无法自动发现已经完成或遗漏的项。",
      },
      {
        term: "多轮容易漂移",
        description:
          "LLM 下一轮可能改写计划、忘记旧计划，或者把未完成事项说成已完成。",
      },
      {
        term: "与长期任务混淆",
        description:
          "把本轮 TODO 落盘成长期计划，会让临时执行节奏污染项目级任务系统。",
      },
    ],
    loop: [
      `TODO Manager 主要影响 “LLM 思考和工具执行之间” 的节奏。模型可以通过 TODO 工具创建和更新短期清单；Agent 在每轮提醒中暴露当前 TODO 状态，让下一轮模型继续按计划推进。`,
      `它不改变工具执行的安全边界，也不替代 History。它只是给当前 session 增加一个结构化、可观察的计划层。`,
    ],
    figure: {
      alt: "TODO Manager 在 Agent Loop 中的位置",
      accent: "TODO Manager",
      rows: [
        ["User Task", "→", "Agent Loop", "→", "TODO Manager"],
        ["Tool Calls", "↔", "TODO State", "→", "Session Reminder"],
        ["Next LLM Turn", "→", "Plan-aware Action", "→", "Progress Update"],
      ],
      caption:
        "图 03-1 · TODO 不执行工具，它只让当前 session 的执行节奏变得结构化。",
    },
    walkthrough: [
      `用户提出复合任务，Agent 先创建 3 个 TODO 项。`,
      `Agent 把第一个 TODO 标记为 in_progress，开始读取失败测试。`,
      `工具执行完成后，Agent 根据观察结果修改代码，并更新 TODO 状态。`,
      `第一项完成后，Agent 将第二项标记为 in_progress。`,
      `如果达到 maxRounds，Agent 返回时带上当前 TODO 状态，告诉用户还剩什么。`,
      `下一轮用户说“继续”，当前 TODO 状态通过 reminder 帮助模型接上节奏。`,
    ],
    interfacesIntro: [
      `TODO 的接口要小而明确：创建列表、更新状态、删除条目。它的状态存在闭包里，随 session 生命周期结束而结束。`,
    ],
    interfaceCode: `type TodoStatus = "pending" | "in_progress" | "completed";

interface TodoItem {
  id: string;
  content: string;
  status: TodoStatus;
}

interface TodoManager {
  list(): TodoItem[];
  add(content: string): TodoItem;
  update(id: string, patch: Partial<TodoItem>): TodoItem;
  remove(id: string): boolean;
}

// 关键约束：同一时间最多一个 in_progress。
function setInProgress(id: string) {
  for (const todo of todos) {
    if (todo.status === "in_progress" && todo.id !== id) {
      todo.status = "pending";
    }
  }
  update(id, { status: "in_progress" });
}`,
    sourceIntro: [
      `先看业务层如何维护状态机，再看工具 provider 如何把 TODO 暴露给模型。不要把它和第 12 章的持久化 Task 混读。`,
    ],
    sources: [
      { path: "src/todo.ts", note: "session-local TODO 管理器" },
      { path: "src/todo.test.ts", note: "TODO 状态机测试" },
      { path: "src/cli-commands.ts", note: "CLI 中查看或操作任务的入口" },
      { path: "src/agent.ts", note: "TODO reminder 如何影响 loop" },
    ],
    design: [
      `TODO 的价值不是“让模型显得有条理”，而是把执行计划变成 harness 可以观察的状态。只要状态结构化，测试就能证明 agent 没有漏步骤。`,
      `TODO 保持 session-local，是为了不把临时执行清单变成长期项目计划。短期节奏和长期任务的边界越清楚，后续 Task 系统越容易设计。`,
    ],
    split: [
      {
        term: "TodoManager",
        description: "维护当前 session 的 TODO 数组、状态机和格式化输出。",
      },
      {
        term: "TODO tools",
        description:
          "把 add/update/list/remove 暴露给模型，让模型能显式维护计划。",
      },
      {
        term: "Agent reminder",
        description:
          "把当前 TODO 状态放进动态提醒，而不是重写稳定 system prompt。",
      },
    ],
    stateBoundary: [
      {
        term: "session-local",
        description: "TODO 列表、当前 in_progress 项、临时执行说明。",
      },
      {
        term: "不持久化",
        description: "TODO 不写入 agentHome，不跨重启恢复，不承担长期计划。",
      },
      {
        term: "进入 LLM messages",
        description:
          "当前 TODO 摘要可以作为 reminder 注入，帮助模型继续下一步。",
      },
    ],
    prompt: {
      goal: "实现 session-local TODO Manager，让 agent 能为多步骤任务维护短期执行清单。",
      scene:
        "用户给复合任务时，agent 先创建 TODO，再按 pending/in_progress/completed 推进。",
      modules:
        "新增或完善 src/todo.ts、TODO 工具 provider、agent reminder 和相关测试。",
      wiring:
        "在 composition root 创建当前 session 的 TodoManager，把工具注册进 registry，把摘要注入动态 reminder。",
      boundary:
        "不要把 TODO 持久化为长期 Task；不要让多个 TODO 同时 in_progress。",
      cases:
        "删除不存在项、重复更新、状态非法、达到 maxRounds 后的剩余任务提示。",
      validation:
        "测试 add/update/remove/list、单 in_progress 约束和中断后 reminder 内容。",
      sources: "src/todo.ts、src/todo.test.ts、src/agent.ts。",
      docs: "说明 TODO 是短期执行节奏，不是跨会话任务系统。",
    },
    trap: {
      mistake: "把 TODO 当成长期项目任务落盘。",
      why: "临时执行步骤会污染项目级计划，也会让重启后的状态语义变得模糊。",
      fix: "TODO 只在 session 内存活；跨会话计划交给 Persistent Task。",
      verify: "重启或新建 agent 后 TODO 为空，但第 12 章 Task 仍可持久化。",
    },
    traps: [
      "只让模型自然语言声明计划，harness 无法检查状态。",
      "允许多个 in_progress，用户和模型都不知道当前真正执行的是哪一步。",
      "子智能体继承父 TODO，会让局部分析污染主任务进度。",
    ],
    validation: {
      manual:
        "让 agent 执行三步任务，中途要求它汇报当前 TODO，看是否只标记一个 in_progress。",
      deterministic: "用 TODO 工具测试状态更新、删除和非法 id。",
      integration: "在 agent 多轮运行中观察 TODO reminder 是否随更新变化。",
      failure: "TODO 内容只出现在自然语言回复里，工具和测试无法读取。",
    },
    verifyItems: [
      `${inlineCode("src/todo.test.ts")} 覆盖状态机和列表操作。`,
      "模拟 maxRounds 到达时，最终回复应包含未完成 TODO 的清楚提示。",
      "子智能体测试中确认 child 不共享 parent 的 TODO manager。",
    ],
    debug: [
      "检查 TodoManager 是否被创建在 session 级别，而不是模块全局变量。",
      "检查 update 时是否自动收敛其他 in_progress。",
      "检查 reminder 是否来自最新 TODO 状态。",
      "检查工具返回是否足够简洁，避免 TODO 自己撑爆上下文。",
    ],
    practice: [
      "写一个 prompt，让 coding agent 只实现 TODO Manager 的内存状态机和测试，不接 LLM。再补一版 prompt，把它接进 tool registry 和 agent reminder。",
    ],
    summary: [
      "本章让 agent 的行动有了节奏。下一步，当主 agent 遇到一个局部复杂问题时，我们希望它能委托一个隔离上下文的小 agent 去探索，而不是把所有信息都塞进主 History。",
    ],
    next: [
      "下一章进入 SubAgent：把“委托”做成一种工具，同时严格控制上下文隔离、递归风险和权限继承。",
    ],
  },
  {
    id: "04-subagent",
    number: "04",
    filename: "04-subagent.html",
    eyebrow: "第 04 章 · 委托与隔离",
    title: "让 Agent 学会分身：SubAgent",
    lede: "SubAgent 让主 agent 可以把局部问题交给一个隔离上下文的小 agent。它看起来像多智能体，其实第一版只需要把“委托”做成一个受控工具。",
    known: [
      `你已经有工具、TODO 和主 loop。现在要解决的问题不是“怎么让 agent 更聪明”，而是“怎么让它在不污染主上下文的情况下做局部探索”。`,
      `SubAgent 的关键直觉是：它本质上是一个工具。主 agent 调用 ${inlineCode("run_subagent")}，传入任务；harness 创建 child agent，给它独立 History 和受限工具集，最后把结果作为 tool result 返回父 agent。`,
    ],
    scene: [
      `用户要求：“帮我 review 这次重构的风险。”主 agent 可能需要读取多处文件、比较设计文档、整理发现。如果这些探索细节全部进入主 History，主上下文会迅速膨胀。`,
      `更好的做法是让主 agent 委托一个 review 子智能体：child 独立搜集证据，最后只把结论和引用返回给父 agent。`,
    ],
    naive: [
      `朴素做法是在主 loop 里递归调用 ${inlineCode("createAgent()")}，并把父 agent 的所有依赖原样传进去。甚至允许 child 再调用 run_subagent。`,
      `这会很快失控：上下文递归、权限扩大、工具循环、父子 History 混在一起。SubAgent 必须从第一天就被看作“受控工具”，而不是随便复制一个完整 agent。`,
    ],
    naiveCode: `async function runSubagent(task) {
  const child = createAgent(parentDependencies);
  return child.run(task);
}`,
    whyNaiveFails: [
      {
        term: "递归调用失控",
        description:
          "如果 child 也能调用 run_subagent，很容易形成树状爆炸，成本、时间和上下文都不可控。",
      },
      {
        term: "权限被无意扩大",
        description:
          "父 agent 在 default 模式下可写文件，不代表 child 做分析时也应该拥有写权限。",
      },
      {
        term: "父子上下文污染",
        description:
          "child 的探索过程如果直接写入父 History，会让主对话变长，也会混淆谁观察了什么。",
      },
    ],
    loop: [
      `SubAgent 插在工具执行层：对父 agent 来说，${inlineCode("run_subagent")} 只是一个普通工具调用；对 harness 来说，它会启动一段新的 agent loop。`,
      `这个 child loop 可以复用稳定 system prompt snapshot，但必须拥有独立 History、独立 maxRounds 和经过过滤的 registry。最终返回父 agent 的只是一段总结性 tool result。`,
    ],
    figure: {
      alt: "父 Agent 调用 SubAgent 的关系",
      accent: "SubAgent Tool",
      rows: [
        ["Parent Agent", "→", "SubAgent Tool", "→", "Child Agent"],
        ["Stable Snapshot", "→", "Child History", "→", "Filtered Registry"],
        ["Child Result", "→", "tool_result", "→", "Parent History"],
      ],
      caption: "图 04-1 · SubAgent 是父 loop 里的工具，但它内部拥有独立 loop。",
    },
    walkthrough: [
      `父 agent 判断当前任务适合委托，返回 ${inlineCode("run_subagent")} tool call。`,
      `ToolRegistry 找到 subagent 工具，权限层确认是否允许启动 child。`,
      `SubAgent 工具创建 child History，不复用父 History 的可变内容。`,
      `组装 child registry，过滤掉 run_subagent 等可能导致递归的工具。`,
      `child agent 在自己的 maxRounds 内完成读取、分析或总结。`,
      `child 的最终回答被包装成父 agent 的 tool result。`,
      `父 agent 看到这个结果后，继续生成给用户的最终回复或下一步动作。`,
    ],
    interfacesIntro: [
      `SubAgent 的接口要非常克制。父 agent 只传任务文本和少量配置；child 不能拿到父内部所有状态的可变引用。`,
    ],
    interfaceCode: `interface SubagentRequest {
  task: string;
  maxRounds?: number;
  readonly?: boolean;
}

async function runSubagent(request: SubagentRequest): Promise<ToolResult> {
  const childHistory = createHistory();
  const childRegistry = createReadonlyRegistry();
  const child = createAgent({
    history: childHistory,
    tools: childRegistry,
    stablePrompt: parentStablePromptSnapshot,
    maxRounds: request.maxRounds ?? 6,
  });

  const answer = await child.run(request.task);
  return { output: answer };
}`,
    sourceIntro: [
      `先看 subagent 工具如何创建 child，再看 registry 过滤。不要把它和后续 Async Run 混淆：SubAgent 是同步工具调用，Async Run 是后台运行实例。`,
    ],
    sources: [
      { path: "src/tools/subagent.ts", note: "SubAgent 工具入口" },
      { path: "src/tools/subagent.test.ts", note: "过滤与 maxRounds 测试" },
      { path: "src/agent.ts", note: "父 agent 如何接收 subagent tool_result" },
      { path: "src/system-prompt.ts", note: "稳定 prompt snapshot 的复用边界" },
      { path: "src/session.ts", note: "parentSessionId / child session 关系" },
    ],
    design: [
      `SubAgent 的目标不是炫技，而是控制上下文污染。主 agent 需要结果，不一定需要 child 的每一步思考和观察。`,
      `把 SubAgent 做成工具，可以复用工具调用、权限、History 配对和测试框架，同时把递归与权限收窄放在同一个边界上处理。`,
    ],
    split: [
      {
        term: "Parent Agent",
        description: "决定是否委托，并把 child 结果纳入自己的下一轮推理。",
      },
      {
        term: "SubAgent Tool",
        description: "负责创建 child agent、过滤工具、运行并包装结果。",
      },
      {
        term: "Child Agent",
        description: "拥有独立 History 和 maxRounds，只执行被委托的局部任务。",
      },
    ],
    stateBoundary: [
      {
        term: "共享",
        description:
          "稳定 prompt snapshot、只读项目上下文、必要的 logger 或 session 元信息。",
      },
      {
        term: "隔离",
        description: "History、TODO、临时工具观察、child 轮次预算。",
      },
      {
        term: "收窄",
        description: "工具 registry、权限 profile、可写能力和递归调用能力。",
      },
    ],
    prompt: {
      goal: "实现 run_subagent 工具，让父 agent 可以委托一个隔离上下文的 child agent 完成局部分析。",
      scene:
        "主 agent 遇到 review、搜索、解释等局部任务时，调用 child agent，最终只把总结结果写回父 History。",
      modules:
        "实现 tools/subagent.ts，扩展 registry 过滤能力，补充 session parent/child 元信息和测试。",
      wiring:
        "在 composition root 注入 createReadonlyRegistryFn 和稳定 prompt snapshot，不在工具内部重新创建全套共享依赖。",
      boundary:
        "child 不得默认继承父 TODO，不得递归调用 subagent，不得扩大权限。",
      cases: "child 超过 maxRounds、child 工具失败、父工具被过滤、空任务输入。",
      validation:
        "测试 child 能返回结果、过滤工具不可用、maxRounds 生效、父 History 只看到 tool_result 摘要。",
      sources:
        "src/tools/subagent.ts、src/tools/registry.ts、src/session.ts、src/agent.ts。",
      docs: "说明 SubAgent 是工具，不是生产级多智能体调度系统。",
    },
    trap: {
      mistake: "让 child agent 完整继承父 agent 的工具和权限。",
      why: "委托分析不应该自动获得写权限和递归能力，否则会放大风险。",
      fix: "通过 registry filter 和权限 profile 显式收窄 child 能力。",
      verify: "child 尝试调用被过滤工具时，应得到可恢复错误而不是执行成功。",
    },
    traps: [
      "把 child 探索消息全部塞进父 History，会让上下文迅速膨胀。",
      "child 没有 maxRounds，会导致父工具调用长时间阻塞。",
      "在 subagent 工具内部重新创建 Memory/Skill/OutputStore 等共享依赖，会让状态不一致。",
    ],
    validation: {
      manual:
        "让 agent 委托一个子智能体解释文件，再观察父回复是否只包含总结而不是完整 child 日志。",
      deterministic:
        "fake child 返回固定结果，断言父 History 收到 tool_result。",
      integration: "测试 registry filter 后 child 无法调用 run_subagent。",
      failure: "child 能递归启动 child，或 child 写文件权限大于父期望。",
    },
    verifyItems: [
      `${inlineCode("src/tools/subagent.test.ts")} 覆盖 child 运行和工具过滤。`,
      "检查 parentSessionId 是否能表达父子关系，但不把 child History 混入父 History。",
      "用 maxRounds 很小的 child 任务验证超限时返回明确错误。",
    ],
    debug: [
      "先看 subagent 工具拿到的 registry 是否已经过滤。",
      "检查 child History 是否新建，而不是引用父 History。",
      "检查 stable prompt snapshot 是否复用稳定前缀，而不是运行中重新生成。",
      "检查 child 错误是否包装成 ToolResult 返回父 loop。",
    ],
    practice: [
      "写一个 prompt，让 coding agent 只实现只读 SubAgent：child 只能 run_read，不能 run_write，也不能再次 run_subagent。",
    ],
    summary: [
      "本章让 agent 学会委托，但委托仍然依赖当前已有知识。下一章我们要让 agent 按需加载领域说明，避免把所有技巧都塞进 system prompt。",
    ],
    next: [
      "下一章进入 Skill：它不是动作工具，而是可按需读取的能力说明，让 agent 在需要时临时获得领域工作方式。",
    ],
  },
  {
    id: "05-skill",
    number: "05",
    filename: "05-skill.html",
    eyebrow: "第 05 章 · 按需加载指导",
    title: "按需加载能力：Skill",
    lede: "Skill 不是工具，而是一份可按需注入的工作说明。它让 agent 在不膨胀 system prompt 的情况下，临时学习某个领域的流程、约束和验证方法。",
    known: [
      `你已经有工具和 SubAgent。工具负责动作，SubAgent 负责委托。Skill 解决的是另一个问题：agent 面对特定领域时，需要一份“怎么做”的说明。`,
      `本章要区分 Skill 和 Tool：Tool 是 ${inlineCode("run_read")} 这种可执行动作；Skill 是 ${inlineCode("SKILL.md")} 这种指导文本。模型读了 Skill 后，仍然通过普通工具执行工作。`,
    ],
    scene: [
      `用户要求：“请做一次代码审查。”代码审查不只是读文件，它还包含优先级、输出格式、关注风险、不要堆摘要等工作习惯。如果这些都写进全局 system prompt，prompt 会越来越长。`,
      `Skill 系统让 agent 先扫描有哪些技能，再在需要时读取 code-review/SKILL.md。这样稳定 prompt 只保留索引，完整说明按需进入当前消息。`,
    ],
    naive: [
      `朴素方案是把所有领域说明都拼进 system prompt：代码审查、解释代码、写测试、调试 CI、重构计划……一次性全部给模型。`,
      `这看起来省事，但很快会破坏上下文预算和 prompt cache。更糟的是，Skill 内容更新后如果每轮重写 system prompt，稳定前缀就不稳定了。`,
    ],
    naiveCode: `const systemPrompt = [
  basePrompt,
  readFile("skills/code-review/SKILL.md"),
  readFile("skills/explain-code/SKILL.md"),
  readFile("skills/debug-ci/SKILL.md"),
].join("\\n\\n");`,
    whyNaiveFails: [
      {
        term: "上下文膨胀",
        description:
          "大量未使用的 skill 文本占据 token，真正任务相关的源码和工具结果反而被挤出上下文。",
      },
      {
        term: "稳定前缀被破坏",
        description:
          "Skill 文件变化如果直接重写 system prompt，会让 prompt cache 失去稳定前缀。",
      },
      {
        term: "能力边界不清",
        description:
          "把所有说明混在一起，模型可能在普通解释任务里套用代码审查格式，输出风格漂移。",
      },
    ],
    loop: [
      `Skill 主要影响 “构建 messages 前” 的上下文选择。稳定 system prompt 只放轻量 skill 索引；当模型需要某个 skill 时，通过 skill 工具读取完整内容，再把它作为当前任务的上下文。`,
      `这和 Tool 的动作不同：Skill 本身不改文件、不跑命令，只改变模型接下来如何思考和使用已有工具。`,
    ],
    figure: {
      alt: "Skill 按需加载流程",
      accent: "Skill Manager",
      rows: [
        ["Stable Prompt", "→", "Skill Index", "→", "LLM"],
        ["LLM", "→", "run_skill_invoke", "→", "Skill Manager"],
        ["SKILL.md", "→", "Current Messages", "→", "Domain-aware Action"],
      ],
      caption: "图 05-1 · Skill 索引稳定，完整说明按需进入当前上下文。",
    },
    walkthrough: [
      `启动时 SkillManager 扫描 skills 目录，提取每个 skill 的名称和描述。`,
      `system prompt 中只加入简短 skill 索引，让模型知道有哪些指导可用。`,
      `用户发起代码审查任务，模型决定调用 skill invoke。`,
      `SkillManager 读取对应 SKILL.md，返回内容给模型。`,
      `模型根据 Skill 指导选择读文件、跑测试或输出 findings。`,
      `如果用户移除 skill，当前系统通过 reminder 告知变化，而不是立刻重写稳定 prompt。`,
    ],
    interfacesIntro: [
      `Skill 的接口围绕 scan、invoke、remove 展开。真正的执行仍然由普通工具完成，SkillManager 不应该偷偷操作项目文件。`,
    ],
    interfaceCode: `interface SkillSummary {
  name: string;
  description: string;
  path: string;
}

interface SkillManager {
  scan(): Promise<SkillSummary[]>;
  invoke(name: string): Promise<string>;
  remove(name: string): Promise<boolean>;
  buildPromptSection(): string; // 只包含稳定、轻量索引
}`,
    sourceIntro: [
      `先看 SkillManager 如何扫描和读取，再看 system prompt 如何只注入索引。Skill 的重点是上下文经济性，不是工具能力。`,
    ],
    sources: [
      { path: "src/skills.ts", note: "Skill 管理器和工具 provider" },
      { path: "src/skills.test.ts", note: "scan/invoke/remove 测试" },
      { path: "src/system-prompt.ts", note: "稳定 prompt 中的 skill 索引" },
      { path: "skills/code-review/SKILL.md", note: "示例代码审查 Skill" },
      { path: "skills/explain-code/SKILL.md", note: "示例代码解释 Skill" },
    ],
    design: [
      `Skill 是“可加载的工作方式”。它把领域策略放进文件，让模型在需要时读取，而不是把所有策略永久塞进 system prompt。`,
      `这个设计也让课程更适合 vibe coding：你可以把某类任务的经验沉淀成 Skill，再让 agent 在合适时调用。`,
    ],
    split: [
      {
        term: "Skill files",
        description:
          "用普通 Markdown 描述任务场景、工作流程、输出格式和验证方法。",
      },
      {
        term: "SkillManager",
        description: "扫描、解析、读取和移除 skill，提供稳定索引。",
      },
      {
        term: "Skill tools",
        description: "让模型按名称读取完整 Skill 内容，但不直接执行动作。",
      },
    ],
    stateBoundary: [
      {
        term: "稳定 prompt",
        description: "只放 skill 名称、描述等轻量索引。",
      },
      {
        term: "动态 messages",
        description: "按需读取的完整 SKILL.md 内容进入当前任务上下文。",
      },
      {
        term: "文件系统",
        description:
          "Skill 文件位于 skillsDir，由 SkillManager 控制扫描和读取。",
      },
    ],
    prompt: {
      goal: "实现 Skill 系统，让 agent 能扫描技能索引并按需读取 SKILL.md 指导。",
      scene:
        "面对代码审查、代码解释等任务时，模型先读取对应 Skill，再用普通工具完成工作。",
      modules:
        "实现 src/skills.ts、SkillToolProvider、示例 skills/*/SKILL.md 和测试。",
      wiring:
        "在 system prompt 中注入稳定 skill 索引，把 skill 工具注册进 registry。",
      boundary:
        "不要把所有 Skill 全文塞进 system prompt；Skill 不执行工具动作。",
      cases: "skill 不存在、格式不完整、删除后索引更新、读取内容过大。",
      validation:
        "测试 scan/invoke/remove，确认 system prompt 只含索引，完整内容按需返回。",
      sources:
        "src/skills.ts、src/system-prompt.ts、skills/code-review/SKILL.md。",
      docs: "说明 Skill 是指导文本，Tool 是动作能力。",
    },
    trap: {
      mistake: "把所有 SKILL.md 全文拼进 system prompt。",
      why: "这会膨胀上下文并破坏 prompt cache，也让无关技能干扰当前任务。",
      fix: "稳定 prompt 只放索引，完整 skill 通过工具按需读取。",
      verify: "检查 system prompt snapshot 中没有完整 SKILL.md 正文。",
    },
    traps: [
      "Skill 文件格式过度复杂，会让学生难以编写自己的技能。",
      "Skill 更新后立即重写稳定 prompt，会让 cache 友好设计失效。",
      "把 Skill 当工具执行，会混淆“指导”和“动作”的边界。",
    ],
    validation: {
      manual:
        "让 agent 先列出 skills，再调用 code-review skill，看输出是否遵守审查格式。",
      deterministic: "测试 scan/invoke/remove 的返回值和错误路径。",
      integration:
        "检查 system prompt 只出现 skill 摘要，invoke 后完整内容进入当前 messages。",
      failure: "未调用 skill 时，完整 SKILL.md 已经出现在 system prompt 里。",
    },
    verifyItems: [
      `${inlineCode("src/skills.test.ts")} 覆盖 skill 生命周期。`,
      `${inlineCode("src/system-prompt.test.ts")} 验证稳定索引注入。`,
      "手动修改 skill 文件后，确认当前会话通过 reminder 知道变化，而不是重写稳定前缀。",
    ],
    debug: [
      "先看 skillsDir 是否指向预期目录。",
      "检查 SKILL.md 是否有可解析的名称和描述。",
      "检查 invoke 工具是否按名称读取，而不是按用户输入路径任意读文件。",
      "检查 skill 内容是否过长，需要在后续压缩章节处理。",
    ],
    practice: [
      "写一个 prompt，让 coding agent 新增一个 explain-error Skill：它只是一份 Markdown 指导，不新增任何工具。",
    ],
    summary: [
      "本章让 agent 能按需学习工作方式。接下来问题变成：随着工具结果、Skill 内容和多轮历史越来越多，messages 会变得太长，需要专门的标准化与压缩管道。",
    ],
    next: [
      "下一章进入 Normalize、MessageBlock 和 Compress：我们要保护 tool_call/tool_result 配对，同时让长上下文可控。",
    ],
  },
  {
    id: "06-compress",
    number: "06",
    filename: "06-compress.html",
    eyebrow: "第 06 章 · 管理越来越长的上下文",
    title: "上下文太长怎么办：Normalize / Block / Compress",
    lede: "Agent 一旦会读文件、跑命令、加载 Skill，History 会迅速变长。本章把消息整理和压缩变成一条明确管道，避免简单截断破坏工具协议。",
    known: [
      `你已经见过 user、assistant、tool_call、tool_result、Skill 内容和 TODO reminder。所有这些最终都会影响 messages，而 LLM 的上下文窗口是有限的。`,
      `本章不是教“随便总结一下历史”。它要建立三个概念：normalize 让消息合法，MessageBlock 定义压缩原子，compressor 决定什么时候摘要、什么时候保留原文。`,
    ],
    scene: [
      `用户让 agent 跑测试，bash 输出几千行；随后又让 agent 读取多个文件、调用子智能体、加载 Skill。几轮之后，下一次 LLM 调用超出上下文限制。`,
      `如果你直接删掉前半段 messages，很可能把 assistant tool_call 留下，却删掉对应 tool_result，或者删掉用户最初的约束。正确做法是先把消息整理成块，再按规则压缩。`,
    ],
    naive: [
      `朴素方案是当 messages 太长时，直接保留最后 N 条。很多聊天 demo 都这么做，因为普通对话里最近消息往往更重要。`,
      `Coding agent 不一样。工具调用有协议配对，文件编辑有前因后果，权限拒绝可能影响后续行为。按条数截断会制造出 LLM 协议不合法或事实断裂的上下文。`,
    ],
    naiveCode: `if (messages.length > 40) {
  messages = messages.slice(-40);
}`,
    whyNaiveFails: [
      {
        term: "切断工具配对",
        description:
          "assistant tool_call 和 tool_result 必须成对保留或成对摘要，不能只留下其中一半。",
      },
      {
        term: "丢失长期约束",
        description:
          "用户早期说过“不要改 public API”，简单截断会让后续编辑忘记这个约束。",
      },
      {
        term: "压缩不可解释",
        description:
          "没有 MessageBlock 时，你不知道压缩的是哪一段历史，也无法测试压缩前后语义是否保留。",
      },
    ],
    loop: [
      `压缩管道发生在 “构建 messages 前”。Agent 从 History 取出 entries 后，先 normalize，再 groupToBlocks，再根据 token 预算做衰减压缩、即时压缩或全量压缩，最后 flatten 回 LLM 可接受 messages。`,
      `压缩失败不能让 agent 崩溃。最小策略是降级保留原文或触发 recovery，而不是在用户看不见的地方生成半截上下文。`,
    ],
    figure: {
      alt: "消息标准化和压缩管道",
      accent: "MessageBlock",
      rows: [
        ["History Entries", "→", "normalize", "→", "MessageBlock"],
        ["Token Budget", "→", "compress / decay", "→", "Block Summary"],
        ["flatten", "→", "LLM Messages", "→", "Next Turn"],
      ],
      caption: "图 06-1 · 压缩对象是消息块，不是随意的单条 message。",
    },
    walkthrough: [
      `Agent 准备下一轮 LLM 请求，先从 History 读取原始 entries。`,
      `normalize 清理非法元数据、修复可恢复的 tool result 顺序问题。`,
      `groupToBlocks 把普通对话、工具调用组、系统提醒分成压缩原子。`,
      `compressor 估算 token，发现 bash 输出块过大。`,
      `即时压缩把大输出替换为 preview 或摘要，并保留关键事实。`,
      `衰减压缩把很旧的工具结果替换为更短的历史摘要。`,
      `如果总量仍超预算，全量压缩生成会话摘要，再继续当前 loop。`,
    ],
    interfacesIntro: [
      `MessageBlock 是本章核心。它让压缩器知道哪些消息必须一起处理，避免把协议相关消息拆散。`,
    ],
    interfaceCode: `type MessageBlock =
  | { kind: "conversation"; messages: Message[]; round: number }
  | { kind: "tool_use"; call: Message; results: Message[]; round: number }
  | { kind: "reminder"; messages: Message[]; round: number };

function prepareMessages(history: HistoryEntry[]) {
  const normalized = normalizeMessages(history);
  const blocks = groupToBlocks(normalized);
  const compacted = compressor.compact(blocks);
  return flattenToMessages(compacted);
}`,
    sourceIntro: [
      `这一章读源码时按管道顺序看：normalize 负责合法性，message-block 负责分组，compressor 负责策略，agent 负责调用这条管道。`,
    ],
    sources: [
      { path: "src/normalize.ts", note: "消息合法化和工具结果整理" },
      { path: "src/message-block.ts", note: "压缩原子和 flatten 逻辑" },
      { path: "src/compressor.ts", note: "衰减、即时、全量压缩策略" },
      { path: "src/output-store.ts", note: "大输出 handle 化" },
      { path: "src/agent.ts", note: "prepareMessages 管道入口" },
      { path: "src/message-block.test.ts", note: "工具块分组测试" },
    ],
    design: [
      `压缩不是“省 token 的小优化”，而是 agent 能持续工作的基础设施。它必须懂协议边界、状态年龄和工具输出价值。`,
      `Normalize 和 Compress 分开，是为了让合法性和摘要策略各自可测试。先保证 messages 合法，再考虑怎么变短。`,
    ],
    split: [
      {
        term: "normalize",
        description: "把历史条目整理成 LLM 协议可接受的消息序列。",
      },
      {
        term: "message-block",
        description: "把消息组织成不能随意拆开的压缩原子。",
      },
      {
        term: "compressor",
        description: "根据预算、年龄和工具类型决定保留、摘要或 handle 化。",
      },
    ],
    stateBoundary: [
      {
        term: "History",
        description: "保存原始对话事实，不因为压缩而丢失本地记录。",
      },
      {
        term: "LLM messages",
        description: "使用压缩后的上下文，服务当前请求。",
      },
      {
        term: "OutputStore",
        description: "保存大输出原文，LLM 只看到 output_id 和 preview。",
      },
    ],
    prompt: {
      goal: "实现消息标准化、MessageBlock 分组和上下文压缩管道。",
      scene:
        "工具输出和多轮历史过长时，agent 能缩短 LLM messages，同时保留工具协议和关键事实。",
      modules:
        "实现 normalize.ts、message-block.ts、compressor.ts，并接入 agent.prepareMessages。",
      wiring:
        "Agent 每次调用 LLM 前走 normalize→groupToBlocks→compress→flatten 管道。",
      boundary:
        "不要按 message 数量简单截断；不要把 tool_call 和 tool_result 拆散。",
      cases:
        "大工具输出、旧工具结果、压缩失败、空内容、非法 tool_result 顺序。",
      validation: "测试工具块配对、token 预算裁剪、全量压缩后仍能继续对话。",
      sources:
        "src/normalize.ts、src/message-block.ts、src/compressor.ts、src/agent.ts。",
      docs: "说明压缩是上下文治理，不是普通摘要功能。",
    },
    trap: {
      mistake: "只保留最后 N 条 messages。",
      why: "这会破坏工具协议、丢失约束，也无法解释压缩行为。",
      fix: "先分块，再按块压缩或保留，工具调用组必须整体处理。",
      verify: "构造 tool_call 在边界处的历史，压缩后仍应有合法配对或合法摘要。",
    },
    traps: [
      "把压缩摘要写回原始 History，会丢失审计事实。",
      "压缩器吞掉错误，会让上下文悄悄变坏。",
      "把所有工具输出都完整保留，迟早触发 context length error。",
    ],
    validation: {
      manual:
        "让 agent 运行一个大输出命令，再继续提问，看它是否能引用摘要或 output_id。",
      deterministic:
        "测试 groupToBlocks 不拆工具调用组，compressor 在预算内输出。",
      integration: "模拟 context length error 后触发 compact/recovery。",
      failure: "压缩后 LLM API 报 tool_result 没有对应 tool_call。",
    },
    verifyItems: [
      `${inlineCode("src/normalize.test.ts")} 覆盖消息合法化。`,
      `${inlineCode("src/message-block.test.ts")} 覆盖分块和 flatten。`,
      `${inlineCode("src/compressor.test.ts")} 覆盖压缩策略和失败降级。`,
    ],
    debug: [
      "先打印压缩前后的 block 列表，而不是只看最终 messages。",
      "检查每个 tool_result 是否还能找到 call id。",
      "检查 output_id 是否能通过 OutputStore 读回原文。",
      "检查压缩摘要是否错误覆盖了用户硬约束。",
    ],
    practice: [
      "写一个 prompt，让 coding agent 实现一个只处理大 bash 输出的即时压缩器，要求保留前后 preview 和 output_id。",
    ],
    summary: [
      "本章让上下文变得可治理。下一章要处理另一个基础问题：工具能力越强，越需要明确的权限边界。",
    ],
    next: [
      "下一章进入 Permission：在工具执行前决定哪些动作自动允许、哪些需要确认、哪些必须拒绝。",
    ],
  },
];

chapters.push(
  {
    id: "07-permission",
    number: "07",
    filename: "07-permission.html",
    eyebrow: "第 07 章 · 执行动作前的安全闸门",
    title: "给工具画边界：Permission",
    lede: "工具让 agent 真正能改变世界，Permission 则决定它什么时候可以动手。本章把权限检查放在工具执行前，让 plan/default/auto 三种模式有清楚边界。",
    known: [
      `你已经知道工具调用如何进入 loop。现在要补上执行前的安全闸门：并不是模型提出 ${inlineCode("run_write")}，harness 就应该立刻写文件。`,
      `PermissionManager 不是简单的 yes/no。它要结合模式、工具名、命令安全、路径边界、用户确认和子智能体继承策略。`,
    ],
    scene: [
      `用户让 agent “清理项目里的临时文件”。模型可能提出 ${inlineCode("rm -rf")}，也可能写出项目外路径。如果 harness 不检查，教学项目也可能把真实工作区搞坏。`,
      `正确流程是：工具调用进入执行层前，PermissionManager 先判断 allow / ask / deny。只有 allow 才执行；ask 需要用户确认；deny 会作为可恢复错误写回 LLM。`,
    ],
    naive: [
      `朴素方案是相信模型：“既然用户让 agent 工作，模型应该知道不要做危险事。”或者提供一个 auto 模式直接允许所有工具。`,
      `这不是 agent harness，而是裸奔的脚本执行器。模型会误解、幻觉、复制用户危险命令，也可能被不可信文件内容诱导。`,
    ],
    naiveCode: `if (toolCall.name.startsWith("run_")) {
  return registry.execute(toolCall.name, toolCall.arguments);
}`,
    whyNaiveFails: [
      {
        term: "模式语义消失",
        description:
          "plan 模式应该只计划不写入，default 模式应该敏感操作询问，auto 也不应绕过硬性安全黑名单。",
      },
      {
        term: "路径逃逸",
        description:
          "只看工具名不看参数，会允许 write ../outside.txt 这类越界写入。",
      },
      {
        term: "子智能体权限扩大",
        description: "child agent 做只读分析时，不应该继承父 agent 的写权限。",
      },
    ],
    loop: [
      `Permission 插在 “工具执行前”。Agent 已经收到 tool call，但还没调用 handler。权限层根据工具、参数、当前模式和路径策略返回 allow / ask / deny。`,
      `deny 不是进程异常，而是 tool_result 错误，让模型知道这个动作不能做，并尝试更安全的方案。`,
    ],
    figure: {
      alt: "权限检查位于工具执行前",
      accent: "Permission",
      rows: [
        ["assistant tool_call", "→", "Permission", "→", "allow / ask / deny"],
        ["allow", "→", "Tool Handler", "→", "tool_result"],
        ["deny", "→", "ToolResult error", "→", "LLM"],
      ],
      caption:
        "图 07-1 · 权限层不替代工具参数校验，它是在执行前再加一道用户和项目边界。",
    },
    walkthrough: [
      `LLM 返回一个写文件 tool call。`,
      `Agent 根据工具名和参数构造 permission request。`,
      `PermissionManager 检查当前模式：plan/default/auto。`,
      `路径类工具先解析到绝对路径，再确认是否仍在 projectRoot 内。`,
      `危险命令命中硬黑名单时直接 deny。`,
      `default 模式下敏感写操作返回 ask，Terminal 向用户确认。`,
      `用户拒绝时，Agent 写入错误 tool_result；用户允许时才执行工具。`,
    ],
    interfacesIntro: [
      `权限结果最好显式建模，而不是用 throw 表示所有情况。ask/deny/allow 是业务决策，真正的系统异常才应该抛出。`,
    ],
    interfaceCode: `type PermissionDecision =
  | { action: "allow" }
  | { action: "ask"; reason: string }
  | { action: "deny"; reason: string };

interface PermissionManager {
  checkToolUse(request: {
    toolName: string;
    args: unknown;
    projectRoot: string;
    mode: "plan" | "default" | "auto";
  }): Promise<PermissionDecision>;
}`,
    sourceIntro: [
      `先读 PermissionManager，再读文件工具和 bash 工具如何各自做内部校验。权限层和工具层要互相补位，不能只靠其中一个。`,
    ],
    sources: [
      { path: "src/permission.ts", note: "权限模式和决策" },
      { path: "src/permission.test.ts", note: "plan/default/auto 与路径测试" },
      { path: "src/command-safety.ts", note: "shell 硬性黑名单" },
      { path: "src/tools/files.ts", note: "文件工具的路径边界" },
      { path: "src/agent.ts", note: "工具执行前的权限拦截" },
    ],
    design: [
      `Permission 的价值是把用户意图、模式选择和工具风险放在 harness 层判断，而不是期待模型自觉。`,
      `即使 auto 模式也不意味着无限制执行。安全黑名单、路径边界和资源限制属于硬边界，不应该被模式轻易绕过。`,
    ],
    split: [
      {
        term: "PermissionManager",
        description: "根据工具请求做 allow/ask/deny 决策。",
      },
      { term: "Terminal", description: "承载 default 模式下的用户确认交互。" },
      {
        term: "Tool Handler",
        description: "仍要做参数和路径校验，不能假设权限层已经覆盖全部风险。",
      },
    ],
    stateBoundary: [
      {
        term: "进入 LLM",
        description:
          "deny/ask 被拒绝后的原因可以作为 tool_result 错误进入 messages。",
      },
      {
        term: "不进入 LLM",
        description: "用户确认的内部 UI 状态、绝对路径细节和安全策略实现。",
      },
      {
        term: "子智能体",
        description: "权限应显式继承或收窄，不应隐式复制父状态。",
      },
    ],
    prompt: {
      goal: "实现 PermissionManager，在工具执行前根据模式、路径和命令风险做 allow/ask/deny。",
      scene:
        "agent 要写文件或运行命令时，harness 必须先判断是否允许、询问或拒绝。",
      modules:
        "实现 permission.ts、command-safety.ts 接入、agent 工具执行拦截和测试。",
      wiring:
        "composition root 创建 PermissionManager，Agent 执行每个 tool call 前调用它。",
      boundary: "不要用 auto 绕过硬性安全；不要只检查工具名而忽略参数路径。",
      cases:
        "plan 模式写入、路径越界、危险命令、用户拒绝确认、child 权限收窄。",
      validation:
        "测试 plan/default/auto、路径逃逸、ask 确认和 deny tool_result。",
      sources:
        "src/permission.ts、src/agent.ts、src/tools/files.ts、src/command-safety.ts。",
      docs: "说明权限是工具执行前的 harness 决策，不是模型自我约束。",
    },
    trap: {
      mistake: "默认允许所有 run_* 工具。",
      why: "工具名只说明动作类别，不说明参数是否安全。",
      fix: "权限层检查工具名、参数、模式和项目边界，工具层再做业务校验。",
      verify: "尝试写 projectRoot 外路径时，无论模式如何都不应成功。",
    },
    traps: [
      "把 ask 写成 LLM 自问自答，而不是询问真实用户。",
      "只用字符串 startsWith 检查路径，符号链接和 .. 可能绕过。",
      "Hook 放在权限前后不清晰，导致观察到的事件语义混乱。",
    ],
    validation: {
      manual: "切换 plan/default/auto 模式，分别尝试写文件和危险命令。",
      deterministic: "测试 PermissionManager 的 allow/ask/deny 返回。",
      integration: "Agent 收到 deny 后应继续 loop，而不是进程崩溃。",
      failure: "用户拒绝后工具仍执行，或 deny 没有写回 LLM 可见结果。",
    },
    verifyItems: [
      `${inlineCode("src/permission.test.ts")} 覆盖权限模式。`,
      `${inlineCode("src/tools/files.test.ts")} 覆盖路径边界。`,
      `${inlineCode("src/agent.test.ts")} 覆盖权限拒绝如何进入 tool_result。`,
    ],
    debug: [
      "检查 tool call 是否在执行 handler 前经过 PermissionManager。",
      "检查模式来源是否和 CLI / runtime 状态一致。",
      "检查路径 normalize 后是否仍在 projectRoot。",
      "检查 deny reason 是否足够清楚，模型能据此换方案。",
    ],
    practice: [
      "写一个 prompt，只实现 plan 模式：所有写工具拒绝，读工具允许，并用测试证明。",
    ],
    summary: [
      "本章给工具加上边界。下一章我们会在 loop 周围开放扩展点，让外部逻辑观察 session 和工具使用，但不破坏核心协议。",
    ],
    next: [
      "下一章进入 Hook：它让我们在 SessionStart、PreToolUse、PostToolUse 插入扩展逻辑。",
    ],
  },
  {
    id: "08-hook",
    number: "08",
    filename: "08-hook.html",
    eyebrow: "第 08 章 · 在主循环旁边扩展",
    title: "在 Loop 周围挂钩子：Hook",
    lede: "Hook 是 agent loop 的观察和扩展点。它允许我们在 session start、tool use 前后插入逻辑，但必须避免破坏 tool_call/tool_result 的消息配对。",
    known: [
      `你已经有权限层。现在想在工具调用前后做一些额外事情：记录日志、注入提醒、阻止某类行为、触发统计。直接改 ${inlineCode("agent.ts")} 会让主 loop 越来越臃肿。`,
      `Hook 的目标是“可扩展但不失控”。它应该观察事件、返回轻量消息或决策，不应该变成第二套 agent loop。`,
    ],
    scene: [
      `用户运行测试失败后，你想通过 PostToolUse hook 注入一句提醒：“测试失败时请先读失败日志，不要盲改。”这对模型有帮助，但如果插入位置不对，会破坏工具消息顺序。`,
      `Hook 系统要提供明确事件：SessionStart、PreToolUse、PostToolUse，并让 hook 输出延迟到安全位置注入。`,
    ],
    naive: [
      `朴素方案是在每个工具 handler 里手写 before/after 逻辑，或者让 hook 直接往 History 任意位置插消息。`,
      `这会让工具实现和扩展逻辑耦合，也可能把系统提醒插到 assistant tool_call 和 tool_result 中间，导致 LLM 协议非法。`,
    ],
    naiveCode: `history.add(assistantToolCall);
history.add({ role: "system", content: "hook reminder" });
history.add(toolResult); // 这里已经破坏了 tool_call/tool_result 邻近关系`,
    whyNaiveFails: [
      {
        term: "消息配对被破坏",
        description: "PostToolUse 的提醒不能插在工具调用组内部。",
      },
      {
        term: "扩展点污染业务",
        description: "每个工具都手写 hook 调用，会让工具模块变得不纯。",
      },
      {
        term: "失败传播不清",
        description:
          "hook 失败不应该默认让工具执行失败，除非设计明确允许阻断。",
      },
    ],
    loop: [
      `Hook 分布在 loop 的边缘：SessionStart 在会话启动后；PreToolUse 在权限允许后、工具执行前；PostToolUse 在工具执行后、结果写回安全位置时。`,
      `关键原则是：Hook 可以产生 reminder，但 reminder 要进入 session event buffer 或安全注入点，而不是插入工具消息组中间。`,
    ],
    figure: {
      alt: "Hook 在工具执行周围的位置",
      accent: "HookRunner",
      rows: [
        ["SessionStart", "→", "HookRunner", "→", "Session Event"],
        ["Permission allow", "→", "PreToolUse", "→", "Tool Handler"],
        ["tool_result", "→", "PostToolUse", "→", "Deferred Reminder"],
      ],
      caption: "图 08-1 · Hook 是旁路扩展，不应该破坏主消息协议。",
    },
    walkthrough: [
      `启动 REPL 时触发 SessionStart hook，记录会话信息。`,
      `LLM 返回 tool call，权限层先做 allow/ask/deny。`,
      `允许执行后，HookRunner 触发 PreToolUse，观察工具名和参数。`,
      `工具执行并返回 ToolResult。`,
      `Agent 写回 tool_result，保持工具配对完整。`,
      `HookRunner 触发 PostToolUse，产生的提醒进入 session event buffer。`,
      `下一轮构建 messages 时，reminder 在安全位置注入给 LLM。`,
    ],
    interfacesIntro: [
      `Hook 输入是事件上下文，输出是轻量结果。不要让 hook 直接持有 History 可变引用。`,
    ],
    interfaceCode: `type HookEvent =
  | { kind: "SessionStart"; sessionId: string }
  | { kind: "PreToolUse"; toolName: string; args: unknown }
  | { kind: "PostToolUse"; toolName: string; result: ToolResult };

interface HookRunner {
  run(event: HookEvent): Promise<HookResult[]>;
}`,
    sourceIntro: [
      `先看 HookRunner，再看 session-events 如何延迟注入提醒。Hook 和权限的相对顺序也值得仔细读。`,
    ],
    sources: [
      { path: "src/hooks.ts", note: "Hook 事件与运行器" },
      { path: "src/hooks.test.ts", note: "Hook 顺序和错误测试" },
      { path: "src/session-events.ts", note: "延迟注入的事件缓冲区" },
      { path: "src/agent.ts", note: "Pre/PostToolUse 接入点" },
      { path: "src/system-prompt.ts", note: "reminder 与稳定 prompt 的边界" },
    ],
    design: [
      `Hook 的设计重点是“不侵入”。主 loop 保持清楚，扩展逻辑通过事件观察。`,
      `把 hook 输出延迟成 reminder，是为了同时满足两件事：模型能知道外部提醒，工具消息协议不被破坏。`,
    ],
    split: [
      {
        term: "HookRunner",
        description: "按稳定顺序执行 hook，收集结果和错误。",
      },
      {
        term: "SessionEventBuffer",
        description: "缓存 out-of-band 事件，下一轮安全注入。",
      },
      {
        term: "Agent",
        description: "只在固定点触发 hook，不把扩展逻辑写进主流程。",
      },
    ],
    stateBoundary: [
      {
        term: "hook context",
        description: "可观察工具名、参数、结果摘要，但不应暴露敏感内部状态。",
      },
      {
        term: "reminder",
        description: "hook 输出可以作为动态消息进入下一轮 LLM。",
      },
      { term: "History", description: "不允许 hook 任意插入工具调用组中间。" },
    ],
    prompt: {
      goal: "实现 HookRunner 和 SessionEventBuffer，让 agent 支持 SessionStart/PreToolUse/PostToolUse 扩展点。",
      scene: "工具执行前后需要观察和提醒，但不能把扩展逻辑写死在每个工具里。",
      modules: "实现 hooks.ts、session-events.ts，并在 agent.ts 的固定点触发。",
      wiring:
        "composition root 创建 HookRunner，Agent 注入后触发事件，hook 输出进入 reminder buffer。",
      boundary:
        "hook 不得直接破坏 tool_call/tool_result 配对；hook 失败默认不让主 loop 崩溃。",
      cases:
        "多个 hook 顺序、hook 抛错、PostToolUse 产生提醒、权限拒绝时是否触发 PreToolUse。",
      validation: "测试事件顺序、延迟注入、hook 错误隔离和 agent 集成路径。",
      sources: "src/hooks.ts、src/session-events.ts、src/agent.ts。",
      docs: "说明 Hook 是扩展点，不是第二套业务流程。",
    },
    trap: {
      mistake: "PostToolUse 直接往 History 当前工具组中插入 system message。",
      why: "这会让 LLM 协议认为 tool_result 顺序非法。",
      fix: "PostToolUse 输出进入 session event buffer，下一轮在安全位置注入。",
      verify:
        "构造工具调用后 hook reminder，检查 messages 中 tool_call/tool_result 仍相邻或合法配对。",
    },
    traps: [
      "Hook 顺序不稳定会导致调试困难。",
      "Hook 吞掉工具错误会掩盖真实失败。",
      "PreToolUse 放在权限前会让 hook 观察到本不该执行的敏感参数。",
    ],
    validation: {
      manual:
        "启用一个 PostToolUse hook，让它在工具执行后提醒模型如何处理失败输出。",
      deterministic: "测试 HookRunner 对多个 hook 的顺序和错误隔离。",
      integration: "Agent 执行工具后，下一轮 messages 包含 hook reminder。",
      failure: "hook reminder 出现在 tool_call 和 tool_result 之间。",
    },
    verifyItems: [
      `${inlineCode("src/hooks.test.ts")} 验证 hook 生命周期。`,
      `${inlineCode("src/session-events.test.ts")} 验证提醒缓冲。`,
      `${inlineCode("src/agent.test.ts")} 验证 hook 与工具执行集成。`,
    ],
    debug: [
      "检查 hook 触发点在权限之后还是之前。",
      "检查 session event buffer 是否被 drain。",
      "检查 hook 错误是否被记录但不吞掉工具结果。",
      "检查当前 messages 是否仍符合 LLM 工具协议。",
    ],
    practice: [
      "写一个 prompt，实现一个只记录 PostToolUse 事件的 hook，不改变工具结果。",
    ],
    summary: [
      "本章给 loop 增加了旁路扩展。下一章会把“跨会话长期事实”从 History 和 TODO 中拆出来，形成 Memory。",
    ],
    next: ["下一章进入 Memory：哪些东西值得长期记住，哪些只应该留在当前会话。"],
  },
);

function makeChapter(config) {
  return {
    id: config.id,
    number: config.number,
    filename: config.filename,
    eyebrow: config.eyebrow,
    title: config.title,
    lede: config.lede,
    known: [
      config.known,
      `读这一章时请把注意力放在 agent loop 的接入点：${config.loopFocus}。代码片段只服务于理解架构边界，不要求你逐行背实现。`,
    ],
    studyPath: config.studyPath ?? [
      `先把自己放进一个真实 query：没有 ${config.coreConcept} 时，当前 agent 会在哪里卡住。`,
      `再故意设计一个朴素方案，观察它如何破坏 loop、状态或安全边界。这个失败比“正确答案”更重要，因为它能帮你写出更好的重建 prompt。`,
      `最后才看实现：先看图和数据流，再看少量接口、源码入口和验证方法。读完后，你应该能用自己的话描述 ${config.coreConcept} 的职责，而不是只记住文件名。`,
    ],
    scene: config.scene,
    naive: [
      config.naive,
      `这个朴素方案的问题在于：它把 ${config.coreConcept} 当成普通实现细节，而不是 agent harness 的一条稳定边界。`,
    ],
    naiveCode: config.naiveCode,
    whyNaiveFails: config.failures,
    loop: [
      `${config.coreConcept} 接入 loop 的位置是：${config.loopFocus}。理解这个位置，比记住具体函数名更重要。`,
      config.loopDetail,
    ],
    figure: config.figure,
    implementationBridge: config.implementationBridge ?? [
      `到这里我们已经知道 ${config.coreConcept} 为什么存在、插在 loop 的哪里，以及朴素方案会怎样失败。下面才进入实现层：只抓住能固定架构的接口、状态边界和接线路径。`,
      `读源码时不要从文件顶部一路啃到底。更有效的顺序是：先找入口函数，再找它读写的状态，最后看测试如何证明这些状态变化是真的发生了。`,
    ],
    walkthrough: config.walkthrough,
    interfacesIntro: [
      `下面的接口和伪码只保留本章最关键的形状。真正写代码时，可以让 coding agent 参考源码地图中的文件补齐细节。`,
    ],
    interfaceCode: config.interfaceCode,
    sourceIntro: [
      `源码阅读建议从第一个文件开始，按数据流往后看。当前项目源码已经包含后续章节能力，所以读本章时只聚焦这里列出的入口。`,
    ],
    sources: config.sources,
    extraSections: config.extraSections ?? [],
    sourceNote: config.sourceNote ?? {
      title: "读源码时的提醒",
      paragraphs: [
        `GitHub 链接指向当前主干实现，可能已经包含后续章节能力。学习本章时，请只沿着 ${config.coreConcept} 相关的数据流阅读，暂时忽略旁边更复杂的分支。`,
      ],
    },
    design: config.design,
    split: config.split,
    stateBoundary: config.stateBoundary,
    prompt: config.prompt,
    trap: config.trap,
    traps: config.traps,
    validation: config.validation,
    verifyItems: config.verifyItems,
    debug: config.debug,
    practice: [
      `练习：不看 Prompt Card，自己写一段 prompt，让另一个 coding agent 实现本章的 ${config.coreConcept}。写完后对照卡片，看是否遗漏了状态边界、失败模式和测试。`,
    ],
    summary: config.summary,
    next: config.next,
  };
}

chapters.push(
  makeChapter({
    id: "09-memory",
    number: "09",
    filename: "09-memory.html",
    eyebrow: "第 09 章 · 跨会话长期事实",
    title: "跨会话记忆：Memory",
    lede: "History 记住当前对话，TODO 记住当前执行节奏，Memory 记住跨会话仍然有价值的用户偏好和项目事实。",
    coreConcept: "Memory",
    loopFocus:
      "构建稳定上下文和动态提醒之前，决定哪些长期事实可以进入当前 LLM 请求",
    known: `你已经知道 History 和 TODO 都是当前会话里的状态。Memory 解决的是另一个问题：用户说“以后默认用中文解释代码”或“这个项目不要自动推送 GitHub”时，agent 下次启动仍应知道。`,
    scene: [
      `用户反复告诉 agent：“这个项目的提交信息用中文，除非我特别要求英文。”如果每次都靠 History，重启后就丢了；如果自动保存所有聊天，又会制造隐私和噪音。`,
      `Memory 要求 agent 只保存值得长期记住、用户明确允许或主动创建的事实，并通过工具提供 create/list/read/delete 能力。`,
    ],
    naive: `朴素方案是把所有对话日志永久保存，然后每次启动都塞回 prompt。这样看似什么都不会忘，但实际上会保存大量临时、隐私和过期信息。`,
    naiveCode: `const memory = await readAllChatLogs();
systemPrompt += "\\nPast conversations:\\n" + memory;`,
    failures: [
      {
        term: "隐私和噪音",
        description:
          "不是所有聊天都值得长期保存，自动保存会把临时信息、敏感内容和错误事实混在一起。",
      },
      {
        term: "上下文污染",
        description: "把所有历史塞回 prompt，会让当前任务被无关旧信息影响。",
      },
      {
        term: "删除语义不清",
        description:
          "用户删除 memory 后，如果稳定 prompt 仍保留旧快照，就会出现看似删除但模型仍知道的错觉。",
      },
    ],
    loopDetail:
      "Memory 的轻量索引可以参与稳定 prompt，具体内容则通过工具按需读取；memory 变化通过 reminder 告知当前会话，避免运行中重写 system prompt。",
    figure: {
      alt: "Memory 与 History 的边界",
      accent: "Memory",
      rows: [
        ["User Preference", "→", "Memory Tool", "→", "agentHome/memory"],
        ["Stable Index", "→", "System Prompt", "→", "LLM"],
        ["invoke/read", "→", "Current Messages", "→", "Task Behavior"],
      ],
      caption: "图 09-1 · Memory 是跨会话知识，不是完整聊天日志。",
    },
    walkthrough: [
      `用户要求记录一条长期偏好。`,
      `LLM 调用 memory create 工具，传入简短、可解释的事实。`,
      `MemoryManager 把记录写入 agentHome 下的 memory 目录。`,
      `后续会话启动时，system prompt 只看到 memory 索引或摘要。`,
      `当任务需要细节时，模型通过 memory read 获取完整内容。`,
      `用户删除 memory 后，当前会话通过 reminder 得知删除事实。`,
    ],
    interfaceCode: `interface MemoryEntry {
  id: string;
  title: string;
  content: string;
  createdAt: string;
}

interface MemoryManager {
  create(input: { title: string; content: string }): Promise<MemoryEntry>;
  list(): Promise<Array<Pick<MemoryEntry, "id" | "title">>>;
  read(id: string): Promise<MemoryEntry>;
  delete(id: string): Promise<boolean>;
  buildPromptSection(): Promise<string>;
}`,
    sources: [
      { path: "src/memory.ts", note: "Memory 管理器" },
      { path: "src/tools/memory.ts", note: "Memory 工具 provider" },
      { path: "src/memory.test.ts", note: "Memory 生命周期测试" },
      { path: "src/system-prompt.ts", note: "Memory 索引进入 prompt 的边界" },
      { path: "src/project-context.ts", note: "agentHome 路径归属" },
    ],
    design: [
      `Memory 的设计要保守：宁可少记，也不要自动记一切。长期事实一旦进入未来上下文，会持续影响 agent 行为。`,
      `把 Memory 放在 agentHome，而不是项目源码里，可以避免 agent 个人偏好污染仓库。`,
    ],
    split: [
      {
        term: "MemoryManager",
        description: "负责跨会话存储、读取、删除和 prompt section 构建。",
      },
      {
        term: "Memory tools",
        description: "让模型显式创建、列出、读取和删除长期记忆。",
      },
      {
        term: "System prompt",
        description: "只注入轻量索引，具体内容按需读取。",
      },
    ],
    stateBoundary: [
      {
        term: "持久化",
        description: "经过确认的偏好、项目约定、长期工作方式。",
      },
      {
        term: "不持久化",
        description: "临时任务进度、一次性错误输出、未经确认的私人信息。",
      },
      {
        term: "当前会话",
        description: "memory 创建或删除后的 reminder，帮助模型处理快照边界。",
      },
    ],
    prompt: {
      goal: "实现跨会话 Memory 管理器和工具，让 agent 能保存、读取、删除长期偏好。",
      scene:
        "用户明确要求记住长期事实时，agent 调用 Memory 工具落盘；后续会话可读取。",
      modules:
        "src/memory.ts、src/tools/memory.ts、system-prompt.ts、project-context.ts。",
      wiring:
        "composition root 创建 MemoryManager，注册 memory tools，system prompt 注入轻量索引。",
      boundary:
        "不要自动保存所有对话；不要把 Memory 写进项目源码；删除后用 reminder 说明当前快照边界。",
      cases: "重复标题、读取不存在 id、删除后再读、敏感信息拒绝保存。",
      validation:
        "测试 create/list/read/delete、重启后仍存在、删除后当前会话提醒。",
      sources: "src/memory.ts、src/tools/memory.ts、src/system-prompt.ts。",
      docs: "说明 Memory 不是 History，也不是 Task。",
    },
    trap: {
      mistake: "未经确认自动保存用户聊天内容。",
      why: "长期记忆会影响未来行为，自动保存会带来隐私和错误事实风险。",
      fix: "让 Memory 创建成为显式工具动作，并尽量保存短小、可解释的事实。",
      verify: "普通聊天不应产生 memory 文件，只有 memory create 才落盘。",
    },
    traps: [
      "把项目临时事实写成长期偏好。",
      "Memory 删除后不提醒当前会话存在旧快照边界。",
      "把 Memory 全文全部塞进 system prompt。",
    ],
    validation: {
      manual: "创建一条偏好，重启后让 agent list/read，再删除并确认不可读。",
      deterministic: "测试 MemoryManager 的文件读写和错误路径。",
      integration: "检查 system prompt 只包含索引，read 工具才返回正文。",
      failure: "未调用 create 时出现新的 memory 文件。",
    },
    verifyItems: [
      `${inlineCode("src/memory.test.ts")} 覆盖持久化生命周期。`,
      `${inlineCode("src/tools/memory.test.ts")} 覆盖工具 provider。`,
      `${inlineCode("src/system-prompt.test.ts")} 覆盖索引注入。`,
    ],
    debug: [
      "检查 agentHome 是否正确。",
      "检查 memory id 和文件名是否一致。",
      "检查删除后索引是否刷新。",
      "检查当前会话是否需要 reminder 说明变化。",
    ],
    summary: [
      "本章让 agent 拥有长期偏好。下一章要处理成本和性能：稳定 prompt、tools、memory index 都不能每轮乱变。",
    ],
    next: ["下一章进入 Prompt Cache 友好的请求布局。"],
  }),
  makeChapter({
    id: "10-cache",
    number: "10",
    filename: "10-cache.html",
    eyebrow: "第 10 章 · 稳定前缀与动态提醒",
    title: "Prompt Cache 友好的请求布局",
    lede: "Agent 越复杂，system prompt、tools、skills、memory 和项目上下文越容易每轮变化。本章先讲清 LLM prompt cache 的命中直觉，再把请求拆成稳定前缀和动态尾部，最后落到本项目的实现。",
    coreConcept: "Prompt Cache 友好布局",
    loopFocus:
      "每次调用 LLM 前构建请求时，决定哪些内容放进可复用的稳定 prefix，哪些内容留在动态 messages 尾部",
    known: `你已经有 Skill、Memory、Tool Registry、Hook reminder 和 History。它们都想影响模型，但它们变化频率完全不同：工具定义通常几乎不变，History 每轮都会增长，Hook reminder 可能只在一次 turn 有效。`,
    studyPath: [
      "先把 prompt cache 当成“服务器复用相同前缀的计算结果”来理解：它不是语义缓存，不会因为两段 prompt 意思差不多就命中。",
      "再看随手改 prompt 结构会怎样影响成本和延迟：稳定内容放错位置，可能让每一轮都重新处理几万 token。",
      "最后才看实现：本项目不直接控制 provider 的真实 cache，但用稳定 system/tools snapshot、动态 reminder 和 cache-debug hash，让请求布局尽量对 cache 友好。",
    ],
    scene: [
      `用户让 agent 重构一个中型项目。每轮请求都会带上很长的系统规则、工具 schema、项目说明、memory 索引、历史消息和最新工具结果。假设稳定前缀有 20k token，一轮任务跑 30 次 LLM 调用，是否命中 cache 会直接影响等待时间和费用。`,
      `接着用户在会话中创建了一条 Memory，或者 Hook 产生了一条临时提醒。如果我们立刻重建 system prompt，下一轮请求的前缀就变了；如果我们把提醒放在动态 messages 尾部，稳定前缀就还能复用。`,
      `所以本章讲的不是一个小优化，而是一条架构边界：长期稳定规则放前面，短期运行状态放后面。`,
    ],
    naive: `朴素方案是每轮都重新扫描 skills、memory、tools、TODO、权限状态和项目上下文，然后生成一个“最新最完整”的 system prompt。这样看起来模型知道了一切，但它把稳定规则和临时状态揉成了一个每轮都会变的大字符串。`,
    naiveCode: `function buildRequest() {
  return {
    system: [
      readAgentRules(),
      scanSkills(),
      scanMemory(),
      currentTodos(),
      hookReminders(),
      new Date().toISOString(),
    ].join("\\n\\n"),
    tools: buildToolsFromCurrentMode(),
    messages: history.getMessages(),
  };
}`,
    failures: [
      {
        term: "exact prefix 被破坏",
        description:
          "很多 provider 的 cache 命中依赖完全相同的前缀。你在 system prompt 前半段插入时间戳、TODO 或 reminder，就等于把后面所有内容的位置和 hash 都改了。",
      },
      {
        term: "工具 schema 变成动态内容",
        description:
          "工具列表和 schema 如果按权限、状态、排序随机变化，模型每轮看到的动作空间都不同，cache 也更难复用。",
      },
      {
        term: "动态状态污染长期规则",
        description:
          "一次性提醒、TODO 状态、hook 消息不应该永久写进 system prompt；否则子智能体 fork、会话恢复和调试日志都会被临时状态污染。",
      },
      {
        term: "性能损失被误认为模型慢",
        description:
          "同一个 agent 任务有时快、有时慢，可能不是模型推理差异，而是前缀 cache 没命中，导致 provider 重新做 prefill。",
      },
    ],
    loopDetail:
      "请求构建分成稳定层和动态层：稳定层包括 system prompt snapshot、tool definitions、稳定项目上下文；动态层包括 History 增量、session reminders、tool results 和本轮工作集。Agent 每轮调用 LLM 前都要守住这个分层。",
    figure: {
      alt: "Prompt Cache 友好请求分层",
      accent: "Stable Prefix",
      rows: [
        ["Stable Prefix", "→", "system snapshot", "→", "tool schemas"],
        ["Still Stable", "→", "memory index", "→", "repo context pack"],
        ["Dynamic Tail", "→", "history + reminders", "→", "tool results"],
        ["Cache Debug", "→", "local prefix hash", "→", "drift alarm"],
      ],
      caption:
        "图 10-1 · 越靠前越要稳定；越靠后越适合放本轮变化。动态状态不要通过重写 system prompt 表达。",
    },
    extraSections: [
      {
        id: "cache-principle",
        title: "LLM cache hit 大概怎么发生",
        body: `<p>一次 LLM 请求可以粗略分成两段成本：先处理输入 prompt，也就是 prefill；再逐 token 生成输出。Prompt cache 优化的是前半段：如果服务器最近处理过相同的 prompt 前缀，就可以复用那段前缀的中间计算结果，而不是每轮重新把 system prompt、工具 schema 和长上下文全部跑一遍。</p>
<p>关键是“相同前缀”。OpenAI 官方文档明确说 cache hit 只可能发生在 prompt 的 exact prefix match 上，并建议把静态内容放在开头、把用户特定的可变内容放在结尾；工具和图片等内容也必须在请求之间保持一致。Anthropic 的文档也强调 cache prefix 会按 tools、system、messages 的顺序组成，改变 breakpoint 前的任何 block 都会产生不同 hash。</p>
<div class="note">
  <p class="note__title">不要把它想成语义缓存</p>
  <p>“这两段 prompt 意思差不多”“只是换了一个时间戳”“只是把工具顺序改了”都不等于 cache hit。对 cache 来说，前缀结构和 token 序列才是事实。</p>
</div>
<figure class="figure">
  <div class="flow-map" role="img" aria-label="prompt cache hit 与 miss 对比">
    <div class="flow-row">
      <span class="flow-node flow-node--accent">请求 A 前缀</span>
      <span class="flow-arrow">=</span>
      <span class="flow-node flow-node--accent">请求 B 前缀</span>
      <span class="flow-arrow">→</span>
      <span class="flow-node">可能 cache hit</span>
    </div>
    <div class="flow-row">
      <span class="flow-node">system 中插入时间戳</span>
      <span class="flow-arrow">→</span>
      <span class="flow-node">前缀 token 改变</span>
      <span class="flow-arrow">→</span>
      <span class="flow-node flow-node--accent">cache miss</span>
    </div>
    <div class="flow-row">
      <span class="flow-node">动态 reminder 放尾部</span>
      <span class="flow-arrow">→</span>
      <span class="flow-node">前缀保持稳定</span>
      <span class="flow-arrow">→</span>
      <span class="flow-node">复用机会更高</span>
    </div>
  </div>
  <figcaption>图 10-2 · cache 关心的是前缀是否一致，不关心你觉得两次请求“差不多”。</figcaption>
</figure>`,
      },
      {
        id: "cost-and-latency",
        title: "随意改变 prompt 结构会付出什么代价",
        body: `<p>官方文档给了足够明确的量级：OpenAI 写到 Prompt Caching 可以最高降低约 80% 延迟、最高降低约 90% 输入 token 成本；Anthropic 文档中的显式 cache breakpoint 成本模型里，cache read 约为基础输入 token 价格的 10%，cache write 则高于普通输入 token；Gemini 文档区分了自动 implicit caching 和需要开发者显式创建的 context cache。</p>
${definitionList([
  {
    term: "成本层面",
    description:
      "长 agent prompt 里最贵的往往不是本轮用户一句话，而是每轮重复发送的 system、tools、项目上下文和历史前缀。cache miss 会让这些重复 token 重新按普通输入处理。",
  },
  {
    term: "延迟层面",
    description:
      "prefill 重新处理长前缀会增加首 token 等待时间。coding agent 一次任务可能调用几十轮 LLM，单轮多几秒会迅速累积成明显卡顿。",
  },
  {
    term: "行为层面",
    description:
      "工具定义和系统规则每轮漂移，不只是慢，也会让模型对可用动作空间的理解不稳定。cache-friendly layout 同时也是行为稳定 layout。",
  },
])}
<p>教学项目不需要追求 provider 级 cache 控制，但必须让学生知道：prompt 结构不是随便拼字符串。它是一种运行时协议，决定成本、延迟和模型对环境的稳定理解。</p>`,
      },
      {
        id: "prompt-stack",
        title: "一次 Agent 请求由什么组成",
        body: `<p>现在把一次 agent 请求拆开看。越靠上越应该稳定，越靠下越允许变化。这样讲，学生就能理解为什么 Memory 创建后不应该立刻重写 system prompt，而应该作为本轮 reminder 出现在动态尾部。</p>
<figure class="figure">
  <div class="flow-map" role="img" aria-label="Agent 请求栈">
    <div class="flow-row">
      <span class="flow-node flow-node--accent">1. System Prompt Snapshot</span>
      <span class="flow-node">身份、原则、长期行为规则</span>
    </div>
    <div class="flow-row">
      <span class="flow-node flow-node--accent">2. Tool Definitions</span>
      <span class="flow-node">工具名、schema、描述、稳定顺序</span>
    </div>
    <div class="flow-row">
      <span class="flow-node">3. Stable Context</span>
      <span class="flow-node">AGENTS.md、memory index、repo map、pinned context</span>
    </div>
    <div class="flow-row">
      <span class="flow-node">4. History</span>
      <span class="flow-node">user / assistant / tool messages，随 turn 增长</span>
    </div>
    <div class="flow-row">
      <span class="flow-node">5. Dynamic Reminders</span>
      <span class="flow-node">TODO、hook、memory 变更、schedule 通知</span>
    </div>
    <div class="flow-row">
      <span class="flow-node">6. Working Evidence</span>
      <span class="flow-node">本轮读取的文件片段、工具输出、错误摘要</span>
    </div>
  </div>
  <figcaption>图 10-3 · 推荐请求栈：稳定规则先出现，动态运行现场后出现。</figcaption>
</figure>`,
      },
      {
        id: "provider-differences",
        title: "不同 provider 的 cache 语义并不一样",
        body: `<p>这一章先用通用思想讲“稳定前缀”，但真实 provider 的能力不完全一样。教程不要求学生背参数，而是要知道适配层应该把这些差异收口。</p>
${definitionList([
  {
    term: "OpenAI",
    description:
      "主要是自动 prompt caching：长 prompt 达到门槛后，服务端按前缀 hash 路由和查找缓存；usage 里可观察 cached_tokens。本项目的稳定 prefix 设计天然服务这种模式。",
  },
  {
    term: "Anthropic",
    description:
      "支持显式 cache_control breakpoint，可以更精细地标记哪些 block 可缓存。它的文档特别提醒：把 breakpoint 放在变化 block 上会导致每次都写新 cache 而很少命中。",
  },
  {
    term: "Gemini",
    description:
      "同时有 implicit caching 和 explicit context caching；显式缓存更像先创建一个 cached content，再在后续请求中引用它。模型适配专题会把这种差异放进 profile/policy。",
  },
])}
<p>所以本章实现不要写死某一家 provider 的特殊参数。更稳的做法是先把 agent harness 的请求结构做好，再由后续模型适配层决定是否增加 provider-specific cache 参数。</p>`,
      },
      {
        id: "recommended-layout",
        title: "本项目推荐的请求布局",
        body: `<p>推荐方案可以压缩成一句话：<strong>稳定内容在会话开始形成 snapshot，动态内容在每轮作为 message/reminder 追加。</strong>这不是为了牺牲最新状态，而是为了让最新状态出现在正确的位置。</p>
${definitionList([
  {
    term: "稳定层",
    description:
      "system-prompt.ts 生成会话级 snapshot；tools/registry.ts 输出稳定顺序的工具定义；stable-context.ts 组织相对稳定的 repo map 和 pinned context。",
  },
  {
    term: "动态层",
    description:
      "history.ts 提供多轮 messages；session-events.ts 把 memory、skill、hook、schedule 等运行中变化转成 system-reminder；工具结果作为 tool result 留在消息链中。",
  },
  {
    term: "观察层",
    description:
      "cache-debug.ts 记录本地 system/tools/prefix hash。它不是 provider 的真实账单指标，但能告诉我们自己的前缀有没有意外漂移。",
  },
])}
<pre class="code-block"><code>// 推荐心智模型，不是完整实现：
request = {
  stablePrefix: [
    systemPromptSnapshot,
    stableToolDefinitions,
    stableProjectContext,
  ],
  dynamicTail: [
    ...historyMessages,
    ...sessionEventReminders,
    ...currentToolResults,
  ],
};</code></pre>`,
      },
      {
        id: "official-references",
        title: "官方文档如何支撑这个设计",
        body: `<p>生成教程时可以把这三份官方文档当成背景依据，但正文不要写成 API 参数手册：</p>
<ul>
  <li><a href="https://developers.openai.com/api/docs/guides/prompt-caching" target="_blank" rel="noreferrer">OpenAI Prompt caching</a>：说明 exact prefix match、cached_tokens、延迟和输入 token 成本量级。</li>
  <li><a href="https://platform.claude.com/docs/en/build-with-claude/prompt-caching" target="_blank" rel="noreferrer">Anthropic Prompt caching</a>：说明 tools/system/messages 的 cache prefix 顺序、cache_control breakpoint 和变化 block 的陷阱。</li>
  <li><a href="https://ai.google.dev/gemini-api/docs/caching" target="_blank" rel="noreferrer">Gemini Context caching</a>：说明 implicit caching 与 explicit caching 的区别，以及 TTL/metadata 等运行边界。</li>
</ul>`,
      },
    ],
    implementationBridge: [
      "现在才进入本项目实现。注意我们没有在第 10 章直接调用 provider 的 cache API，因为教学主线要先建立 provider-agnostic 的请求结构。真实 provider 的 cache 参数会在模型适配专题里进一步收口。",
      "实现重点是三件事：会话级 stable snapshot、运行中事件转 reminder、用本地 hash 发现前缀漂移。只要这三件事成立，即使未来换 provider，请求结构也不会推倒重来。",
    ],
    walkthrough: [
      `会话启动时，composition root 创建 Memory、Skill、ToolRegistry 等共享实例。`,
      `system-prompt.ts 读取稳定规则，形成本会话的 system prompt snapshot。`,
      `ToolRegistry 按固定顺序输出工具定义；权限变化不会临时改写工具 schema。`,
      `用户在运行中创建 Memory 或触发 Hook，业务模块不重写 system prompt，而是写入 session event。`,
      `下一轮 Agent 构建请求时，stable prefix 仍然是 system snapshot + tools + 稳定上下文。`,
      `session-events.ts 把动态变化 drain 成 reminder，追加在 messages 尾部。`,
      `cache-debug.ts 计算本地 prefix hash；如果同一会话无结构变化却 hash 变化，说明某处把动态内容塞进了稳定层。`,
    ],
    interfaceCode: `interface StablePromptSnapshot {
  system: string;
  toolsHash: string;
  stableContextHash: string;
  createdAt: string;
}

interface SessionEventBuffer {
  push(event: SessionEvent): void;
  drainAsReminders(): Message[];
}

function buildLLMRequest() {
  return [
    ...stablePrefixSnapshot,
    ...historyMessages,
    ...sessionEventBuffer.drainAsReminders(),
  ];
}`,
    sources: [
      { path: "src/system-prompt.ts", note: "稳定 prompt 与 reminder" },
      { path: "src/cache-debug.ts", note: "本地 prefix hash 调试" },
      { path: "src/session-events.ts", note: "动态事件缓冲" },
      { path: "src/tools/registry.ts", note: "工具定义稳定顺序" },
      { path: "src/stable-context.ts", note: "稳定上下文 pack" },
      { path: "src/agent.ts", note: "请求构建边界" },
    ],
    design: [
      `Cache 友好不是为了“讨好 provider”，而是迫使我们把长期稳定规则和短期运行状态拆清楚。这个拆分会同时改善性能、可调试性和子智能体快照一致性。`,
      `稳定前缀不是永远不变。Skill 文件真的变了、工具 schema 真改了、项目规则更新了，都可以在下个会话或明确 invalidation 后刷新。问题在于不要让每轮临时状态悄悄刷新它。`,
      `本地 hash 只能说明自己的请求前缀是否稳定，不等于真实 provider cache hit，但它足以发现大多数设计漂移。真实命中率要看 provider usage 字段或控制台指标。`,
    ],
    split: [
      {
        term: "Stable layer",
        description:
          "system prompt snapshot、稳定工具定义、相对稳定的项目上下文。它们尽量形成可复用 prefix。",
      },
      {
        term: "Dynamic layer",
        description:
          "History、TODO、hook reminder、memory 变更提醒、tool result。它们表达当前运行现场。",
      },
      {
        term: "Debug layer",
        description:
          "记录 system/tools/prefix hash，用于发现意外变化；真实缓存指标仍以 provider usage 为准。",
      },
    ],
    stateBoundary: [
      {
        term: "会话开始固定",
        description:
          "system prompt snapshot、工具定义顺序、稳定上下文 pack 的基本布局。",
      },
      {
        term: "每轮可变",
        description:
          "messages、reminders、tool results、working set、用户当前 query。",
      },
      {
        term: "不可误解",
        description:
          "cache debug hash 不是 provider 计费命中证明；它只证明本地构造出的前缀有没有漂移。",
      },
    ],
    prompt: {
      goal: "实现 Prompt Cache 友好的 LLM 请求布局：稳定 system/tools/context prefix + 动态 history/reminder/tool-result tail。",
      scene:
        "Agent 运行中 Skill/Memory/Hook/TODO 会变化，但这些变化不应每轮重写 system prompt；它们应通过动态 reminder 告知模型。",
      modules:
        "system-prompt.ts、session-events.ts、cache-debug.ts、stable-context.ts、agent.ts、tools/registry.ts。",
      wiring:
        "会话启动创建 stable snapshot；ToolRegistry 输出稳定顺序；Agent 每轮合并 history 和 drained reminders；cache-debug 记录 prefix hash。",
      boundary:
        "不要根据临时权限或状态动态改变工具定义；不要把 timestamp/TODO/hook reminder 放进稳定 system prompt；不要把本地 hash 当真实 cache hit。",
      cases:
        "memory 创建、skill 删除、子智能体 fork、工具顺序变化、stable context invalidation、provider usage.cached_tokens 观测。",
      validation:
        "多轮 prefix hash 稳定；动态事件进入 messages；子智能体复用 snapshot；真实 provider 可通过 usage.cached_tokens 或控制台观察缓存情况。",
      sources:
        "src/system-prompt.ts、src/cache-debug.ts、src/session-events.ts、src/stable-context.ts、src/agent.ts。",
      docs: "说明 prompt cache 原理、请求分层图、动态 reminder 的 trade-off，以及 cache-debug 的局限。",
    },
    trap: {
      mistake: "为了让模型“知道最新状态”，每轮重新生成完整 system prompt。",
      why: "动态状态会污染稳定前缀，cache 命中机会下降；子智能体和调试日志也会拿到漂移的规则快照。",
      fix: "会话级 stable snapshot + 每轮动态 reminders；真正需要刷新稳定层时显式 invalidation。",
      verify:
        "多轮无结构变化时 prefix hash 应保持不变；memory/hook 变化应出现在 messages 尾部。",
    },
    traps: [
      "根据 permission mode 动态隐藏工具定义。",
      "把 cache debug hash 写成真实计费指标。",
      "memory 更新后忘了通过 reminder 告诉当前会话。",
      "把时间戳、当前轮次、TODO 状态放进 system prompt 开头。",
      "只稳定 system prompt，却让 tool schema 顺序每轮随机变化。",
      "把 provider-specific cache 参数散落在 agent loop，而不是收口到 adapter/policy。",
    ],
    validation: {
      manual:
        "创建 memory 后继续提问，确认模型知道变化；同时观察 cache debug 中 system/tools/prefix hash 不因 reminder 乱变。",
      deterministic:
        "测试 system prompt snapshot、tool definitions 顺序和 stable context hash 在多轮保持稳定。",
      integration:
        "子智能体继承父 stable snapshot；session event 只 drain 一次；tool result 仍保留在动态消息链。",
      failure:
        "没有工具/schema/规则变化时，每轮 prefix hash 都变化；或者 memory 变化后模型不知道最新状态。",
    },
    verifyItems: [
      `${inlineCode("src/cache-debug.test.ts")} 验证 hash。`,
      `${inlineCode("src/system-prompt.test.ts")} 验证 snapshot。`,
      `${inlineCode("src/session-events.test.ts")} 验证动态提醒。`,
    ],
    debug: [
      "比较 system/tools/prefix hash。",
      "检查是否有模块运行中修改工具 schema。",
      "检查 reminder 是否被 drain 一次。",
      "检查 child 是否复用父 snapshot。",
    ],
    summary: [
      "本章让请求布局稳定。下一章处理真实模型调用的另一类问题：限流、网络、上下文超限和格式异常。",
    ],
    next: ["下一章进入 Recovery。"],
  }),
  makeChapter({
    id: "11-recovery",
    number: "11",
    filename: "11-recovery.html",
    eyebrow: "第 11 章 · 出错时继续保持结构",
    title: "LLM 出错时不要崩：Recovery",
    lede: "真实模型调用会失败：限流、网络抖动、上下文超限、格式异常。本章把错误分类和恢复动作纳入 agent loop。",
    coreConcept: "Recovery",
    loopFocus:
      "LLM 调用失败后，根据错误类别选择 backoff、compact、continue 或 fail",
    known: `你已经有压缩器和稳定请求布局。现在要承认一个现实：即使 harness 写得正确，provider 仍然会失败。`,
    scene: [
      `Agent 正在帮用户修测试，突然 LLM API 返回 rate limit。或者 messages 太长，provider 返回 context length error。直接抛异常会让用户丢失当前进度。`,
      `Recovery 层要先分类错误，再选择恢复动作：限流 backoff，超上下文 compact，流式中断可能 continue，不可恢复错误明确失败。`,
    ],
    naive: `朴素方案是 try/catch 后统一 retry 三次。如果三次还失败，就把错误抛给用户。`,
    naiveCode: `for (let i = 0; i < 3; i++) {
  try { return await llm.chat(messages); }
  catch (error) { await sleep(1000); }
}
throw error;`,
    failures: [
      {
        term: "错误类别不同",
        description:
          "rate limit 适合 backoff，context length 需要 compact，参数错误 retry 没意义。",
      },
      {
        term: "预算会泄漏",
        description: "retry 状态如果跨 turn 复用，会让下一次用户请求莫名失败。",
      },
      {
        term: "审计缺失",
        description:
          "恢复动作不写入事件流，后续无法解释 agent 为什么压缩或等待。",
      },
    ],
    loopDetail:
      "Recovery 属于单次 agent.run 的控制流。它读取错误、当前预算和压缩能力，决定下一步动作，但不应永久污染下一轮用户请求。",
    figure: {
      alt: "LLM 错误恢复决策",
      accent: "Recovery",
      rows: [
        ["LLM Error", "→", "Recovery", "→", "classify"],
        ["rate_limit", "→", "backoff", "→", "retry"],
        ["context_length", "→", "compact", "→", "retry"],
        ["fatal", "→", "fail", "→", "user-visible error"],
      ],
      caption: "图 11-1 · Recovery 的第一步是分类，不是盲目重试。",
    },
    walkthrough: [
      `Agent 构建 messages 并调用 LLM。`,
      `LLM 抛出 context length error。`,
      `Recovery classifier 判断为可通过 compact 恢复。`,
      `Agent 调用 compressor 生成更短 messages。`,
      `同一次 agent.run 内重试 LLM。`,
      `重试成功后继续正常 tool/answer loop。`,
      `如果超过恢复预算，返回明确失败并保留可诊断信息。`,
    ],
    interfaceCode: `type RecoveryAction =
  | { kind: "backoff"; delayMs: number }
  | { kind: "compact" }
  | { kind: "continue" }
  | { kind: "fail"; reason: string };

function decideRecovery(error: unknown, state: RecoveryState): RecoveryAction {
  if (isRateLimit(error)) return { kind: "backoff", delayMs: state.nextDelay };
  if (isContextLength(error)) return { kind: "compact" };
  return { kind: "fail", reason: formatError(error) };
}`,
    sources: [
      { path: "src/recovery.ts", note: "错误分类与恢复决策" },
      { path: "src/recovery.test.ts", note: "恢复策略测试" },
      { path: "src/llm.ts", note: "LLM 调用与错误表面" },
      { path: "src/compressor.ts", note: "context length 后的 compact 能力" },
      { path: "src/transcript.ts", note: "恢复事件审计" },
    ],
    design: [
      `Recovery 让 agent 失败得有结构。不是所有错误都能修，但所有错误都应该被分类、记录，并给用户一个可理解结果。`,
      `把 provider 差异收敛在 recovery/adapter 层，可以避免 agent loop 到处散落 if provider。`,
    ],
    split: [
      { term: "classifier", description: "把 provider 错误转成领域类别。" },
      {
        term: "policy",
        description: "决定 backoff、compact、continue、fail。",
      },
      { term: "agent loop", description: "执行恢复动作，并控制本次运行预算。" },
    ],
    stateBoundary: [
      {
        term: "run-local",
        description: "retry 次数、backoff 预算、compact 尝试次数。",
      },
      { term: "History", description: "不应写入半截失败 assistant 消息。" },
      { term: "Transcript", description: "可以记录恢复事件，便于审计。" },
    ],
    prompt: {
      goal: "实现 LLM 错误分类和恢复策略，支持 backoff、compact、continue、fail。",
      scene: "LLM 限流、上下文超限或流式中断时，agent 尝试恢复而不是直接崩溃。",
      modules: "recovery.ts、llm.ts、agent.ts、compressor.ts、transcript.ts。",
      wiring: "Agent 捕获 LLM 错误，调用 recovery decision，再执行对应动作。",
      boundary:
        "不要无限 retry；恢复预算只属于当前 agent.run；不可恢复错误要明确失败。",
      cases:
        "rate limit、network、context length、invalid request、stream interrupted。",
      validation: "mock 各类错误，断言恢复动作、重试次数和最终状态。",
      sources: "src/recovery.ts、src/agent.ts、src/llm.ts。",
      docs: "说明错误分类比简单 retry 更重要。",
    },
    trap: {
      mistake: "所有错误都 retry。",
      why: "参数错误和权限错误 retry 只会浪费时间，context length 需要先压缩。",
      fix: "先分类，再选择恢复动作，并设置预算。",
      verify: "mock invalid request 时应 fail，不应 retry 三次。",
    },
    traps: [
      "retry 预算跨 turn 复用。",
      "压缩失败后继续追加 messages。",
      "把 provider 原始错误泄漏成用户难懂的长堆栈。",
    ],
    validation: {
      manual: "人为设置很小上下文预算触发 compact，再观察是否继续执行。",
      deterministic: "mock LLM 依次抛 rate limit、成功，验证 backoff 后重试。",
      integration: "Transcript 中能看到 recovery 事件。",
      failure: "同一个错误无限循环或吞掉失败。",
    },
    verifyItems: [
      `${inlineCode("src/recovery.test.ts")} 覆盖决策。`,
      `${inlineCode("src/agent.test.ts")} 覆盖集成。`,
      "用 fake compressor 测试 context length 恢复路径。",
    ],
    debug: [
      "检查错误是否被正确分类。",
      "检查恢复预算是否在本次 run 内初始化。",
      "检查 compact 后 messages 是否真的变短。",
      "检查失败原因是否给用户可理解信息。",
    ],
    summary: [
      "本章让 agent 在模型失败时保持可控。下一章会把长期项目计划落盘，从 session 级 TODO 走向 Persistent Task。",
    ],
    next: ["下一章进入 Persistent Task。"],
  }),
);

chapters.push(
  makeChapter({
    id: "15-hardening",
    number: "15",
    filename: "15-hardening.html",
    eyebrow: "第 15 章 · 长期运行的卫生系统",
    title: "长期运行不会把系统跑坏：Runtime Hardening",
    lede: "教学项目也会长时间运行。日志、输出、occurrence、task archive 和 eval trace 如果无限增长，最后会把 agentHome 变成垃圾场。",
    coreConcept: "Runtime Hardening",
    loopFocus:
      "持久化边界和运行时维护层，确保长期运行后数据仍可读、可清理、可解释",
    known: `你已经有 Memory、Task、Async Run、Schedule、OutputStore 和日志。它们都可能落盘，也都可能长期增长。`,
    scene: [
      `用户连续几周使用 agent：每天 schedule 跑报告，后台任务输出测试日志，LLM 通信日志持续追加。某天启动变慢，磁盘空间变小，某个 JSON 还因为中断写坏了。`,
      `Runtime Hardening 不是炫技优化，而是避免系统在真实使用中慢慢腐烂：原子写、日志轮转、output handle、清理 dry-run、时间语义统一。`,
    ],
    naive: `朴素方案是“先不管，等文件太多再 rm -rf logs”。这会让重要审计记录、用户长期记忆和可删除缓存混在一起。`,
    naiveCode: `// 危险：不知道哪些数据可删，哪些是长期事实。
rm -rf ~/.learn-claude-code-ts/*`,
    failures: [
      {
        term: "半截 JSON",
        description: "写入中断会留下损坏文件，下次启动解析失败。",
      },
      {
        term: "无限增长",
        description: "日志、outputs、occurrences、eval traces 都会累积。",
      },
      {
        term: "误删长期事实",
        description: "清理策略如果不分类，可能删掉用户 Memory 或长期 Task。",
      },
    ],
    loopDetail:
      "Hardening 不只在 agent loop 内，它覆盖所有读写边界：写文件时原子替换，写日志时轮转，暴露大输出时用 output_id，清理时先 dry-run。",
    figure: {
      alt: "Runtime Hardening 数据边界",
      accent: "Hardening",
      rows: [
        ["Atomic Write", "→", "valid JSON", "→", "recoverable startup"],
        ["Log Rotation", "→", "bounded logs", "→", "agentHome hygiene"],
        ["Cleanup Dry-run", "→", "typed retention", "→", "safe delete"],
      ],
      caption: "图 15-1 · 长期运行的关键是分类治理，不是一刀切删除。",
    },
    walkthrough: [
      `TaskStore 写 group.json 时先写同目录临时文件。`,
      `写完后校验 JSON，再 rename 覆盖正式文件。`,
      `LLM logger 追加日志前检查大小，超过阈值执行轮转。`,
      `大工具输出先登记到 OutputStore，LLM 只拿到 output_id。`,
      `清理命令先 dry-run，列出将删除的日志、旧 output、旧 occurrence。`,
      `用户确认后按类别执行清理，Memory 和 active Task 默认不删。`,
      `时间字段使用 turnIndex/loopRound/messageSequence 等明确语义，避免 round 混用。`,
    ],
    interfaceCode: `interface CleanupPlan {
  dryRun: boolean;
  categories: Array<"logs" | "outputs" | "occurrences" | "eval_traces">;
  olderThanDays: number;
}

async function atomicWriteJson(path: string, value: unknown) {
  const temp = path + ".tmp";
  await writeFile(temp, JSON.stringify(value, null, 2));
  JSON.parse(await readFile(temp, "utf8"));
  await rename(temp, path);
}`,
    sources: [
      { path: "src/atomic-write.ts", note: "原子写入" },
      { path: "src/log-rotation.ts", note: "日志轮转" },
      { path: "src/output-store.ts", note: "大输出句柄" },
      { path: "src/timeline.ts", note: "时间语义类型" },
      { path: "src/llm-logger.ts", note: "LLM 日志记录和轮转" },
    ],
    design: [
      `鲁棒性设计的核心不是“多加 try/catch”，而是让每类数据都有生命周期：什么是事实，什么是派生索引，什么是缓存，什么可以清理。`,
      `清理机制必须保守，尤其不能默认删除 Memory、active Task 和仍有关联的 outputs。`,
    ],
    split: [
      {
        term: "写入安全",
        description: "原子写、读写对称校验、id 一致性检查。",
      },
      {
        term: "增长控制",
        description: "日志轮转、output TTL、occurrence 保留策略。",
      },
      {
        term: "可解释清理",
        description: "dry-run 先告诉用户将删除什么，再执行。",
      },
    ],
    stateBoundary: [
      {
        term: "长期事实",
        description: "Memory、TaskGroup、Schedule 规则，默认不自动删除。",
      },
      {
        term: "审计与缓存",
        description:
          "logs、outputs、old occurrences、eval traces，可按策略清理。",
      },
      {
        term: "时间语义",
        description:
          "turnIndex、loopRound、loopIndex、messageSequence、transcript sequence 各有含义。",
      },
    ],
    prompt: {
      goal: "为 agentHome 持久化数据补 Runtime Hardening：原子写、日志轮转、output handle 和清理 dry-run。",
      scene:
        "agent 长期运行后，数据增长仍可控，坏文件不会破坏启动，清理不会误删长期事实。",
      modules:
        "atomic-write.ts、log-rotation.ts、output-store.ts、timeline.ts、相关 store 和 tests。",
      wiring:
        "持久化 store 使用 atomic write；logger 使用 rotation；清理命令按类别扫描。",
      boundary:
        "不要默认删除 Memory/active Task；不要把裸路径暴露给 LLM；清理先 dry-run。",
      cases:
        "写入中断、坏 JSON、日志超限、output_id 越权读取、旧 occurrence 清理。",
      validation: "测试原子写、日志轮转、output_id 读取边界和清理计划。",
      sources:
        "src/atomic-write.ts、src/log-rotation.ts、src/output-store.ts、src/timeline.ts。",
      docs: "说明鲁棒性是长期运行卫生系统，不是生产化大改。",
    },
    trap: {
      mistake: "清理时一刀切删除 agentHome。",
      why: "agentHome 同时包含长期事实、审计日志和缓存，生命周期完全不同。",
      fix: "按类别和 TTL 生成 dry-run 计划，默认保护长期事实。",
      verify: "dry-run 输出应明确分类，且不包含 Memory 和 active Task。",
    },
    traps: [
      "原子写临时文件跨目录，rename 不再原子。",
      "output path 直接给 LLM。",
      "round 同时表示 turn 和 loop，导致压缩年龄判断漂移。",
    ],
    validation: {
      manual: "制造大日志和旧 output，运行 dry-run，检查计划是否可解释。",
      deterministic: "测试坏 JSON 不污染正式文件，日志超限后轮转。",
      integration: "OutputStore 只能通过 output_id 读取登记输出。",
      failure: "清理计划包含长期 Memory，或坏 JSON 让启动崩溃。",
    },
    verifyItems: [
      `${inlineCode("src/atomic-write.test.ts")} 验证原子写。`,
      `${inlineCode("src/llm-logger.test.ts")} 验证轮转。`,
      `${inlineCode("src/output-store.test.ts")} 验证 output_id。`,
    ],
    debug: [
      "先分类数据目录。",
      "检查 store 读写是否对称。",
      "检查清理计划是否 dry-run。",
      "检查时间字段是否语义明确。",
    ],
    summary: [
      "主线教程到这里已经从最小 loop 长成了一个可长期运行的教学 agent。接下来两个专题分别讲模型差异和如何测试不确定系统。",
    ],
    next: ["专题 A：不同大模型不是只换模型名。"],
  }),
  makeChapter({
    id: "model-policy",
    number: "A",
    filename: "model-policy.html",
    eyebrow: "专题 A · 模型能力驱动的运行策略",
    title: "不同大模型不是只换模型名",
    lede: "当 agent 面对不同 provider 和模型时，不能在 agent.ts 里写一堆 if modelName。本专题用能力画像和 Runtime Policy 收敛差异。",
    coreConcept: "Foundation Model Profile + Runtime Policy",
    loopFocus: "LLM 请求构建和上下文预算选择阶段，根据模型能力事实选择运行策略",
    known: `你已经理解 agent loop 的稳定骨架。模型适配的目标是不破坏这条骨架，让协议差异留在 adapter/policy 层。`,
    scene: [
      `一个模型支持严格 tool call，另一个只支持类 OpenAI schema；一个有超长上下文，另一个 reasoning delta 格式不同。如果这些差异直接散落在 Agent Loop，代码会很快失去整体性。`,
      `Profile 描述事实，Policy 做 runtime 决策，Adapter 处理协议差异。三者分开，agent loop 才能保持稳定。`,
      `更具体地说，差异不只是 ${inlineCode("model")} 这个字符串。输出 token 参数、工具强制方式、并行工具调用、reasoning/thinking 预算、流式 delta 形状、JSON/structured output、prompt cache 语义，都会改变 agent 的行为。`,
    ],
    naive: `朴素方案是在 agent.ts 或 llm.ts 里按模型名写分支。模型越多，分支越多，测试越难。`,
    naiveCode: `if (model.includes("kimi")) {
  // 特殊上下文策略
} else if (model.includes("gpt")) {
  // 另一套工具格式
}`,
    failures: [
      {
        term: "事实和决策混在一起",
        description:
          "context window 是事实，是否开启 aggressive compression 是策略。",
      },
      {
        term: "模型名脆弱",
        description: "同一 provider 新模型能力会变化，按名字硬编码容易过期。",
      },
      {
        term: "loop 被污染",
        description:
          "agent.ts 负责运行逻辑，不应该理解每个 provider 的协议细节。",
      },
      {
        term: "参数差异会变成行为差异",
        description:
          "同样是“限制输出长度”，OpenAI Responses API 使用 max_output_tokens，Anthropic Messages API 使用 max_tokens，Gemini 使用 generation config；如果 adapter 不统一，agent 可能误以为模型拒答、截断或仍在 reasoning。",
      },
    ],
    loopDetail:
      "Profile 在启动/配置阶段解析，Policy 影响 compression、budget、reasoning、adapter 行为；LLM Adapter 把统一消息转成 provider 请求。",
    figure: {
      alt: "模型能力画像到运行策略",
      accent: "Runtime Policy",
      rows: [
        ["Model Name", "→", "Foundation Profile", "→", "Runtime Policy"],
        ["Policy", "→", "Context Budget", "→", "Stable Context"],
        ["LLM Adapter", "→", "Provider Protocol", "→", "Agent Loop"],
      ],
      caption: "图 A-1 · Profile 是事实，Policy 是决策，Adapter 是协议转换。",
    },
    walkthrough: [
      `配置解析出 provider 和 model。`,
      `FoundationModelProfile registry 匹配模型能力事实。`,
      `RuntimePolicy 根据 profile 和环境变量覆盖生成决策。`,
      `ContextBudget 分配 stable/working/evidence/token 预算。`,
      `StableContextManager 构建稳定项目上下文。`,
      `LLM Adapter 根据 provider 协议构建请求和解析响应。`,
      `Agent Loop 仍然只处理统一 assistant/tool/result 语义。`,
      `如果模型支持并行工具调用，Policy 决定当前 agent 是否允许并行；如果当前 harness 只支持顺序工具执行，Adapter 或 Policy 应把它收敛为单工具调用。`,
      `如果模型返回 reasoning/thinking 块，Adapter 保存 raw assistant 供审计，但只把可见 assistant content 和 tool calls 交给主 loop。`,
    ],
    interfaceCode: `interface FoundationModelProfile {
  id: string;
  provider: "openai" | "anthropic" | "gemini" | "openai-compatible";
  contextWindow: number;
  supportsToolCalls: boolean;
  supportsReasoning: boolean;
  cacheBehavior: "strong" | "weak" | "unknown";
  toolCalling: {
    supportsParallel: boolean;
    supportsForcedToolChoice: boolean;
    supportsStrictSchema: boolean;
  };
  outputBudgetParam: "max_output_tokens" | "max_tokens" | "maxOutputTokens";
  reasoningControl:
    | { kind: "none" }
    | { kind: "effort"; values: string[] }
    | { kind: "token_budget"; min: number; max: number; disableValue?: number };
}

interface RuntimePolicy {
  compressionMode: "normal" | "aggressive" | "relaxed";
  reasoningMode: "off" | "auto" | "visible";
  contextBudget: ContextBudgetConfig;
  toolCallMode: "single" | "parallel";
}`,
    sources: [
      { path: "src/foundation-models.ts", note: "模型能力画像" },
      { path: "src/runtime-policy.ts", note: "运行策略解析" },
      { path: "src/llm-adapter.ts", note: "协议适配" },
      { path: "src/context-budget.ts", note: "上下文预算" },
      { path: "src/stable-context.ts", note: "稳定上下文管理" },
      { path: "src/context-ranking.ts", note: "工作集排序" },
    ],
    extraSections: [
      {
        id: "parameter-matrix",
        title: "参数差异矩阵",
        body: `<p>下面这些例子不是为了让你背 API，而是让你看到“模型适配”为什么会影响 agent 行为。官方 API 会演进，所以教程中的做法是把差异抽象成 capability 和 policy，再由 adapter 生成具体请求。</p>
<dl class="defs">
  <dt>输出预算</dt>
  <dd>OpenAI Responses API 示例使用 ${inlineCode("max_output_tokens")} 控制输出上限；Anthropic Messages API 的核心输出上限是 ${inlineCode("max_tokens")}，且 extended thinking 的 ${inlineCode("budget_tokens")} 必须小于 ${inlineCode("max_tokens")}；Gemini 在 generation config 里表达输出和 thinking 预算。这个差异会影响 agent 判断“模型回答太短”到底是模型能力问题、预算问题，还是 reasoning 消耗了输出预算。</dd>

  <dt>工具选择</dt>
  <dd>OpenAI 工具调用可配置并行函数调用，例如通过 ${inlineCode("parallel_tool_calls: false")} 收敛成零个或一个工具；Anthropic 文档里 ${inlineCode("tool_choice: { type: 'auto' }")} 表示 Claude 自行决定是否用工具，也可以用 tool_choice 做硬约束；Gemini 使用 ${inlineCode("toolConfig.functionCallingConfig.mode")} 和 ${inlineCode("allowedFunctionNames")} 控制函数调用。Agent 如果只支持顺序工具，就必须把“模型是否可能一次返回多个工具”写进 policy。</dd>

  <dt>Reasoning / Thinking</dt>
  <dd>OpenAI reasoning 模型通过 ${inlineCode("reasoning: { effort: 'medium' }")} 这类参数表达推理强度；Anthropic extended thinking 有 ${inlineCode("thinking.budget_tokens")} 和 display/summary 语义；Gemini 的 thinking config 使用 ${inlineCode("thinkingBudget")}，其中 ${inlineCode("0")} 可关闭部分模型 thinking，${inlineCode("-1")} 表示动态 thinking。Agent 需要决定：thinking 是否进入用户可见正文、是否计入输出预算、是否需要保留 raw block 供多轮连续性。</dd>

  <dt>结构化输出</dt>
  <dd>有的 provider 支持严格 JSON schema，有的更依赖 prompt 或工具参数 schema。对 coding agent 来说，最终目标不是“拿到漂亮 JSON”，而是保证 tool call 参数可校验、错误可恢复、adapter 能把 provider 方言转成统一 ToolCall。</dd>

  <dt>流式事件</dt>
  <dd>不同 provider 的 streaming delta 可能把文本、tool name、tool arguments、reasoning/thinking 分成不同事件。Adapter 必须聚合成完整 assistant message 后再交给 agent loop，否则 tool arguments 可能是半截 JSON。</dd>
</dl>`,
      },
      {
        id: "behavior-differences",
        title: "参数如何改变 Agent 行为",
        body: `<p>同一套 agent loop，在不同模型参数下会表现出不同工作方式。Runtime Policy 的任务，就是把这些差异变成可解释、可测试的行为，而不是让模型自己猜。</p>
<dl class="defs">
  <dt>上下文窗口大</dt>
  <dd>行为不应该是“关闭压缩”，而是放宽 working/evidence budget，保留更多最近文件和证据，同时继续保护 stable prefix。大窗口模型仍可能因为工具输出爆炸而需要 output handle。</dd>

  <dt>推理预算高</dt>
  <dd>适合复杂重构、跨模块审计、eval judge；但对简单读文件任务会增加延迟和成本。Policy 可以按 task intent 决定 reasoning effort / thinkingBudget。</dd>

  <dt>工具调用保守</dt>
  <dd>如果模型默认更愿意直接回答，system prompt 和 tool_choice 可以稍微推它“先调查再回答”。但不能把所有任务都强制工具调用，否则普通解释和写作任务会变慢。</dd>

  <dt>并行工具调用强</dt>
  <dd>适合读取多个文件，但如果 permission、output-store、history 配对和冲突检测只支持顺序执行，就应关闭并行或在 adapter 层排队。</dd>

  <dt>JSON/工具参数不稳定</dt>
  <dd>Agent 行为应更保守：加强 schema 描述、开启 strict schema（如果 provider 支持）、把参数解析失败写成 tool_result 错误，让模型修正参数而不是让进程崩溃。</dd>
</dl>`,
      },
      {
        id: "adapter-example",
        title: "Adapter 伪码：统一意图，不统一参数名",
        body: `<p>Profile 和 Policy 的一个直观好处是：Agent 只表达统一意图，Adapter 负责把它翻译成 provider 参数。</p>
<pre class="code-block"><code>${escapeHtml(`type UnifiedLLMRequest = {
  messages: Message[];
  tools: ToolDefinition[];
  outputBudget: number;
  reasoning: "off" | "low" | "medium" | "high";
  toolMode: "auto" | "required" | "none";
  allowParallelTools: boolean;
};

function toProviderRequest(req: UnifiedLLMRequest, profile: FoundationModelProfile) {
  if (profile.provider === "openai") {
    return {
      input: toResponsesInput(req.messages),
      tools: toOpenAITools(req.tools),
      max_output_tokens: req.outputBudget,
      reasoning: req.reasoning === "off" ? undefined : { effort: req.reasoning },
      parallel_tool_calls: req.allowParallelTools,
    };
  }

  if (profile.provider === "anthropic") {
    return {
      messages: toAnthropicMessages(req.messages),
      tools: toAnthropicTools(req.tools),
      max_tokens: req.outputBudget,
      thinking: toAnthropicThinking(req.reasoning, req.outputBudget),
      tool_choice: toAnthropicToolChoice(req.toolMode),
    };
  }

  return {
    contents: toGeminiContents(req.messages),
    tools: toGeminiTools(req.tools),
    config: {
      maxOutputTokens: req.outputBudget,
      thinkingConfig: toGeminiThinking(req.reasoning),
      toolConfig: toGeminiToolConfig(req.toolMode, req.tools),
    },
  };
}`)}</code></pre>
<p>这个伪码故意不追求可直接运行。它要表达的设计点是：Agent Loop 不知道 provider 参数名；Runtime Policy 决定统一意图；Adapter 负责参数翻译和响应归一化。</p>`,
      },
      {
        id: "official-docs",
        title: "继续查官方文档",
        body: `<p>模型 API 参数变化很快，教程只能讲适配思路。真正实现时，要回到官方文档确认当前参数名和边界：<a href="https://developers.openai.com/api/docs/guides/function-calling" target="_blank" rel="noreferrer">OpenAI function calling</a>、<a href="https://developers.openai.com/api/docs/guides/reasoning" target="_blank" rel="noreferrer">OpenAI reasoning</a>、<a href="https://platform.claude.com/docs/en/agents-and-tools/tool-use/overview" target="_blank" rel="noreferrer">Claude tool use</a>、<a href="https://platform.claude.com/docs/en/build-with-claude/extended-thinking" target="_blank" rel="noreferrer">Claude extended thinking</a>、<a href="https://ai.google.dev/gemini-api/docs/function-calling" target="_blank" rel="noreferrer">Gemini function calling</a>、<a href="https://ai.google.dev/gemini-api/docs/thinking" target="_blank" rel="noreferrer">Gemini thinking</a>。</p>`,
      },
    ],
    design: [
      `大模型差异应该变成 harness 的能力输入，而不是 prompt 黑魔法。这样教学项目才能展示可迁移的设计套路。`,
      `即使有 1M context，也不意味着关闭压缩。大上下文需要更好的分层，而不是把仓库全塞进去。`,
      `适配的目标不是“支持最多模型参数”，而是让每个参数都能解释为 agent 行为：是否允许并行工具、是否保留 reasoning、如何分配上下文、失败时如何恢复。`,
    ],
    split: [
      {
        term: "FoundationModelProfile",
        description: "描述模型事实和来源可信度。",
      },
      { term: "RuntimePolicy", description: "把事实转成当前运行决策。" },
      {
        term: "LLM Adapter",
        description: "处理 provider 协议差异和 streaming 聚合。",
      },
      {
        term: "Parameter Mapper",
        description:
          "把 outputBudget、reasoning、toolMode、allowParallelTools 这类统一意图翻译成 provider 参数名。",
      },
    ],
    stateBoundary: [
      {
        term: "稳定",
        description: "模型 profile 和默认 policy 在会话开始形成基线。",
      },
      {
        term: "可覆盖",
        description:
          "session-local override 可调整策略，但不能破坏稳定前缀边界。",
      },
      {
        term: "协议状态",
        description:
          "reasoning/raw assistant 属于 adapter 层，不是普通用户可见正文。",
      },
      {
        term: "行为状态",
        description:
          "toolCallMode、compressionMode、reasoningMode 会改变 agent 做事方式，应进入 policy snapshot 和测试断言。",
      },
    ],
    prompt: {
      goal: "新增 Foundation Model Profile、Runtime Policy、Context Budget 和 LLM Adapter 抽象。",
      scene: "不同模型能力不同，但 agent loop 不应按模型名散落分支。",
      modules:
        "foundation-models.ts、runtime-policy.ts、context-budget.ts、llm-adapter.ts、stable-context.ts。",
      wiring:
        "config 解析 profile/policy，LLM client 使用 adapter，Agent 使用统一接口。",
      boundary:
        "不要在 agent.ts 按 modelName if；Profile 是事实，Policy 是决策。",
      cases:
        "未知模型 fallback、reasoning delta、tool call streaming、1M context 预算。",
      validation:
        "profile 注册、policy override、adapter 请求构建、stable context hash。",
      sources:
        "src/foundation-models.ts、src/runtime-policy.ts、src/llm-adapter.ts。",
      docs: "说明模型适配是能力驱动，不是换模型名。",
    },
    trap: {
      mistake: "在 agent loop 里按模型名写分支。",
      why: "这会让核心 loop 背负 provider 协议差异，越改越乱。",
      fix: "把差异收敛到 profile/policy/adapter。",
      verify: "新增模型 profile 时不需要改 agent.ts。",
    },
    traps: [
      "把 profile 事实和 policy 决策混写。",
      "把 reasoning 当普通 assistant content。",
      "大上下文模型直接禁用压缩。",
    ],
    validation: {
      manual: "切换不同 provider profile，观察 agent loop 行为接口不变。",
      deterministic: "测试 profile resolver、policy parser、adapter parser。",
      integration: "稳定上下文 hash 在相同配置下稳定。",
      failure: "新增模型需要修改 agent.ts。",
    },
    verifyItems: [
      `${inlineCode("src/foundation-models.test.ts")} 覆盖 profile。`,
      `${inlineCode("src/runtime-policy.test.ts")} 覆盖 policy。`,
      `${inlineCode("src/llm-adapter.test.ts")} 覆盖协议适配。`,
    ],
    debug: [
      "先看解析到的 profile。",
      "再看 policy override。",
      "检查 adapter 原始响应保存。",
      "检查 context budget 是否符合模型窗口。",
    ],
    summary: [
      "专题 A 把模型差异变成运行策略输入。专题 B 会回答最后一个问题：怎样测试一个不确定的 agent。",
    ],
    next: ["专题 B：如何测试一个不确定的 Coding Agent。"],
  }),
  makeChapter({
    id: "eval",
    number: "B",
    filename: "eval.html",
    eyebrow: "专题 B · 测试不确定系统",
    title: "如何测试一个不确定的 Coding Agent",
    lede: "Agent 会调用真实模型，但测试不能一开始就依赖真实模型。本专题用 deterministic-first 的 eval harness 证明 loop 行为。",
    coreConcept: "Eval Harness",
    loopFocus:
      "测试层用 Driver、Trace、Assertion 从外部观察 agent 行为，而不是把 live LLM 当默认门禁",
    known: `你已经实现了完整 agent。现在要证明它真的工作：不是“我跑了一次看起来可以”，而是能用可重复事实验证行为。`,
    scene: [
      `用户要求 agent 读取文件并写报告。真实模型可能今天用 run_read，明天先解释计划，后天输出风格不同。我们不能把这种不确定性当第一层测试。`,
      `Eval Harness 先用 ScriptedLLM、ScriptedTerminal、Fake Tool Registry 控制变量，再逐层加入 real tools、replay、live smoke、judge。`,
      `本专题要让读者理解一件事：测试 agent 不是测试“模型聪不聪明”，而是测试 harness 有没有把输入、工具、权限、状态、输出、trace 和报告组织成可重复事实。`,
    ],
    naive: `朴素方案是写几个真实 query，调用线上模型，看最终回答像不像。`,
    naiveCode: `const answer = await liveAgent.run("请读 README 并总结");
expect(answer).toContain("README");`,
    failures: [
      {
        term: "不可重复",
        description: "真实模型输出会漂移，CI 不适合默认依赖它。",
      },
      {
        term: "只看结果不看行为",
        description: "最终文本正确，不代表工具调用、权限和文件写入路径正确。",
      },
      {
        term: "失败不可定位",
        description: "没有 trace 时，只知道 fail，不知道哪一步错了。",
      },
      {
        term: "覆盖层级混乱",
        description:
          "把 unit test、integration test、live smoke、judge report 混成一个“智能体测试”，会导致快的测试不快、准的测试不准、失败时也不知道该看哪层。",
      },
    ],
    loopDetail:
      "Eval 不改变 production loop，而是通过 CodingAgentDriver 驱动被测 agent，用 TraceRecorder 记录事实，用 assertions 验证行为。",
    figure: {
      alt: "Eval Harness 分层",
      accent: "TraceRecorder",
      rows: [
        ["EvalCase", "→", "Driver", "→", "Agent"],
        ["Runtime Events", "→", "TraceRecorder", "→", "Assertions"],
        ["Deterministic", "→", "Replay / Live / Judge", "→", "Report"],
      ],
      caption: "图 B-1 · 确定性测试先行，live 和 judge 只作为补充层。",
    },
    walkthrough: [
      `编写 EvalCase，描述 workspace、steps 和 assertions。`,
      `Runner 创建临时 workspace，避免污染真实仓库。`,
      `Driver 用 ScriptedLLM 控制模型响应。`,
      `Agent 执行工具，TraceRecorder 记录 tool call、文件路径、权限事件。`,
      `Portable assertions 检查文件、输出和事实。`,
      `Instrumented assertions 检查工具调用细节。`,
      `Report 汇总失败原因，live/judge suite 默认 opt-in。`,
      `如果失败，先读 report 中的 step，再读 trace 事件，而不是直接重跑 live LLM。`,
      `当 deterministic suite 稳定后，再少量加入 replay fixture 和 live smoke，观察真实模型是否仍能遵守同一套 harness 边界。`,
    ],
    interfaceCode: `interface EvalCase {
  name: string;
  workspace: WorkspaceFixture;
  steps: EvalStep[];
  assertions: EvalAssertion[];
}

interface CodingAgentDriver {
  runStep(step: EvalStep): Promise<void>;
  collectTrace(): RuntimeEvent[];
  cleanup(): Promise<void>;
}

type RuntimeEvent =
  | { kind: "agent.message"; role: string; contentPreview: string }
  | { kind: "tool.call"; stepId: string; toolName: string; args: unknown }
  | { kind: "tool.result"; stepId: string; toolName: string; error: boolean }
  | { kind: "permission.prompt"; stepId: string; toolName: string }
  | { kind: "runtime.path"; name: "workspace" | "agentHome"; path: string };

type EvalAssertion =
  | { kind: "fileExists"; path: string }
  | { kind: "fileContains"; path: string; text: string }
  | { kind: "toolCalled"; toolName: string }
  | { kind: "permissionPromptShown"; toolName: string }
  | { kind: "finalOutputContains"; text: string };
}`,
    sources: [
      { path: "src/eval/core/case-schema.ts", note: "EvalCase 类型" },
      { path: "src/eval/core/driver.ts", note: "Driver 边界" },
      { path: "src/eval/core/trace.ts", note: "TraceRecorder" },
      { path: "src/eval/core/assertions.ts", note: "断言层" },
      {
        path: "src/eval/drivers/learn-claude-code/scripted-llm.ts",
        note: "ScriptedLLM",
      },
      {
        path: "src/eval/core/report.ts",
        note: "JSON/Markdown 报告聚合",
      },
      { path: "src/eval/README.md", note: "Eval 使用说明" },
    ],
    extraSections: [
      {
        id: "testing-layers",
        title: "先把测试层级拆清楚",
        body: `<p>一个 coding agent 的测试不能只有一种。你要先问：这层测试想证明什么事实？如果事实不同，测试工具就不同。</p>
<dl class="defs">
  <dt>单元测试</dt>
  <dd>证明一个模块的局部规则，例如 PermissionManager 是否拒绝越界路径、TaskStore 是否能重建 index、Compressor 是否不拆 tool_call/tool_result。它快、稳定、失败定位清楚。</dd>

  <dt>Agent 集成测试</dt>
  <dd>证明主 loop 能把 History、LLM、ToolRegistry、Permission、Hook、Recovery 串起来。这里可以用 fake/scripted LLM，避免真实模型漂移。</dd>

  <dt>Deterministic Eval</dt>
  <dd>证明一个完整任务场景可重复：给定 workspace、scripted model outputs 和 steps，agent 应调用哪些工具、产生哪些文件、给出什么最终摘要。</dd>

  <dt>Replay Eval</dt>
  <dd>把历史 fixture 变成可重复样本。它适合复现旧 bug：过去某个工具调用顺序错了，今天要保证不会再错。</dd>

  <dt>Live Smoke</dt>
  <dd>用真实模型观察端到端体验，但默认不进 CI 硬门禁。它回答“真实模型大致能不能走通”，不回答“harness 是否确定正确”。</dd>

  <dt>Judge</dt>
  <dd>用 LLM 判断语义质量，例如总结是否完整、回答是否遵守格式。但 judge 只能补充 hard assertions，不能代替文件、工具、权限这些事实断言。</dd>
</dl>`,
      },
      {
        id: "case-design",
        title: "EvalCase 应该怎么写",
        body: `<p>好的 EvalCase 像一份小型实验记录：它告诉 runner 如何准备环境，告诉 driver 如何驱动 agent，告诉 assertions 要检查哪些事实。</p>
<pre class="code-block"><code>${escapeHtml(`const caseReadAndSummarize = {
  name: "read-config-and-write-summary",
  workspace: {
    files: {
      "config.json": "{ \\"mode\\": \\"safe\\" }",
    },
  },
  steps: [
    {
      id: "ask",
      input: "读取 config.json，并把模式写入 report.md",
      scriptedAssistant: [
        toolCall("run_read", { path: "config.json" }),
        toolCall("run_write", { path: "report.md", content: "mode: safe" }),
        finalText("已写入 report.md"),
      ],
    },
  ],
  assertions: [
    fileExists("report.md"),
    fileContains("report.md", "mode: safe"),
    toolCalled("run_read"),
    toolCalled("run_write"),
  ],
};`)}</code></pre>
<p>注意这个 case 不要求真实模型“自由发挥”。它先证明 harness 在确定输入下能正确执行。等这层稳了，再引入 live 模型看真实行为。</p>`,
      },
      {
        id: "trace-design",
        title: "Trace 是事实来源，不是日志美化",
        body: `<p>很多人第一次做 eval，会把 stdout 当 trace。这样很难机器判断，也很难定位失败。Trace 应该是结构化事件，每个事件有 kind、stepId、时间、关键字段和可选 preview。</p>
<dl class="defs">
  <dt>tool.call</dt>
  <dd>记录工具名、参数、stepId。它能证明模型是否真的调用了工具，而不是在最终答案里假装读过文件。</dd>

  <dt>tool.result</dt>
  <dd>记录工具是否成功、输出 preview、output_id。它能证明工具层返回了什么观察，而不是只看最终文本。</dd>

  <dt>permission.prompt</dt>
  <dd>记录敏感操作是否触发确认。它能证明安全边界仍在，而不是被 eval driver 绕过。</dd>

  <dt>runtime.path</dt>
  <dd>记录临时 workspace 和 agentHome。它能帮助失败后定位产物，同时证明测试没有污染真实仓库。</dd>

  <dt>agent.message</dt>
  <dd>记录 user/assistant/tool message 的摘要。它能帮助你检查 tool_call/tool_result 是否配对，但不需要把完整大输出塞进报告。</dd>
</dl>
<p>有了结构化 trace，assertion 才能像“查询事实”一样写，而不是靠正则猜日志文本。</p>`,
      },
      {
        id: "assertion-strategy",
        title: "断言策略：先硬事实，后语义判断",
        body: `<p>Eval 里最重要的取舍是：哪些东西必须硬断言，哪些东西可以让 judge 判断。</p>
<dl class="defs">
  <dt>Portable assertions</dt>
  <dd>不依赖当前项目内部实现，检查文件是否存在、文件是否包含 sentinel、最终输出是否包含关键文本。它适合跨 agent 项目复用。</dd>

  <dt>Instrumented assertions</dt>
  <dd>依赖 trace 事件，检查某个工具是否被调用、某一步是否没有调用写工具、权限提示是否出现。它更贴近本项目 harness，但定位能力强。</dd>

  <dt>Negative assertions</dt>
  <dd>同样重要。例如权限拒绝场景不仅要断言“出现拒绝提示”，还要断言目标文件不存在、run_write 没有执行。</dd>

  <dt>Judge assertions</dt>
  <dd>只用于语义质量，例如“总结是否覆盖风险”。Judge 结果必须带理由，解析失败要明确标为 judge failure，而不是让 case 静默通过。</dd>
</dl>`,
      },
      {
        id: "live-and-judge",
        title: "Live、Judge 和 Report 的边界",
        body: `<p>真实模型测试有价值，但它不应该站在第一层。推荐顺序是：deterministic 先稳定，replay 防回归，live smoke 少量观察，judge 最后补语义。</p>
<ul>
  <li><strong>Live suite 要 opt-in：</strong>例如通过 ${inlineCode("EVAL_LIVE=1")}、${inlineCode("EVAL_LIVE_FULL=1")}、${inlineCode("EVAL_JUDGE=1")} 显式开启。没有 API key 时，默认测试不应失败。</li>
  <li><strong>Live case 要小：</strong>每个 case 只验证一个用户可感知工作流，比如“读文件并写报告”“权限拒绝后解释原因”。不要把多个复杂能力塞进一个 live case。</li>
  <li><strong>Judge 要有鲁棒 parser：</strong>LLM judge 可能输出 markdown、解释文字或半截 JSON。parser 应能提取 JSON，提取失败要给出可诊断错误。</li>
  <li><strong>Report 要服务定位：</strong>报告不只是 pass/fail，它应该列出 case、step、失败 assertion、相关 trace 事件、workspace 路径和 agentHome 路径。</li>
</ul>`,
      },
      {
        id: "failure-diagnosis",
        title: "失败后怎么定位",
        body: `<p>Eval 的价值在失败时最明显。一个好的失败报告应该让你在 1-2 分钟内知道先看哪里。</p>
<ol>
  <li><strong>先看 assertion：</strong>是文件不存在、文本不包含、工具没调用，还是权限提示没出现？</li>
  <li><strong>再看 stepId：</strong>失败绑定在哪一步？如果 stepId 为空，先修 assertion 绑定。</li>
  <li><strong>读 trace 事件：</strong>模型是否提出了 tool call？工具是否返回错误？权限是否拒绝？</li>
  <li><strong>进入临时 workspace：</strong>检查实际文件产物，而不是猜测 agent 写了什么。</li>
  <li><strong>最后才重跑 live：</strong>如果 deterministic 已经失败，重跑 live 只会增加噪音。</li>
</ol>`,
      },
      {
        id: "mcp-team-boundary",
        title: "MCP 与 Agent Team：先做原型边界",
        body: `<p>教程里可以介绍 MCP 和 Agent Team 的 eval 原型，但必须诚实标注边界：当前项目如果没有生产级 MCP runtime 或真正的 team scheduler，就不能把测试写成“生产能力已完成”。</p>
<dl class="defs">
  <dt>MCP fixture server</dt>
  <dd>先用本地 fixture server 验证 JSON-RPC 协议事件、工具发现和调用记录。它证明 harness 能观察 MCP 交互，不等于已经接入任意真实 MCP 服务。</dd>

  <dt>Agent Team trace</dt>
  <dd>先记录 supervisor、worker、handoff、artifact 等事件。即使执行仍是顺序的，也能先设计好 trace 和 assertion 语言。</dd>

  <dt>describe.skip 的意义</dt>
  <dd>原型测试可以存在，但默认 skip，避免读者误以为功能已经生产可用。文档必须说明它们是未来能力的测试草图。</dd>
</dl>`,
      },
      {
        id: "suite-growth-path",
        title: "一套 Eval Suite 应该如何长出来",
        body: `<p>不要第一天就写“全自动真实模型验收”。推荐的增长顺序和 agent 本身一样，也是递进式的。</p>
<ol>
  <li><strong>第 1 步：纯 deterministic。</strong>只用 ScriptedLLM、ScriptedTerminal 和 fake tool。目标是证明 runner、driver、trace、assertion 的骨架能跑。</li>
  <li><strong>第 2 步：接入真实核心工具。</strong>仍然不用真实模型，但把 run_read、run_write、run_edit_exact、run_bash 换成真实工具，在临时 workspace 里验证文件系统边界。</li>
  <li><strong>第 3 步：加 CLI 黑盒 driver。</strong>同一个 EvalCase 可以通过 in-process driver 跑，也可以通过 CLI driver 跑。这样能发现 composition root、stdio、命令行参数和真实启动路径的问题。</li>
  <li><strong>第 4 步：加入 replay。</strong>把过去失败过的模型响应保存成 fixture。Replay 的价值是“旧 bug 不复发”，不是追求覆盖所有自然语言变化。</li>
  <li><strong>第 5 步：少量 live smoke。</strong>每个 live case 都要小，且只验证一个用户路径。比如“读文件后总结”“写 sentinel 报告”“权限拒绝后解释原因”。</li>
  <li><strong>第 6 步：full-tools nightly。</strong>把 Memory、Task、Async Run、Schedule、OutputStore 都放进临时 agentHome，作为 nightly 或手动回归，不进入默认快速门禁。</li>
  <li><strong>第 7 步：judge/report。</strong>最后再用 judge 补语义质量，用 report 帮助定位失败。Judge 的输出只能补充 hard facts，不能覆盖 hard assertion。</li>
</ol>
<p>这条路线能防止测试系统变成另一个不确定的大系统。每加一层，都要问：这一层新增了什么风险？它是否仍然能解释失败？</p>`,
      },
      {
        id: "report-shape",
        title: "失败报告应该长什么样",
        body: `<p>一个好的 eval report 应该像医生的检查单：先给结论，再给证据，再给下一步排查入口。下面是一个简化形状。</p>
<pre class="code-block"><code>${escapeHtml(`{
  "suite": "deterministic-core-tools",
  "case": "permission-denies-outside-write",
  "status": "failed",
  "failedAssertion": {
    "kind": "fileNotExists",
    "path": "../outside.txt",
    "message": "Expected outside file to be absent, but it was created"
  },
  "step": {
    "id": "attempt-outside-write",
    "input": "try writing outside the workspace"
  },
  "relatedEvents": [
    { "kind": "tool.call", "toolName": "run_write", "argsPreview": "{ path: '../outside.txt' }" },
    { "kind": "permission.prompt", "toolName": "run_write" },
    { "kind": "tool.result", "toolName": "run_write", "error": false }
  ],
  "paths": {
    "workspace": "/tmp/eval-...",
    "agentHome": "/tmp/eval-agent-home-..."
  },
  "nextDebugHint": "Permission returned allow after prompt; inspect path normalization before permission decision."
}`)}</code></pre>
<p>注意这个报告没有把所有日志都贴出来。它只贴和失败断言相关的 trace 事件，并给出临时路径，让开发者可以继续进入现场查看。</p>`,
      },
      {
        id: "eval-query-design",
        title: "Live Query 怎么设计才不浪费钱",
        body: `<p>Live query 的目标不是难倒模型，而是观察真实模型在 harness 边界内是否能完成用户路径。它应该短、清晰、有 sentinel，并且失败后能靠 trace 定位。</p>
<dl class="defs">
  <dt>好 query</dt>
  <dd>“读取 config.json，把 mode 字段写入 report.md，内容包含 sentinel: MODE_OK。”这个 query 有明确输入、明确输出、明确文件产物。</dd>

  <dt>坏 query</dt>
  <dd>“帮我优化这个项目。”它太大、目标不清、模型可以做很多合理但不可断言的事情。</dd>

  <dt>好断言</dt>
  <dd>report.md 存在、包含 MODE_OK、调用过 run_read 和 run_write、没有调用 run_bash。</dd>

  <dt>坏断言</dt>
  <dd>最终回答“看起来不错”。这类判断可以交给 judge 辅助，但不能作为唯一验收。</dd>
</dl>`,
      },
    ],
    design: [
      `测试 agent 的第一原则是控制不确定性。先证明 harness 行为，再用 live smoke 观察真实模型表现。`,
      `Trace 是事实来源，不是漂亮日志。断言应该检查文件存在、工具被调用、权限提示出现等可机器判断事实。`,
      `Eval 设计不是为了追求“模型分数”，而是把不确定系统拆成可观察事实：workspace、driver 输入、LLM 脚本、tool events、permission events、最终产物。`,
      `一个好 eval case 应该小而硬：一个场景，一个主要风险，几条能定位失败的断言。复杂工作流可以由 suite 聚合，而不是塞进单个 case。`,
    ],
    split: [
      {
        term: "Driver",
        description: "被测对象边界，可以是 in-process 或 CLI。",
      },
      { term: "Trace", description: "记录运行事实，供断言和报告使用。" },
      {
        term: "Suites",
        description:
          "deterministic、replay、live、judge、full-tools 分层运行。",
      },
      {
        term: "Report",
        description:
          "把 case 结果、trace 摘要、失败断言和临时路径汇总成 JSON/Markdown。",
      },
    ],
    stateBoundary: [
      { term: "临时 workspace", description: "真实工具只能操作隔离目录。" },
      {
        term: "临时 agentHome",
        description: "测试 Memory/Task/Schedule 不污染用户环境。",
      },
      {
        term: "live opt-in",
        description: "真实模型测试必须显式环境变量开启。",
      },
      {
        term: "judge 语义层",
        description:
          "只判断最终语义质量，不替代工具、文件、权限这些 hard assertions。",
      },
    ],
    prompt: {
      goal: "实现 deterministic-first eval harness，用 Driver/Trace/Assertion 验证 agent 行为。",
      scene: "不依赖真实模型，也能测试 agent loop、工具调用、权限和文件结果。",
      modules: "eval/core、drivers、cases、replay、live、judge、report。",
      wiring:
        "runner 创建 workspace，driver 驱动 agent，trace 记录事件，assertions 验证行为。",
      boundary:
        "默认 CI 不跑 live LLM；judge 不能替代 hard assertion；真实工具必须隔离。",
      cases:
        "工具调用顺序、权限提示、文件写入、replay fixture、live smoke、judge JSON 解析。",
      validation:
        "npm run test:eval 跑 deterministic；live/judge 用环境变量 opt-in。",
      sources: "src/eval/core/*、src/eval/cases/*、src/eval/live/*。",
      docs: "说明 eval 是证明 harness 行为，不是给模型打分游戏。",
    },
    trap: {
      mistake: "只用真实 LLM 最终文本做测试。",
      why: "不可重复，也无法证明工具和权限行为正确。",
      fix: "确定性 harness 先行，live/judge 作为补充。",
      verify: "断网或无 API key 时 deterministic suite 仍可运行。",
    },
    traps: [
      "trace 只是文本日志，无法机器断言。",
      "assertion 绑定错 stepId。",
      "MCP/Team 原型测试未 skip 却被误读为生产能力完成。",
    ],
    validation: {
      manual: "运行 deterministic eval，再单独 opt-in live smoke。",
      deterministic: "ScriptedLLM + fake/real core tools 断言行为事实。",
      integration: "Report 同时输出 JSON 和 Markdown，便于定位失败。",
      failure: "没有 API key 时默认测试失败，说明 live 被错误纳入门禁。",
    },
    verifyItems: [
      `${inlineCode("src/eval/runner.test.ts")} 覆盖核心 runner。`,
      `${inlineCode("src/eval/cases/deterministic.test.ts")} 覆盖 deterministic suite。`,
      `${inlineCode("src/eval/judge/judge-suite.test.ts")} 覆盖 judge 解析。`,
    ],
    debug: [
      "先看 trace 事件。",
      "再看 assertion 指向的 stepId。",
      "检查 workspace/agentHome 是否临时目录。",
      "检查 live 环境变量是否误开。",
    ],
    summary: [
      "专题 B 给完整 agent 加上验证层。到这里，教程已经覆盖从最小 loop 到长期运行和 eval 的完整构建路径。",
    ],
    next: ["最后可以阅读 Reference，把术语、Prompt Card 和验证手册串起来。"],
  }),
  makeChapter({
    id: "reference",
    number: "R",
    filename: "reference.html",
    eyebrow: "Reference · 复盘与速查",
    title: "术语、Prompt Pack 与验证手册",
    lede: "这一页不是新功能章节，而是把整套教程的核心术语、prompt 写法和验证层级收束成查阅入口。",
    coreConcept: "Reference Pack",
    loopFocus: "读完整套教程后，把分散的概念整理成可复用 prompt 和验收清单",
    known: `你已经走过最小 loop、工具、权限、持久化、调度、模型适配和 eval。现在需要一张地图，帮助你回头查概念并写自己的重建 prompt。`,
    scene: [
      `你准备让另一个 coding agent 从零重建类似项目。此时不该把 20 多章原文全复制过去，而应该提炼：目标、模块边界、接线顺序、corner case、验证命令。`,
      `Reference 的任务就是把这些材料归档成 Prompt Pack 和验证手册。`,
    ],
    naive: `朴素方案是把所有章节 Prompt Card 直接拼成一个超长 prompt，一次性让 coding agent 实现全部功能。`,
    naiveCode: `prompt = chapter00 + chapter01 + ... + chapter15 + topicA + topicB;`,
    failures: [
      {
        term: "任务过大",
        description:
          "一次性实现全部功能会打破递进设计，也让 review 和测试失去边界。",
      },
      {
        term: "验收模糊",
        description: "超长 prompt 往往没有分阶段验收，失败时不知道该回滚哪里。",
      },
      {
        term: "教学节奏丢失",
        description: "本项目的价值在于逐步长出 agent，而不是一口气堆完功能。",
      },
    ],
    loopDetail:
      "Reference 不接入 runtime loop，它服务学习者的构建 loop：读一章、写 prompt、实现、验证、复盘，再进入下一章。",
    figure: {
      alt: "学习者重建 Agent 的循环",
      accent: "Prompt Pack",
      rows: [
        ["Read Chapter", "→", "Prompt Card", "→", "Implement"],
        ["Run Tests", "→", "Review Trace", "→", "Fix"],
        ["Update Docs", "→", "Next Chapter", "→", "Agent grows"],
      ],
      caption: "图 R-1 · 学习者也有自己的 loop：阅读、提示、实现、验证、复盘。",
    },
    walkthrough: [
      `选择一个章节，例如工具调用。`,
      `提取 Prompt Card 中的目标、模块、接线和边界。`,
      `让 coding agent 只实现这一章，不提前做后续章节。`,
      `运行该章对应的确定性测试和手工 query。`,
      `阅读源码地图，确认实现边界没有漂移。`,
      `更新 summary 或教程，再进入下一章。`,
    ],
    interfaceCode: `interface RebuildPrompt {
  goal: string;
  modules: string[];
  wiring: string[];
  boundaries: string[];
  cornerCases: string[];
  validation: string[];
  docs: string[];
}`,
    sources: [
      { path: "doc/web-tutorial-plan.md", note: "教程总蓝图" },
      { path: "doc/summary.md", note: "当前实现状态" },
      { path: "tutorial/assets/content.js", note: "章节元数据" },
      { path: "tutorial/chapters/00-preface.html", note: "样章结构" },
      { path: "src/eval/README.md", note: "验证系统说明" },
    ],
    design: [
      `Reference 要帮助学生形成架构意识：不是背函数名，而是知道每个能力插在 loop 的哪里，状态属于哪里，怎么验证。`,
      `Prompt Pack 最好按章节拆分。每次只实现一个独立增量，保留教学项目的递进性。`,
    ],
    split: [
      {
        term: "术语表",
        description:
          "解释 History、Transcript、ToolResult、Reminder、Occurrence 等概念。",
      },
      { term: "Prompt Pack", description: "按章节整理可复制实现任务。" },
      {
        term: "验证手册",
        description:
          "列出 deterministic、integration、live、judge 的使用边界。",
      },
    ],
    stateBoundary: [
      {
        term: "学习资料",
        description: "Reference 总结教程，不参与 agent runtime。",
      },
      {
        term: "实现状态",
        description: "以 summary.md 和源码为准，而不是旧 PDD 草稿。",
      },
      {
        term: "验证证据",
        description: "以测试、trace、report 和手工 query 为准。",
      },
    ],
    prompt: {
      goal: "把整套教程整理成可分阶段执行的 Prompt Pack 和验证手册。",
      scene: "学生读完教程后，用自己的话指导 coding agent 逐章重建项目。",
      modules: "教程章节、prompt pack、术语表、验证清单。",
      wiring: "每张卡片都指向源码入口、测试入口和文档同步位置。",
      boundary: "不要一次性让 agent 实现全部章节；不要把 prompt 写成使用手册。",
      cases: "章节依赖、跨模块边界、live 测试 opt-in、文档和实现漂移。",
      validation:
        "抽取任意章节 Prompt Card，看是否能指导另一个 agent 生成合理改动计划。",
      sources:
        "doc/web-tutorial-plan.md、tutorial/chapters/*、src/eval/README.md。",
      docs: "Reference 本身就是教程收束页。",
    },
    trap: {
      mistake: "把教程当 API 手册读。",
      why: "本教程的目标是训练架构 prompt 能力，而不是记住工具命令列表。",
      fix: "每章都追问：新增能力插在 loop 哪里，状态在哪里，如何验证。",
      verify: "不看源码细节，也能用自己的话写出本章实现 prompt。",
    },
    traps: [
      "一次性实现所有章节。",
      "只复制 Prompt Card 不理解边界。",
      "把 live smoke 当默认 CI 门禁。",
    ],
    validation: {
      manual: "选一章，口述场景、设计、边界、验证，再看正文补漏。",
      deterministic: "检查每章都有 Prompt Card 和验证项。",
      integration: "站点导航、页内目录、上一章/下一章都可用。",
      failure: "学生只能复述功能列表，无法说明 loop 接入点。",
    },
    verifyItems: [
      "每章至少有场景、loop 位置、源码地图、Prompt Card、验证。",
      "Prompt Card 面向实现 agent 能力，不面向写教程。",
      "验证层级区分 deterministic/live/judge。",
    ],
    debug: [
      "找不到概念时先查术语表。",
      "实现漂移时查 summary.md。",
      "测试失败时先看 trace。",
      "章节导航问题查 content.js。",
    ],
    summary: [
      "Reference 是整套教程的出口。学生从这里带走的不是一个功能列表，而是一套能用 prompt 重建 agent harness 的表达方式。",
    ],
    next: [
      "回到第 00 章，试着不用原文，只根据自己的理解重写最小 agent loop 的 Prompt Card。",
    ],
  }),
);

chapters.push(
  makeChapter({
    id: "12-task",
    number: "12",
    filename: "12-task.html",
    eyebrow: "第 12 章 · 把长期计划放到磁盘上",
    title: "长期计划落盘：Persistent Task",
    lede: "TODO 是当前 session 的节奏，Task Group 是跨会话、跨天、跨项目仍然存在的长期计划。本章把任务系统从内存推进到持久化存储。",
    coreConcept: "Persistent Task",
    loopFocus:
      "工具执行层和持久化层之间，把长期计划保存为可重建、可校验的项目状态",
    known: `你已经有 session-local TODO 和 Memory。Persistent Task 既不是 TODO，也不是 Memory：它记录项目中的长期工作计划，而不是用户偏好或本轮步骤。`,
    scene: [
      `用户说：“接下来三天逐步完成权限重构，今天先做审计，明天实现，后天补 eval。”这不是一次 session 的 TODO，而是一个长期 Task Group。`,
      `Task 系统需要能创建 group、添加 task、更新状态、表达依赖，并在重启后仍能恢复。`,
    ],
    naive: `朴素方案是把 TODO 数组直接 JSON.stringify 到磁盘。这样确实能重启恢复，但会把临时执行节奏和长期计划混在同一种格式里。`,
    naiveCode: `await writeFile("tasks.json", JSON.stringify(currentTodos));`,
    failures: [
      {
        term: "身份不稳定",
        description: "长期 task 需要 group_id/task_id，不能依赖数组下标。",
      },
      {
        term: "派生状态漂移",
        description:
          "ready/blocked 应由依赖计算得出，落盘后可能和真实状态不一致。",
      },
      {
        term: "索引损坏不可恢复",
        description: "index.json 应是可重建索引，不应成为唯一事实来源。",
      },
    ],
    loopDetail:
      "Task 通过工具暴露给模型：模型可以创建和更新长期计划；当前 active task group 可通过 reminder 影响本轮执行，但存储事实来自磁盘。",
    figure: {
      alt: "Task Group 持久化布局",
      accent: "TaskStore",
      rows: [
        ["Task Tools", "→", "TaskManager", "→", "TaskStore"],
        ["group.json", "→", "index.json", "→", "rebuildable"],
        ["active group", "→", "Reminder", "→", "Agent Loop"],
      ],
      caption: "图 12-1 · group.json 是事实，index.json 是可重建派生索引。",
    },
    walkthrough: [
      `用户要求创建一个长期计划。`,
      `LLM 调用 task group create 工具。`,
      `TaskManager 校验 group 标题、projectKey 和任务初始状态。`,
      `TaskStore 写入 ${inlineCode("groups/<group_id>/group.json")}，并更新 index.json。`,
      `用户继续添加依赖任务，TaskManager 检查依赖是否存在且无环。`,
      `下一次启动时，TaskStore 扫描 group.json，可重建 index。`,
      `Agent 当前会话只通过 active group reminder 获得需要执行的上下文。`,
    ],
    interfaceCode: `interface TaskGroup {
  groupId: string;
  projectKey: string;
  title: string;
  tasks: TaskItem[];
}

interface TaskItem {
  id: string;
  title: string;
  status: "pending" | "in_progress" | "completed" | "cancelled";
  dependsOn: string[];
}

// ready/blocked 由 dependsOn 和 status 推导，不直接落盘。`,
    sources: [
      { path: "src/task-store.ts", note: "Task 持久化和索引重建" },
      { path: "src/tasks.ts", note: "Task 业务状态机" },
      { path: "src/tools/tasks.ts", note: "Task 工具 provider" },
      { path: "src/task-store.test.ts", note: "存储校验测试" },
      { path: "src/tasks.test.ts", note: "依赖和状态测试" },
    ],
    design: [
      `长期任务的关键是身份和可恢复性。文件名、group_id 和内容里的身份必须一致，否则未来清理、索引重建和审计都会出错。`,
      `把 ready/blocked 这类派生状态留在计算层，可以避免存储多年后出现“看起来 blocked 但依赖已完成”的漂移。`,
    ],
    split: [
      {
        term: "TaskStore",
        description: "负责文件布局、JSON 校验、原子写和索引重建。",
      },
      {
        term: "TaskManager",
        description: "负责状态机、依赖图和 active group。",
      },
      {
        term: "Task tools",
        description: "给模型暴露 create/list/read/add/update/delete 能力。",
      },
    ],
    stateBoundary: [
      {
        term: "持久化事实",
        description: "TaskGroup、TaskItem、依赖关系和显式状态。",
      },
      {
        term: "派生状态",
        description: "ready/blocked、列表排序、active 摘要。",
      },
      {
        term: "session-local",
        description: "当前 active group 的 reminder 和正在执行的 TODO。",
      },
    ],
    prompt: {
      goal: "实现 Persistent Task Group，让 agent 能跨会话保存长期项目计划。",
      scene:
        "用户创建多天任务计划时，agent 用 Task 工具落盘 group 和 task，并能重启后读取。",
      modules: "task-store.ts、tasks.ts、tools/tasks.ts、tests。",
      wiring:
        "composition root 创建 TaskStore/TaskManager，注册 Task 工具，active group 进入 reminder。",
      boundary: "不要复用 TODO 格式；ready/blocked 不落盘；index 必须可重建。",
      cases: "group_id 不匹配、依赖不存在、依赖成环、删除 task 后依赖收敛。",
      validation: "测试创建、更新、依赖、索引重建和坏 JSON 拒绝。",
      sources: "src/task-store.ts、src/tasks.ts、src/tools/tasks.ts。",
      docs: "说明 Task 是长期计划，TODO 是短期节奏。",
    },
    trap: {
      mistake: "把 ready/blocked 直接写进 group.json。",
      why: "派生状态会随依赖变化而漂移，落盘后很难保持一致。",
      fix: "只保存事实状态，读取时重新计算派生状态。",
      verify:
        "修改依赖状态后，ready/blocked 自动变化且 group.json 不记录它们。",
    },
    traps: [
      "用数组下标当 task id。",
      "index.json 损坏后无法恢复。",
      "Task 和 TODO 互相覆盖状态。",
    ],
    validation: {
      manual: "创建带依赖的 group，重启后读取，确认依赖和状态仍在。",
      deterministic: "TaskStore 坏文件、id 不匹配、索引重建测试。",
      integration: "Task 工具返回 active group reminder。",
      failure: "删除 index.json 后任务列表全部丢失。",
    },
    verifyItems: [
      `${inlineCode("src/task-store.test.ts")} 覆盖持久化。`,
      `${inlineCode("src/tasks.test.ts")} 覆盖业务状态机。`,
      `${inlineCode("src/tools/tasks.test.ts")} 覆盖工具层。`,
    ],
    debug: [
      "检查 group_id 是否同时匹配目录名和内容。",
      "检查依赖图是否有环。",
      "检查 index 是否可从 group.json 重建。",
      "检查 active group 是否只是会话状态。",
    ],
    summary: [
      "本章让长期计划可持久化。下一章处理另一种长期任务形态：正在后台运行、不阻塞主 loop 的执行实例。",
    ],
    next: ["下一章进入 Async Run。"],
  }),
  makeChapter({
    id: "13-async-run",
    number: "13",
    filename: "13-async-run.html",
    eyebrow: "第 13 章 · 不阻塞主循环",
    title: "不阻塞主循环：Async Run",
    lede: "有些命令、子任务或分析需要后台执行。Async Run 让 agent 启动非阻塞运行实例，同时继续与用户对话。",
    coreConcept: "Async Run",
    loopFocus:
      "工具执行层启动后台实例，结果通过 notification/reminder 回到后续 turn",
    known: `你已经有同步工具和 SubAgent。Async Run 不是长期 Task，也不是 Schedule，它是当前运行期里的后台执行实例。`,
    scene: [
      `用户说：“先跑完整测试，期间帮我继续看权限代码。”完整测试可能跑很久，主 agent 不应该卡住等待。`,
      `Async Run 让 agent 启动一个后台命令或子智能体，返回 run_id；之后可以 check/list/readOutput，并在完成时通过 reminder 通知主 loop。`,
    ],
    naive: `朴素方案是直接 await 长命令，直到它结束再回复用户。`,
    naiveCode: `const output = await runBash("npm test");
return output; // 用户在测试期间无法继续交互`,
    failures: [
      {
        term: "主循环阻塞",
        description: "用户无法继续下达任务，agent 也无法并行分析。",
      },
      {
        term: "终态竞争",
        description: "timeout 后 late result 可能覆盖已经结束的状态。",
      },
      {
        term: "前后台冲突",
        description: "后台正在读取或测试文件时，前台写操作可能让结果无意义。",
      },
    ],
    loopDetail:
      "Async Run 启动后立即返回 run_id；后台完成时进入 notification 队列，下一轮构建 messages 时以 reminder 注入。",
    figure: {
      alt: "Async Run 非阻塞流程",
      accent: "AsyncRunManager",
      rows: [
        ["Agent Tool", "→", "AsyncRunManager", "→", "run_id"],
        [
          "Background Executor",
          "→",
          "finished/failed/timeout",
          "→",
          "Notification",
        ],
        ["Next Turn", "→", "Reminder", "→", "User-visible status"],
      ],
      caption: "图 13-1 · Async Run 是运行实例，不是持久化计划。",
    },
    walkthrough: [
      `LLM 调用 async_start，要求后台运行测试。`,
      `AsyncRunManager 创建 run_id 和 running 状态。`,
      `后台 executor 开始执行 command 或 subagent。`,
      `Agent 立即回复用户 run_id，并继续主 loop。`,
      `用户稍后调用 async_check 或 async_list。`,
      `后台完成后，finishRun 只允许 running 进入终态。`,
      `completion notification 在下一轮以 reminder 告知模型和用户。`,
    ],
    interfaceCode: `type AsyncRunStatus = "running" | "succeeded" | "failed" | "timeout";

interface AsyncRunManager {
  start(input: AsyncRunInput): Promise<{ runId: string }>;
  check(runId: string): AsyncRunSnapshot;
  list(): AsyncRunSnapshot[];
  readOutput(runId: string): Promise<string>;
  drainNotifications(): AsyncRunNotification[];
}`,
    sources: [
      { path: "src/async-runs.ts", note: "Async Run 核心状态机" },
      { path: "src/tools/async-runs.ts", note: "Async Run 工具 provider" },
      { path: "src/async-runs.test.ts", note: "后台运行状态测试" },
      { path: "src/execution-policy.ts", note: "非交互执行边界" },
      { path: "src/session-events.ts", note: "完成通知注入" },
    ],
    design: [
      `Async Run 让“等待”变成可管理状态。它不是让 agent 无限并发，而是把后台执行的生命周期显式化。`,
      `终态只允许从 running 收敛，是为了防止 timeout 后迟到的输出覆盖最终状态。`,
    ],
    split: [
      {
        term: "AsyncRunManager",
        description: "管理 run_id、状态机、输出和通知。",
      },
      {
        term: "Executor",
        description: "实际执行 command 或 subagent，并把结果交回 manager。",
      },
      {
        term: "Async tools",
        description: "提供 start/check/list/output_read 给模型调用。",
      },
    ],
    stateBoundary: [
      {
        term: "session-local",
        description: "run 实例、running 状态和通知队列。",
      },
      {
        term: "output store",
        description: "长输出可以通过 handle 读取，不直接塞进 messages。",
      },
      { term: "非持久化", description: "当前 Async Run 不承诺跨重启恢复。" },
    ],
    prompt: {
      goal: "实现 Async Run，让 agent 能启动、查询、列出和读取后台运行实例。",
      scene: "长测试或长分析在后台运行，主 agent 能继续响应用户。",
      modules:
        "async-runs.ts、tools/async-runs.ts、execution-policy.ts、session-events.ts。",
      wiring:
        "composition root 创建 AsyncRunManager，注册 async tools，完成通知进入 reminder。",
      boundary:
        "Async Run 不是持久化 Task；后台命令使用非交互 execution policy；终态不可被 late result 覆盖。",
      cases: "timeout、失败、late success、读取不存在 run、前台写冲突。",
      validation: "测试 start/check/list/output_read、终态收敛和通知 drain。",
      sources: "src/async-runs.ts、src/tools/async-runs.ts。",
      docs: "说明 Async Run 是运行实例，不是长期计划。",
    },
    trap: {
      mistake: "timeout 后允许 late result 覆盖状态。",
      why: "用户已经看到 timeout，迟到成功会让审计和后续行为矛盾。",
      fix: "finishRun 只允许 running 进入终态，终态后忽略 late result。",
      verify: "模拟 timeout 后再 finish success，状态仍为 timeout。",
    },
    traps: [
      "后台命令绕过 readonly policy。",
      "把 run 当作跨重启任务恢复。",
      "后台完成通知丢失，模型不知道结果可读。",
    ],
    validation: {
      manual: "启动一个 sleep 或测试命令，期间继续对话，再 check/readOutput。",
      deterministic: "用 fake executor 控制 succeeded/failed/timeout。",
      integration: "完成通知应在下一轮 reminder 中出现。",
      failure: "主 loop 被长命令阻塞，或 timeout 被 late success 覆盖。",
    },
    verifyItems: [
      `${inlineCode("src/async-runs.test.ts")} 覆盖核心。`,
      `${inlineCode("src/tools/async-runs.test.ts")} 覆盖工具层。`,
      "冲突检测测试覆盖前台写与后台 readPaths。",
    ],
    debug: [
      "检查 run_id 是否唯一。",
      "检查状态转移是否只从 running 到终态。",
      "检查 executor 是否使用正确 policy。",
      "检查 notifications 是否 drain 后不重复。",
    ],
    summary: [
      "本章让 agent 能后台运行。下一章会让后台运行被时间触发：Schedule。",
    ],
    next: ["下一章进入 Schedule。"],
  }),
  makeChapter({
    id: "14-schedule",
    number: "14",
    filename: "14-schedule.html",
    eyebrow: "第 14 章 · 让时间触发 Agent",
    title: "让时间触发 Agent：Schedule",
    lede: "Schedule 把长期定时规则和实际执行分开：规则持久化，触发时创建 occurrence，真正运行交给 Async Run。",
    coreConcept: "Schedule",
    loopFocus:
      "Agent 主动对话之外，由 tick 根据时间规则创建 Async Run 并注入通知",
    known: `你已经有 Persistent Task 和 Async Run。Schedule 不是另一个执行器，它只是“什么时候启动一次任务”的长期规则。`,
    scene: [
      `用户说：“每天早上 9 点检查测试结果，每周五生成一份状态报告。”这些需求不能靠用户每次手动输入。`,
      `Schedule 持久化规则；每次到期产生 occurrence；occurrence 触发 Async Run；完成后通知主 session。`,
    ],
    naive: `朴素方案是在 Schedule 里直接运行命令并维护 running/succeeded/failed。`,
    naiveCode: `if (now >= schedule.nextRunAt) {
  schedule.status = "running";
  schedule.output = await runTask(schedule.prompt);
}`,
    failures: [
      {
        term: "第二套执行生命周期",
        description:
          "Schedule 自己管理 running/timeout，会和 Async Run 重复且不一致。",
      },
      {
        term: "重启收敛困难",
        description:
          "进程死掉后 running occurrence 必须能被识别为 orphaned 并收敛。",
      },
      {
        term: "时间规则陷阱",
        description:
          "timezone、DST、monthly clamp 都会让“下次执行”不只是加毫秒。",
      },
    ],
    loopDetail:
      "Schedule 的 tick 不在普通用户 turn 内触发，但触发结果最终通过 Async Run notification/reminder 回到 agent loop。",
    figure: {
      alt: "Schedule 触发 Async Run",
      accent: "Schedule",
      rows: [
        ["Schedule Rule", "→", "tick(now)", "→", "Occurrence"],
        ["Occurrence", "→", "Async Run", "→", "run_id"],
        ["Completion", "→", "Notification", "→", "Next Turn"],
      ],
      caption:
        "图 14-1 · Schedule 只管时间和审计，执行生命周期交给 Async Run。",
    },
    walkthrough: [
      `用户创建 daily schedule，指定 prompt、timezone 和 overlapPolicy。`,
      `ScheduleStore 持久化 schedule 和 nextRunAt。`,
      `后台 tick 扫描当前项目可触发 schedule。`,
      `到期后创建 occurrence，记录触发时间和 prompt snapshot。`,
      `ScheduleManager 调用 AsyncRunManager start。`,
      `Async Run 完成后，occurrence 进入 succeeded/failed。`,
      `主 loop 下一轮看到 schedule 完成提醒。`,
    ],
    interfaceCode: `interface Schedule {
  id: string;
  projectKey: string;
  prompt: string;
  rrule: string;
  timezone: string;
  overlapPolicy: "skip" | "allow";
  nextRunAt: string;
}

interface Occurrence {
  id: string;
  scheduleId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "orphaned";
}`,
    sources: [
      { path: "src/schedule-store.ts", note: "Schedule 持久化" },
      { path: "src/schedules.ts", note: "tick、occurrence 和 Async Run 接线" },
      { path: "src/tools/schedules.ts", note: "Schedule 工具 provider" },
      { path: "src/schedules.test.ts", note: "时间触发测试" },
      { path: "src/async-runs.ts", note: "实际执行生命周期" },
    ],
    design: [
      `Schedule 的核心克制是“不执行”。它只决定某个时间点应该启动什么，执行交给已有 Async Run，这样生命周期和输出读取都复用同一套机制。`,
      `occurrence 是审计记录：同一个 schedule 每次触发都要留下独立事实，便于解释、重试和清理。`,
    ],
    split: [
      { term: "ScheduleStore", description: "保存规则、occurrence 和索引。" },
      {
        term: "ScheduleManager",
        description: "计算到期、处理 overlap、启动 Async Run。",
      },
      { term: "AsyncRunManager", description: "负责实际执行和输出。" },
    ],
    stateBoundary: [
      { term: "持久化", description: "schedule 规则、occurrence 审计记录。" },
      { term: "运行态", description: "Async Run 实例和通知队列。" },
      {
        term: "项目边界",
        description: "当前项目 manager 只触发当前 projectKey 的 schedule。",
      },
    ],
    prompt: {
      goal: "实现 Schedule 定时系统，让规则持久化，到期时创建 occurrence 并启动 Async Run。",
      scene: "用户创建每天或每周运行的 agent prompt，系统在 tick 时触发。",
      modules:
        "schedule-store.ts、schedules.ts、tools/schedules.ts、async-runs.ts。",
      wiring:
        "ScheduleManager 注入 AsyncRunManager；tick 到期时 start async run；完成通知进入 session events。",
      boundary:
        "Schedule 不实现第二套执行生命周期；当前项目只触发自己的 schedule。",
      cases:
        "overlap allow/skip、orphaned running、timezone、DST、monthly clamp。",
      validation:
        "测试 create/list/read/cancel/delete、tick 触发、重启收敛和 overlap。",
      sources:
        "src/schedule-store.ts、src/schedules.ts、src/tools/schedules.ts。",
      docs: "说明 Schedule 是时间规则，Async Run 是执行实例。",
    },
    trap: {
      mistake: "让 Schedule 自己执行命令并保存输出。",
      why: "会产生第二套 running/timeout/output 生命周期，和 Async Run 不一致。",
      fix: "Schedule 只创建 occurrence，并委托 Async Run 执行。",
      verify:
        "tick 后应该有 occurrence + async run，而不是 schedule 自己带 output。",
    },
    traps: [
      "重启后旧 running occurrence 不收敛。",
      "跨项目 schedule 被当前项目 tick 误触发。",
      "overlapPolicy 语义不清导致重复运行。",
    ],
    validation: {
      manual:
        "创建一个短间隔 schedule，等待 tick 后查看 occurrence 和 async run。",
      deterministic: "用 fake clock 测试 nextRunAt 和 overlap。",
      integration: "重启 manager 后 orphaned running occurrence 被收敛。",
      failure: "schedule 自己保存执行输出，或 tick 触发了其他项目规则。",
    },
    verifyItems: [
      `${inlineCode("src/schedules.test.ts")} 覆盖业务层。`,
      `${inlineCode("src/schedule-store.test.ts")} 覆盖持久化。`,
      `${inlineCode("src/tools/schedules.test.ts")} 覆盖工具层。`,
    ],
    debug: [
      "检查 projectKey。",
      "检查 nextRunAt 计算。",
      "检查 occurrence 和 run_id 关联。",
      "检查 overlapPolicy 分支。",
    ],
    summary: [
      "本章让 agent 能被时间唤醒。下一章从长期运行角度收束：数据会增长、文件可能损坏、日志会膨胀，系统需要鲁棒性设计。",
    ],
    next: ["下一章进入 Runtime Hardening。"],
  }),
);

const chapterOrder = [
  "02-tools",
  "03-todo",
  "04-subagent",
  "05-skill",
  "06-compress",
  "07-permission",
  "08-hook",
  "09-memory",
  "10-cache",
  "11-recovery",
  "12-task",
  "13-async-run",
  "14-schedule",
  "15-hardening",
  "model-policy",
  "eval",
  "reference",
];

const orderIndex = new Map(chapterOrder.map((id, index) => [id, index]));
const orderedChapters = [...chapters].sort((a, b) => {
  return (orderIndex.get(a.id) ?? 999) - (orderIndex.get(b.id) ?? 999);
});

await mkdir(chaptersDir, { recursive: true });

for (const chapter of orderedChapters) {
  const filePath = resolve(chaptersDir, chapter.filename);
  await writeFile(filePath, renderChapter(chapter), "utf8");
  console.log(`generated ${chapter.filename}`);
}
