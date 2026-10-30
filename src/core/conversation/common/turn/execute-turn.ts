import { createResponsesTurn } from "./responses-turn";
import {
  createStreamRenderer,
  createToolCallLogger,
  createSoftConvergeNotice,
} from "./renderer";
import { runAgentLoop, DEFAULT_MAX_ITERATIONS } from "./loop";
import { resolveResponsesThinkingFields } from "../../../llm";
import type { Tool } from "../../../tools";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
  ThinkingStyle,
} from "../../../llm/types";

/** executeConversationTurn 入参对象 */
export interface ConversationTurnOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 生效的思考档位（经 resolveThinkingLevel 解析） */
  thinkingLevel: ThinkingLevel;
  /** 思考协议风格（经 resolveThinkingStyle 解析） */
  thinkingStyle: ThinkingStyle;
  /** 对话历史：单次会话为本地数组，REPL 跨轮共享，由回合函数向其追加 */
  history: ResponseHistoryItem[];
  /** 本轮用户输入 */
  userInput: string;
  /** system 提示词（无状态模式每轮随请求重传） */
  instructions: string;
  /** 会话可执行工具列表（全量，含未激活的 MCP 工具） */
  tools: Tool[];
  /** 下发给模型的工具清单（MCP 折叠时仅含 discover_mcp_tools 与已激活工具） */
  advertisedTools: Tool[];
  /** 工具调用轮数上限，超出后软收敛为直接作答；缺省 DEFAULT_MAX_ITERATIONS */
  maxIterations?: number;
}

/**
 * 执行一轮对话回合：渲染器 + Responses 回合函数 + agentic loop 的共用 wiring（单次会话与 REPL 每轮共用）
 * 思考档位与协议风格在此折算为协议扩展字段下发；回答与深度思考流式渲染，
 * 工具调用前打印提示行，首次进入软收敛轮时提示用户
 * @param {ConversationTurnOptions} options - 入参对象（字段说明见接口定义）
 * @returns {Promise<string>} 模型的最终回答文本
 */
export async function executeConversationTurn(
  options: ConversationTurnOptions,
): Promise<string> {
  const renderer = createStreamRenderer();
  const runTurn = createResponsesTurn({
    llmConfig: options.llmConfig,
    userInput: options.userInput,
    history: options.history,
    instructions: options.instructions,
    extraBody: resolveResponsesThinkingFields({
      thinkingLevel: options.thinkingLevel,
      thinkingStyle: options.thinkingStyle,
      thinkingEffortMap: options.llmConfig.thinkingEffortMap,
    }),
    tools: options.advertisedTools,
    onDelta: renderer.onDelta,
    onReasoningDelta: renderer.onReasoningDelta,
  });
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  return runAgentLoop({
    runTurn,
    tools: options.tools,
    maxIterations,
    onToolCall: createToolCallLogger(renderer),
    onSoftConverge: createSoftConvergeNotice(renderer, maxIterations),
  });
}
