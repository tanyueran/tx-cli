import type { Command } from "commander";
import {
  loadLlmConfig,
  parseThinkingLevel,
  THINKING_LEVELS,
} from "../../core/llm";
import { runOneShotChat, runReplChat } from "../../core/conversation/chat";

/** chat 命令执行体的选项入参 */
interface ChatOptions {
  /** 思考档位（--think），未指定时回退配置默认 */
  think?: string;
  /** 是否启用 MCP 服务器：--no-mcp 显式传入 false，缺省视为开启 */
  mcp?: boolean;
}

/**
 * chat 命令执行体：档位校验、配置装载与单次/多轮分流
 * 与 commander 解耦后可直接对分流与空参逻辑单测；
 * 空白问题（如 tx chat "" 或 tx chat "  "）按未传参处理，进入多轮对话而非向模型发送空消息
 * @param {string[]} question - 命令位置参数（可变参数）
 * @param {ChatOptions} opts - 命令行选项
 * @returns {Promise<void>}
 */
export async function runChatAction(
  question: string[],
  opts: ChatOptions,
): Promise<void> {
  // 档位解析前置：非法值在对话开始前报错退出，避免带着错误配置发请求
  const thinkingLevel = parseThinkingLevel(opts.think);
  const config = await loadLlmConfig();
  // commander 的 --no-mcp 取反约定：显式传入时 opts.mcp 为 false，缺省为 true
  const mcpEnabled = opts.mcp !== false;
  const questionText = question.join(" ").trim();
  if (questionText) {
    await runOneShotChat(config, questionText, thinkingLevel, mcpEnabled);
    return;
  }
  await runReplChat(config, thinkingLevel, mcpEnabled);
}

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
    .option(
      "--think <level>",
      `思考档位：${THINKING_LEVELS.join(" | ")}，缺省时回退配置文件 llm.thinkingLevel（最终默认 medium）`,
    )
    .option(
      "--no-mcp",
      "禁用 MCP 服务器（默认读取 ~/.tx-cli/config.json 的 mcpServers 段）",
    )
    .action(async (question: string[], opts: ChatOptions) => {
      await runChatAction(question, opts);
    });
}
