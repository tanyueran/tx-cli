import type { Command } from "commander";
import { loadLlmConfig, parseThinkingLevel } from "../../core/llm";
import { runOneShotChat, runReplChat } from "../../core/chat";

/**
 * 注册 chat 命令：与大模型对话
 * 思考档位优先级：--think > 配置文件 llm.thinkingLevel > medium
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerChatCommand(program: Command): void {
  program
    .command("chat [question...]")
    .description("与大模型对话：传入问题为单次问答，不带参数进入多轮对话模式")
    .option("--think <level>", "思考档位：off | low | medium | high")
    .action(async (question: string[], opts: { think?: string }) => {
      // 档位解析前置：非法值在对话开始前报错退出，避免带着错误配置发请求
      const thinkingLevel = parseThinkingLevel(opts.think);
      const config = await loadLlmConfig();
      if (question.length > 0) {
        await runOneShotChat(config, question.join(" "), thinkingLevel);
        return;
      }
      await runReplChat(config, thinkingLevel);
    });
}
