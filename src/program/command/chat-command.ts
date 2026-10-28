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
 * chat 命令执行体：档位校验、配置装载与单次/多轮分流
 * 与 commander 解耦后可直接对分流与空参逻辑单测；
 * 空白问题（如 tx chat "" 或 tx chat "  "）按未传参处理，进入多轮对话而非向模型发送空消息；
 * Chat 模式为轻量只读问答：不装配 bash 与 MCP，思考档位兜底 low，需要执行任务请用 agent 命令
 * @param {string[]} questionSegments - 命令位置参数（可变参数，未拼接的问题分段）
 * @param {ChatOptions} chatOptions - 命令行选项
 * @returns {Promise<void>}
 */
export async function runChatAction(
  questionSegments: string[],
  chatOptions: ChatOptions,
): Promise<void> {
  // CLI 选项处理全部前置：loadLlmConfig 在配置缺失时会进入交互向导并写盘，
  // 必须先完成所有命令行选项的解析
  // 思考档位链路：--think > 配置文件（项目 > 全局）> low，兜底值由会话层按模式解析；
  // 档位经 parseThinkingLevel 校验归一化（支持大小写与首尾空格），非法值在进入交互向导前报错退出
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
 * 工具带仅含只读内置工具（read_file 等）与技能，不装配 bash、MCP；
 * 沙箱档位、审批策略、bash 开关与 MCP 开关等执行类选项归 agent 命令；
 * 思考档位链路：--think > 配置文件（项目 > 全局）> low（轻量兜底）；
 * 档位经 parseThinkingLevel 校验（与 agent 命令同一口径）：非法值报错退出
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
