/**
 * cli/conversation/chat：chat 命令的终端多轮对话入口
 * 模式配置与单次入口在 core（CHAT_MODE_CONFIG / runOneShotChat），
 * 本模块只承载终端 REPL 薄包装
 */
import { CHAT_MODE_CONFIG } from "@tx-cli/core";
import type {
  LlmConfig,
  SessionChannels,
  ThinkingLevel,
} from "@tx-cli/core";
import { runReplConversation } from "./repl/repl";

/**
 * chat 命令的多轮对话模式（REPL 入口），会话循环复用终端 runReplConversation
 * 只读语义同单次问答；会话内可用 /think 切换思考档位
 * @param {LlmConfig} llmConfig - LLM 接入配置
 * @param {ThinkingLevel | undefined} thinkingLevel - 初始思考档位，未指定时回退配置默认
 * @param {SessionChannels} channels - 会话通道集合
 * @returns {Promise<void>}
 */
export async function runReplChat(
  llmConfig: LlmConfig,
  thinkingLevel: ThinkingLevel | undefined,
  channels: SessionChannels,
): Promise<void> {
  await runReplConversation({
    llmConfig,
    modeConfig: CHAT_MODE_CONFIG,
    thinkingLevel,
    mcpEnabled: false,
    channels,
  });
}
