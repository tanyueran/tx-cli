import { CancelError } from "../../shared/errors";
import { withTimeout } from "../../shared/timeout";
import type { ToolCall } from "../llm/types";
import type { Tool, ToolOutput, ToolResult } from "./types";

/** 单个工具执行的超时时间（毫秒） */
const TOOL_TIMEOUT_MS = 30_000;

/** 工具输出回传给模型前的截断上限（字符数），防止撑爆上下文 */
const MAX_OUTPUT_CHARS = 8 * 1024;

/**
 * 截断超长输出：超限时保留前段并附加说明，让模型知晓内容不完整
 * @param {string} output - 原始输出
 * @returns {string} 截断后的输出
 */
function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }
  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n...（输出过长已截断，原文共 ${output.length} 字符）`;
}

/**
 * 执行单次工具调用：解析参数、超时兜底、异常转结果、输出截断
 * 执行失败不抛出，而是转为 ok:false 的结果回传模型，由模型自行调整重试，不中断会话；
 * 唯一的例外是用户取消（CancelError，如审批问询中按 Ctrl+C）：原样上抛走取消流程，
 * 避免被包装成失败结果回传后模型继续推进会话，违背用户的中断意图
 * @param {Tool} tool - 目标工具
 * @param {ToolCall} call - 模型发起的调用请求
 * @returns {Promise<ToolResult>} 配好 callId 的执行结果
 * @throws {CancelError} 用户在工具执行期间的交互中主动取消时抛出
 */
export async function executeToolCall(
  tool: Tool,
  call: ToolCall
): Promise<ToolResult> {
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(call.arguments || "{}") as Record<string, unknown>;
  } catch {
    return {
      callId: call.id,
      ok: false,
      output: `参数不是合法的 JSON 对象: ${call.arguments}`,
    };
  }

  let output: ToolOutput;
  try {
    // 超时时长优先取工具自带的 timeoutMs（如 MCP 工具放宽到 60s），缺省用全局值
    const timeoutMs = tool.timeoutMs ?? TOOL_TIMEOUT_MS;
    output = await withTimeout(
      tool.execute(args),
      timeoutMs,
      `工具执行超时（${timeoutMs / 1000}s）`,
    );
  } catch (err) {
    // 用户主动取消不是工具失败：上抛给对话层按取消流程处理（REPL 中断本轮，单次问答退出）
    if (err instanceof CancelError) {
      throw err;
    }
    output = {
      ok: false,
      output: `工具执行失败: ${(err as Error)?.message ?? String(err)}`,
    };
  }
  return {
    callId: call.id,
    ok: output.ok,
    output: truncateOutput(output.output),
  };
}
