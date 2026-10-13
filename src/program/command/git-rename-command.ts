import type { Command } from "commander";
import { cwd } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { simpleGit } from "simple-git";
import pico from "picocolors";
import { existsWithExactCase } from "../../shared/fs";
import { CliError } from "../../shared/errors";

/**
 * 注册 git-rename 命令：git 重命名模块（支持大小写转换）
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerGitRenameCommand(program: Command): void {
  program
    .command("git-rename <old-model-url> <new-model-url>")
    .description("git重命名模块")
    .action(async (_oldModelUrl: string, _newModelUrl: string) => {
      // 按需创建，避免模块顶层实例化污染其他命令，也便于测试注入
      const git = simpleGit();
      const basePath = cwd();
      const oldModelUrl = resolve(basePath, _oldModelUrl);
      const newModelUrl = resolve(basePath, _newModelUrl);

      if (!existsWithExactCase(oldModelUrl)) {
        throw new CliError(`${oldModelUrl}文件不存在`);
      }
      if (existsWithExactCase(newModelUrl)) {
        throw new CliError(`${newModelUrl}文件已存在`);
      }

      // 判断旧文件是否被 git 跟踪
      let gitRootPath: string;
      let status;
      try {
        status = await git.status();
        gitRootPath = await git.revparse(["--show-toplevel"]);
      } catch (err) {
        throw new CliError(
          `当前目录不是一个git仓库：${(err as Error).message}`
        );
      }

      if (
        status.not_added
          .map((item) => resolve(gitRootPath, item))
          .includes(oldModelUrl) ||
        (status.ignored || [])
          .map((item) => resolve(gitRootPath, item))
          .includes(oldModelUrl)
      ) {
        throw new CliError(`文件${oldModelUrl}未被git跟踪`);
      }

      const oldModelName = basename(oldModelUrl);
      const interimModelUrl = join(dirname(oldModelUrl), `___${oldModelName}`);

      try {
        await git.mv(oldModelUrl, interimModelUrl);
      } catch (err) {
        throw new CliError(`重命名失败：${(err as Error).message}`);
      }

      try {
        await git.mv(interimModelUrl, newModelUrl);
      } catch (err) {
        // 第二步失败时回滚，避免残留 ___ 中间态文件
        try {
          await git.mv(interimModelUrl, oldModelUrl);
          console.log(pico.yellow("已回滚到原文件名"));
        } catch (rollbackErr) {
          console.error(
            pico.red(
              `回滚失败，请手动将 ${interimModelUrl} 改回 ${oldModelUrl}：${
                (rollbackErr as Error).message
              }`
            )
          );
        }
        throw new CliError(`重命名失败：${(err as Error).message}`);
      }

      console.log(pico.green(`重命名成功：${oldModelUrl} -> ${newModelUrl}`));
    });
}