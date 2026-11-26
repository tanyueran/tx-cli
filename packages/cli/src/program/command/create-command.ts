import type { Command } from "commander";
import path from "node:path";
import pico from "picocolors";
import { runScaffold } from "@tanyueran/agent-scaffold";
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
      // 相对项目路径基于命令行的实际执行目录：pnpm/npm 通过 INIT_CWD 传递调用方目录，
      // 直接执行 bin 时没有该变量，回退到当前工作目录
      const cwd = process.env.INIT_CWD || process.cwd();
      const result = await runScaffold({
        name: projectName,
        nameLabel: "项目名称",
        kind: "project",
        prompt: channels.prompt,
        output: channels.output,
        cwd,
      });
      if (result) {
        // 进入目录的提示以执行目录为基准展示，避免出现 cd ././xxx 或落到 packages/cli 的路径
        const relativeDir = path.relative(cwd, result.targetPath);
        const cdPath = relativeDir.startsWith("..")
          ? result.targetPath
          : `./${relativeDir}`;
        channels.output.text(pico.green("创建成功"));
        channels.output.text(pico.green(`cd ${cdPath} && pnpm install`));
      }
    });
}
