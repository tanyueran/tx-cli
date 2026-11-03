/**
 * core/conversation 模块的桶导出：对话机制层统一入口（chat、agent 等命令共用）
 * 目录按职责分层：session 会话装配、loop 回合执行机制、sub-agent 子 Agent、repl 终端交互
 * 说明：模块内部文件互相引用（如 loop 内 responses-turn 引用 loop 的类型）时，仍直接走具体文件
 */
export { runAgentLoop } from "./loop/loop";
export type { RunTurn, TurnOutcome } from "./loop/loop";
export { createResponsesTurn } from "./loop/responses-turn";
export { buildSystemPrompt } from "./session/prompt";
export {
  createStreamRenderer,
  createToolCallLogger,
  printToolCall,
} from "./loop/renderer";
export { runConversationRepl, runReplConversation } from "./repl/repl";
export type { ReplConversationOptions } from "./repl/repl";
export type { ReplOptions } from "./repl/state";
export { runOneShotConversation } from "./one-shot";
export type { OneShotConversationOptions } from "./one-shot";
export type { ConversationModeConfig } from "./session/mode";
export { assembleSessionContext } from "./session/session-assembly";
export {
  attachSubAgentTools,
  createSubAgentRunner,
  filterSubAgentTools,
  SUB_AGENT_TOOL_NAME,
  DEFAULT_SUB_AGENT_MAX_ITERATIONS,
} from "./sub-agent/attach";
export type {
  SubAgentRequest,
  SubAgentRunResult,
  SubAgentRunner,
  SubAgentControl,
} from "./sub-agent/attach";
export {
  createSubAgentDispatcher,
  DEFAULT_MAX_BACKGROUND_NODES,
  SUB_AGENT_TIMEOUT_MS,
  MAX_TASK_CHARS,
  MAX_CONTEXT_CHARS,
} from "./sub-agent/dispatcher";
export {
  createDelegateTaskTool,
  createTaskStatusTool,
  createTaskStopTool,
} from "./sub-agent/tools";
export type {
  SubAgentDispatcher,
  SubAgentDispatchRequest,
  SubAgentDispatchResult,
  SubAgentNodeEvent,
  SubAgentNodeStatus,
  TaskNodeSpec,
  TaskNodeState,
  SubAgentPlan,
} from "./sub-agent/dispatcher";
export type { SubAgentToolHandle } from "./sub-agent/tools";
export type {
  SessionAssembly,
  SessionAssemblyOptions,
  AssembleSessionContextOptions,
} from "./session/session-assembly";
export {
  createConversationRuntime,
  disposeConversationRuntime,
} from "./session/runtime";
export type { ConversationRuntime, ConversationOptions } from "./session/runtime";
