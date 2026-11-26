/**
 * 测试用的会话通道 mock：把输出收集到数组、输入按预设脚本返回、提示按预设结果返回
 * 用于 core 包的会话链路单测，避免触碰真实终端
 */
import type {
  InputChannel,
  InputRequest,
  OutputChannel,
  PromptChannel,
  SessionChannels,
  ToolCallInfo,
  UsageDisplayInfo,
} from "@tanyueran/agent-core";

/** 输出通道的收集记录 */
export interface CapturedOutput {
  /** 输出文本 */
  text?: string;
  /** 工具调用信息 */
  toolCall?: ToolCallInfo;
  /** 用量展示信息 */
  usage?: UsageDisplayInfo;
}

/** mock 输出通道：把各类输出记录到数组，供断言使用 */
export class MockOutputChannel implements OutputChannel {
  /** 记录到的输出序列（按发生顺序） */
  readonly records: CapturedOutput[] = [];
  /** 记录到的文本行（便于直接断言文案） */
  readonly texts: string[] = [];
  /** 是否同时输出到真实 console（便于复用既有的 console 断言写法） */
  private readonly echo: boolean;

  /**
   * @param {object} [options] - 可选配置
   * @param {boolean} [options.echo] - 是否同时输出到真实 console
   */
  constructor(options?: { echo?: boolean }) {
    this.echo = options?.echo ?? false;
  }

  /**
   * 记录一行文本
   * @param {string} content - 文本内容
   * @returns {void}
   */
  text(content: string): void {
    this.records.push({ text: content });
    this.texts.push(content);
    if (this.echo) {
      console.log(content);
    }
  }

  /**
   * 记录流式正文增量
   * @param {string} token - 增量文本
   * @returns {void}
   */
  streamToken(token: string): void {
    this.records.push({ text: token });
  }

  /**
   * 记录流式思考增量
   * @param {string} token - 增量文本
   * @returns {void}
   */
  streamThinking(token: string): void {
    this.records.push({ text: token });
  }

  /**
   * 结束思考块（mock 无状态）
   * @returns {void}
   */
  endThinking(): void {}

  /**
   * 记录工具调用信息
   * @param {ToolCallInfo} info - 工具调用信息
   * @returns {void}
   */
  toolCall(info: ToolCallInfo): void {
    this.records.push({ toolCall: info });
  }

  /**
   * 记录工具执行结果摘要（mock 无额外展示）
   * @param {string} _name - 工具名称
   * @param {boolean} _ok - 是否成功
   * @param {string} [_summary] - 结果摘要
   * @returns {void}
   */
  toolResult(_name: string, _ok: boolean, _summary?: string): void {}

  /**
   * 记录错误输出
   * @param {string} message - 错误文本
   * @returns {void}
   */
  error(message: string): void {
    this.records.push({ text: message });
    this.texts.push(message);
    if (this.echo) {
      console.error(message);
    }
  }

  /**
   * 记录警告输出
   * @param {string} message - 警告文本
   * @returns {void}
   */
  warn(message: string): void {
    this.records.push({ text: message });
    this.texts.push(message);
    if (this.echo) {
      console.warn(message);
    }
  }

  /**
   * 记录系统提示输出
   * @param {string} message - 提示文本
   * @returns {void}
   */
  system(message: string): void {
    this.records.push({ text: message });
    this.texts.push(message);
  }

  /**
   * 记录成功输出
   * @param {string} message - 成功文本
   * @returns {void}
   */
  success(message: string): void {
    this.records.push({ text: message });
    this.texts.push(message);
  }

  /**
   * 记录弱化输出
   * @param {string} message - 次要文本
   * @returns {void}
   */
  dim(message: string): void {
    this.records.push({ text: message });
    this.texts.push(message);
  }

  /**
   * 记录用量展示信息
   * @param {UsageDisplayInfo} info - 用量展示信息
   * @returns {void}
   */
  usage(info: UsageDisplayInfo): void {
    this.records.push({ usage: info });
  }

  /**
   * 补换行（mock 无状态）
   * @returns {void}
   */
  ensureNewline(): void {}

  /**
   * 启动 loading（mock 无状态）
   * @returns {void}
   */
  startLoading(): void {}

  /**
   * 收起 loading（mock 无状态）
   * @returns {void}
   */
  stopLoading(): void {}
}

/** mock 输入通道：按预设脚本依次返回输入 */
export class MockInputChannel implements InputChannel {
  /** 已收到的输入请求 */
  readonly requests: Array<string | InputRequest> = [];

  /**
   * @param {string[]} [script] - 预设输入脚本，依次返回；用尽后返回空串
   * @param {boolean} [interactive] - 是否模拟可交互终端环境（默认 true）
   */
  constructor(
    private readonly script: string[] = [],
    private readonly interactive = true,
  ) {}

  /**
   * 返回脚本中的下一条输入
   * @param {string | InputRequest} [request] - 输入请求
   * @returns {Promise<string>} 预设输入
   */
  async readLine(request?: string | InputRequest): Promise<string> {
    this.requests.push(request ?? "");
    return this.script.shift() ?? "";
  }

  /**
   * 返回预设的可交互状态
   * @returns {boolean} 可交互时为 true
   */
  isInteractive(): boolean {
    return this.interactive;
  }

  /**
   * 关闭输入通道（mock 无状态）
   * @returns {void}
   */
  close(): void {}
}

/** mock 提示通道：按预设结果返回 */
export class MockPromptChannel implements PromptChannel {
  /** 收到的确认问询 */
  readonly confirms: string[] = [];
  /** 收到的选择问询 */
  readonly selects: string[] = [];

  /**
   * @param {boolean} [confirmResult] - 确认问询的固定返回值
   * @param {string} [selectResult] - 选择问询的固定返回值
   */
  constructor(
    private readonly confirmResult = false,
    private readonly selectResult = "deny",
  ) {}

  /**
   * 返回预设的确认结果
   * @param {string} message - 提示信息
   * @param {boolean} [_initial] - 默认值
   * @returns {Promise<boolean>} 预设结果
   */
  async confirm(message: string, _initial = false): Promise<boolean> {
    this.confirms.push(message);
    return this.confirmResult;
  }

  /**
   * 返回预设的选择结果
   * @param {string} message - 提示信息
   * @param {Array<{ title: string; value: T }>} [_choices] - 选项列表
   * @returns {Promise<T>} 预设结果
   */
  async select<T = string>(
    message: string,
    _choices: Array<{ title: string; value: T }>,
  ): Promise<T> {
    this.selects.push(message);
    return this.selectResult as unknown as T;
  }

  /**
   * 返回空文本
   * @param {string} _message - 提示信息
   * @param {string} [_defaultValue] - 默认值
   * @returns {Promise<string>} 空串
   */
  async input(_message: string, _defaultValue?: string): Promise<string> {
    return "";
  }
}

/**
 * 创建一组 mock 会话通道
 * @param {object} [options] - 可选配置
 * @param {string[]} [options.input] - 输入脚本
 * @param {boolean} [options.confirm] - 确认问询返回值
 * @param {string} [options.select] - 选择问询返回值
 * @param {boolean} [options.interactive] - 是否模拟可交互终端环境（默认 true）
 * @returns {SessionChannels & { output: MockOutputChannel; input: MockInputChannel; prompt: MockPromptChannel }} mock 通道集合
 */
export function createMockChannels(options?: {
  input?: string[];
  confirm?: boolean;
  select?: string;
  interactive?: boolean;
}): SessionChannels & {
  output: MockOutputChannel;
  input: MockInputChannel;
  prompt: MockPromptChannel;
} {
  return {
    output: new MockOutputChannel(),
    input: new MockInputChannel(
      options?.input ?? [],
      options?.interactive ?? true,
    ),
    prompt: new MockPromptChannel(options?.confirm ?? false, options?.select ?? "deny"),
  };
}
