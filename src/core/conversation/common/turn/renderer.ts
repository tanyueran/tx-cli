import pico from "picocolors";
import type { ToolCall } from "../../../llm/types";
import type { Tool } from "../../../tools";

/** 思考/loading 状态行的 spinner 动画帧（Claude Code 风格星形序列） */
const SPINNER_FRAMES = ["✻", "✽", "✶", "✷", "✸", "✹"];

/** spinner 帧间隔（毫秒） */
const SPINNER_INTERVAL_MS = 120;

/**
 * 创建流式渲染器：正文按原样输出，深度思考内容以单行状态行展示，
 * 思考结束后原地折叠为一行摘要（「✻ 思考了 N 字」）
 *
 * 状态行固定为「spinner 帧 + 思考中…（+ 字数）」的短格式：单行重绘（\r + 清行）
 * 不依赖多行行数记账，也不会因宽度估算偏差触发 soft wrap 错位——此前多行预览视窗
 * 一旦某行实际渲染宽度超估算就会换行，导致后续「上移 N 行清除」全部错位，
 * 思考残影与正文穿插堆积。思考中 spinner 持续转动，即使无增量也有执行反馈。
 *
 * TTY 下使用 ANSI 光标控制实现原地重绘；非 TTY（重定向、CI、管道）退化为
 * 暗色全量流式输出，不产生任何转义序列。思考内容懒触发：模型未返回思考增量时
 * loading 状态行仅在显式调用 startLoading 后出现。
 *
 * @returns {object} 渲染器：onDelta 正文增量、onReasoningDelta 思考增量、endThinking 结束思考块、ensureNewline 补齐换行、startLoading 启动 loading 动画、stopLoading 收起 loading
 */
export function createStreamRenderer() {
  // 上一段输出的流类型：用于在思考块与正文之间插入换行分隔
  // undefined 表示光标已处于行首（初始状态或刚输出过换行）
  let lastStreamKind: "reasoning" | "content" | undefined;

  const isTTY = Boolean(process.stdout.isTTY);
  let statusShown = false; // 状态行（loading / 思考中）当前是否在屏幕上
  let reasoningChars = 0; // 本次请求的思考内容累计字符数（按码点计），0 表示尚未出现思考
  let spinnerTimer: NodeJS.Timeout | undefined;
  let spinnerFrame = 0;

  /** 绘制状态行：spinner 帧 + 思考文案（出现思考后附带字数），原地单行重绘 */
  const renderStatus = (): void => {
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length];
    const label =
      reasoningChars > 0
        ? `${frame} 思考中… (已思考 ${reasoningChars} 字)`
        : `${frame} 思考中…`;
    process.stdout.write(`\r\x1b[2K${pico.dim(label)}`);
    statusShown = true;
  };

  /** 停止 spinner 动画定时器（不清屏，清屏由调用方按需处理） */
  const stopSpinnerTimer = (): void => {
    if (spinnerTimer === undefined) {
      return;
    }
    clearInterval(spinnerTimer);
    spinnerTimer = undefined;
  };

  /**
   * 启动 loading 动画：模型请求发出后、首个增量到达前的空窗反馈
   * 已启动时幂等；非 TTY 下为空操作。新一轮请求会重置思考字数计数
   * @returns {void}
   */
  const startLoading = (): void => {
    if (!isTTY || spinnerTimer !== undefined) {
      return;
    }
    reasoningChars = 0;
    spinnerFrame = 0;
    renderStatus();
    spinnerTimer = setInterval(() => {
      spinnerFrame++;
      renderStatus();
    }, SPINNER_INTERVAL_MS);
    spinnerTimer.unref?.();
  };

  /**
   * 收起 loading：停动画并清除状态行，兜底用于请求失败 / 取消等无输出场景
   * 正常流式路径由 endThinking 完成折叠，此处幂等无害
   * @returns {void}
   */
  const stopLoading = (): void => {
    stopSpinnerTimer();
    if (isTTY && statusShown) {
      process.stdout.write("\r\x1b[2K");
      statusShown = false;
      lastStreamKind = undefined;
    }
  };

  // 结束思考块：TTY 下停动画、清除状态行并折叠为一行摘要（有思考时）；
  // 非 TTY 下仅补换行。仅在状态行确实输出过时才重置 lastStreamKind，
  // 避免破坏正文的行尾状态（createToolCallLogger 会连续调用 endThinking + ensureNewline）
  const endThinking = (): void => {
    stopSpinnerTimer();
    if (isTTY) {
      if (!statusShown) {
        return;
      }
      process.stdout.write("\r\x1b[2K");
      if (reasoningChars > 0) {
        process.stdout.write(`${pico.dim(`✻ 思考了 ${reasoningChars} 字`)}\n`);
      }
      statusShown = false;
      lastStreamKind = undefined;
      return;
    }
    if (lastStreamKind === "reasoning") {
      process.stdout.write("\n");
      lastStreamKind = undefined;
    }
  };

  return {
    onDelta: (text: string): void => {
      endThinking();
      process.stdout.write(text);
      lastStreamKind = "content";
    },
    onReasoningDelta: (text: string): void => {
      if (!isTTY) {
        // 降级路径（重定向 / CI / 管道）：暗色全量流式，无光标控制
        if (lastStreamKind !== "reasoning") {
          // 首个思考增量：以暗色省略号标记思考块开始
          process.stdout.write(pico.dim("…… "));
        }
        process.stdout.write(pico.dim(text));
        lastStreamKind = "reasoning";
        return;
      }
      if (lastStreamKind === "content") {
        // 正文未换行结束：先补换行再起状态行，避免 \r 重写吞掉刚输出的正文
        process.stdout.write("\n");
        lastStreamKind = undefined;
      }
      if (spinnerTimer === undefined) {
        // 兜底：未经过 startLoading 直接收到思考增量（如子 Agent 单测场景）
        startLoading();
      }
      reasoningChars += [...text].length;
      renderStatus();
      lastStreamKind = "reasoning";
    },
    endThinking,
    // 正文输出后光标停在行尾：切换到非流式输出（工具调用提示等）前补换行
    ensureNewline: (): void => {
      if (lastStreamKind === "content") {
        process.stdout.write("\n");
        lastStreamKind = undefined;
      }
    },
    startLoading,
    stopLoading,
  };
}

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
      const parsedArgs = JSON.parse(call.arguments || "{}");
      if (
        parsedArgs &&
        typeof parsedArgs === "object" &&
        !Array.isArray(parsedArgs)
      ) {
        console.log(pico.cyan(`→ 调用 ${call.name}`));
        console.log(tool.renderCall(parsedArgs));
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
  renderer: ReturnType<typeof createStreamRenderer>,
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
  maxIterations: number,
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
