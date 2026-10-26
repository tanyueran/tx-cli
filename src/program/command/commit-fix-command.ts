import type { Command } from "commander";
import pico from "picocolors";
import simpleGit from "simple-git";
import { disposeOnesInfo } from "../../core/commit-fix";
import { CliError } from "../../shared/errors";
import { askSelect } from "../../shared/interactive-prompt";

/**
 * 注册 commit-fix 命令：把 ones 上复制的信息转换为规范的 commit message 并提交
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerCommitFixCommand(program: Command): void {
  program
    .command("commit-fix <message...>")
    .description(
      "根据ones上“【id】+【title】+【message】”的信息改为：“fix(【id】): 【title】”格式提交git commit。注意：后面的消息双引号包裹"
    )
    .action(async (message: string[]) => {
      // 按需创建，避免模块顶层实例化污染其他命令，也便于测试注入
      const git = simpleGit();
      if (!(await git.checkIsRepo())) {
        throw new CliError("当前目录不是一个git仓库");
      }

      // 暂存区为空时 git 只会抛出底层信息，这里前置校验给出明确提示
      const status = await git.status();
      if (status.staged.length === 0) {
        throw new CliError("暂存区为空，请先执行 git add 添加要提交的文件");
      }

      const newMessage = disposeOnesInfo(message.join(" "));

      console.log(pico.green("commit message: " + newMessage));
      const confirm = await askSelect("确认按照处理后的信息提交吗？", [
        { title: "确认", value: "confirm" },
        { title: "取消", value: "cancel" },
      ]);
      if (confirm !== "confirm") {
        console.log(pico.yellow("已取消"));
        return;
      }

      try {
        await git.commit(newMessage);
      } catch (err) {
        throw new CliError(`提交失败: ${(err as Error).message}`);
      }
      console.log(pico.green("提交成功"));
    });
}
