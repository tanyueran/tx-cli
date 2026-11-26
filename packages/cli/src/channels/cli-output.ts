/**
 * CLI 输出通道：把 core 的 OutputChannel 接口落到终端实现
 * 承担 TTY 状态行原地重绘（思考中 spinner）、非 TTY 的降级全量流式输出与工具调用提示渲染
 */
import pico from "picocolors";
import { formatUsageTable } from "./usage-table";
import type { OutputChannel, ToolCallInfo } from "@tanyueran/agent-core";

/** 思考/loading 状态行的 spinner 动画帧（Claude Code 风格星形序列） */
const SPINNER_FRAMES = ["✻", "✽", "✶", "✷", "✸", "✹"];

/** spinner 帧间隔（毫秒） */
const SPINNER_INTERVAL_MS = 120;

/**
 * 按行首符号为自定义渲染文本补色（core 只产出纯文本，样式由 CLI 展示层添加）：
 * ☑ 已完成任务暗色弱化、◐ 进行中任务黄色高亮，其余行原样输出
 * @param {string} text - 工具自定义渲染文本（如任务清单视图）
 * @returns {string} 着色后的文本
 */
function colorizeRenderedCall(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith("☑ ")) {
        return pico.dim(line);
      }
      if (trimmed.startsWith("◐ ")) {
        return pico.yellow(line);
      }
      return line;
    })
    .join("\n");
}

/**
 * CLI 输出通道：文本经 console 输出，流式思考以单行状态行原地重绘
 *
 * TTY 下使用 ANSI 光标控制实现原地重绘；非 TTY（重定向、CI、管道）退化为
 * 暗色全量流式输出，不产生任何转义序列。思考内容懒触发：模型未返回思考增量时
 * loading 状态行仅在显式调用 startLoading 后出现。
 */
export class CliOutputChannel implements OutputChannel {
  /**
   * 上一段输出的流类型：用于在思考块与正文之间插入换行分隔
   * undefined 表示光标已处于行首（初始状态或刚输出过换行）
   */
  private lastStreamKind: "reasoning" | "content" | undefined = undefined;
  /** 终端是否为 TTY：决定是否使用光标控制原地重绘 */
  private readonly isTTY: boolean = Boolean(process.stdout.isTTY);
  /** 状态行（loading / 思考中）当前是否在屏幕上 */
  private statusShown = false;
  /** 本次请求的思考内容累计字符数（按码点计），0 表示尚未出现思考 */
  private reasoningChars = 0;
  /** spinner 动画定时器 */
  private spinnerTimer: NodeJS.Timeout | undefined = undefined;
  /** spinner 当前帧序号 */
  private spinnerFrame = 0;

  /**
   * 输出普通文本（一行）
   * @param {string} content - 文本内容，可含 ANSI 色码
   * @returns {void}
   */
  text(content: string): void {
    console.log(content);
  }

  /**
   * 输出流式正文增量：先折叠思考状态行，再原样写入正文
   * @param {string} token - 增量文本
   * @returns {void}
   */
  streamToken(token: string): void {
    this.endThinking();
    process.stdout.write(token);
    this.lastStreamKind = "content";
  }

  /**
   * 输出流式思考增量：TTY 下更新状态行，非 TTY 下暗色全量输出
   * @param {string} token - 增量文本
   * @returns {void}
   */
  streamThinking(token: string): void {
    if (!this.isTTY) {
      // 降级路径（重定向 / CI / 管道）：暗色全量流式，无光标控制
      if (this.lastStreamKind !== "reasoning") {
        // 首个思考增量：以暗色省略号标记思考块开始
        process.stdout.write(pico.dim("…… "));
      }
      process.stdout.write(pico.dim(token));
      this.lastStreamKind = "reasoning";
      return;
    }
    if (this.lastStreamKind === "content") {
      // 正文未换行结束：先补换行再起状态行，避免 \r 重写吞掉刚输出的正文
      process.stdout.write("\n");
      this.lastStreamKind = undefined;
    }
    if (this.spinnerTimer === undefined) {
      // 兜底：未经过 startLoading 直接收到思考增量（如子 Agent 单测场景）
      this.startLoading();
    }
    this.reasoningChars += [...token].length;
    this.renderStatus();
    this.lastStreamKind = "reasoning";
  }

  /**
   * 结束思考块：TTY 下停动画、清除状态行并折叠为一行摘要（有思考时）；
   * 非 TTY 下仅补换行。仅在状态行确实输出过时才重置 lastStreamKind，
   * 避免破坏正文的行尾状态
   * @returns {void}
   */
  endThinking(): void {
    this.stopSpinnerTimer();
    if (this.isTTY) {
      if (!this.statusShown) {
        return;
      }
      process.stdout.write("\r\x1b[2K");
      if (this.reasoningChars > 0) {
        process.stdout.write(`${pico.dim(`✻ 思考了 ${this.reasoningChars} 字`)}\n`);
      }
      this.statusShown = false;
      this.lastStreamKind = undefined;
      return;
    }
    if (this.lastStreamKind === "reasoning") {
      process.stdout.write("\n");
      this.lastStreamKind = undefined;
    }
  }

  /**
   * 输出工具调用信息：优先使用工具自定义渲染，否则打印原始参数
   * @param {ToolCallInfo} info - 工具调用信息
   * @returns {void}
   */
  toolCall(info: ToolCallInfo): void {
    if (info.renderedCall) {
      console.log(pico.cyan(`→ 调用 ${info.name}`));
      console.log(colorizeRenderedCall(info.renderedCall));
      return;
    }
    console.log(pico.cyan(`→ 调用 ${info.name}(${info.arguments})`));
  }

  /**
   * 输出工具执行结果摘要（当前 CLI 无额外摘要展示，仅占位）
   * @param {string} _name - 工具名称
   * @param {boolean} _ok - 是否执行成功
   * @param {string} [_summary] - 结果摘要
   * @returns {void}
   */
  toolResult(_name: string, _ok: boolean, _summary?: string): void {
    // CLI 侧工具结果由工具自身的输出承载，此处不重复展示
  }

  /**
   * 输出错误信息（stderr）
   * @param {string} message - 错误文本
   * @returns {void}
   */
  error(message: string): void {
    console.error(pico.red(message));
  }

  /**
   * 输出警告信息（stderr）
   * @param {string} message - 警告文本
   * @returns {void}
   */
  warn(message: string): void {
    console.warn(pico.yellow(message));
  }

  /**
   * 输出系统提示信息（stdout）
   * @param {string} message - 提示文本
   * @returns {void}
   */
  system(message: string): void {
    console.log(pico.cyan(message));
  }

  /**
   * 输出成功信息（stdout）
   * @param {string} message - 成功文本
   * @returns {void}
   */
  success(message: string): void {
    console.log(pico.green(message));
  }

  /**
   * 输出弱化 / 次要信息（stdout）
   * @param {string} message - 次要文本
   * @returns {void}
   */
  dim(message: string): void {
    console.log(pico.dim(message));
  }

  /**
   * 输出用量统计表格
   * @param {import("@tanyueran/agent-core").UsageDisplayInfo} info - 用量展示信息
   * @returns {void}
   */
  usage(info: import("@tanyueran/agent-core").UsageDisplayInfo): void {
    console.log(formatUsageTable(info.rows, info.pricing));
  }

  /**
   * 确保当前行尾有换行（从流式切换到非流式输出前调用）
   * @returns {void}
   */
  ensureNewline(): void {
    if (this.lastStreamKind === "content") {
      process.stdout.write("\n");
      this.lastStreamKind = undefined;
    }
  }

  /**
   * 启动 loading 动画：模型请求发出后、首个增量到达前的空窗反馈
   * 已启动时幂等；非 TTY 下为空操作。新一轮请求会重置思考字数计数
   * @returns {void}
   */
  startLoading(): void {
    if (!this.isTTY || this.spinnerTimer !== undefined) {
      return;
    }
    this.reasoningChars = 0;
    this.spinnerFrame = 0;
    this.renderStatus();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame++;
      this.renderStatus();
    }, SPINNER_INTERVAL_MS);
    this.spinnerTimer.unref?.();
  }

  /**
   * 收起 loading：停动画并清除状态行，兜底用于请求失败 / 取消等无输出场景
   * 正常流式路径由 endThinking 完成折叠，此处幂等无害
   * @returns {void}
   */
  stopLoading(): void {
    this.stopSpinnerTimer();
    if (this.isTTY && this.statusShown) {
      process.stdout.write("\r\x1b[2K");
      this.statusShown = false;
      this.lastStreamKind = undefined;
    }
  }

  /**
   * 绘制状态行：spinner 帧 + 思考文案（出现思考后附带字数），原地单行重绘
   * @returns {void}
   */
  private renderStatus(): void {
    const frame = SPINNER_FRAMES[this.spinnerFrame % SPINNER_FRAMES.length];
    const label =
      this.reasoningChars > 0
        ? `${frame} 思考中… (已思考 ${this.reasoningChars} 字)`
        : `${frame} 思考中…`;
    process.stdout.write(`\r\x1b[2K${pico.dim(label)}`);
    this.statusShown = true;
  }

  /**
   * 停止 spinner 动画定时器（不清屏，清屏由调用方按需处理）
   * @returns {void}
   */
  private stopSpinnerTimer(): void {
    if (this.spinnerTimer === undefined) {
      return;
    }
    clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }
}
