import prompts from "prompts";
import pico from "picocolors";
import { program } from "../var";
import { disposeOnesInfo } from "../../utils/disposeOnesInfoUtils";
import simpleGit from "simple-git";

const git = simpleGit();

program
  .command("commit-fix <message...>")
  .description(
    "根据ones上“【id】+【title】+【message】”的信息改为：“fix(【id】): 【title】”格式提交git commit。注意：后面的消息双引号包裹",
  )
  .action(async (message: string[]) => {
    console.log("----------获取的message:-------------");
    console.log(message);
    console.log("-----------------------:-------------");

    // 处理message的信息
    const newMessage = disposeOnesInfo(message.join(" "));

    console.log(pico.green("commit message: " + newMessage || "-"));
    const result = await prompts({
      type: "select",
      name: "confirm",
      message: "确认按照处理后的信息提交吗？",
      choices: [
        { title: "确认", value: "confirm" },
        { title: "取消", value: "cancel" },
      ],
    });
    if (result.confirm === "confirm") {
      try {
        await git.commit(newMessage);
        console.log(pico.green("提交成功"));
      } catch (err) {
        console.log(pico.red("提交失败"));
      }
    } else {
      console.log("取消");
    }
  });
