import type { ToolDefinition } from "../../types/llm";

/**
 * 工具执行的输出载体：不含调用配对信息（callId 由执行器统一包装）
 */
export interface ToolOutput {
  /** 执行是否成功 */
  ok: boolean;
  /**
   * 回传给模型的内容：成功时为工具输出，失败时为错误说明
   * 失败信息同样回传，模型可据此调整参数重试
   */
  output: string;
}

/**
 * 工具执行结果：ToolOutput 加上调用配对 ID，供回合适配器回传
 */
export interface ToolResult extends ToolOutput {
  /** 对应的工具调用 ID（ToolCall.id），回传结果时用于配对 */
  callId: string;
}

/**
 * 工具接口：在 ToolDefinition（模型可见的定义）之上增加本地执行逻辑
 * 内置工具、技能工具（load_skill）、MCP 工具均实现此接口，不支持运行时动态注册
 */
export interface Tool extends ToolDefinition {
  /**
   * 单工具执行超时（毫秒）：缺省用执行器的全局超时（30s）
   * MCP 等外部工具可放宽（如 60s），由适配层按需声明
   */
  timeoutMs?: number;
  /**
   * 执行工具
   * @param {Record<string, unknown>} args - 模型给出的参数（已解析的 JSON 对象）
   * @returns {Promise<ToolOutput>} 执行输出（成功或失败的说明）
   */
  execute(args: Record<string, unknown>): Promise<ToolOutput>;
}
