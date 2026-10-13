import type { ToolCall } from "../../types/llm";
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
 * 带超时执行：超时以错误拒绝，由调用方统一转为失败结果
 * @param {Promise<ToolOutput>} promise - 工具执行的 Promise
 * @returns {Promise<ToolOutput>} 工具输出
 */
function withTimeout(promise: Promise<ToolOutput>): Promise<ToolOutput> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`工具执行超时（${TOOL_TIMEOUT_MS / 1000}s）`));
    }, TOOL_TIMEOUT_MS);
  });
  return (async () => {
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  })();
}

/**
 * 执行单次工具调用：解析参数、超时兜底、异常转结果、输出截断
 * 任何失败都不抛出，而是转为 ok:false 的结果回传模型，由模型自行调整重试，不中断会话
 * @param {Tool} tool - 目标工具
 * @param {ToolCall} call - 模型发起的调用请求
 * @returns {Promise<ToolResult>} 配好 callId 的执行结果
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
    output = await withTimeout(tool.execute(args));
  } catch (err) {
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
