import type { ConversationModeConfig } from "../common/mode";

/** chat 命令的基础 system 提示词（人设），经 setupSkillContext 组装技能清单后下发 */
export const SYSTEM_PROMPT = "你是 tx-cli 内置的 AI 助手，用简洁的中文回答问题。";

/** chat 模式配置：只读问答人设，固定不装配 bash（执行任务请用 agent 模式），问答场景 8 轮足够 */
export const CHAT_MODE: ConversationModeConfig = {
  basePrompt: SYSTEM_PROMPT,
  modeLabel: "对话模式",
  bashEnabled: false,
  maxIterations: 8,
};
