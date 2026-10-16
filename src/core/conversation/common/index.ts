/**
 * core/conversation/common 模块的桶导出：对话机制层统一入口（chat、agent 等命令共用）
 * 说明：模块内部文件互相引用（如 turn 适配器引用 loop 的类型）时，仍直接走具体文件
 */
export { runAgentLoop } from "./loop";
export type { RunTurn, TurnOutcome } from "./loop";
export { createChatCompletionsTurn } from "./chat-completions-turn";
export { createResponsesTurn } from "./responses-turn";
export type { ResponsesTurn } from "./responses-turn";
export { DEFAULT_THINKING_LEVEL } from "./constants";
export { buildInitialMessages, buildSystemPrompt } from "./prompt";
export {
  createStreamRenderer,
  createToolCallLogger,
  printToolCall,
} from "./renderer";
export { setupSkillContext } from "./skill-context";
export type { SkillContext } from "./skill-context";
export { resolveThinkingLevel, warnThinkingFallback } from "./thinking";
