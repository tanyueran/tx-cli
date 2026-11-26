/**
 * core/conversation 模块的桶导出：对话机制层统一入口（chat、agent 等命令与各前端共用）
 * 目录按职责分层：session 会话装配与无头多轮会话、loop 回合执行机制、sub-agent 子 Agent；
 * 终端 REPL 在 cli 包（core 不含终端展示依赖），桌面端与云端优先复用 ConversationSession
 * 说明：模块内部文件互相引用（如 loop 内 responses-turn 引用 loop 的类型）时，仍直接走具体文件
 */
export { runAgentLoop } from "./loop/loop";
export type { RunTurn, TurnOutcome } from "./loop/loop";
export { createResponsesTurn } from "./loop/responses-turn";
export { buildSystemPrompt } from "./session/prompt";
export {
  createStreamRenderer,
  createToolCallLogger,
  buildToolCallInfo,
} from "./loop/renderer";
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
export { ConversationSession } from "./session/conversation-session";
export type {
  ConversationSessionOptions,
  ConversationTurnResult,
} from "./session/conversation-session";
export {
  buildBackgroundNotice,
  printTaskEventLines,
  formatElapsed,
} from "./session/background-events";
export { maybeCompactHistory } from "./loop/compaction";
export {
  formatSessionMarkdown,
  writeSessionMarkdown,
} from "./session/session-export";
export type { SessionExportMeta } from "./session/session-export";
export { runOneShotAgent, AGENT_MODE_CONFIG } from "./agent";
export { runOneShotChat, CHAT_MODE_CONFIG } from "./chat";
export { attachSubAgentIfEnabled } from "./sub-agent/attach";
export { MCP_INLINE_TOOL_LIMIT } from "./session/session-assembly";
export { formatCompactionNotice } from "./loop/compaction";
export { createMcpDiscoveryTool } from "../mcp/discovery-tool";
export { TASK_STATUS_TOOL_NAME, TASK_STOP_TOOL_NAME } from "../tools/registry";
export { executeConversationTurn } from "./loop/execute-turn";
