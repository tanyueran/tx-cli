/**
 * core/conversation/common 模块的桶导出：对话机制层统一入口（chat、agent 等命令共用）
 * 目录按职责分类：runtime 负责会话装配，turn 负责回合执行，repl 负责多轮交互
 * 说明：模块内部文件互相引用（如 turn 适配器引用 loop 的类型）时，仍直接走具体文件
 */
export { runAgentLoop } from "./turn/loop";
export type { RunTurn, TurnOutcome } from "./turn/loop";
export { createResponsesTurn } from "./turn/responses-turn";
export { buildSystemPrompt } from "./runtime/prompt";
export {
  createStreamRenderer,
  createToolCallLogger,
  printToolCall,
} from "./turn/renderer";
export { runConversationRepl, runReplConversation } from "./repl/repl";
export type { ReplOptions, ReplConversationOptions } from "./repl/repl";
export { runOneShotConversation } from "./one-shot";
export type { OneShotConversationOptions } from "./one-shot";
export type { ConversationModeConfig } from "./runtime/mode";
export { setupSkillContext } from "./runtime/skill-context";
export type {
  SkillContext,
  SkillAssemblyOptions,
  SetupSkillContextOptions,
} from "./runtime/skill-context";
export {
  createConversationRuntime,
  disposeConversationRuntime,
} from "./runtime/runtime";
export type { ConversationRuntime, ConversationOptions } from "./runtime/runtime";
