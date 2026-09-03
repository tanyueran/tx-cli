import pico from "picocolors";
import { startServer } from "../../utils/startServer";
import { program } from "../var";

program
  .command("server")
  .description("启动一个本地HTTP服务器")
  .option("-p, --port <number>", "端口号", "8080")
  .option("-H, --host <host>", "主机地址", "localhost")
  .option("-d, --directory <path>", "服务的目录", ".")
  .option("-o, --open", "启动后自动打开浏览器")
  .option("-s, --silent", "静默模式，不输出信息")
  .option("--header <json>", "启动服务设置的HTTP相应头", "{}")
  .action((options) => {
    const port = Number(options.port);
    // 端口必须是 1-65535 的整数
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return console.error(
        pico.red(`端口号无效：${options.port}，请传入 1-65535 之间的整数`)
      );
    }

    let header: Record<string, string>;
    try {
      header = JSON.parse(options.header);
    } catch {
      return console.error(
        pico.red(
          `--header 不是合法的JSON：${options.header}，示例：--header '{"Cache-Control":"no-cache"}'`
        )
      );
    }
    // JSON.parse 能解析出数组、字符串等非对象值，这里要求必须是普通对象
    if (
      typeof header !== "object" ||
      header === null ||
      Array.isArray(header)
    ) {
      return console.error(
        pico.red(`--header 必须是一个JSON对象，示例：--header '{"key":"value"}'`)
      );
    }

    // 启动服务器
    startServer({
      ...options,
      port,
      openBrowser: !!options.open,
      silent: !!options.silent,
      header,
    });
  });
