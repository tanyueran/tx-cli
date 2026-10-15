import { streamChat } from "../../llm";
import type {
  ChatMessage,
  LlmConfig,
  ToolCall,
  ToolDefinition,
} from "../../../types/llm";
import type { ToolResult } from "../../tools";
import type { RunTurn, TurnOutcome } from "./loop";

/** Chat Completions 回合函数创建参数 */
interface CreateChatCompletionsTurnParams {
  /** LLM 接入配置 */
  config: LlmConfig;
  /** 初始消息（system + user）；工具调用轮次由本函数内部追加 */
  messages: ChatMessage[];
  /** 可供模型调用的工具定义 */
  tools?: ToolDefinition[];
  /** 协议扩展字段（思考参数等），原样透传给 streamChat */
  extraBody?: Record<string, unknown>;
  /** 回答增量回调，用于实时渲染 */
  onDelta: (text: string) => void;
  /** 深度思考增量回调（可选） */
  onReasoningDelta?: (text: string) => void;
}

/**
 * 创建 Chat Completions（单次问答）模式的回合函数
 * 上下文在本地维护：每轮把 assistant(toolCalls) 与 tool 结果消息追加进 messages 后重发
 * @param {CreateChatCompletionsTurnParams} params - 创建参数
 * @returns {RunTurn} 可传给 runAgentLoop 的回合函数
 */
export function createChatCompletionsTurn(
  params: CreateChatCompletionsTurnParams
): RunTurn {
  // 上一轮模型请求的工具调用：回传结果时需先追加对应的 assistant 消息再逐个配对
  let pendingToolCalls: ToolCall[] = [];

  return async (
    toolResults: ToolResult[],
    disableTools: boolean
  ): Promise<TurnOutcome> => {
    if (pendingToolCalls.length > 0) {
      params.messages.push({
        role: "assistant",
        content: "",
        toolCalls: pendingToolCalls,
      });
      for (const result of toolResults) {
        params.messages.push({
          role: "tool",
          content: result.output,
          toolCallId: result.callId,
        });
      }
    }

    const result = await streamChat({
      config: params.config,
      messages: params.messages,
      // 软收敛轮不下发工具定义，迫使模型直接作答
      tools: disableTools ? undefined : params.tools,
      extraBody: params.extraBody,
      onDelta: params.onDelta,
      onReasoningDelta: params.onReasoningDelta,
    });

    pendingToolCalls = result.toolCalls;
    if (result.toolCalls.length > 0) {
      return { type: "tool_calls", toolCalls: result.toolCalls };
    }
    return { type: "reply", reply: result.reply };
  };
}
