import pico from "picocolors";
import type { ToolCall } from "../../../types/llm";

/**
 * 创建流式渲染器：正文按原样输出，深度思考内容以暗色流式输出
 * 思考内容懒触发：模型未返回思考增量时不产生任何额外输出
 * @returns {object} 渲染器：onDelta 正文增量、onReasoningDelta 思考增量、endThinking 结束思考块
 */
export function createStreamRenderer() {
  // 上一段输出的流类型：用于在思考块与正文之间插入换行分隔
  let last: "reasoning" | "content" | undefined;
  const endThinking = (): void => {
    if (last === "reasoning") {
      process.stdout.write("\n");
      last = undefined;
    }
  };
  return {
    onDelta: (text: string): void => {
      endThinking();
      process.stdout.write(text);
      last = "content";
    },
    onReasoningDelta: (text: string): void => {
      if (last !== "reasoning") {
        // 首个思考增量：以暗色省略号标记思考块开始
        process.stdout.write(pico.dim("…… "));
      }
      process.stdout.write(pico.dim(text));
      last = "reasoning";
    },
    endThinking,
  };
}

/**
 * 打印工具调用提示：各对话模式共用的渲染样式
 * @param {ToolCall} call - 模型发起的调用请求
 * @returns {void}
 */
export function printToolCall(call: ToolCall): void {
  console.log(pico.cyan(`→ 调用 ${call.name}(${call.arguments})`));
}

/**
 * 生成 agentic loop 的工具调用回调：结束思考块并打印调用提示
 * 各对话模式（单次问答 / REPL）共用的 onToolCall 实现
 * @param {ReturnType<typeof createStreamRenderer>} renderer - 流式渲染器
 * @returns {(call: ToolCall) => void} 可传给 runAgentLoop 的 onToolCall 回调
 */
export function createToolCallLogger(
  renderer: ReturnType<typeof createStreamRenderer>
): (call: ToolCall) => void {
  return (call) => {
    renderer.endThinking();
    printToolCall(call);
  };
}
