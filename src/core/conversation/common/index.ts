/**
 * core/conversation/common 模块的桶导出：对话机制层统一入口（chat、agent 等命令共用）
 * 说明：模块内部文件互相引用（如 turn 适配器引用 loop 的类型）时，仍直接走具体文件
 */
export { runAgentLoop } from "./loop";
export type { RunTurn, TurnOutcome } from "./loop";
export { createResponsesTurn } from "./responses-turn";
export { buildSystemPrompt } from "./prompt";
export {
  createStreamRenderer,
  createToolCallLogger,
  printToolCall,
} from "./renderer";
export { runConversationRepl, runReplConversation } from "./repl";
export type { ReplOptions } from "./repl";
export { runOneShotConversation } from "./one-shot";
export type { ConversationModeConfig } from "./mode";
export { setupSkillContext } from "./skill-context";
export type { SkillContext, SkillAssemblyOptions } from "./skill-context";
export {
  createConversationRuntime,
  disposeConversationRuntime,
} from "./runtime";
export type { ConversationRuntime, ConversationOptions } from "./runtime";
