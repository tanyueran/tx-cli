/**
 * conversation/chat：chat 命令的对话能力（Chat 模式）
 * 模式差异收敛为 CHAT_MODE 配置，单次/多轮机制复用 common
 */
import { runOneShotConversation, runReplConversation } from "./common";
import type { ConversationModeConfig } from "./common/mode";
import type { LlmConfig, ThinkingLevel } from "../llm/types";

/** chat 命令的基础 system 提示词（人设），经 setupSkillContext 组装技能清单后下发 */
export const SYSTEM_PROMPT = "你是 tx-cli 内置的 AI 助手，用简洁的中文回答问题。";

/** chat 模式配置：只读问答人设，固定不装配 bash（执行任务请用 agent 模式），问答场景 8 轮足够 */
export const CHAT_MODE: ConversationModeConfig = {
  basePrompt: SYSTEM_PROMPT,
  modeLabel: "对话模式",
  bashEnabled: false,
  maxIterations: 8,
};

/**
 * 单次问答（chat 命令的 Chat 模式入口）：只读问答，轻量工具带——固定不装配 bash 与 MCP，
 * 沙箱上下文仍创建（只读工具继续受 fs 边界管控），技能照常装配；
 * 具体流程复用 common 的 runOneShotConversation
 * @param {LlmConfig} config - LLM 接入配置
 * @param {string} question - 用户问题
 * @param {ThinkingLevel} thinkingLevel - 思考档位（chat 默认 low，--think 按次覆盖，由命令层解析）
 * @returns {Promise<void>}
 */
export async function runOneShotChat(
  config: LlmConfig,
  question: string,
  thinkingLevel: ThinkingLevel,
): Promise<void> {
  await runOneShotConversation(
    config,
    CHAT_MODE,
    question,
    thinkingLevel,
    false,
  );
}

/**
 * 多轮对话模式（REPL，chat 命令的 Chat 模式入口）：只读问答，轻量工具带——固定不装配 bash 与 MCP，
 * 沙箱上下文仍创建（只读工具继续受 fs 边界管控），技能照常装配；
 * 会话循环复用 common 的 runReplConversation
 * @param {LlmConfig} config - LLM 接入配置
 * @param {ThinkingLevel} thinkingLevel - 初始思考档位（chat 默认 low，会话内可用 /think 切换）
 * @returns {Promise<void>}
 */
export async function runReplChat(
  config: LlmConfig,
  thinkingLevel: ThinkingLevel,
): Promise<void> {
  await runReplConversation(config, CHAT_MODE, thinkingLevel, false);
}
