import { streamResponse } from "../../../llm";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ToolDefinition,
} from "../../../llm/types";
import type { ToolResult } from "../../../tools";
import type { RunTurn, TurnOutcome } from "./loop";

/** Responses 回合函数创建参数 */
interface CreateResponsesTurnOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 本轮用户输入（创建时追加进共享历史） */
  userInput: string;
  /**
   * 跨轮共享的对话历史：由调用方（REPL 会话）持有并跨轮传递，
   * 回合函数向其追加用户输入、工具调用与回答，实现多轮上下文衔接
   */
  history: ResponseHistoryItem[];
  /** system 提示词（服务端不留存会话，每轮随请求重传） */
  instructions?: string;
  /** 协议扩展字段（思考参数等），原样透传给 streamResponse */
  extraBody?: Record<string, unknown>;
  /** 可供模型调用的工具定义 */
  tools?: ToolDefinition[];
  /** 回答增量回调，用于实时渲染 */
  onDelta: (text: string) => void;
  /** 深度思考增量回调（可选） */
  onReasoningDelta?: (text: string) => void;
}

/**
 * 创建 Responses API（无状态模式）的回合函数
 * store=false：服务端不留存会话，历史由本地维护、每轮全量发送；
 * 首轮发送用户文本，模型请求工具时向历史追加 function_call / function_call_output 项，
 * 给出回答后追加 assistant 消息（供 REPL 多轮对话的每一轮会话使用）
 * @param {CreateResponsesTurnOptions} options - 创建参数
 * @returns {RunTurn} 回合函数，可传给 runAgentLoop
 */
export function createResponsesTurn(
  options: CreateResponsesTurnOptions,
): RunTurn {
  // 本轮用户输入先入历史：后续 agentic 循环的每次请求都携带完整上下文
  options.history.push({
    type: "message",
    role: "user",
    content: options.userInput,
  });

  return async (
    toolResults: ToolResult[],
    toolsDisabled: boolean,
  ): Promise<TurnOutcome> => {
    // 上一轮模型请求的工具已执行：追加结果项，与历史中的 function_call 靠 callId 配对
    for (const toolResult of toolResults) {
      options.history.push({
        type: "function_call_output",
        callId: toolResult.callId,
        output: toolResult.output,
      });
    }

    const response = await streamResponse({
      llmConfig: options.llmConfig,
      input: options.history,
      instructions: options.instructions,
      extraBody: options.extraBody,
      // 软收敛轮不下发工具定义，迫使模型直接作答
      tools: toolsDisabled ? undefined : options.tools,
      onDelta: options.onDelta,
      onReasoningDelta: options.onReasoningDelta,
    });

    // 模型的回答文本与工具调用都记入历史：无状态模式下服务端不再留存本轮输出
    if (response.reply) {
      options.history.push({
        type: "message",
        role: "assistant",
        content: response.reply,
      });
    }
    if (response.toolCalls.length > 0) {
      for (const call of response.toolCalls) {
        options.history.push({
          type: "function_call",
          callId: call.callId,
          name: call.name,
          arguments: call.arguments,
        });
      }
      return { type: "tool_calls", toolCalls: response.toolCalls };
    }
    return { type: "reply", reply: response.reply };
  };
}
