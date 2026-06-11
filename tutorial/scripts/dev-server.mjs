import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 这个开发服务器默认只服务 tutorial/ 目录下的静态文件。
// 第一版教程站刻意不引入 VitePress/Astro，是为了先校准内容、视觉和交互；
// 但学生仍然需要一个真正的 HTTP 服务，因为浏览器在 file:// 下通常会拦截
// fetch("./chapters/00-preface.html") 这类本地文件读取。
//
// 教程正文会嵌入源码阅读链接，例如 /source/src/agent.ts。
// 因此服务器额外暴露一个只读 /source/src/* 路由，让学生可以在浏览器里
// 直接打开源码文件。这个路由仍然做严格路径边界检查，不允许读取 src/ 外部。

const currentFile = fileURLToPath(import.meta.url);
const rootDir = resolve(currentFile, "../..");
const repoRootDir = resolve(rootDir, "..");
const sourceRootDir = resolve(repoRootDir, "src");
const port = Number.parseInt(process.env.PORT ?? "5173", 10);
const host = process.env.HOST ?? "127.0.0.1";

const mimeTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".ts", "text/plain; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml; charset=utf-8"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".webp", "image/webp"],
]);

function isInsideDirectory(filePath, directoryPath) {
  return filePath === directoryPath || filePath.startsWith(`${directoryPath}/`);
}

function resolveRequestPath(requestUrl) {
  const url = new URL(requestUrl ?? "/", `http://${host}:${port}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith("/source/src/")) {
    const sourceRelativePath = pathname.slice("/source/src/".length);
    const absoluteSourcePath = resolve(
      sourceRootDir,
      normalize(sourceRelativePath),
    );

    if (!isInsideDirectory(absoluteSourcePath, sourceRootDir)) {
      return null;
    }

    return absoluteSourcePath;
  }

  if (pathname === "/logo.png") {
    // 教程站点仍以 tutorial/ 为静态根目录；logo 是项目级品牌资产，
    // 因此只额外暴露这个单文件路由，而不是放开整个仓库根目录。
    return resolve(repoRootDir, "logo.png");
  }

  // 静态服务器最重要的安全边界：请求路径必须被限制在 tutorial 根目录内。
  // normalize 会收敛 ../ 片段，resolve 后再做 startsWith 检查，避免路径逃逸。
  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const absolutePath = resolve(rootDir, normalize(relativePath));
  if (!isInsideDirectory(absolutePath, rootDir)) {
    return null;
  }
  return absolutePath;
}

async function serveFile(response, filePath) {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      response.end("Not found");
      return;
    }

    const mimeType =
      mimeTypes.get(extname(filePath)) ?? "application/octet-stream";
    response.writeHead(200, {
      "content-type": mimeType,
      "cache-control": "no-cache",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

const server = createServer(async (request, response) => {
  const filePath = resolveRequestPath(request.url);
  if (!filePath) {
    response.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
    response.end("Forbidden");
    return;
  }

  await serveFile(response, filePath);
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`Tutorial server running at ${url}`);
  console.log(
    `Open ${url}/?chapter=00-preface or ${url}/?chapter=01-agent-loop`,
  );
});
