import type { Command } from "commander";
import pico from "picocolors";
import open from "open";
import { startServer } from "../../core/server";
import { CliError } from "../../shared/errors";

/**
 * 校验并转换端口号
 * @param {string} raw - 命令行传入的原始端口
 * @returns {number} 合法的端口号
 */
export function parsePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CliError(`端口号无效：${raw}，请传入 1-65535 之间的整数`);
  }
  return port;
}

/**
 * 校验并解析 --header 参数
 * @param {string} raw - 命令行传入的 JSON 字符串
 * @returns {Record<string, string>} 响应头键值对
 */
export function parseHeader(raw: string): Record<string, string> {
  let header: unknown;
  try {
    header = JSON.parse(raw);
  } catch {
    throw new CliError(
      `--header 不是合法的JSON：${raw}，示例：--header '{"Cache-Control":"no-cache"}'`
    );
  }
  // JSON.parse 能解析出数组、字符串等非对象值，这里要求必须是普通对象
  if (typeof header !== "object" || header === null || Array.isArray(header)) {
    throw new CliError(
      `--header 必须是一个JSON对象，示例：--header '{"key":"value"}'`
    );
  }
  return header as Record<string, string>;
}

/**
 * 把启动失败的底层错误转换为可读提示
 * @param {NodeJS.ErrnoException} err - server 抛出的错误
 * @param {number} port - 尝试监听的端口
 * @returns {CliError} 带有可读文案的错误
 */
function toReadableError(
  err: NodeJS.ErrnoException,
  port: number
): CliError {
  if (err.code === "EADDRINUSE") {
    return new CliError(`端口 ${port} 已被占用，请换一个端口`);
  }
  return new CliError(`服务器启动失败: ${err.message}`);
}

/**
 * 注册 server 命令：启动本地静态文件服务器
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerServerCommand(program: Command): void {
  program
    .command("server")
    .description("启动一个本地HTTP服务器")
    .option("-p, --port <number>", "端口号", "8080")
    .option("-H, --host <host>", "主机地址", "localhost")
    .option("-d, --directory <path>", "服务的目录", ".")
    .option("-o, --open", "启动后自动打开浏览器")
    .option("-s, --silent", "静默模式，不输出信息")
    .option("--header <json>", "启动服务设置的HTTP相应头", "{}")
    .action(async (options) => {
      const port = parsePort(options.port);
      const header = parseHeader(options.header);

      let server;
      let url: string;
      try {
        ({ server, url } = await startServer({
          port,
          header,
          host: options.host,
          directory: options.directory,
        }));
      } catch (err) {
        throw toReadableError(err as NodeJS.ErrnoException, port);
      }

      if (!options.silent) {
        console.log(pico.green(`> 本地开发服务器已启动`));
        console.log(pico.green(`> 访问地址: ${url}`));
        console.log(pico.green(`> 服务目录: ${options.directory}`));
        console.log(pico.green(`> 按 Ctrl+C 停止服务器`));
      }

      if (options.open) {
        open(url).catch((err) => {
          console.warn(pico.yellow(`无法自动打开浏览器: ${err.message}`));
        });
      }

      // 进程生命周期由命令层负责
      process.on("SIGINT", () => {
        console.log("\n> 正在关闭服务器...");
        server.close(() => {
          console.log(pico.gray("> 服务器已停止。"));
          process.exit(0);
        });
      });
    });
}
