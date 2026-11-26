import type { Command } from "commander";
import pico from "picocolors";
import { runScaffold } from "@tanyueran/agent-scaffold";
import { createCliChannels } from "../../channels";

/**
 * 注册 add 命令：基于模板添加模块
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerAddCommand(program: Command): void {
  program
    .command("add [module-name]")
    .description("添加模块")
    .action(async (moduleName?: string) => {
      // 会话通道：交互问询与提示的出口
      const channels = createCliChannels();
      const result = await runScaffold({
        name: moduleName,
        nameLabel: "模块名",
        kind: "module",
        prompt: channels.prompt,
        output: channels.output,
        // 相对模块路径基于命令行的实际执行目录：pnpm/npm 通过 INIT_CWD 传递调用方目录，
        // 直接执行 bin 时没有该变量，回退到当前工作目录
        cwd: process.env.INIT_CWD || process.cwd(),
      });
      if (result) {
        channels.output.text(pico.green(`模块已生成：${result.targetPath}`));
      }
    });
}
