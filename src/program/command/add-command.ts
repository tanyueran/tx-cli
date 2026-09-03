import type { Command } from "commander";
import pico from "picocolors";
import { runScaffold } from "../../core/scaffold";

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
      const result = await runScaffold({
        name: moduleName,
        nameLabel: "模块名",
        kind: "module",
      });
      if (result) {
        console.log(pico.green(`模块已生成：${result.targetPath}`));
      }
    });
}
