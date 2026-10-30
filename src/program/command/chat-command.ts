import type { Command } from "commander";
import {
  loadLlmConfig,
  parseThinkingLevel,
  THINKING_LEVELS,
} from "../../core/llm";
import { runOneShotChat, runReplChat } from "../../core/conversation/chat";

/** chat 命令执行体的选项入参 */
interface ChatOptions {
  /** 思考档位（--think），由 parseThinkingLevel 校验归一化，未指定时回退配置默认（项目 > 全局） */
  think?: string;
}

/**
 * chat 命令执行体：校验思考档位、装载配置，按是否传入问题分流单次/多轮
 *
 * CLI 选项必须先于 loadLlmConfig 处理：配置缺失时后者会进入交互向导并写盘，
 * 档位非法值需在写盘前报错退出（校验口径与 agent 命令一致）。
 * 空白问题（如 tx chat ""）按未传参处理，进入多轮对话而非向模型发送空消息。
 *
 * @param {string[]} questionSegments - 命令位置参数（可变参数）
 * @param {ChatOptions} chatOptions - 命令行选项
 * @returns {Promise<void>}
 */
export async function runChatAction(
  questionSegments: string[],
  chatOptions: ChatOptions,
): Promise<void> {
  const thinkingLevel = parseThinkingLevel(chatOptions.think);
  const llmConfig = await loadLlmConfig();
  const questionText = questionSegments.join(" ").trim();
  if (questionText) {
    await runOneShotChat({
      llmConfig,
      question: questionText,
      thinkingLevel,
    });
    return;
  }
  await runReplChat(llmConfig, thinkingLevel);
}

/**
 * 注册 chat 命令：与大模型只读问答（Chat 模式）
 * 工具带仅含只读内置工具与技能，不装配 bash、MCP 与写侧工具（只读语义由模式配置强制，见 CHAT_MODE_CONFIG）；
 * 执行类选项（沙箱、审批、bash、MCP 开关）归 agent 命令
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerChatCommand(program: Command): void {
  program
    .command("chat [question...]")
    .description(
      "与大模型轻量只读问答：传入问题为单次问答，不带参数进入多轮对话模式（执行任务请用 agent 命令）",
    )
    .option(
      "--think <level>",
      `思考档位：${THINKING_LEVELS.join(" | ")}，优先级：命令行 > 项目配置 > 全局配置（chat 最终默认 low，仅对本次对话生效）`,
    )
    .action(async (questionSegments: string[], chatOptions: ChatOptions) => {
      await runChatAction(questionSegments, chatOptions);
    });
}
