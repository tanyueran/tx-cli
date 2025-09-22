import { startServer } from "../../utils/startServer";
import { program } from "../var";

program
  .command("server")
  .description("启动一个本地HTTP服务器")
  .option("-p, --port <number>", "端口号", "8080")
  .option("-h, --host <host>", "主机地址", "localhost")
  .option("-d, --directory <path>", "服务的目录", ".")
  .option("-o, --open", "启动后自动打开浏览器")
  .option("-s, --silent", "静默模式，不输出信息")
  .option("--header <json>", "启动服务设置的HTTP相应头", "{}")
  .action((options) => {
    // 将字符串选项转换为正确类型
    const opts = {
      ...options,
      port: parseInt(options.port, 10),
      openBrowser: !!options.open,
      silent: !!options.silent,
      header: JSON.parse(options.header),
    };

    // 启动服务器
    startServer(opts);
  });
