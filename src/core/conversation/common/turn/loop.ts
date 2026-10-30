import { CancelError, CliError } from "../../../../shared/errors";
import {
  markTurnCancelled,
  runWithTurnCancellation,
} from "../../../../shared/turn-cancel";
import type { ToolCall } from "../../../llm/types";
import { executeToolCall } from "../../../tools";
import type { Tool, ToolResult } from "../../../tools";

/** 单回合结果：模型的最终回答，或新的工具调用请求 */
export type TurnOutcome =
  | { type: "reply"; reply: string }
  | { type: "tool_calls"; toolCalls: ToolCall[] };

/**
 * 回合函数：由两种模式的适配器提供，loop 不感知具体接口
 * @param {ToolResult[]} toolResults - 上一轮工具执行结果（首轮为空数组）
 * @param {boolean} toolsDisabled - 本轮是否禁用工具（软收敛：迫使模型直接作答）
 * @returns {Promise<TurnOutcome>} 最终回答或新的工具调用请求
 */
export type RunTurn = (
  toolResults: ToolResult[],
  toolsDisabled: boolean,
) => Promise<TurnOutcome>;

/** 工具调用轮数默认上限：模式未指定 maxIterations 时回退该值（chat 显式 8、agent 显式 40） */
export const DEFAULT_MAX_ITERATIONS = 8;

/** agentic 循环参数 */
interface AgentLoopOptions {
  /** 回合函数（模式适配器提供） */
  runTurn: RunTurn;
  /** 本轮会话可用的工具列表 */
  tools: Tool[];
  /** 最大迭代轮数，默认 DEFAULT_MAX_ITERATIONS；超出后进入软收敛 */
  maxIterations?: number;
  /** 每次工具调用执行前的回调，用于渲染调用提示（如"→ 调用 read_file(...)"）；附带工具实例供自定义渲染 */
  onToolCall?: (call: ToolCall, tool?: Tool) => void;
  /** 首次进入软收敛轮（达到轮数上限）时的回调，用于向用户提示模型将被迫直接作答 */
  onSoftConverge?: () => void;
}

/**
 * 执行 agentic 循环：请求 → 工具调用 → 回传结果 → 再请求，直到模型给出最终回答
 * 同一轮的多个工具调用并发执行（Promise.all 保证结果顺序与请求一致），总延迟取决于最慢者；
 * 只读工具无共享可变状态，并发安全；有副作用的工具（bash、write_file、edit_file）
 * 经 permission.isSerial 声明在会话级串行队列中依次执行，避免并发读-改-写竞态
 * 达到 maxIterations 后进入软收敛：最后一轮不再下发工具定义，迫使模型基于已有信息作答，
 * 避免硬截断导致用户等了半天什么都没有；
 * 回合级取消传播：整个循环运行在回合取消上下文中，任一工具的用户取消（CancelError）
 * 会标记回合取消——同轮尚未启动的工具、串行队列中排队的任务与待审批的问询全部短路，
 * 正在执行的 Promise 无法终止（JS 限制），照常完成但结果随整体 reject 丢弃
 * @param {AgentLoopOptions} options - 循环参数
 * @returns {Promise<string>} 模型的最终回答文本
 * @throws {CliError} 软收敛轮模型仍请求工具（理论上不可达）时抛出
 * @throws {CancelError} 用户在工具执行期间的交互中取消时抛出（回合中断，交由调用方按取消流程处理）
 */
export async function runAgentLoop(options: AgentLoopOptions): Promise<string> {
  return runWithTurnCancellation(async () => {
    const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const toolMap = new Map(options.tools.map((tool) => [tool.name, tool]));
    let toolResults: ToolResult[] = [];

    for (let iteration = 0; ; iteration++) {
      // 超出轮数上限后禁用工具，软收敛为直接作答
      const toolsDisabled = iteration >= maxIterations;
      if (toolsDisabled) {
        // 首次进入软收敛轮时提示一次：模型将被禁止调用工具，直接基于已有信息作答
        options.onSoftConverge?.();
      }
      // 执行回合函数，把上一轮工具执行结果作为输入反馈给AI
      const outcome = await options.runTurn(toolResults, toolsDisabled);
      if (outcome.type === "reply") {
        return outcome.reply;
      }
      if (toolsDisabled) {
        // 工具定义已不下发，模型不可能发起调用；防御性兜底
        throw new CliError("工具调用轮数已达上限，且模型仍要求调用工具");
      }

      // onToolCall 为同步回调，在各自执行前按序触发提示；未注册工具（模型幻觉）转为失败结果回传，由模型自行纠正
      toolResults = await Promise.all(
        outcome.toolCalls.map(async (call) => {
          const tool = toolMap.get(call.name);
          options.onToolCall?.(call, tool);
          if (!tool) {
            return {
              callId: call.callId,
              ok: false,
              output: `未注册的工具: ${call.name}，请从可用工具中选择`,
            };
          }
          try {
            // 执行工具调用
            return await executeToolCall(tool, call);
          } catch (err) {
            // 用户取消不是工具失败：标记回合取消（同轮排队任务与待审批点全部短路）后原样上抛
            if (err instanceof CancelError) {
              markTurnCancelled();
            }
            throw err;
          }
        }),
      );
    }
  });
}
