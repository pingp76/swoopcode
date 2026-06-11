import { chapters, defaultChapterId, navGroups } from "./content.js";

// 这个文件刻意不用框架，先把教程站点的交互边界做清楚：
// - 左侧章节导航由 content.js 的元数据渲染，避免每个页面重复维护。
// - 中间正文从 chapters/*.html 拉取，方便作者直接修改长文内容。
// - 右侧页内目录从正文标题自动生成，避免正文改了但目录忘记同步。
// - 左右侧栏显隐、独立滚动、平滑锚点滚动复刻 web/temp/2 的样张行为。
//
// 这不是最终站点框架的绑定选择。它更像一块“交互样板”：未来迁移到
// VitePress/Astro 时，可以把这里的行为拆成 layout/component。

const STORAGE_KEY = "swoopcode.tutorial.sidebar.v1";
const article = document.querySelector(".article");
const articleRoot = document.querySelector("#article-root");
const chapterNav = document.querySelector("#chapter-nav");
const pageToc = document.querySelector("#page-toc");
const layout = document.querySelector("[data-layout]");

function readCurrentChapterId() {
  const params = new URLSearchParams(window.location.search);
  const requested = params.get("chapter");
  if (requested && chapters[requested]) return requested;
  return defaultChapterId;
}

function buildChapterUrl(id) {
  const params = new URLSearchParams(window.location.search);
  params.set("chapter", id);
  params.delete("reset");
  const query = params.toString();
  return query ? `./?${query}` : "./";
}

function orderedChapterIds() {
  return navGroups.flatMap((group) => group.items);
}

function findAdjacentChapter(currentId, direction) {
  const ids = orderedChapterIds();
  const currentIndex = ids.indexOf(currentId);
  if (currentIndex === -1) return null;

  const nextIndex = currentIndex + direction;
  if (nextIndex < 0 || nextIndex >= ids.length) return null;

  const id = ids[nextIndex];
  const chapter = chapters[id];
  if (!chapter) return null;

  return { id, chapter };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderChapterNav(currentId) {
  if (!chapterNav) return;

  const groupsHtml = navGroups
    .map((group) => {
      const itemsHtml = group.items
        .map((id) => {
          const chapter = chapters[id];
          if (!chapter) return "";
          const classes = [
            id === currentId ? "is-current" : "",
            chapter.ready ? "" : "is-pending",
          ]
            .filter(Boolean)
            .join(" ");
          const label = `
            <span class="chapter-num">${escapeHtml(chapter.number)}</span>
            <span class="chapter-title">${escapeHtml(chapter.navTitle)}</span>
          `;

          if (!chapter.ready) {
            return `<li class="${classes}"><span class="chapter-link chapter-link--disabled" title="后续章节占位">${label}</span></li>`;
          }

          return `<li class="${classes}"><a class="chapter-link" href="${buildChapterUrl(id)}">${label}</a></li>`;
        })
        .join("");

      return `
        <p class="sidebar__heading">${escapeHtml(group.heading)}</p>
        <ol class="chapter-list ${group.id !== "main" ? "chapter-list--flat" : ""}">
          ${itemsHtml}
        </ol>
      `;
    })
    .join("");

  chapterNav.innerHTML = groupsHtml;
}

function renderPlaceholderChapter(chapter) {
  const label = chapter.group === "topic" ? "专题占位" : "章节占位";
  return `
    <p class="article__eyebrow">${escapeHtml(label)} · 尚未展开</p>
    <h1 class="article__title">${escapeHtml(chapter.title)}</h1>
    <p class="article__lede">这一页已经放进导航，正文会在后续生成。当前第一版先专注校准第 00 章和第 01 章的内容、视觉节奏和交互。</p>
    <hr class="rule" />
    <h2 id="why-placeholder">为什么先占位</h2>
    <p>完整教程会沿着 agent loop 一章一章长出来。先保留后续入口，可以让你在调整视觉时提前看到整套课程的导航密度。</p>
  `;
}

function renderPagerItem(adjacent, label, disabledReason) {
  if (!adjacent) {
    return `
      <span class="article-pager__item article-pager__item--disabled">
        <span class="article-pager__label">${label}</span>
        <span class="article-pager__title">${disabledReason}</span>
      </span>
    `;
  }

  const { id, chapter } = adjacent;
  const title = `${chapter.number} · ${chapter.navTitle}`;
  if (!chapter.ready) {
    return `
      <span class="article-pager__item article-pager__item--disabled">
        <span class="article-pager__label">${label}</span>
        <span class="article-pager__title">${escapeHtml(title)} · 尚未生成</span>
      </span>
    `;
  }

  return `
    <a class="article-pager__item" href="${buildChapterUrl(id)}">
      <span class="article-pager__label">${label}</span>
      <span class="article-pager__title">${escapeHtml(title)}</span>
    </a>
  `;
}

function renderArticlePager(currentId) {
  if (!articleRoot) return;

  // 章节正文是独立 HTML 片段，底部“上一章 / 下一章”属于站点框架能力。
  // 放在这里统一生成有两个好处：
  // 1. 后续批量生成章节时不用在每个 HTML 文件末尾重复粘贴导航。
  // 2. 导航顺序只信任 content.js 的章节清单，避免正文文件和侧栏章节顺序漂移。
  articleRoot.querySelector(".article-pager")?.remove();

  const previous = findAdjacentChapter(currentId, -1);
  const next = findAdjacentChapter(currentId, 1);
  const pager = document.createElement("nav");
  pager.className = "article-pager";
  pager.setAttribute("aria-label", "章节翻页");
  pager.innerHTML = `
    ${renderPagerItem(previous, "上一章", "已经是第一章")}
    ${renderPagerItem(next, "下一章", "已经是最后一章")}
  `;
  articleRoot.append(pager);
}

async function loadChapter(id) {
  const chapter = chapters[id] ?? chapters[defaultChapterId];
  if (!chapter || !articleRoot) return;

  document.title = `${chapter.number} · ${chapter.title} · swoopcode`;

  if (!chapter.ready || !chapter.file) {
    articleRoot.innerHTML = renderPlaceholderChapter(chapter);
    afterArticleRendered(id);
    return;
  }

  try {
    const response = await fetch(chapter.file, { cache: "no-cache" });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    articleRoot.innerHTML = await response.text();
  } catch (error) {
    // fetch 在 file:// 下通常会失败，所以这里给出面向学生的提示。
    // 教程设计目标是“本地 web 服务阅读”，不是直接双击 HTML。
    articleRoot.innerHTML = `
      <p class="article__eyebrow">载入失败</p>
      <h1 class="article__title">${escapeHtml(chapter.title)}</h1>
      <p class="article__lede">没有成功读取章节 HTML。请使用 <code>npm run tutorial:dev</code> 启动本地服务后再访问。</p>
      <pre class="code-block"><code>${escapeHtml(String(error))}</code></pre>
    `;
  }

  afterArticleRendered(id);
}

function afterArticleRendered(currentId) {
  renderArticlePager(currentId);
  renderChapterNav(currentId);
  updateTopNav(currentId);
  buildPageToc();
  bindInPageLinks();
  bindCopyButtons();
  highlightAllCodeBlocks(articleRoot);

  if (article) {
    article.scrollTop = 0;
    if (window.location.hash) {
      requestAnimationFrame(() => {
        const target = document.getElementById(window.location.hash.slice(1));
        if (target) scrollArticleToTarget(target, { animated: false });
      });
    }
    article.addEventListener("scroll", syncActiveSection, { passive: true });
  }

  syncActiveSection();
}

function updateTopNav(currentId) {
  const activeGroup = chapters[currentId]?.group ?? "main";
  document.querySelectorAll(".site-nav a").forEach((link) => {
    link.removeAttribute("aria-current");
    const href = link.getAttribute("href") ?? "";
    if (activeGroup === "main" && href === "./") {
      link.setAttribute("aria-current", "page");
    }
    if (currentId === "model-policy" && href.includes("model-policy")) {
      link.setAttribute("aria-current", "page");
    }
    if (currentId === "eval" && href.includes("eval")) {
      link.setAttribute("aria-current", "page");
    }
    if (currentId === "reference" && href.includes("reference")) {
      link.setAttribute("aria-current", "page");
    }
  });
}

function collectHeadings() {
  if (!articleRoot) return [];
  return Array.from(articleRoot.querySelectorAll("h2[id], h3[id]"));
}

function buildPageToc() {
  const headings = collectHeadings();
  if (!pageToc) return;

  if (headings.length === 0) {
    pageToc.innerHTML = `<span class="toc__empty">本页暂无小节</span>`;
    return;
  }

  pageToc.innerHTML = headings
    .map((heading) => {
      const depth =
        heading.tagName.toLowerCase() === "h3" ? "toc__link--sub" : "";
      return `<a class="toc__link ${depth}" href="#${heading.id}">${escapeHtml(heading.textContent ?? "")}</a>`;
    })
    .join("");

  const inlineToc = articleRoot?.querySelector("#article-inline-toc");
  if (inlineToc) {
    inlineToc.innerHTML = headings
      .filter((heading) => heading.tagName.toLowerCase() === "h2")
      .map(
        (heading) =>
          `<a href="#${heading.id}">${escapeHtml(heading.textContent ?? "")}</a>`,
      )
      .join("");
  }
}

function prefersReducedMotion() {
  return (
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false
  );
}

function easeOutCubic(t) {
  const p = 1 - t;
  return 1 - p * p * p;
}

let runningScrollFrame = null;

function cancelRunningScroll() {
  if (runningScrollFrame != null) {
    cancelAnimationFrame(runningScrollFrame);
    runningScrollFrame = null;
  }
}

function animateArticleScroll(targetTop) {
  if (!article) return;
  cancelRunningScroll();

  const startTop = article.scrollTop;
  const distance = Math.abs(startTop - targetTop);
  if (distance < 2) return;

  const duration = Math.min(600, Math.max(240, distance * 0.4));
  let startTime = null;

  function step(now) {
    if (startTime == null) startTime = now;
    const progress = Math.min(1, (now - startTime) / duration);
    article.scrollTop =
      startTop + (targetTop - startTop) * easeOutCubic(progress);
    if (progress < 1) {
      runningScrollFrame = requestAnimationFrame(step);
    } else {
      runningScrollFrame = null;
    }
  }

  runningScrollFrame = requestAnimationFrame(step);
}

function scrollArticleToTarget(target, options = { animated: true }) {
  if (!article) return;
  const targetTop = Math.max(0, target.offsetTop - article.offsetTop - 24);
  if (!options.animated || prefersReducedMotion()) {
    article.scrollTop = targetTop;
    return;
  }
  animateArticleScroll(targetTop);
}

function bindInPageLinks() {
  const links = document.querySelectorAll(
    ".toc a[href^='#'], .article__meta a[href^='#']",
  );
  links.forEach((link) => {
    link.addEventListener("click", (event) => {
      const hash = link.getAttribute("href");
      if (!hash || hash.length < 2) return;
      const target = document.getElementById(hash.slice(1));
      if (!target) return;

      event.preventDefault();
      scrollArticleToTarget(target);

      // 保留 query 参数，只替换 hash。这样 ?chapter=01-agent-loop 与页内锚点可以共存。
      window.history.replaceState(
        null,
        "",
        `${window.location.pathname}${window.location.search}${hash}`,
      );
      syncActiveSection();
    });
  });
}

function syncActiveSection() {
  const headings = collectHeadings();
  const tocLinks = Array.from(document.querySelectorAll(".toc a"));
  if (!article || headings.length === 0 || tocLinks.length === 0) return;

  const currentTop = article.scrollTop + 80;
  let current = headings[0];
  for (const heading of headings) {
    const headingTop = heading.offsetTop - article.offsetTop;
    if (headingTop <= currentTop) current = heading;
  }

  tocLinks.forEach((link) => {
    const href = link.getAttribute("href");
    link.toggleAttribute("aria-current", href === `#${current?.id}`);
  });
}

function bindCopyButtons() {
  const buttons = document.querySelectorAll("[data-copy-card]");
  buttons.forEach((button) => {
    button.addEventListener("click", async () => {
      const card = button.closest(".card");
      const body = card?.querySelector(".card__body");
      const text = body?.innerText?.trim();
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
        flashCopyButton(button, "已复制");
      } catch {
        fallbackCopyText(text);
        flashCopyButton(button, "已复制");
      }
    });
  });
}

function fallbackCopyText(text) {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function flashCopyButton(button, label) {
  const original = button.textContent;
  button.textContent = label;
  window.setTimeout(() => {
    button.textContent = original;
  }, 1200);
}

function readCollapseOverride() {
  const raw = new URLSearchParams(window.location.search).get("collapse");
  if (raw === "left") return { left: false, right: true };
  if (raw === "right") return { left: true, right: false };
  if (raw === "both") return { left: false, right: false };
  if (raw === "none") return { left: true, right: true };
  return null;
}

function readSavedLayoutState() {
  if (new URLSearchParams(window.location.search).get("reset") === "1") {
    sessionStorage.removeItem(STORAGE_KEY);
  }

  const override = readCollapseOverride();
  if (override) return override;

  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
}

function saveLayoutState(side, open) {
  try {
    const current =
      JSON.parse(sessionStorage.getItem(STORAGE_KEY) || "{}") || {};
    current[side] = open;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // sessionStorage 可能被隐私设置禁用；禁用时只影响刷新后状态保持，不影响当前交互。
  }
}

function applySidebarState(side, open) {
  const sidebar = document.querySelector(`[data-sidebar="${side}"]`);
  const button = document.querySelector(`[data-toggle="${side}"]`);
  if (!sidebar || !button || !layout) return;

  sidebar.setAttribute("data-collapsed", open ? "false" : "true");
  sidebar.setAttribute("aria-hidden", open ? "false" : "true");
  button.setAttribute("aria-expanded", open ? "true" : "false");

  const layoutAttr =
    side === "left" ? "data-left-collapsed" : "data-right-collapsed";
  layout.setAttribute(layoutAttr, open ? "false" : "true");

  const icon = button.querySelector("[aria-hidden='true']");
  if (icon) {
    if (side === "left") {
      icon.textContent = open ? "‹" : "›";
    } else {
      icon.textContent = open ? "›" : "‹";
    }
  }

  const label = side === "left" ? "章节目录" : "本页小节";
  const verb = open ? "隐藏" : "显示";
  button.setAttribute("aria-label", `${verb}${label}`);
  button.setAttribute("title", `${verb}${label}`);
}

function initializeSidebarLayout() {
  const saved = readSavedLayoutState();
  applySidebarState("left", saved.left !== false);
  applySidebarState("right", saved.right !== false);

  document.querySelectorAll("[data-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const side = button.getAttribute("data-toggle");
      if (side !== "left" && side !== "right") return;

      const sidebar = document.querySelector(`[data-sidebar="${side}"]`);
      const isOpen = sidebar?.getAttribute("data-collapsed") !== "true";
      const nextOpen = !isOpen;
      applySidebarState(side, nextOpen);
      saveLayoutState(side, nextOpen);
    });
  });
}

// ============================================================
// 代码块语法高亮 (TS/JS, 运行时零依赖)
// ------------------------------------------------------------
// 设计取舍:
// - 不引入 highlight.js / shiki, 保持 "零依赖 + 零网络" 承诺。
// - 识别 6 类 token: 关键字 / 字符串 / 数字 / 注释 / 接口名 / 类型名。
// - 输入是已经 HTML 转义的字符串 (代码块写在 .html 里, < > & 已是实体),
//   所以第一步反转义, 高亮后再转义回去, 避免把代码误识别为 HTML。
// - 只处理 <pre class="code-block"><code>...</code></pre>, 不动行内 <code>。
// ============================================================

const TS_KEYWORDS = new Set([
  // 控制流
  "if",
  "else",
  "for",
  "while",
  "do",
  "switch",
  "case",
  "default",
  "break",
  "continue",
  "return",
  "throw",
  "try",
  "catch",
  "finally",
  // 声明
  "const",
  "let",
  "var",
  "function",
  "class",
  "extends",
  "implements",
  "interface",
  "type",
  "enum",
  "namespace",
  "module",
  "declare",
  "import",
  "export",
  "from",
  "as",
  "default",
  // 运算符 / 字面量
  "new",
  "delete",
  "typeof",
  "instanceof",
  "in",
  "of",
  "void",
  "this",
  "super",
  "yield",
  "async",
  "await",
  "static",
  "get",
  "set",
  // 字面量
  "true",
  "false",
  "null",
  "undefined",
  // TS 特有
  "public",
  "private",
  "protected",
  "readonly",
  "abstract",
  "keyof",
  "infer",
  "is",
  "satisfies",
  "never",
  "unknown",
  "any",
]);

const TS_BUILTIN_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "bigint",
  "symbol",
  "object",
  "Array",
  "Map",
  "Set",
  "Record",
  "Partial",
  "Readonly",
  "Promise",
  "Date",
  "RegExp",
  "Error",
  "void",
  "never",
  "unknown",
  "any",
]);

function unescapeHtmlEntities(input) {
  return input
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function escapeHtmlEntities(input) {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function highlightTokens(source) {
  // 状态机: 普通 / 行注释 / 块注释 / 字符串 / 模板字符串
  let out = "";
  let i = 0;
  const len = source.length;

  function push(text, cls) {
    if (!text) return;
    out += cls
      ? `<span class="tok-${cls}">${escapeHtmlEntities(text)}</span>`
      : escapeHtmlEntities(text);
  }

  function isIdStart(ch) {
    return /[A-Za-z_$]/.test(ch);
  }
  function isIdPart(ch) {
    return /[A-Za-z0-9_$]/.test(ch);
  }

  while (i < len) {
    const ch = source[i];
    const next = source[i + 1];

    // 行注释
    if (ch === "/" && next === "/") {
      let j = i;
      while (j < len && source[j] !== "\n") j++;
      push(source.slice(i, j), "comment");
      i = j;
      continue;
    }

    // 块注释
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < len - 1 && !(source[j] === "*" && source[j + 1] === "/")) j++;
      j = Math.min(len, j + 2);
      push(source.slice(i, j), "comment");
      i = j;
      continue;
    }

    // 字符串 (单引号 / 双引号)
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      while (j < len && source[j] !== quote) {
        if (source[j] === "\\") j += 2;
        else if (source[j] === "\n") break;
        else j++;
      }
      j = Math.min(len, j + 1);
      push(source.slice(i, j), "string");
      i = j;
      continue;
    }

    // 模板字符串 (允许 ${...} 嵌套, 简单版本: 找到匹配的 `)
    if (ch === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < len) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === "$" && source[j + 1] === "{") {
          depth++;
          j += 2;
          continue;
        }
        if (source[j] === "}" && depth > 0) {
          depth--;
          j++;
          continue;
        }
        if (source[j] === "`" && depth === 0) {
          j++;
          break;
        }
        j++;
      }
      push(source.slice(i, j), "string");
      i = j;
      continue;
    }

    // 数字 (含 0x / 0b / 0o / 小数 / 指数)
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next))) {
      let j = i;
      if (source[j] === "0" && /[xXbBoO]/.test(source[j + 1])) {
        j += 2;
        while (j < len && /[0-9a-fA-F_]/.test(source[j])) j++;
      } else {
        while (j < len && /[0-9_]/.test(source[j])) j++;
        if (source[j] === ".") j++;
        while (j < len && /[0-9_]/.test(source[j])) j++;
        if (source[j] === "e" || source[j] === "E") {
          j++;
          if (source[j] === "+" || source[j] === "-") j++;
          while (j < len && /[0-9_]/.test(source[j])) j++;
        }
      }
      push(source.slice(i, j), "number");
      i = j;
      continue;
    }

    // 标识符
    if (isIdStart(ch)) {
      let j = i;
      while (j < len && isIdPart(source[j])) j++;
      const word = source.slice(i, j);

      // 类型标注位: `:` `=` `(` `,` `<` `[` `!` `?` `{` `&` `|` 之后
      // 才把标识符识别成类型名; interface/type 后的 identifier 一律是类型
      let cls = "";
      if (TS_KEYWORDS.has(word)) {
        cls = "keyword";
      } else if (TS_BUILTIN_TYPES.has(word)) {
        cls = "type";
      } else if (word[0] >= "A" && word[0] <= "Z") {
        // 名字以大写开头的标识符 (PascalCase) 在 TS 习惯上是类型/接口
        cls = "type";
      }

      push(word, cls);
      i = j;
      continue;
    }

    // 其他字符原样输出
    push(ch, "");
    i++;
  }

  return out;
}

function highlightCodeBlock(codeElement) {
  if (codeElement.dataset.highlighted === "true") return;
  codeElement.dataset.highlighted = "true";
  const raw = codeElement.textContent ?? "";
  const source = unescapeHtmlEntities(raw);
  codeElement.innerHTML = highlightTokens(source);
}

function highlightAllCodeBlocks(root) {
  if (!root) return;
  const blocks = root.querySelectorAll("pre.code-block > code");
  blocks.forEach(highlightCodeBlock);
}

initializeSidebarLayout();
renderChapterNav(readCurrentChapterId());
loadChapter(readCurrentChapterId());
