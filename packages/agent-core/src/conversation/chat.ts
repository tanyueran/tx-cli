/**
 * conversation/chat：chat 命令的对话能力（Chat 模式）
 * 模式差异收敛为 CHAT_MODE_CONFIG 配置，单次机制复用 session/loop 分层；
 * 终端多轮入口（runReplChat）在 cli 包，由 CLI 组合 ConversationSession 实现
 */
import { runOneShotConversation } from "./one-shot";
import type { ConversationModeConfig } from "./session/mode";
import type { LlmConfig, ThinkingLevel } from "../llm/types";
import type { SessionChannels } from "../channels";

/** chat 命令的基础 system 提示词（人设），经 assembleSessionContext 组装技能清单后下发 */
export const SYSTEM_PROMPT =
  "你是 tx-cli 内置的 AI 助手，用简洁的中文回答问题。";

/** chat 模式配置：只读问答人设，固定不装配 bash、MCP 与写侧工具（write_file / edit_file），问答场景 8 轮足够，思考档位兜底 low */
export const CHAT_MODE_CONFIG: ConversationModeConfig = {
  basePrompt: SYSTEM_PROMPT,
  modeLabel: "对话模式",
  bashEnabled: false,
  // 只读语义由代码强制：剔除写侧工具后不依赖 sandbox.level / sandbox.enabled 配置
  writeToolsEnabled: false,
  maxIterations: 8,
  defaultThinkingLevel: "low",
};

/** runOneShotChat 入参对象 */
interface OneShotChatOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 用户问题 */
  question: string;
  /** 命令行指定的思考档位，未指定时回退配置默认 */
  thinkingLevel?: ThinkingLevel;
  /** 会话通道集合：输入 / 输出 / 交互提示的抽象出口，由各端注入 */
  channels: SessionChannels;
}

/**
 * chat 命令的单次问答（Chat 模式入口），流程复用会话机制的 runOneShotConversation
 * 只读语义由模式配置强制：固定不装配 bash、MCP 与写侧工具，不依赖沙箱档位配置
 * @param {OneShotChatOptions} options - 入参对象（字段说明见接口定义）
 * @returns {Promise<void>}
 */
export async function runOneShotChat({
  llmConfig,
  question,
  thinkingLevel,
  channels,
}: OneShotChatOptions): Promise<void> {
  await runOneShotConversation({
    llmConfig,
    modeConfig: CHAT_MODE_CONFIG,
    userInput: question,
    thinkingLevel,
    mcpEnabled: false,
    channels,
  });
}
