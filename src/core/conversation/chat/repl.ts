import { runReplConversation } from "../common";
import type { LlmConfig, ThinkingLevel } from "../../../types/llm";
import { CHAT_MODE } from "./constants";

/**
 * 多轮对话模式（REPL，chat 命令的 Chat 模式入口）：只读问答，固定不装配 bash 工具，
 * 沙箱上下文仍创建（只读工具继续受 fs 边界管控），MCP 与技能照常装配；
 * 会话循环复用 common 的 runReplConversation
 * @param {LlmConfig} config - LLM 接入配置
 * @param {ThinkingLevel | undefined} thinkingLevel - 命令行指定的思考档位，未指定时回退配置默认
 * @param {boolean} mcpEnabled - 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启
 * @returns {Promise<void>}
 */
export async function runReplChat(
  config: LlmConfig,
  thinkingLevel?: ThinkingLevel,
  mcpEnabled = true,
): Promise<void> {
  await runReplConversation(config, CHAT_MODE, thinkingLevel, mcpEnabled);
}
