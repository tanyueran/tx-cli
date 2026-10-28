/**
 * conversation/chat：chat 命令的对话能力（Chat 模式）
 * 模式差异收敛为 CHAT_MODE_CONFIG 配置，单次/多轮机制复用 common
 */
import { runOneShotConversation, runReplConversation } from "./common";
import type { ConversationModeConfig } from "./common/mode";
import type { LlmConfig, ThinkingLevel } from "../llm/types";

/** chat 命令的基础 system 提示词（人设），经 setupSkillContext 组装技能清单后下发 */
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
}

/**
 * 单次问答（chat 命令的 Chat 模式入口）：只读问答，轻量工具带——固定不装配 bash 与 MCP，
 * 写侧工具（write_file / edit_file）在装配阶段剔除，只读语义不依赖沙箱档位配置；
 * 沙箱上下文仍创建（只读工具继续受 fs 边界管控），技能照常装配；
 * 思考档位链路：--think > 配置文件（项目 > 全局）> low（轻量兜底，由会话层解析）；
 * 具体流程复用 common 的 runOneShotConversation
 * @param {OneShotChatOptions} options - 入参对象（llmConfig/question/thinkingLevel 字段说明见接口定义）
 * @returns {Promise<void>}
 */
export async function runOneShotChat({
  llmConfig,
  question,
  thinkingLevel,
}: OneShotChatOptions): Promise<void> {
  await runOneShotConversation({
    llmConfig,
    modeConfig: CHAT_MODE_CONFIG,
    userInput: question,
    thinkingLevel,
    mcpEnabled: false,
  });
}

/**
 * 多轮对话模式（REPL，chat 命令的 Chat 模式入口）：只读问答，轻量工具带——固定不装配 bash 与 MCP，
 * 写侧工具（write_file / edit_file）在装配阶段剔除，只读语义不依赖沙箱档位配置；
 * 沙箱上下文仍创建（只读工具继续受 fs 边界管控），技能照常装配；
 * 思考档位链路同单次问答，会话内可用 /think 切换；
 * 会话循环复用 common 的 runReplConversation
 * @param {LlmConfig} llmConfig - LLM 接入配置
 * @param {ThinkingLevel | undefined} thinkingLevel - 初始思考档位，未指定时回退配置默认
 * @returns {Promise<void>}
 */
export async function runReplChat(
  llmConfig: LlmConfig,
  thinkingLevel?: ThinkingLevel,
): Promise<void> {
  await runReplConversation({
    llmConfig,
    modeConfig: CHAT_MODE_CONFIG,
    thinkingLevel,
    mcpEnabled: false,
  });
}
