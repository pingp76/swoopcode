# Coding Agent 网页教程

这是 `doc/web-tutorial-plan.md` 的第一版可运行雏形，目前只实现第 00 章和第 01 章，用于先校准内容语气、视觉节奏和阅读交互。

## 本地运行

在仓库根目录运行：

```bash
npm run tutorial:dev
```

或进入本目录运行：

```bash
cd tutorial
npm run dev
```

默认访问地址：

```text
http://127.0.0.1:5173
```

## 当前内容

- 第 00 章：为什么要手搓一个 Coding Agent
- 第 01 章：最小 Agent Loop

## 设计说明

当前页面刻意保持为无依赖静态站点：HTML 内容放在 `chapters/`，视觉 token 放在 `assets/styles.css`，导航、侧栏收起、页内目录滚动由 `assets/app.js` 负责。这样后续可以先快速调整中文正文和视觉风格，再决定是否迁移到 VitePress、Astro 或其他文档框架。
