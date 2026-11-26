/**
 * CLI 输入通道：REPL 输入行的 TTY 编排（补全面板、Tab 补全、历史回溯）
 * 输入状态机与帧渲染是纯逻辑，放在本包 conversation/repl/input.ts；
 * 本文件只负责终端交互（raw mode、keypress 监听、光标定位、终端恢复）
 */
import readline from "node:readline";
import { CancelError } from "@tanyueran/agent-common";
import { InputAbortedError } from "@tanyueran/agent-core";
import {
  ReplInputController,
  renderReplFrame,
} from "../conversation/repl/input";
import type { InputChannel, InputRequest } from "@tanyueran/agent-core";

/**
 * 判断当前进程是否连接真实终端（stdin 与 stdout 均为 TTY）
 * @returns {boolean} 处于 TTY 时为 true
 */
export function isTerminalTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * 读取一行 REPL 输入（交互入口）：TTY 环境走自研组件（补全面板、Tab 补全、历史回溯），
 * 非 TTY（管道、CI）回退到逐行问答；空输入会被忽略（继续等待），提交值去除首尾空格
 * @param {InputRequest} request - 输入请求（提示文案、建议回调、历史、中断信号、初始草稿）
 * @returns {Promise<string>} 用户输入（trim 后非空）
 * @throws {CancelError} 用户 Ctrl+C/D/Esc 取消，或非 TTY 下输入流关闭（EOF）
 * @throws {InputAbortedError} 输入等待被外部中断（后台任务唤醒），携带当前草稿
 */
export async function readReplLine(request: InputRequest): Promise<string> {
  const interactive = isTerminalTty();
  // 信号已触发：直接以中断失败（携带初始草稿），不再进入等待
  if (request.signal?.aborted) {
    throw new InputAbortedError(request.initialInput ?? "");
  }
  if (!interactive) {
    return readReplLinePlain(request.message);
  }
  return readReplLineTty(request);
}

/**
 * 非 TTY 回退：用 readline question 逐行读取，空输入重新询问
 * @param {string} message - 提示文案
 * @returns {Promise<string>} 用户输入（trim 后非空）
 * @throws {CancelError} 输入流关闭（EOF）时
 */
async function readReplLinePlain(message: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    terminal: false,
  });
  try {
    for (;;) {
      const line = await new Promise<string | null>((resolve) => {
        rl.once("close", () => resolve(null));
        rl.question(message, (answer) => resolve(answer));
      });
      // resolve(null) 仅来自 close 事件（EOF）：视为取消，且接口已关闭不能继续循环
      if (line === null) {
        throw new CancelError();
      }
      const trimmed = line.trim();
      if (trimmed !== "") {
        return trimmed;
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * TTY 交互编排：开启 bracketed paste → raw mode + keypress 事件驱动状态机 → 全帧重绘，
 * 提交/取消时恢复终端状态（关闭 paste、退出 raw mode、移除监听）
 * @param {InputRequest} request - 输入请求（提示文案、建议回调、历史、中断信号、初始草稿）
 * @returns {Promise<string>} 用户输入（trim 后非空）
 * @throws {CancelError} 用户取消
 * @throws {InputAbortedError} 输入等待被外部中断
 */
async function readReplLineTty({
  message,
  suggest,
  history,
  signal,
  initialInput,
}: InputRequest): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const controller = new ReplInputController(
    suggest ?? (() => []),
    history,
    initialInput,
  );

  /** 上一帧绘制结束后光标相对帧首行的物理行偏移（重绘时先回到帧首再清屏） */
  let prevCursorRow = 0;

  /**
   * 全帧重绘：回到上一帧首行 → 光标列归零 → 清屏下方 → 写入整帧 → 按物理行/列定位光标
   * 输入行超出终端宽度会自动换行，因此定位一律使用帧的物理行数（rowCount / cursorRow），
   * 不能用逻辑行数（lineCount）：否则折行后重绘起点逐次下移，旧输入行残留在屏幕上
   * @returns {void}
   */
  const draw = (): void => {
    const frame = renderReplFrame(controller, {
      message,
      columns: stdout.columns || 80,
    });
    // 先回到上一帧首行：折行输入时上一帧光标可能停在中间物理行，
    // 若直接从当前行清屏，帧首以上的旧行无法被重绘覆盖（逐行残留）
    if (prevCursorRow > 0) {
      readline.moveCursor(stdout, 0, -prevCursorRow);
    }
    readline.cursorTo(stdout, 0);
    readline.clearScreenDown(stdout);
    stdout.write(frame.text);
    // 写完帧文本后光标停在最后一个物理行（面板行或输入折行末行），
    // 一次性相对移动到光标所在物理行（向上为负、向下为正），再按列定位
    const rowDelta = frame.cursorRow - (frame.rowCount - 1);
    if (rowDelta !== 0) {
      readline.moveCursor(stdout, 0, rowDelta);
    }
    readline.cursorTo(stdout, frame.cursorColumn);
    prevCursorRow = frame.cursorRow;
  };

  return new Promise<string>((resolve, reject) => {
    /**
     * keypress 处理：驱动状态机并按结果响铃 / 提交 / 取消 / 重绘
     * @param {string | undefined} str - 按键文本
     * @param {readline.Key | undefined} key - 按键元信息
     * @returns {void}
     */
    const onKeypress = (
      str: string | undefined,
      key: readline.Key | undefined,
    ): void => {
      const outcome = controller.keypress(str, key);
      switch (outcome.type) {
        case "submit":
          settle(false);
          return;
        case "cancel":
          settle(true);
          return;
        case "bell":
          stdout.write("\x07");
          return;
        default:
          draw();
      }
    };

    /** 是否已落定：防止按键提交与外部中断并发时重复恢复终端（重复换行等） */
    let settled = false;

    /**
     * 终端恢复：移除监听、退出 raw mode、暂停输入流、关闭 paste、落一行光标
     * @returns {void}
     */
    const teardown = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      stdin.removeListener("keypress", onKeypress);
      stdout.removeListener("resize", draw);
      signal?.removeEventListener("abort", onAbort);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
      // 关闭 bracketed paste 模式
      stdout.write("\x1b[?2004l");
      stdout.write("\n");
    };

    /**
     * 用户按键收尾（提交或取消）：恢复终端后按结果 resolve / reject
     * @param {boolean} cancelled - 是否为用户取消
     * @returns {void}
     */
    const settle = (cancelled: boolean): void => {
      teardown();
      if (cancelled) {
        reject(new CancelError("已取消输入"));
        return;
      }
      resolve(controller.input.trim());
    };

    /**
     * 外部中断收尾（后台任务完成自动唤醒等）：与用户取消相同的终端恢复，
     * 但以 InputAbortedError 拒绝并携带当前草稿，调用方据此还原输入行
     * @returns {void}
     */
    const settleByAbort = (): void => {
      teardown();
      reject(new InputAbortedError(controller.input));
    };

    /** 外部中断信号处理 */
    const onAbort = (): void => {
      settleByAbort();
    };

    signal?.addEventListener("abort", onAbort, { once: true });
    stdin.resume();
    // 开启 bracketed paste 模式：终端粘贴整段发送，由状态机单行化，避免粘贴内换行误提交
    stdout.write("\x1b[?2004h");
    // 让 stdin 逐键触发 keypress 事件
    readline.emitKeypressEvents(stdin);
    if (stdin.isTTY) {
      // 进入原始模式（按键无需回车即可到达）
      stdin.setRawMode(true);
    }
    stdin.on("keypress", onKeypress);
    stdout.on("resize", draw);
    draw();
  });
}

/**
 * CLI 输入通道：把 core 的 InputChannel 接口落到终端实现
 * 非 REPL 场景（仅需一行文本）退化为 readline 逐行问答
 */
export class CliInputChannel implements InputChannel {
  /**
   * 等待用户输入一行文本
   * @param {string | InputRequest} [request] - 提示文案，或完整的输入请求参数
   * @returns {Promise<string>} 用户输入的文本（trim 后非空）
   */
  async readLine(request?: string | InputRequest): Promise<string> {
    const normalized: InputRequest =
      typeof request === "string" ? { message: request } : (request ?? { message: "" });
    if (!normalized.suggest) {
      // 无补全需求的场景：直接用 readline 逐行问答，避免进入 raw mode 状态机
      return readReplLinePlain(normalized.message);
    }
    return readReplLine(normalized);
  }

  /**
   * 判断当前输入端是否处于可交互终端环境
   * CI 与显式 headless 标记下一律视为不可交互
   * @returns {boolean} 可交互时为 true
   */
  isInteractive(): boolean {
    if (process.env.CI || process.env.TX_SANDBOX_HEADLESS) {
      return false;
    }
    return isTerminalTty();
  }

  /**
   * 关闭输入通道（CLI 输入由终端直接管理，无需额外释放）
   * @returns {void}
   */
  close(): void {
    // CLI 输入通道无持有资源
  }
}
