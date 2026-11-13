import type { Command } from "commander";
import pico from "picocolors";
import { runScaffold } from "@tx-cli/scaffold";
import { createCliChannels } from "../../channels";

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
      // 会话通道：交互问询与提示的出口
      const channels = createCliChannels();
      const result = await runScaffold({
        name: projectName,
        nameLabel: "项目名称",
        kind: "project",
        prompt: channels.prompt,
        output: channels.output,
      });
      if (result) {
        channels.output.text(pico.green("创建成功"));
        channels.output.text(
          pico.green(`cd ./${result.name} && pnpm install`),
        );
      }
    });
}
