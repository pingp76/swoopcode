# Coding Agent 网页教程

把 `learn-claude-code-ts` 项目讲成网页教程, 让学生看了能自己 vibe coding
类似的 coding agent, 也了解工作原理和注意事项。

## 本地运行

在仓库根目录运行:

```bash
npm run tutorial:dev
```

或进入本目录运行:

```bash
cd tutorial
npm run dev
```

默认访问地址:

```text
http://127.0.0.1:5173
```

## 已发布章节

### 主线教程 (16 章, 按推荐顺序阅读)

- 第 00 章 · 元方法 — 用 LLM 写 LLM Agent 的元方法
- 第 01 章 · 最小 Agent Loop
- 第 02 章 · 给 Agent 一双手: 工具调用
- 第 03 章 · 让多轮执行有节奏: TODO Manager
- 第 04 章 · 让 Agent 学会分身: SubAgent
- 第 05 章 · 按需加载能力: Skill
- 第 06 章 · 上下文太长怎么办: Normalize / Block / Compress
- 第 07 章 · 给工具画边界: Permission
- 第 08 章 · 在 Loop 周围挂钩子: Hook
- 第 09 章 · 跨会话记忆: Memory
- 第 10 章 · Prompt Cache 友好的请求布局
- 第 11 章 · LLM 出错时不要崩: Recovery
- 第 12 章 · 长期计划落盘: Persistent Task
- 第 13 章 · 不阻塞主循环: Async Run
- 第 14 章 · 让时间触发 Agent: Schedule
- 第 15 章 · 长期运行不会把系统跑坏: Runtime Hardening

### 专题章

- 专题 A · 模型适配: 不同大模型不是只换模型名
- 专题 B · 如何测试一个不确定的 Coding Agent
- Reference · 术语表、Prompt Pack 与验证手册

## 章节结构 (每章统一)

- **差量表**: 这一章在上一章基础上改了什么 (列文件 / 职责 / 边界)
- **作者怎么想的**: 4 步思考链 (现象 / 反例 / 接口 / 验证)
- **先观察**: 2 段故意有气味的代码 + 提问
- **接口 / loop 接入 / 主体代码**
- **反例梯度**: 4 档 (新手 / 中级 / 高级 / 边界) 错法
- **Validation 卡片**: 5 条可落到 vitest 的断言
- **回望 / 前瞻**: 与前几章的差量验证 + 给后续章节留的张力
- **vibe-coding 三件套**: 4 轮拆卡 + review checklist + 调试伪装 + commit 节奏
- **Prompt Card**: 6 段模板 (目标 / 场景 / 模块 / 接线 / 边界 / 验证)

## 设计说明

当前页面刻意保持为无依赖静态站点: HTML 内容放在 `chapters/`, 视觉
token 放在 `assets/styles.css`, 导航、侧栏收起、页内目录滚动由
`assets/app.js` 负责。这样后续可以先快速调整中文正文和视觉风格, 再
决定是否迁移到 VitePress、Astro 或其他文档框架。

代码块由 `assets/app.js` 内的自写 TS/JS 词法分析器高亮, 零依赖, 暖色
调适配。源码链接指向 GitHub `main` 分支 (仓库已 public, 匿名可访问)。

## 校对与维护

- 仓库根的 `AGENTS.md` 说明了章节模板的稳定约定, 不要中途修改
- 章节作者只编辑 `chapters/*.html`, 不动布局代码
- 新章节需要:
  1. 在 `assets/content.js` 加章节元数据 + navGroup
  1. 在 `chapters/` 新建 HTML, 沿用 6 段结构
  1. 在 README 同步更新发布状态
- 术语锁定: 任何新概念先在 Reference 章"术语锁定表" 加一行, 别名替换全局生效
