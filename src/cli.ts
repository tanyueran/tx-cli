import pico from "picocolors";
import { start } from "./index";

/**
 * 可执行入口：负责兜底未预期错误与设置退出码
 * 与 dev 模式（tsx ./src/cli.ts）共用同一份逻辑，避免两种运行方式行为不一致
 */
start().catch((err: unknown) => {
  // Commander 因 exitOverride 抛出的错误（如 --help / --version）已自带输出
  const code = (err as { code?: string })?.code;
  if (typeof code === "string" && code.startsWith("commander.")) {
    process.exitCode = (err as { exitCode?: number }).exitCode ?? 0;
    return;
  }
  console.error(pico.red((err as Error)?.stack || String(err)));
  process.exitCode = 1;
});
