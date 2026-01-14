import { program } from "../var";
import { cwd } from "node:process";
import { basename, resolve } from "node:path";
import { existsWithExactCase } from "../../utils/fileUtils";
import { simpleGit } from "simple-git";

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
      return console.error(`${oldModelUrl}文件不存在`);
    }

    if (existsWithExactCase(newModelUrl)) {
      return console.error(`${newModelUrl}文件已存在`);
    }

    // 判断旧文件是否被git跟踪
    const status = await git.status();
    const gitRootPath = await git.revparse(["--show-toplevel"]);
    if (
      status.not_added
        .map((item) => resolve(gitRootPath, item))
        .includes(oldModelUrl) ||
      (status.ignored || [])
        .map((item) => resolve(gitRootPath, item))
        .includes(oldModelUrl)
    ) {
      return console.error(`文件${oldModelUrl}未被git跟踪`);
    }

    const oldModelName = basename(oldModelUrl);
    const interimModelName = `___${oldModelName}`;
    const interimModelUrl = oldModelUrl.replace(
      oldModelName!,
      interimModelName
    );

    await git.mv(oldModelUrl, interimModelUrl);
    await git.mv(interimModelUrl, newModelUrl);
  });
