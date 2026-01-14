import { ServerOptions } from "../types/server";
import http from "node:http";
import connect from "connect";
import serveStatic from "serve-static";
import open from "open";
import { resolve } from "node:path";
import pico from "picocolors";

function setHeaders(
  res: any,
  path: string,
  stat: any,
  headerOptions: Record<string, string>
) {
  for (const [key, value] of Object.entries(headerOptions)) {
    res.setHeader(key, value);
  }
}

function startServer(options: ServerOptions = {}) {
  const {
    port = 8080,
    host = "localhost",
    directory = process.cwd(), // 默认为当前工作目录
    openBrowser = false,
    silent = false,
    header = {},
  } = options;

  // 创建 Connect 应用
  const app = connect();

  // 添加静态文件服务中间件
  app.use(
    serveStatic(resolve(directory), {
      setHeaders: (...args) => setHeaders(...args, header),
    })
  );

  // 处理404
  app.use((req, res) => {
    res.statusCode = 404;
    res.end("Not Found");
  });

  // 创建 HTTP 服务器
  const server = http.createServer(app);

  server.listen(port, host, () => {
    const url = `http://${host}:${port}`;
    if (!silent) {
      console.log(pico.green(`> 本地开发服务器已启动`));
      console.log(pico.green(`> 访问地址: ${url}`));
      console.log(pico.green(`> 服务目录: ${directory}`));
      console.log(pico.green(`> 按 Ctrl+C 停止服务器`));
    }

    // 自动打开浏览器
    if (openBrowser) {
      open(url).catch((err) => {
        console.warn(pico.yellow(`无法自动打开浏览器: ${err.message}`));
      });
    }
  });

  // 处理关闭信号 (Ctrl+C)
  process.on("SIGINT", () => {
    console.log("\n> 正在关闭服务器...");
    server.close(() => {
      console.log(pico.gray("> 服务器已停止。"));
      process.exit(0);
    });
  });

  return server; // 返回 server 实例以便于测试或管理
}

export { startServer };
