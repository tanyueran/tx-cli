import readline from "node:readline";
import pico from "picocolors";
import { CancelError } from "../../../shared/errors";
import {
  displayWidth,
  stripAnsi,
  truncateToWidth,
} from "../../../shared/string";

/** 补全建议项（与 slash-commands 的 SlashSuggestion 结构兼容，可直接传入） */
export interface ReplSuggestion {
  /** 建议主体（含 / 前缀的命令名或技能名） */
  name: string;
  /** 描述（可选） */
  description?: string;
  /** 参数占位说明（可选） */
  args?: string;
}

/** keypress 事件的最小形状（仅取本组件关心的字段，便于单测构造） */
export interface ReplKeyEvent {
  /** 键名（如 return、backspace、up、escape；bracketed paste 为 paste-start/paste-end） */
  name?: string;
  /** 是否伴随 Ctrl 修饰键 */
  ctrl?: boolean;
  /** 是否伴随 Meta/Option 修饰键 */
  meta?: boolean;
  /** 事件附带的文本（与顶层 str 一致，便于单独构造事件） */
  str?: string;
}

/** 单次按键的处理结果：none=普通编辑（需重绘）、bell=响铃、submit=提交输入行、cancel=取消退出 */
export type ReplKeyOutcome =
  | { type: "none" }
  | { type: "bell" }
  | { type: "submit" }
  | { type: "cancel" };

/** 补全面板最多展示的建议条数 */
export const PANEL_LIMIT = 10;

/**
 * 判断码点是否为 UTF-16 低代理（代理对的后半个 code unit）
 * @param {number | undefined} code - 字符码点
 * @returns {boolean} 是否为低代理
 */
function isLowSurrogate(code: number | undefined): boolean {
  return code !== undefined && code >= 0xdc00 && code <= 0xdfff;
}

/**
 * 判断码点是否为 UTF-16 高代理（代理对的前半个 code unit）
 * @param {number | undefined} code - 字符码点
 * @returns {boolean} 是否为高代理
 */
function isHighSurrogate(code: number | undefined): boolean {
  return code !== undefined && code >= 0xd800 && code <= 0xdbff;
}

/**
 * 计算光标左侧上一个字素的起始下标（代理对感知，一次退格/左移跨过整个 emoji）
 * @param {string} input - 当前行内容
 * @param {number} cursor - 当前光标下标
 * @returns {number} 上一字素起始下标（行首时为 0）
 */
function prevGraphemeStart(input: string, cursor: number): number {
  if (cursor <= 0) {
    return 0;
  }
  const prev = input.charCodeAt(cursor - 1);
  if (isLowSurrogate(prev) && isHighSurrogate(input.charCodeAt(cursor - 2))) {
    return cursor - 2;
  }
  return cursor - 1;
}

/**
 * 计算光标处下一个字素的结束下标（代理对感知，一次删除/右移跨过整个 emoji）
 * @param {string} input - 当前行内容
 * @param {number} cursor - 当前光标下标
 * @returns {number} 下一字素结束下标（行尾时为 input.length）
 */
function nextGraphemeEnd(input: string, cursor: number): number {
  if (cursor >= input.length) {
    return input.length;
  }
  if (
    isHighSurrogate(input.charCodeAt(cursor)) &&
    isLowSurrogate(input.charCodeAt(cursor + 1))
  ) {
    return cursor + 2;
  }
  return cursor + 1;
}

/**
 * REPL 自研输入组件的纯状态机：维护当前行、光标、补全面板与输入历史，
 * 不直接触碰终端（渲染与 TTY 编排分别由 renderReplFrame / askReplLine 负责），可脱离 TTY 单测
 */
export class ReplInputController {
  /** 当前行内容 */
  input = "";
  /** 光标在 input 中的下标（按 code unit 计） */
  cursor = 0;
  /** 面板中当前高亮的候选下标 */
  selection = 0;
  /** 用户按 Esc 主动关闭面板的标记（再次编辑时自动重开） */
  dismissed = false;
  /** 面板当前应展示的候选列表（由 suggest 回调产出） */
  suggestions: ReplSuggestion[] = [];

  /** 建议回调：输入行变化时重算候选（cursor 供中途 token 感知场景使用） */
  private readonly suggest: (input: string, cursor: number) => ReplSuggestion[];
  /** 输入历史（调用方持有并追加，本组件只读；可能为 undefined 表示无历史） */
  private readonly history: readonly string[] | undefined;
  /** 历史回溯下标：null 表示不在回溯态 */
  private historyIndex: number | null = null;
  /** 进入历史回溯前的草稿（down 翻到底时恢复） */
  private draft = "";
  /** 是否处于 bracketed paste 接收区间 */
  private inPaste = false;

  /**
   * @param {(input: string, cursor: number) => ReplSuggestion[]} suggest - 建议回调：按当前输入行与光标位置返回候选
   * @param {readonly string[] | undefined} history - 输入历史（调用方持有并追加的数组引用）
   */
  constructor(
    suggest: (input: string, cursor: number) => ReplSuggestion[],
    history?: readonly string[],
  ) {
    this.suggest = suggest;
    this.history = history;
    this.refresh();
  }

  /**
   * 补全面板是否可见：行首以 / 开头（命令与 /skill 二级补全），
   * 或光标左侧 token 以 / 开头（中途技能补全），且未被 Esc 关闭
   */
  get panelVisible(): boolean {
    return (
      (this.input.startsWith("/") || this.cursorToken().startsWith("/")) &&
      !this.dismissed
    );
  }

  /**
   * 取光标左侧的当前 token（以空格为界，与 Tab 补全的 token 口径一致）：
   * 「帮我 /re」光标在词尾时返回 "/re"，「a/b」返回 "a/b"（不以 / 开头，不触发面板）
   * @returns {string} 光标左侧 token
   */
  private cursorToken(): string {
    const tokenStart =
      this.input.lastIndexOf(" ", Math.max(0, this.cursor - 1)) + 1;
    return this.input.slice(tokenStart, this.cursor);
  }

  /**
   * 重算候选列表：高亮复位到第一项，并重新打开面板
   * @returns {void}
   */
  private refresh(): void {
    this.suggestions = this.suggest(this.input, this.cursor);
    this.selection = 0;
    this.dismissed = false;
  }

  /**
   * 退出历史回溯态：当前内容成为新草稿（编辑类按键前调用）
   * @returns {void}
   */
  private leaveHistory(): void {
    this.historyIndex = null;
  }

  /**
   * 面板高亮移动（环绕），↑ 减 ↓ 加由 delta 符号表达
   * @param {number} delta - 移动步长（-1 或 1）
   * @returns {ReplKeyOutcome} 候选为空时 bell，否则 none
   */
  private moveSelection(delta: number): ReplKeyOutcome {
    if (this.suggestions.length === 0) {
      return { type: "bell" };
    }
    const total = this.suggestions.length;
    this.selection = (this.selection + delta + total) % total;
    return { type: "none" };
  }

  /**
   * Tab 补全：用高亮候选替换光标所在 token，
   * 光标在行尾且候选带参数占位时补一个空格便于继续输入
   * @returns {ReplKeyOutcome} 面板不可见或无候选时 bell，否则 none
   */
  private complete(): ReplKeyOutcome {
    if (!this.panelVisible || this.suggestions.length === 0) {
      return { type: "bell" };
    }
    const item = this.suggestions[this.selection];
    const tokenStart =
      this.input.lastIndexOf(" ", Math.max(0, this.cursor - 1)) + 1;
    const atEnd = this.cursor === this.input.length;
    const token = item.name + (atEnd && item.args ? " " : "");
    this.input =
      this.input.slice(0, tokenStart) + token + this.input.slice(this.cursor);
    this.cursor = tokenStart + token.length;
    this.refresh();
    return { type: "none" };
  }

  /**
   * ↑：面板打开时上移高亮；面板关闭时回溯上一条历史（首次进入记住当前草稿）
   * @returns {ReplKeyOutcome} 历史为空或已到顶时 bell，否则 none
   */
  private historyPrev(): ReplKeyOutcome {
    if (!this.history || this.history.length === 0) {
      return { type: "bell" };
    }
    if (this.historyIndex === null) {
      this.draft = this.input;
      this.historyIndex = this.history.length - 1;
    } else if (this.historyIndex > 0) {
      this.historyIndex -= 1;
    } else {
      return { type: "bell" };
    }
    this.input = this.history[this.historyIndex];
    this.cursor = this.input.length;
    this.refresh();
    return { type: "none" };
  }

  /**
   * ↓：面板打开时下移高亮；面板关闭时在历史中后移，翻过最后一条恢复进入前的草稿
   * @returns {ReplKeyOutcome} 不在回溯态时 bell，否则 none
   */
  private historyNext(): ReplKeyOutcome {
    if (this.historyIndex === null || !this.history) {
      return { type: "bell" };
    }
    if (this.historyIndex < this.history.length - 1) {
      this.historyIndex += 1;
      this.input = this.history[this.historyIndex];
    } else {
      this.input = this.draft;
      this.historyIndex = null;
    }
    this.cursor = this.input.length;
    this.refresh();
    return { type: "none" };
  }

  /**
   * 处理一次按键（对应 readline keypress 事件的 str/key 参数）
   * 分发优先级：bracketed paste 边界 → Ctrl+C/D 取消 → 粘贴区单行化插入 → 常规键位
   * @param {string | undefined} str - 按键携带的文本（可打印字符、换行等）
   * @param {ReplKeyEvent | undefined} key - 按键元信息（键名、修饰键）
   * @returns {ReplKeyOutcome} 处理结果（none 时调用方需重绘）
   */
  keypress(
    str: string | undefined,
    key: ReplKeyEvent | undefined,
  ): ReplKeyOutcome {
    const keyName = key?.name;
    // bracketed paste 区间边界：Node 对 \x1b[200~/\x1b[201~ 发出命名事件
    if (keyName === "paste-start") {
      this.inPaste = true;
      return { type: "none" };
    }
    if (keyName === "paste-end") {
      this.inPaste = false;
      return { type: "none" };
    }
    // Ctrl+C：取消本次输入（外层按 CancelError 处理）
    if (key?.ctrl && keyName === "c") {
      return { type: "cancel" };
    }
    // Ctrl+D：仅空输入时视为 EOF 退出；非空时忽略，避免误按丢失已输入内容
    if (key?.ctrl && keyName === "d") {
      return this.input.trim() === "" ? { type: "cancel" } : { type: "none" };
    }
    // 粘贴区间内：单行化插入（换行与 Tab 替换为空格、过滤其余控制字符），
    // 吞掉可能混入的命名键，避免粘贴触发补全/提交
    if (this.inPaste) {
      if (str === undefined) {
        return { type: "none" };
      }
      const flattened = str.replace(/\r\n|\r|\n/g, " ").replace(/\t/g, " ");
      let text = "";
      for (const char of flattened) {
        if (char >= " ") {
          text += char;
        }
      }
      if (text.length > 0) {
        this.insertText(text);
      }
      return { type: "none" };
    }
    switch (keyName) {
      case "return":
      case "enter": {
        if (this.input.trim() === "") {
          return { type: "bell" };
        }
        return { type: "submit" };
      }
      case "backspace": {
        this.leaveHistory();
        const start = prevGraphemeStart(this.input, this.cursor);
        this.input = this.input.slice(0, start) + this.input.slice(this.cursor);
        this.cursor = start;
        this.refresh();
        return { type: "none" };
      }
      case "delete": {
        this.leaveHistory();
        const end = nextGraphemeEnd(this.input, this.cursor);
        this.input = this.input.slice(0, this.cursor) + this.input.slice(end);
        this.refresh();
        return { type: "none" };
      }
      case "left": {
        this.leaveHistory();
        this.cursor = prevGraphemeStart(this.input, this.cursor);
        return { type: "none" };
      }
      case "right": {
        this.leaveHistory();
        this.cursor = nextGraphemeEnd(this.input, this.cursor);
        return { type: "none" };
      }
      case "home": {
        this.leaveHistory();
        this.cursor = 0;
        return { type: "none" };
      }
      case "end": {
        this.leaveHistory();
        this.cursor = this.input.length;
        return { type: "none" };
      }
      case "up": {
        if (this.panelVisible) {
          return this.moveSelection(-1);
        }
        return this.historyPrev();
      }
      case "down": {
        if (this.panelVisible) {
          return this.moveSelection(1);
        }
        return this.historyNext();
      }
      case "tab": {
        return this.complete();
      }
      case "escape": {
        if (this.panelVisible) {
          this.dismissed = true;
          return { type: "none" };
        }
        return { type: "cancel" };
      }
      default:
        break;
    }
    // Ctrl 系行编辑：A/E 行首行尾、U 清到行首、K 清到行尾
    if (key?.ctrl) {
      switch (keyName) {
        case "a": {
          this.leaveHistory();
          this.cursor = 0;
          return { type: "none" };
        }
        case "e": {
          this.leaveHistory();
          this.cursor = this.input.length;
          return { type: "none" };
        }
        case "u": {
          this.leaveHistory();
          this.input = this.input.slice(this.cursor);
          this.cursor = 0;
          this.refresh();
          return { type: "none" };
        }
        case "k": {
          this.leaveHistory();
          this.input = this.input.slice(0, this.cursor);
          this.refresh();
          return { type: "none" };
        }
        default:
          return { type: "none" };
      }
    }
    // 可打印文本插入（排除修饰键组合与控制字符）
    if (!key?.ctrl && !key?.meta && str !== undefined && str >= " ") {
      this.insertText(str);
      return { type: "none" };
    }
    return { type: "none" };
  }

  /**
   * 在光标处插入文本并后移光标，随后重算候选
   * @param {string} text - 待插入文本
   * @returns {void}
   */
  private insertText(text: string): void {
    this.leaveHistory();
    this.input =
      this.input.slice(0, this.cursor) + text + this.input.slice(this.cursor);
    this.cursor += text.length;
    this.refresh();
  }
}

/** renderReplFrame 的渲染选项 */
export interface ReplFrameOptions {
  /** 输入行提示词（可含 ANSI 色码） */
  message: string;
  /** 终端宽度（列数），用于面板行宽预算与光标列 clamp，默认 80 */
  columns?: number;
}

/** 渲染帧：text 为整帧文本（多行以 \n 连接），cursorColumn 为光标列，lineCount 为帧行数 */
export interface ReplFrame {
  /** 整帧文本 */
  text: string;
  /** 光标所在列（已 clamp 到 columns-1） */
  cursorColumn: number;
  /** 帧总行数（重绘上移行数用） */
  lineCount: number;
}

/**
 * 渲染一帧输入行（纯函数，不触碰终端）：首行为提示词 + 当前行文本，
 * 面板可见时下方追加候选列表（居中滑窗 + 超量指示）或「无匹配」占位
 * @param {ReplInputController} controller - 输入状态机
 * @param {ReplFrameOptions} options - 渲染选项（message、columns）
 * @returns {ReplFrame} 帧文本、光标列与行数
 */
export function renderReplFrame(
  controller: ReplInputController,
  { message, columns = 80 }: ReplFrameOptions,
): ReplFrame {
  const promptWidth = displayWidth(stripAnsi(message));
  const cursorColumn = Math.min(
    promptWidth + displayWidth(controller.input.slice(0, controller.cursor)),
    Math.max(0, columns - 1),
  );
  const lines: string[] = [message + controller.input];
  if (controller.panelVisible) {
    if (controller.suggestions.length === 0) {
      lines.push(`  ${pico.gray("无匹配命令，Esc 关闭")}`);
    } else {
      lines.push(...renderPanel(controller, columns));
    }
  }
  return { text: lines.join("\n"), cursorColumn, lineCount: lines.length };
}

/**
 * 渲染候选面板行（内部辅助）：以高亮项为锚的居中滑窗，最多展示 PANEL_LIMIT 条，
 * 窗口外剩余条数以「↑/↓ 还有 N 条」指示
 * @param {ReplInputController} controller - 输入状态机
 * @param {number} columns - 终端宽度（列数）
 * @returns {string[]} 面板各行文本
 */
function renderPanel(
  controller: ReplInputController,
  columns: number,
): string[] {
  const total = controller.suggestions.length;
  const limit = Math.min(PANEL_LIMIT, total);
  // 高亮项尽量位于窗口中部（偏上一位），并 clamp 到合法窗口范围
  const start = Math.min(Math.max(0, controller.selection - 5), total - limit);
  const end = start + limit;
  const rows: string[] = [];
  if (start > 0) {
    rows.push(`  ${pico.gray(`↑ 还有 ${start} 条`)}`);
  }
  for (let i = start; i < end; i += 1) {
    const item = controller.suggestions[i];
    const selected = i === controller.selection;
    const marker = selected ? pico.cyan("❯") : pico.gray("❯");
    rows.push(`  ${marker} ${renderPanelRow(item, selected, columns)}`);
  }
  if (end < total) {
    rows.push(`  ${pico.gray(`↓ 还有 ${total - end} 条`)}`);
  }
  return rows;
}

/**
 * 渲染面板单行：命令标签（含参数占位）+ 描述，按终端宽度预算截断；
 * 描述可用预算过窄（≤4 列）时丢弃描述、仅截断标签
 * @param {ReplSuggestion} item - 候选项
 * @param {boolean} selected - 是否高亮选中
 * @param {number} columns - 终端宽度（列数）
 * @returns {string} 行文本（标签 + 描述，带色码）
 */
function renderPanelRow(
  item: ReplSuggestion,
  selected: boolean,
  columns: number,
): string {
  // 行预算 = columns - 前导 2 空格 - ❯ - 间隙 1 空格（-1 列余量）
  const budget = Math.max(0, columns - 5);
  const label = item.args ? `${item.name} ${item.args}` : item.name;
  const styledLabel = selected ? pico.cyan(label) : label;
  if (item.description === undefined) {
    return styledLabel;
  }
  const descBudget = budget - displayWidth(label) - 2;
  if (descBudget <= 4) {
    const truncated = truncateToWidth(label, budget);
    return selected ? pico.cyan(truncated) : truncated;
  }
  return `${styledLabel}  ${pico.gray(truncateToWidth(item.description, descBudget))}`;
}

/** askReplLine 的入参对象 */
export interface AskReplLineOptions {
  /** 输入行提示词（可含 ANSI 色码） */
  message: string;
  /** 建议回调：按当前输入行与光标位置返回候选列表 */
  suggest: (input: string, cursor: number) => ReplSuggestion[];
  /** 输入历史数组引用（调用方持有并追加；缺省时不支持 ↑/↓ 回溯） */
  history?: string[];
}

/**
 * 读取一行 REPL 输入（交互入口）：TTY 环境走自研组件（补全面板、Tab 补全、历史回溯），
 * 非 TTY（管道、CI）回退到逐行问答；空输入会被忽略（继续等待），提交值去除首尾空格
 * @param {AskReplLineOptions} options - 入参对象（message/suggest/history）
 * @returns {Promise<string>} 用户输入（trim 后非空）
 * @throws {CancelError} 用户 Ctrl+C/D/Esc 取消，或非 TTY 下输入流关闭（EOF）
 */
export async function askReplLine(
  options: AskReplLineOptions,
): Promise<string> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    return askReplLinePlain(options.message);
  }
  return askReplLineTty(options);
}

/**
 * 非 TTY 回退：用 readline question 逐行读取，空输入重新询问
 * @param {string} message - 提示文案
 * @returns {Promise<string>} 用户输入（trim 后非空）
 * @throws {CancelError} 输入流关闭（EOF）时
 */
async function askReplLinePlain(message: string): Promise<string> {
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
 * @param {AskReplLineOptions} options - 入参对象（message/suggest/history）
 * @returns {Promise<string>} 用户输入（trim 后非空）
 * @throws {CancelError} 用户取消
 */
async function askReplLineTty({
  message,
  suggest,
  history,
}: AskReplLineOptions): Promise<string> {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const controller = new ReplInputController(suggest, history);

  /**
   * 全帧重绘：光标回到行首 → 清屏下方 → 写入整帧 → 上移回输入行 → 按列定位
   * 约定：每次 draw 结束后光标都停在帧首行（输入行），因此重绘时无需再上移回帧首，
   * 只需清屏下方重写；若重绘前还上移 (旧行数-1) 行，会越过输入行逐次删除上方会话输出
   * @returns {void}
   */
  const draw = (): void => {
    const frame = renderReplFrame(controller, {
      message,
      columns: stdout.columns || 80,
    });
    readline.cursorTo(stdout, 0);
    readline.clearScreenDown(stdout);
    stdout.write(frame.text);
    // 多行帧（面板可见）写完后光标停在最后一行，先上移回输入行再按列定位，
    // 否则 cursorTo 只改列不改行，光标会落在面板行上、与实际输入位置错开
    if (frame.lineCount > 1) {
      readline.moveCursor(stdout, 0, -(frame.lineCount - 1));
    }
    readline.cursorTo(stdout, frame.cursorColumn);
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

    /**
     * 统一收尾：恢复终端（移除监听、退出 raw mode、暂停输入流、关闭 paste）后
     * 落一行光标，按结果 resolve / reject
     * @param {boolean} cancelled - 是否为用户取消
     * @returns {void}
     */
    const settle = (cancelled: boolean): void => {
      stdin.removeListener("keypress", onKeypress);
      stdout.removeListener("resize", draw);
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
      // 关闭 bracketed paste 模式
      stdout.write("\x1b[?2004l");
      stdout.write("\n");
      if (cancelled) {
        reject(new CancelError("已取消输入"));
        return;
      }
      resolve(controller.input.trim());
    };

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
