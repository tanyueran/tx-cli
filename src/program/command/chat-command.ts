import { Option } from "commander";
import type { Command } from "commander";
import {
  loadLlmConfig,
  parseThinkingLevel,
  THINKING_LEVELS,
} from "../../core/llm";
import { runOneShotChat, runReplChat } from "../../core/conversation/chat";

/** chat 命令执行体的选项入参 */
interface ChatOptions {
  /** 思考档位（--think），未指定时默认 low（轻量思考） */
  think?: string;
}

/**
 * chat 命令执行体：档位校验、配置装载与单次/多轮分流
 * 与 commander 解耦后可直接对分流与空参逻辑单测；
 * 空白问题（如 tx chat "" 或 tx chat "  "）按未传参处理，进入多轮对话而非向模型发送空消息；
 * Chat 模式为轻量只读问答：不装配 bash 与 MCP，深度思考默认 low，需要执行任务请用 agent 命令
 * @param {string[]} question - 命令位置参数（可变参数）
 * @param {ChatOptions} opts - 命令行选项
 * @returns {Promise<void>}
 */
export async function runChatAction(
  question: string[],
  opts: ChatOptions,
): Promise<void> {
  // CLI 选项处理全部前置：loadLlmConfig 在配置缺失时会进入交互向导并写盘，
  // 必须先完成所有命令行选项的解析（枚举合法性已由 commander choices() 拦截）
  // 深度思考默认 low：--think 按次覆盖，不回退配置文件与环境变量档位，保证 chat 轻量
  const thinkingLevel = parseThinkingLevel(opts.think) ?? "low";
  const config = await loadLlmConfig();
  const questionText = question.join(" ").trim();
  if (questionText) {
    await runOneShotChat(config, questionText, thinkingLevel);
    return;
  }
  await runReplChat(config, thinkingLevel);
}

/**
 * 注册 chat 命令：与大模型只读问答（Chat 模式）
 * 工具带仅含只读内置工具（read_file 等）与技能，不装配 bash、MCP；
 * 沙箱档位、审批策略、bash 开关与 MCP 开关等执行类选项归 agent 命令；
 * 深度思考默认 low（轻量），--think 按次覆盖；枚举型选项经 choices() 声明：
 * 非法值由 commander 在 action 执行前拒绝，无需命令内手工校验
 * @param {Command} program - commander 实例
 * @returns {void}
 */
export function registerChatCommand(program: Command): void {
  program
    .command("chat [question...]")
    .description(
      "与大模型轻量只读问答：传入问题为单次问答，不带参数进入多轮对话模式（执行任务请用 agent 命令）",
    )
    .addOption(
      new Option(
        "--think <level>",
        `思考档位：${THINKING_LEVELS.join(" | ")}，默认 low（轻量思考），仅按传入档位对本次对话覆盖`,
      ).choices([...THINKING_LEVELS]),
    )
    .action(async (question: string[], opts: ChatOptions) => {
      await runChatAction(question, opts);
    });
}
