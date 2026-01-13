import { program } from "../var";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsWithExactCase } from "../../utils/fileUtils";

const { simpleGit } = require("simple-git");

const git = simpleGit();

const __dirname = fileURLToPath(dirname(import.meta.url));

program
  .command("git-rename <old-model-url> <new-model-url>")
  .description("git重命名模块")
  .action(async (_oldModelUrl: string, _newModelUrl: string) => {
    const oldModelUrl = resolve(__dirname, _oldModelUrl);
    const newModelUrl = resolve(__dirname, _newModelUrl);

    // nodejs判断文件是否存在
    if (!existsWithExactCase(oldModelUrl)) {
      throw new Error(`${oldModelUrl}文件不存在`);
    }

    if (existsWithExactCase(newModelUrl)) {
      throw new Error(`${newModelUrl}文件已存在`);
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
