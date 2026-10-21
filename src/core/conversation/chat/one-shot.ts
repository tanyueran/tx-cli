import { runOneShotConversation } from "../common";
import type { LlmConfig, ThinkingLevel } from "../../../types/llm";
import { CHAT_MODE } from "./constants";

/**
 * 单次问答（chat 命令的 Chat 模式入口）：只读问答，固定不装配 bash 工具，
 * 沙箱上下文仍创建（只读工具继续受 fs 边界管控），MCP 与技能照常装配；
 * 具体流程复用 common 的 runOneShotConversation
 * @param {LlmConfig} config - LLM 接入配置
 * @param {string} question - 用户问题
 * @param {ThinkingLevel | undefined} thinkingLevel - 命令行指定的思考档位，未指定时回退配置默认
 * @param {boolean} mcpEnabled - 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启
 * @returns {Promise<void>}
 */
export async function runOneShotChat(
  config: LlmConfig,
  question: string,
  thinkingLevel?: ThinkingLevel,
  mcpEnabled = true,
): Promise<void> {
  await runOneShotConversation(
    config,
    CHAT_MODE,
    question,
    thinkingLevel,
    mcpEnabled,
  );
}
