import { ServerOptions } from "../../types/server";
import http from "node:http";
import connect from "connect";
import serveStatic from "serve-static";
import { resolve } from "node:path";

/**
 * 创建并启动一个静态文件服务器
 * 说明：只负责建立服务，不注册进程信号、不调用 process.exit，
 * 启动失败通过 reject 上报，由调用方决定如何提示与退出
 * @param {ServerOptions} options - 服务器配置项
 * @returns {Promise<{ server: http.Server; url: string }>} 监听成功后返回 server 实例与访问地址
 */
export function startServer(
  options: ServerOptions = {}
): Promise<{ server: http.Server; url: string }> {
  const {
    port = 8080,
    host = "localhost",
    directory = process.cwd(),
    header = {},
  } = options;

  const app = connect();

  app.use(
    serveStatic(resolve(directory), {
      setHeaders: (res: http.ServerResponse) => {
        for (const [key, value] of Object.entries(header)) {
          res.setHeader(key, value);
        }
      },
    })
  );

  // 处理404，connect 依据参数个数识别普通中间件，req 需保留
  app.use((_req, res) => {
    res.statusCode = 404;
    res.end("Not Found");
  });

  const server = http.createServer(app);

  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      // 监听成功后移除一次性的启动错误处理，避免影响运行期错误
      server.removeListener("error", reject);
      resolvePromise({ server, url: `http://${host}:${port}` });
    });
  });
}
