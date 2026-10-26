import pico from "picocolors";
import type { ToolCall } from "../../llm/types";
import type { Tool } from "../../tools";

/**
 * 创建流式渲染器：正文按原样输出，深度思考内容以暗色流式输出
 * 思考内容懒触发：模型未返回思考增量时不产生任何额外输出
 * @returns {object} 渲染器：onDelta 正文增量、onReasoningDelta 思考增量、endThinking 结束思考块、ensureNewline 补齐换行
 */
export function createStreamRenderer() {
  // 上一段输出的流类型：用于在思考块与正文之间插入换行分隔
  // undefined 表示光标已处于行首（初始状态或刚输出过换行）
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
    // 正文输出后光标停在行尾：切换到非流式输出（工具调用提示等）前补换行
    ensureNewline: (): void => {
      if (last === "content") {
        process.stdout.write("\n");
        last = undefined;
      }
    },
  };
}

/**
 * 打印工具调用提示：各对话模式共用的渲染样式
 * @param {ToolCall} call - 模型发起的调用请求
 * @returns {void}
 */
/**
 * 打印工具调用提示：优先使用工具自定义渲染（renderCall，如 write_todos 的清单视图），否则打印原始参数
 * 参数解析失败或非对象时回退默认渲染，不影响后续工具执行
 * @param {ToolCall} call - 模型发起的工具调用
 * @param {Tool} [tool] - 调用对应的工具实例（未注册时为 undefined，走默认渲染）
 * @returns {void}
 */
export function printToolCall(call: ToolCall, tool?: Tool): void {
  if (tool?.renderCall) {
    try {
      const args = JSON.parse(call.arguments || "{}");
      if (args && typeof args === "object" && !Array.isArray(args)) {
        console.log(pico.cyan(`→ 调用 ${call.name}`));
        console.log(tool.renderCall(args));
        return;
      }
    } catch {
      // 参数非法 JSON：走默认渲染，实际执行时由执行器返回失败结果
    }
  }
  console.log(pico.cyan(`→ 调用 ${call.name}(${call.arguments})`));
}

/**
 * 生成 agentic loop 的工具调用回调：结束思考块、补齐正文换行后打印调用提示
 * 各对话模式（单次问答 / REPL）共用的 onToolCall 实现
 * @param {ReturnType<typeof createStreamRenderer>} renderer - 流式渲染器
 * @returns {(call: ToolCall, tool?: Tool) => void} 可传给 runAgentLoop 的 onToolCall 回调
 */
export function createToolCallLogger(
  renderer: ReturnType<typeof createStreamRenderer>
): (call: ToolCall, tool?: Tool) => void {
  return (call, tool) => {
    renderer.endThinking();
    renderer.ensureNewline();
    printToolCall(call, tool);
  };
}

/**
 * 生成 agentic loop 的软收敛提示回调：结束思考块、补齐正文换行后打印收敛提示
 * 各对话模式（单次问答 / REPL）共用的 onSoftConverge 实现
 * @param {ReturnType<typeof createStreamRenderer>} renderer - 流式渲染器
 * @param {number} maxIterations - 生效的工具调用轮数上限（提示文案展示用）
 * @returns {() => void} 可传给 runAgentLoop 的 onSoftConverge 回调
 */
export function createSoftConvergeNotice(
  renderer: ReturnType<typeof createStreamRenderer>,
  maxIterations: number
): () => void {
  return () => {
    renderer.endThinking();
    renderer.ensureNewline();
    console.log(
      pico.yellow(
        `已达到工具调用轮数上限（${maxIterations} 轮），AI 将基于已有信息直接作答`,
      ),
    );
  };
}
