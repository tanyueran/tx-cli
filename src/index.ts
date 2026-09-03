import pico from "picocolors";
import { createProgram } from "./program";
import { CliError, CancelError } from "./shared/errors";

/**
 * CLI 入口：创建 program、注册命令、解析参数并统一处理错误
 * 确保所有 CliError 以退出码 1 结束，CancelError 提示后正常退出
 * @returns {Promise<void>}
 */
export async function start(): Promise<void> {
  const program = createProgram();

  program.exitOverride();

  try {
    await program.parseAsync(process.argv);
  } catch (err) {
    if (err instanceof CancelError) {
      // 用户主动取消，属于正常流程：给出黄色提示但仍以退出码 0 结束
      console.log(pico.yellow(err.message));
      return;
    }
    if (err instanceof CliError) {
      console.error(pico.red(err.message));
      process.exitCode = 1;
      return;
    }
    // 未预期的错误仍由 Commander 兜底输出
    throw err;
  }
}