import { program } from "../var";
import { cwd } from "node:process";
import { basename, dirname, join, resolve } from "node:path";
import { existsWithExactCase } from "../../utils/fileUtils";
import { simpleGit } from "simple-git";
import pico from "picocolors";

const git = simpleGit();

program
  .command("git-rename <old-model-url> <new-model-url>")
  .description("git重命名模块")
  .action(async (_oldModelUrl: string, _newModelUrl: string) => {
    const basePath = cwd();

    const oldModelUrl = resolve(basePath, _oldModelUrl);
    const newModelUrl = resolve(basePath, _newModelUrl);

    // nodejs判断文件是否存在
    if (!existsWithExactCase(oldModelUrl)) {
      return console.error(pico.red(`${oldModelUrl}文件不存在`));
    }

    if (existsWithExactCase(newModelUrl)) {
      return console.error(pico.red(`${newModelUrl}文件已存在`));
    }

    // 判断旧文件是否被git跟踪，不在git仓库中时 status/revparse 会抛异常
    let gitRootPath: string;
    let status;
    try {
      status = await git.status();
      gitRootPath = await git.revparse(["--show-toplevel"]);
    } catch (err) {
      return console.error(
        pico.red(`当前目录不是一个git仓库：${(err as Error).message}`)
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
      return console.error(pico.red(`文件${oldModelUrl}未被git跟踪`));
    }

    const oldModelName = basename(oldModelUrl);
    // 用目录 + 文件名拼接中间路径，避免字符串 replace 命中路径中的同名片段
    const interimModelUrl = join(dirname(oldModelUrl), `___${oldModelName}`);

    // 先改成中间名再改成目标名，用于绕过大小写不敏感文件系统；
    // 第二步失败时回滚，避免残留 ___ 中间态文件
    try {
      await git.mv(oldModelUrl, interimModelUrl);
    } catch (err) {
      return console.error(pico.red(`重命名失败：${(err as Error).message}`));
    }

    try {
      await git.mv(interimModelUrl, newModelUrl);
      console.log(pico.green(`重命名成功：${oldModelUrl} -> ${newModelUrl}`));
    } catch (err) {
      console.error(pico.red(`重命名失败：${(err as Error).message}`));
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
    }
  });
