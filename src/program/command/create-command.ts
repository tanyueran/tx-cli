import type { Command } from "commander";
import pico from "picocolors";
import { runScaffold } from "../../core/scaffold";

/**
 * 注册 create 命令：基于模板创建项目
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerCreateCommand(program: Command): void {
  program
    .command("create [project-name]")
    .description("创建项目")
    .action(async (projectName?: string) => {
      const result = await runScaffold({
        name: projectName,
        nameLabel: "项目名称",
        kind: "project",
      });
      if (result) {
        console.log(pico.green("创建成功"));
        console.log(pico.green(`cd ./${result.name} && pnpm install`));
      }
    });
}
