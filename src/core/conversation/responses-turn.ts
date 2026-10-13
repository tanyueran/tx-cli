import { streamResponse } from "../llm";
import type { LlmConfig, ToolDefinition } from "../../types/llm";
import type { ToolResult } from "../tools";
import type { RunTurn, TurnOutcome } from "./loop";

/** Responses 回合函数创建参数 */
interface CreateResponsesTurnParams {
  /** LLM 接入配置 */
  config: LlmConfig;
  /** 本轮用户输入（首轮发送的文本） */
  input: string;
  /** system 提示词（previous_response_id 不延续 instructions，每轮需传入） */
  instructions?: string;
  /** 上一轮响应 ID（衔接服务端会话） */
  previousResponseId?: string;
  /** 协议扩展字段（思考参数等），原样透传给 streamResponse */
  extraBody?: Record<string, unknown>;
  /** 可供模型调用的工具定义 */
  tools?: ToolDefinition[];
  /** 回答增量回调，用于实时渲染 */
  onDelta: (text: string) => void;
  /** 深度思考增量回调（可选） */
  onReasoningDelta?: (text: string) => void;
}

/** Responses 模式回合控制器 */
export interface ResponsesTurn {
  /** 回合函数，可传给 runAgentLoop */
  runTurn: RunTurn;
  /** 本次会话最新的响应 ID（供下一轮对话衔接 previousResponseId） */
  getResponseId(): string | undefined;
}

/**
 * 创建 Responses API（REPL store 会话）模式的回合控制器
 * 上下文由服务端维护：首轮发送用户文本，之后每轮只回传 function_call_output，
 * 靠 responseId 链衔接历史（供 REPL 多轮对话的每一轮会话使用）
 * @param {CreateResponsesTurnParams} params - 创建参数
 * @returns {ResponsesTurn} 回合控制器
 */
export function createResponsesTurn(
  params: CreateResponsesTurnParams,
): ResponsesTurn {
  let responseId = params.previousResponseId;
  let isFirstTurn = true;

  const runTurn: RunTurn = async (
    toolResults: ToolResult[],
    disableTools: boolean,
  ): Promise<TurnOutcome> => {
    const result = await streamResponse({
      config: params.config,
      // 首轮发送用户文本；之后发送工具执行结果（function_call_output）
      input: isFirstTurn ? params.input : toolResults,
      instructions: params.instructions,
      previousResponseId: responseId,
      extraBody: params.extraBody,
      // 软收敛轮不下发工具定义，迫使模型直接作答
      tools: disableTools ? undefined : params.tools,
      onDelta: params.onDelta,
      onReasoningDelta: params.onReasoningDelta,
    });
    responseId = result.responseId || responseId;
    isFirstTurn = false;
    if (result.toolCalls.length > 0) {
      return { type: "tool_calls", toolCalls: result.toolCalls };
    }
    return { type: "reply", reply: result.reply };
  };

  return { runTurn, getResponseId: () => responseId };
}
