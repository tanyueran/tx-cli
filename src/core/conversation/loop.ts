import { CliError } from "../../shared/errors";
import type { ToolCall } from "../../types/llm";
import { executeToolCall } from "../tools";
import type { Tool, ToolResult } from "../tools";

/** 单回合结果：模型的最终回答，或新的工具调用请求 */
export type TurnOutcome =
  | { type: "reply"; reply: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] };

/**
 * 回合函数：由两种模式的适配器提供，loop 不感知具体接口
 * @param {ToolResult[]} toolResults - 上一轮工具执行结果（首轮为空数组）
 * @param {boolean} disableTools - 本轮是否禁用工具（软收敛：迫使模型直接作答）
 * @returns {Promise<TurnOutcome>} 最终回答或新的工具调用请求
 */
export type RunTurn = (
  toolResults: ToolResult[],
  disableTools: boolean
) => Promise<TurnOutcome>;

/** agentic 循环参数 */
interface AgentLoopParams {
  /** 回合函数（模式适配器提供） */
  runTurn: RunTurn;
  /** 本轮会话可用的工具列表 */
  tools: Tool[];
  /** 最大迭代轮数，默认 8；超出后进入软收敛 */
  maxIterations?: number;
  /** 每次工具调用执行前的回调，用于渲染调用提示（如"→ 调用 read_file(...)"） */
  onToolCall?: (call: ToolCall) => void;
}

/**
 * 执行 agentic 循环：请求 → 工具调用 → 回传结果 → 再请求，直到模型给出最终回答
 * 达到 maxIterations 后进入软收敛：最后一轮不再下发工具定义，迫使模型基于已有信息作答，
 * 避免硬截断导致用户等了半天什么都没有
 * @param {AgentLoopParams} params - 循环参数
 * @returns {Promise<string>} 模型的最终回答文本
 * @throws {CliError} 软收敛轮模型仍请求工具（理论上不可达）时抛出
 */
export async function runAgentLoop(params: AgentLoopParams): Promise<string> {
  const maxIterations = params.maxIterations ?? 8;
  const toolMap = new Map(params.tools.map((tool) => [tool.name, tool]));
  let toolResults: ToolResult[] = [];

  for (let iteration = 0; ; iteration++) {
    // 超出轮数上限后禁用工具，软收敛为直接作答
    const disableTools = iteration >= maxIterations;
    const outcome = await params.runTurn(toolResults, disableTools);
    if (outcome.type === "reply") {
      return outcome.reply;
    }
    if (disableTools) {
      // 工具定义已不下发，模型不可能发起调用；防御性兜底
      throw new CliError("工具调用轮数已达上限，且模型仍要求调用工具");
    }

    toolResults = [];
    for (const call of outcome.toolCalls) {
      params.onToolCall?.(call);
      const tool = toolMap.get(call.name);
      // 未注册工具（模型幻觉）：转为失败结果回传，由模型自行纠正
      toolResults.push(
        tool
          ? await executeToolCall(tool, call)
          : {
              callId: call.id,
              ok: false,
              output: `未注册的工具: ${call.name}，请从可用工具中选择`,
            }
      );
    }
  }
}
