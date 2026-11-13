import pico from "picocolors";
import type { OutputChannel, ToolCallInfo } from "../../channels";
import type { ToolCall } from "../../llm/types";
import type { Tool } from "../../tools";

/**
 * 创建流式渲染器：把思考/正文的流式输出转交给输出通道
 *
 * 渲染的具体形态（TTY 状态行原地重绘、非 TTY 全量降级、颜色）由各端的 OutputChannel 决定，
 * core 只负责把「正文增量 / 思考增量 / 思考结束 / 补换行 / loading」这些语义事件转译过去
 * @param {OutputChannel} output - 输出通道（各端实现）
 * @returns {object} 渲染器：onDelta 正文增量、onReasoningDelta 思考增量、endThinking 结束思考块、ensureNewline 补齐换行、startLoading 启动 loading 动画、stopLoading 收起 loading
 */
export function createStreamRenderer(output: OutputChannel) {
  return {
    onDelta: (text: string): void => {
      output.endThinking();
      output.streamToken(text);
    },
    onReasoningDelta: (text: string): void => {
      output.streamThinking(text);
    },
    endThinking: (): void => {
      output.endThinking();
    },
    // 正文输出后光标停在行尾：切换到非流式输出（工具调用提示等）前补换行
    ensureNewline: (): void => {
      output.ensureNewline();
    },
    startLoading: (): void => {
      output.startLoading();
    },
    stopLoading: (): void => {
      output.stopLoading();
    },
  };
}

/**
 * 构造工具调用信息：优先使用工具自定义渲染（renderCall，如 write_todos 的清单视图），否则回退原始参数
 * 参数解析失败或非对象时不带自定义渲染，不影响后续工具执行
 * @param {ToolCall} call - 模型发起的工具调用
 * @param {Tool} [tool] - 调用对应的工具实例（未注册时为 undefined，走默认渲染）
 * @returns {ToolCallInfo} 工具调用信息（交给输出通道渲染）
 */
export function buildToolCallInfo(
  call: ToolCall,
  tool?: Tool,
): ToolCallInfo {
  if (tool?.renderCall) {
    try {
      const parsedArgs = JSON.parse(call.arguments || "{}");
      if (
        parsedArgs &&
        typeof parsedArgs === "object" &&
        !Array.isArray(parsedArgs)
      ) {
        return {
          name: call.name,
          arguments: call.arguments,
          renderedCall: tool.renderCall(parsedArgs),
        };
      }
    } catch {
      // 参数非法 JSON：走默认渲染，实际执行时由执行器返回失败结果
    }
  }
  return { name: call.name, arguments: call.arguments };
}

/**
 * 生成 agentic loop 的工具调用回调：结束思考块、补齐正文换行后输出调用提示
 * 各对话模式（单次问答 / REPL）共用的 onToolCall 实现
 * @param {ReturnType<typeof createStreamRenderer>} renderer - 流式渲染器
 * @param {OutputChannel} output - 输出通道
 * @returns {(call: ToolCall, tool?: Tool) => void} 可传给 runAgentLoop 的 onToolCall 回调
 */
export function createToolCallLogger(
  renderer: ReturnType<typeof createStreamRenderer>,
  output: OutputChannel,
): (call: ToolCall, tool?: Tool) => void {
  return (call, tool) => {
    renderer.endThinking();
    renderer.ensureNewline();
    output.toolCall(buildToolCallInfo(call, tool));
  };
}

/**
 * 生成 agentic loop 的软收敛提示回调：结束思考块、补齐正文换行后打印收敛提示
 * 各对话模式（单次问答 / REPL）共用的 onSoftConverge 实现
 * @param {ReturnType<typeof createStreamRenderer>} renderer - 流式渲染器
 * @param {OutputChannel} output - 输出通道
 * @param {number} maxIterations - 生效的工具调用轮数上限（提示文案展示用）
 * @returns {() => void} 可传给 runAgentLoop 的 onSoftConverge 回调
 */
export function createSoftConvergeNotice(
  renderer: ReturnType<typeof createStreamRenderer>,
  output: OutputChannel,
  maxIterations: number,
): () => void {
  return () => {
    renderer.endThinking();
    renderer.ensureNewline();
    output.text(
      pico.yellow(
        `已达到工具调用轮数上限（${maxIterations} 轮），AI 将基于已有信息直接作答`,
      ),
    );
  };
}
