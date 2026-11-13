import type { Command } from "commander";
import pico from "picocolors";
import { runScaffold } from "@tx-cli/scaffold";
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
      });
      if (result) {
        channels.output.text(pico.green(`模块已生成：${result.targetPath}`));
      }
    });
}
