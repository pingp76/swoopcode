# Tutorial 编写指南

> 本文档是 tutorial 章节的编写规范, 任何新写或大改章节都必须先读本文档。
> 适用对象: tutorial/chapters/*.html
> 配套文档: doc/AGENTS.md (项目整体规范), doc/summary.md (已实现状态)

## 目录

1. [目标读者](#目标读者)
2. [整体架构: 4 段式结构](#整体架构-4-段式结构)
3. [章节开头 5 件套](#章节开头-5-件套)
4. [每个 h2 / h3 小节的 4 段式](#每个-h2--h3-小节的-4-段式)
5. [排版规则](#排版规则)
6. [代码块规范](#代码块规范)
7. [GitHub 永久链接规范](#github-永久链接规范)
8. [图表系统](#图表系统)
9. [常见反模式](#常见反模式)
10. [验证 checklist](#验证-checklist)
11. [与其他章节的交叉引用](#与其他章节的交叉引用)
12. [改写现有章节的工作流](#改写现有章节的工作流)
13. [写新章节的工作流](#写新章节的工作流)
14. [完整改写案例: 怎么从混乱版到好版](#完整改写案例-怎么从混乱版到好版)

---

## 目标读者

教学项目的读者是**初学 agent 架构的开发者** (有 TypeScript 基础, 但
没写过 coding agent)。 编写时假设:

- 读者**没看过**相关源码细节, 看到代码示例要先解释
- 读者**会跳过**看起来在讲废话的小节, 关键概念必须前置
- 读者**会回头查**前面看过的概念, 章节内需要互引而不是重复讲

**永远不要**假设读者已经知道"为什么需要这个"。 每个具体技术点
之前, 必须先用 1-2 段讲清"这个问题是什么"。

---

## 整体架构: 4 段式结构

每个章节用 4 段式结构组织 (从上到下):

```
┌────────────────────────────────────────────┐
│ 1. eyebrow + title + lede (5 件套开头)      │  ← 30 秒让读者决定要不要读
├────────────────────────────────────────────┤
│ 2. 真实失败故事                              │  ← 用具体痛点建立"为什么"
├────────────────────────────────────────────┤
│ 3. N 个技术小节 (h2)                         │  ← 每个 h2 用 4 段式
│    - h2.1 场景 → 朴素 → 正确 → 设计 → 实现   │
│    - h2.2 同上                                │
│    - ...                                     │
├────────────────────────────────────────────┤
│ 4. 收尾: 误解 / 反例梯度 / 验证 / 回望 / 前瞻 │  ← 把本章放回全局
│    / Prompt Card / 练习 / 小结               │
└────────────────────────────────────────────┘
```

### 为什么是这个顺序

- **5 件套开头** 先 30 秒让读者"知道这一章讲什么, 跟我有没有关系"。
- **真实失败故事** 用具体痛点建立动机 ("哦原来这问题真的会发生")。
- **N 个技术小节** 是核心内容, 每个小节独立完整, 读者可单独读。
- **收尾** 帮读者把本章放进整体架构, 留练习题 + Prompt Card 让他们自己复现。

---

## 章节开头 5 件套

每章前 14 行固定是这 5 件套, 顺序不能换:

```html
<p class="article__eyebrow">第 05 章 · 一句话主题</p>           <!-- 1 -->
<h1 class="article__title">Skill: 完整标题 (主语 + 做了什么)</h1>  <!-- 2 -->
<p class="article__lede">                                          <!-- 3 -->
  这一章用 1-2 段讲清楚:
  - 上一章讲了什么 + 这一章补什么 ("第 X 章的 Y 解决不了 Z, 这一章加 W")
  - 这一章会给什么能力 (3-5 个 bullet 风格)
  - 读完后读者能讲清什么 (1 句话)
</p>
<nav aria-label="页内小节" class="article__meta" id="article-inline-toc"></nav>  <!-- 4 -->
<hr class="rule"/>                                                 <!-- 5 -->
```

### 5 件套的细节

1. **eyebrow** (`article__eyebrow`): 一句话, 形如 "第 05 章 · 按需加载能力"。
   用一句话点出主题, **不能是章节序号** (序号写在 eyebrow 里), 也不能
   是"本章简介" 这种空话。
2. **title** (`article__title`): 完整标题, 形如 "Skill: 让 Agent 按需激活
   工具子集"。 主语 + 做了什么, **不能** 只是"Skill" (没说什么)。
3. **lede** (`article__lede`): 1-2 段, 三个内容:
   - **承上启下**: 上一章讲了什么 + 这一章补什么 (必须引用上一章,
     不能凭空开讲)
   - **这一章会给什么**: 3-5 个 bullet 风格的能力列表
   - **读完后能讲清什么**: 1 句话, 描述具体能力 ("读完后, 你能讲清
     X 和 Y 的区别")

   lede 长度建议 4-8 句, 太短看不出来章节价值, 太长读者跳过。

4. **inline-toc** (`article__meta` + `id="article-inline-toc"`):
   留空, 由 app.js 渲染章节内 h2 列表。
5. **rule** (`<hr class="rule"/>`): 视觉分割。

### 反例

```html
<!-- ❌ 太短, 没价值 -->
<p class="article__lede">这一章讲 Skill。</p>

<!-- ❌ 没引用上一章, 凭空开讲 -->
<p class="article__lede">Skill 是一个重要概念。</p>

<!-- ❌ 没有"读完后能讲清什么" -->
<p class="article__lede">这一章讲 Skill 的设计, 包括
  frontmatter 格式 + 闭包激活 + 跨 run 共享。</p>
```

---

## 每个 h2 / h3 小节的 4 段式

每个具体技术点 (h2 或 h3) 必须按这个顺序写。 **"用途 / 真实场景 /
设计思想 / 实现细节" 是错的**, 应该改成"场景 → 朴素想法 → 正确做法
→ 设计思想 → 实现细节"。

### 标准 4 段式 (顺序不能换)

```html
<h2 id="xxx">具体技术点名字</h2>

<p><strong>场景: 具体问题是什么</strong></p>
<p>
  1 段讲清"用户/系统遇到了什么问题"。 用具体例子, 不要抽象。
  比如 "团队要挂 3 个扩展..." 而不是 "扩展点很重要"。
</p>

<p><strong>朴素想法 1: 看似能解但实际不行</strong></p>
<p>
  列出 1-2 个"看似合理但实际有坑" 的方案 + 为什么错。
  用具体代码或场景说明。
</p>

<p><strong>朴素想法 2 (可选): 另一个看似能解但实际不行</strong></p>
<p>同上, 可以有 1-2 个朴议案。</p>

<p><strong>正确做法: 高层方案</strong></p>
<p>
  1-2 段讲清"正解是什么", 给具体代码或调用示例。
</p>

<p><strong>设计思想 (可选): 抽象原则</strong></p>
<p>
  把正解提升到模式/原则高度 (比如 "对应 Reference 模式 3 · 依赖注入")。
  不是所有小节都需要这一段, 简单的小节直接跳到实现。
</p>

<p><strong>实现细节 (可选): 完整代码 + 注释</strong></p>
<p>代码 + 4-5 个实现细节 + GitHub 链接。</p>
```

### 反例 (错的写法)

```html
<!-- ❌ "用途/场景/设计" 抽象堆砌 -->
<h2 id="xxx">X 是什么</h2>
<p><strong>用途</strong>: ...</p>
<p><strong>真实场景</strong>: ...</p>
<p><strong>设计思想</strong>: ...</p>

<!-- ❌ 直接上代码, 不讲为什么 -->
<h2 id="xxx">X 实现</h2>
<pre><code>// 20 行代码, 没有铺垫</code></pre>
```

**为什么这种是错的**: 学生上来就看抽象概念, 脑子里"问题" 还没建立就被
灌 4 个名词 ("用途/场景/设计/实现"), 立刻懵。 应该先用具体痛点
建立"为什么", 再讲"怎么解"。

### 4 段式的详细指南

#### 场景: 1 段, 必有

- 必须是**具体故事** (谁, 遇到了什么), 不能是抽象描述
- 包含数字 / 例子 / 失败后果 (让读者能想象画面)
- **不**给解法, 只给问题
- 长度: 2-5 句, 不要短到只有 1 句

#### 朴素想法: 1-2 个, 必有

- 看似合理但实际有坑的方案
- 一定要写出**为什么错** (不是"我不同意", 而是"这个方案会栈溢出
  / 污染 agent / 误报 cache miss")
- 长度: 每个 1-3 段, 不要短到只有 1 句 "错"
- 2 个朴议案的常见组合: "直接 import 循环" + "互相直接调" /
  "字符串 hash" + "JSON.stringify" / "判空 if" + "optional chaining"

#### 正确做法: 1-2 段, 必有

- 高层描述正解, 不直接上代码
- 引出"为什么这个方案解决了前面 1-2 个朴议案的失败"
- 引出图 / 表格 / 类比, 帮助理解

#### 设计思想: 0-1 段, 可选

- 把正解提升到模式/原则高度
- 引用 Reference 章节的对应模式
- 短小精悍, 1-2 句话

#### 实现细节: 0-1 段, 可选

- 完整代码 (注意第 6 节代码块规范)
- 4-6 个"关键细节" bullet
- GitHub 永久链接

### 表格 vs 段落的取舍

能用表格就用表格, 不要写成多段:

| 用表格 | 用段落 |
|---|---|
| 对比 3+ 个选项的差异 | 讲故事 (场景/动机) |
| 列举 N 条并列规则 | 解释"为什么" |
| 列举 N 个属性 / 字段 | 抽象原则 |

### "5 个细节" 模式

技术实现章节经常用 "5 个细节" 模式, 把代码里的 5 个关键点
列成 bullet:

```html
<pre><code>// 完整代码
function example() { ... }
</code></pre>
<p>5 个细节:</p>
<ol>
<li>关键 1</li>
<li>关键 2</li>
<li>关键 3</li>
<li>关键 4</li>
<li>关键 5</li>
</ol>
```

**反例: 不要写 "3 个细节"** (太短) 或 "10 个细节" (太长, 拆成多个章节)。
5 个刚好够, 重要程度递减。

---

## 排版规则

### 1. 标点符号: 中英文混排

- **中文句号**: 全文统一用 `.` (英文句号), 不混用 `。` (中文句号)
- **引号**: 中文 `"..."` (西文双引号), 不混用 `""`
- **冒号**: 列表冒号用 `:`, 段落冒号用 `:` 后接空格
- **顿号**: 用 `、` (中文顿号), 用于列举
- **逗号**: 段落内用 `, ` (英文逗号 + 空格), 不用 `,`

### 2. 空格规则

- **中英文之间加空格**: `memory 模块` 而不是 `memory模块`,
  `用户跑 LLM` 而不是 `用户跑LLM`
- **数字和中文之间加空格**: `3 个 handler` 而不是 `3个handler`
- **数字和英文之间加空格**: `5 token` 而不是 `5token`
- **代码和中文之间加空格**: `function 命名` 而不是 `function命名`
- **中文引号内不空格**: `"个人偏好"和"团队规范"` 而不是
  `"个人偏好" 和 "团队规范"`
- **特殊例外**: `block A` `tool c1` 这种"代码名 + 编号" 形式, 中间
  加空格更易读

### 3. 多条目用 bulleting, 不要挤在一段

**反例 (一行段, 4 个分号)**:

```html
<p>
  真实场景: 用户把"中文回答" 存为 type: user; team 把"PR 用
  conventional commit" 存为 type: feedback; 项目把"用 pnpm" 存
  为 type: project; 用户把"读 README.md 第 3 节" 存为 type:
  reference。 4 类各管一摊。
</p>
```

**正例 (4 个 bullet)**:

```html
<p>真实场景:</p>
<ul>
  <li>用户把"中文回答" 存为 <code>type: user</code></li>
  <li>team 把"PR 用 conventional commit" 存为 <code>type: feedback</code></li>
  <li>项目把"用 pnpm" 存为 <code>type: project</code></li>
  <li>用户把"读 README.md 第 3 节" 存为 <code>type: reference</code></li>
</ul>
<p>4 类各管一摊。</p>
```

**何时用 bullet, 何时用段落**:
- **bullet**: 列举 N 个独立条目, 每个不需要长解释
- **段落**: 解释"为什么" / 讲具体故事 / 描述抽象关系

### 4. 章节名统一用 "块", 不用 "block"

章节内部描述 "block" 类型时, **全文统一用 `block`**, 不用"块"。

例外: 如果引用的变量名 / 字段名 / 英文术语里是 "block", 保留英文。

### 5. 表格用 `<table class="terms">`

3+ 个对比项, 用 `<table class="terms">`, 不要写成多个 `<dl>` 段落。

---

## 代码块规范

### 1. 完整可读, 不要截断

代码块要给**完整可运行**的代码, 不能截断 ("... 表示省略"
是反模式)。 如果代码太长, 拆成多个代码块, 每个独立完整。

### 2. 必须有"上下文注释"

代码块前要有一段说明, 解释这段代码**做什么 + 在哪个文件**:

```html
<p>具体例子: 走一遍 <code>src/cache-debug.ts</code> 的
<code>stableStringify</code>:</p>
<pre class="code-block"><code>// 教学简化版
function stableStringify(value: unknown): string {
  ...
}
</code></pre>
```

### 3. 教学简化版 vs 真实代码

教学版代码应该:
- 简化 (省略 import / 类型导出 / 错误处理)
- 关键逻辑保留
- 加**行注释**解释为什么这么写 (最多 5-8 条, 不要每行都注释)

```html
<pre class="code-block"><code>// 教学简化版 (实际实现见 src/cache-debug.ts sha256)
function sha256(input: string): string {
  // 用 Node 内置 crypto, 不引入外部依赖
  return createHash("sha256")
    .update(input, "utf-8")
    .digest("hex")
    .slice(0, 8);  // 取前 8 位 hex, 调试用
}
</code></pre>
```

### 4. 不要包含完整可运行程序

教学版代码块**不**是完整可运行程序 (没有 import, 没有 main),
是"展示关键逻辑"。 真实可运行代码通过 GitHub 永久链接看。

### 5. 错误代码块: 必须有 "为什么错" + "正确做法"

```html
<pre class="code-block"><code>// ❌ 错的写法
function bad() { ... }

// ✅ 正确写法
function good() { ... }
</code></pre>
<p>错在: ...; 对的: ...</p>
```

---

## GitHub 永久链接规范

每段代码后, 加 GitHub 永久链接, 用 `<p class="source-link">`:

```html
<p class="source-link">
  <a href="https://github.com/pingp76/swoopcode/blob/main/src/foo.ts#L64"
     rel="noreferrer" target="_blank">
    GitHub · src/foo.ts functionName (L64)
  </a>
</p>
```

### 链接格式

- 仓库固定: `https://github.com/pingp76/swoopcode`
- 路径: `blob/main/<src-relative-path>`
- 行号锚点: `#L<line>` (单行) 或 `#L<start>-L<end>` (多行)
- 链接文字: `GitHub · <path> <什么> (L<行号>)`
- 链接放在 `<p class="source-link">` 里, **不**放在 `<pre>` 里

### 错例

- ❌ `https://github.com/pingp76/swoopcode/blob/main/src/foo.ts` (没行号)
- ❌ `GitHub: src/foo.ts (line 64)` (英文冒号, 应是中文)
- ❌ 把链接塞在 `<pre>` 里 (不渲染成链接)

---

## 图表系统

3 种图 (3 个 div class):

### 1. `flow-stack` (层次栈)

适合: 表达"分层 / 多个独立层 / 阶段流程"。

```html
<div class="figure figure--stack">
  <div class="figure__title">图 N · 简短描述</div>
  <div class="flow-stack">
    <div class="flow-stack__layer flow-stack__layer--stable">
      <div class="flow-stack__label">层 1 名字</div>
      <div class="flow-stack__body">层 1 内容</div>
    </div>
    <div class="flow-stack__layer flow-stack__layer--dynamic">
      <div class="flow-stack__label">层 2 名字</div>
      <div class="flow-stack__body">层 2 内容</div>
    </div>
  </div>
</div>
```

4 种 layer 颜色 (语义):
- `flow-stack__layer` (默认): 普通
- `flow-stack__layer--stable`: 稳定 / 正确
- `flow-stack__layer--dynamic`: 中性 / 当前
- `flow-stack__layer--bad`: ❌ 错误

### 2. `flow-compare` (对比)

适合: 2 种方案 / 错 vs 对 / ❌ vs ✅。

```html
<div class="figure figure--compare">
  <div class="figure__title">图 N · 简短描述</div>
  <div class="flow-compare">
    <div class="flow-compare__col flow-compare__col--bad">
      <div class="flow-compare__head">❌ 错方案</div>
      <div class="flow-compare__body">错方案内容</div>
    </div>
    <div class="flow-compare__col flow-compare__col--good">
      <div class="flow-compare__head">✅ 对方案</div>
      <div class="flow-compare__body">对方案内容</div>
    </div>
  </div>
</div>
```

3 种 col 颜色: `--bad` / `--good` / 默认 (中性)。

### 3. `flow-tree` (树状分支)

适合: 3+ 个并列选项 / 分类树。

### 何时用图, 何时用表

- **图**: 表达**关系 / 流程 / 对比**, 2-4 个并列项
- **表**: 表达**结构化数据**, 5+ 个属性 / 字段

### 配图原则

- **每章 2-4 张图**, 不能没有图 (太抽象), 也不能每节 1 张图
  (学生看图疲劳)
- **配图不重复**: 图 1 讲结构, 图 2 讲流程, 图 3 讲对比, 不要三张
  图讲同一件事
- **图后必须有图注**: `<figcaption>` 简短说"这张图讲什么"
- **图题简短**: 不要 "图 1 · 这是第 1 张图, 讲 A 和 B 的关系",
  应该 "图 1 · A 和 B 的关系"

---

## 常见反模式

### 1. "用途/场景/设计" 抽象堆砌

❌ 每个小节都是 `<p><strong>用途</strong>: ...</p><p><strong>真实场景</strong>: ...</p><p><strong>设计思想</strong>: ...</p>`

✅ 改成"场景 → 朴素想法 → 正确做法 → 设计思想 → 实现"。

### 2. 直接上代码, 不铺垫

❌ `<h2>X 实现</h2><pre>// 30 行代码</pre>`

✅ 先讲"问题" + "朴素方案 + 为什么错" + "正解" + 代码。

### 3. 4 个分号挤在一段

❌ 一段里有 N 个分号, 列举 4+ 件事。

✅ 改成 `<ul>` bullet, 每件事单独一行。

### 4. "调 LLM 总结" / "调用 XX" 错误事实

❌ 教程里说"X 调 LLM 总结", 但实际代码不调 LLM。

✅ 改教程前**先看代码** (`rg` + `read`), 确认事实正确。

### 5. 长段不分段

❌ 一个 `<p>` 5-8 段内容。

✅ 拆成多个 `<p>` 或 `<ul>`, 视觉上分段。

### 6. 用 "块" 不统一

❌ 一章里 "块" 和 "block" 混用。

✅ 全文统一用 "block" (英文), 除非引用变量名。

### 7. "P0 / P1 / P2 调 LLM" 等技术误述

❌ 教程假设某层调 LLM, 实际是字符串拼接。

✅ 写之前**必读代码** (`src/<feature>.ts`), 不靠记忆。 `rg` + `read` 一次。

### 8. "block 块" 重复

❌ "block 块" 这种英文 + 中文重复。

✅ 选一个 (统一 block)。

### 9. 抽象概念放错位置

❌ 把抽象的"模块边界" / "桥接模式" 解释放在某个小节的"设计思想" 里。

✅ 抽象概念放 Reference 章节作为独立 pattern, 主章节里**链接过去**即可, 不要重复讲。

### 10. 章节没具体例子

❌ 一章全是抽象概念, 没有"一个具体的 memory 文件长什么样" /
"一段具体的 cache 日志长什么样"。

✅ 至少有一个具体例子 (文件示例 / 日志示例 / 调用的具体场景)。

---

## 验证 checklist

写完 (或大改) 一章后, 跑这个清单:

### 内容准确性

- [ ] **事实检查**: 教程描述的实现 ≠ 源码里实际写的 (用 `rg` 搜关键
  函数名, 比对代码)
- [ ] **GitHub 链接**: 每段代码后都有 GitHub 永久链接, 行号正确
  (用浏览器点开确认)
- [ ] **PDD 残留**: `rg "PDD-\d+" tutorial/chapters/<file>.html` 0 处
  (引用 PDD 设计文档会被扣分, PDD 是内部设计, 不暴露给学生)

### 结构规范

- [ ] **5 件套开头**: eyebrow + title + lede + inline-toc + rule 都在
- [ ] **小节 4 段式**: 至少"场景 → 朴素 → 正确" 3 段都有
- [ ] **每节 2-4 张图**: 没有图 (太抽象) 或太多图 (疲劳)
- [ ] **小节数量**: 8-15 个 h2 比较合适, 太少章节太薄, 太多学生消化不了

### 排版

- [ ] **多条目用 bullet**: 3+ 个并列项用 `<ul>`, 不用分号挤在一段
- [ ] **中英文之间有空格**: 全文 grep 一下, 修不规范处
- [ ] **统一用 block / 不混用 块**: `rg "块" tutorial/chapters/<file>.html`
  只剩"模块" 等其他用法
- [ ] **表格用 `<table class="terms">`**: 3+ 对比项用表, 不用 dl

### 交叉引用

- [ ] **引上一章**: lede 必须提上一章讲了什么 + 这一章补什么
- [ ] **引 Reference 章节**: 抽象概念 (模式 / 原则) 引到 reference
  对应 pattern, 不重复讲
- [ ] **引后续章节**: 用 `<a href="./chapters/XX.html#yy">` 给链接

### 验证脚本

每次写完跑:

```bash
# PDD 残留
rg -c 'PDD-' tutorial/chapters/*.html 2>/dev/null

# JS 语法
node --check tutorial/assets/content.js && \
node --check tutorial/assets/app.js && echo "JS syntax OK"

# 中英文之间空格 (粗略检查)
# 这个需要肉眼检查, 工具不够智能

# 块 / block 混用
rg '\b块\b' tutorial/chapters/<file>.html
```

---

## 与其他章节的交叉引用

### 主教程章节之间的关系

章节按"主线" + "专题" + "Reference" 组织:

```
主线 (00-preface → 15-hardening)
  ├── 00-preface: 序言, 讲整个项目的故事
  ├── 01-agent-loop: 5 件套 (History / LLM / Agent / REPL / Composition Root)
  ├── 02-tools: Tool interface, 协议, 错误模式
  ├── 03-todo: TODO 数据结构 + reminder 注入
  ├── 04-subagent: 父子 agent 隔离
  ├── 05-skill: skill 加载 + 跨 run 缓存
  ├── 06-compress: 消息块 + P0/P1/P2
  ├── 07-permission: 3 模式 + askUser 同步
  ├── 08-hook: 3 事件 + 3 返回码 + 实战
  ├── 09-memory: 4 类 tag + frontmatter + 桥接
  ├── 10-cache: prefix hash + cache debug
  ├── 11-recovery: 7 错误 + 4 动作
  ├── 12-task: 任务系统 + 状态机
  ├── 13-async-run: 后台执行
  ├── 14-schedule: 定时调度
  └── 15-hardening: 运行时安全

专题
  ├── model-policy: LLM 选型
  ├── eval: 评测 harness
  └── reference: 22 个设计模式
```

### 引用规则

- **主章节之间引用**: 必须给完整 URL, 用 `<a href="./chapters/XX.html#yy">`
- **引 Reference 章节**: 同上, 引用具体 pattern
- **不要在主章节里复制 Reference 内容**: 主章节只说"对应 Reference
  模式 3 · 依赖注入", 不展开讲什么是依赖注入

---

## 改写现有章节的工作流

改写一个"技术细节堆砌" 的章节, 按这个流程:

### 1. 读现有内容 + 看代码 (5-10 分钟)

```bash
# 读章节, 找哪些小节是 "用途/场景/设计" 套路
rg -n '用途|真实场景|设计思想|实现细节' tutorial/chapters/<file>.html

# 看代码, 确认教程描述的事实正确
rg -n 'function 关键函数' src/<feature>.ts
```

### 2. 列出改动点 (5 分钟)

对每个要改的小节, 写一句话说明"改成什么":

- "3 个事件点" → "改成: 场景(团队要挂 3 个扩展) → 朴素 → 正确 → 设计 → 实现"
- "stableStringify" → "改成: 场景(误报 cache miss) → 朴素 → 正确(规则列表) → 关键反直觉点 → 代码 + 走一遍"

### 3. 改一个 h2, 验证一个 (每节 10-15 分钟)

每次只改一个 h2, 改完:
- 检查排版 (空格, bullet, 块/block 混用)
- 检查 PDD 残留
- 检查 JS 语法

不要一次性改完全章再验证。 改一节验证一节, 防止最后发现大方向错了。

### 4. 全文再扫一遍 (最后)

```bash
rg -c 'PDD-' tutorial/chapters/<file>.html  # 0 处
node --check tutorial/assets/content.js
node --check tutorial/assets/app.js
```

### 5. commit + push + PR

```bash
git add tutorial/chapters/<file>.html
git commit -m "docs(<chapter>): <一句话改动总结>"
git push origin <branch>
gh pr create --title "..." --body "..."
gh pr merge --squash --delete-branch
```

---

## 写新章节的工作流

写一个全新章节, 按这个流程:

### 1. 读 PDD 设计文档 (5 分钟)

`doc/pdd-XX-<feature>.md` 写"原始设计"。 教程 = 翻译 PDD 成
教学语言, 不是照搬。 PDD 是给实现者看的, 教程是给学生看的。

### 2. 读源码 (10-15 分钟)

`src/<feature>.ts` 实际怎么写。 教程的代码示例必须**真实**, 不能
"教学版简化" 后跟实际差太远。

### 3. 列 5 件套开头 (5 分钟)

- eyebrow: 一句话主题
- title: 主语 + 做了什么
- lede: 上一章讲了什么 + 这一章补什么 + 读完后能讲清什么

### 4. 列章节大纲 (10 分钟)

列 6-12 个 h2 小节, 每个一句话:

```
1. 真实失败故事 (痛点)
2. 3 个 X (X 是什么)
3. X 的核心边界
4. X 的实现细节
5. X 在主循环的集成
6. X 对 cache 的影响
7. fake test
8. 常见误解
9. 反例梯度
10. Validation
11. 回望 + 前瞻
12. Prompt Card + 练习 + 小结
```

每个 h2 内部用 4 段式 (场景 → 朴素 → 正确 → 实现)。

### 5. 写每个 h2 (每个 10-15 分钟)

同改写流程的步骤 3: 写一节验证一节。

### 6. 收尾 (10 分钟)

- 常见误解 (3 个)
- 反例梯度 (4 个 card)
- Validation 卡片 (4-5 条)
- 回望 + 前瞻
- Prompt Card
- 练习 (3 个)
- 小结 (3-5 条 bullet)

### 7. commit + push + PR

同改写流程的步骤 5。

---

## 完整改写案例: 怎么从混乱版到好版

用第 08 章 "8 个技术小节" 的改写做案例 (实际发生过)。

### 改写前 ❌

```html
<h2 id="three-events">三个事件点: SessionStart / PreToolUse / PostToolUse</h2>
<p>
  <strong>用途</strong>: 主循环在 3 个固定时机发事件, handler
  在外部注册监听。 事件点必须<strong>少而精</strong>, ...
</p>
<p>
  <strong>真实场景</strong>: 团队要"跑完测试后自动 commit", 用
  PostToolUse 监听 ... 触发 <code>git commit</code>; 用户想
  "工具调用前打印彩色日志", ... 团队要"每次启动注入 CLAUDE.md
  内容" 用 SessionStart 一次性发出 query。
</p>
<p>
  <strong>设计思想</strong>: 经典<strong>按需加载</strong>模式 — ...
</p>
```

问题:
1. 上来就 "用途", 读者不知道"为什么需要 3 个事件点"
2. 真实场景 3 个独立事件用分号挤在一段, 不易读
3. 没有"朴素想法" — 直接给解法, 学生不知道"为什么不是 1 个事件点"
4. 设计思想 "经典按需加载" 太抽象, 学生不知道跟具体代码怎么对应

### 改写后 ✅

```html
<h2 id="three-events">三个事件点: SessionStart / PreToolUse / PostToolUse</h2>
<p>
  <strong>场景: 团队要挂 3 个不同的扩展</strong>
</p>
<p>
  团队 leader 想给 harness 加 3 个扩展, 看着都没问题, 但写起来麻烦:
</p>
<ol>
  <li>跑完测试自动 commit, 想监听 run_bash 跑完事件</li>
  <li>工具调用前打印日志, 想监听 "工具执行前" 事件</li>
  <li>启动时注入 CLAUDE.md, 想监听 "启动" 事件</li>
</ol>
<p>
  这 3 个扩展都不是安全检查 (Permission 不管), 都不是业务核心
  (写进 agent.ts 会污染主循环), 都不是单一工具能完成 (跨多个
  工具或整个 session)。
</p>
<p>
  <strong>朴素想法 1</strong>: "每个用户自己写个 wrapper 套在 tool 外?"
  错。 5 个团队 5 个 wrapper, 互相不兼容, 维护噩梦。
</p>
<p>
  <strong>朴素想法 2</strong>: "在 agent.ts 主循环里加 3 个 if?" 错。
  业务规则千变万化, agent.ts 会变成"巨型 switch", 谁都不敢动。
</p>
<p>
  <strong>正确做法</strong>: 主循环在 3 个固定时机发事件, handler 在外部
  注册监听。 事件点必须"少而精" — 多一个事件点就是多一份主循环
  耦合, 永远不会被添加。
</p>
<!-- 配图 1: 3 个事件点位置 -->
<!-- 设计思想: 观察者模式 -->
<!-- 实现细节: ... -->
```

改进点:
1. **场景在前面**: "3 个扩展" 是具体故事, 读者脑子有画面
2. **朴素想法显式**: 2 个错方案 + 为什么错, 学生知道"正解解决了什么"
3. **分条 bullet**: 3 个事件用 `<ol>` 列出来, 一行一个
4. **正解之后配图**: 用 flow-stack 图展示 3 个事件在主循环的位置
5. **设计思想后置**: 不在开头讲抽象, 在正解之后简短点出"对应模式 9 · 观察者"

---

## 最后: 不要忘了

教程是给**初学 agent 架构的开发者**看的, 不是给**已经写完的开发者**
看的。 写每一段时, 问自己:

- [ ] 学生看完这一段, **能口头讲清**这是怎么回事吗?
- [ ] 学生看完这一段, **知道为什么需要**这个吗?
- [ ] 学生看完这一段, **能自己写出类似代码**吗 (有具体例子)?
- [ ] 学生看完这一段, **知道哪里深入**吗 (引到 Reference 章节)?

如果任何一条不满足, 重写。

---

**版本**: v1.0 (2026-06-20)
**维护者**: tutorial 编写者
**变更记录**: 初始版本, 基于 05/06/07/08/09/10/11/12/14/reference 章节的改写经验总结
