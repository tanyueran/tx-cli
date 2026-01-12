import { program } from "../var";
const { simpleGit } = require("simple-git");

const git = simpleGit();

program
  .command("git-rename <old-model-url> <new-model-url>")
  .description("git重命名模块")
  .action(async (oldModelUrl: string, newModelUrl: string) => {
    await git.mv(oldModelUrl, `__${newModelUrl}`);
    await git.mv(`__${newModelUrl}`, newModelUrl);
  });
