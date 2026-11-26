/**
 * I/O Channel 抽象层
 * core 包通过这组接口与外部交互，不直接依赖 readline / stdout / prompts；
 * CLI、桌面端、云端各自提供实现，core 的会话机制对具体终端无感知
 */
import type { LlmPricing, TokenUsage } from "../llm/types";

/** 工具调用信息（用于 OutputChannel.toolCall） */
export interface ToolCallInfo {
  /** 工具名称 */
  name: string;
  /** 工具参数（JSON 字符串） */
  arguments: string;
  /** 自定义渲染文本（如 write_todos 的清单视图） */
  renderedCall?: string;
}

/** 用量展示信息：表格行数据 + 单价配置（渲染交由输出通道实现） */
export interface UsageDisplayInfo {
  /** 表格数据行（本轮 / 累计 / 本次） */
  rows: Array<{
    /** 行标签（如「本轮」「累计」「本次」） */
    label: string;
    /** 该行用量 */
    usage: TokenUsage;
    /** 是否高亮标签：本轮/本次高亮，累计弱化 */
    emphasis?: boolean;
  }>;
  /** 费用单价配置，未配置时费用列显示 - */
  pricing?: LlmPricing;
}

/** 输出通道：向用户展示内容 */
export interface OutputChannel {
  /**
   * 输出普通文本（一行）
   * @param {string} content - 文本内容，可含 ANSI 色码
   * @returns {void}
   */
  text(content: string): void;
  /**
   * 输出流式正文增量（LLM 逐步生成的正文）
   * @param {string} token - 增量文本
   * @returns {void}
   */
  streamToken(token: string): void;
  /**
   * 输出流式思考增量
   * @param {string} token - 增量文本
   * @returns {void}
   */
  streamThinking(token: string): void;
  /**
   * 结束思考块（补换行、收起状态行）
   * @returns {void}
   */
  endThinking(): void;
  /**
   * 输出工具调用信息
   * @param {ToolCallInfo} info - 工具调用信息
   * @returns {void}
   */
  toolCall(info: ToolCallInfo): void;
  /**
   * 输出工具执行结果摘要
   * @param {string} name - 工具名称
   * @param {boolean} ok - 是否执行成功
   * @param {string} [summary] - 结果摘要
   * @returns {void}
   */
  toolResult(name: string, ok: boolean, summary?: string): void;
  /**
   * 输出错误信息
   * @param {string} message - 错误文本
   * @returns {void}
   */
  error(message: string): void;
  /**
   * 输出警告信息
   * @param {string} message - 警告文本
   * @returns {void}
   */
  warn(message: string): void;
  /**
   * 输出系统提示信息
   * @param {string} message - 提示文本
   * @returns {void}
   */
  system(message: string): void;
  /**
   * 输出成功信息
   * @param {string} message - 成功文本
   * @returns {void}
   */
  success(message: string): void;
  /**
   * 输出弱化 / 次要信息
   * @param {string} message - 次要文本
   * @returns {void}
   */
  dim(message: string): void;
  /**
   * 输出用量统计表格
   * @param {UsageDisplayInfo} info - 用量展示信息
   * @returns {void}
   */
  usage(info: UsageDisplayInfo): void;
  /**
   * 确保当前行尾有换行（从流式切换到非流式输出前调用）
   * @returns {void}
   */
  ensureNewline(): void;
  /**
   * 启动 loading 反馈（模型请求发出后、首个增量到达前的空窗反馈）
   * @returns {void}
   */
  startLoading(): void;
  /**
   * 收起 loading 反馈
   * @returns {void}
   */
  stopLoading(): void;
}

/** 输入建议项（补全面板的一行） */
export interface InputSuggestion {
  /** 建议主体（含 / 前缀的命令名或技能名） */
  name: string;
  /** 描述（可选） */
  description?: string;
  /** 参数占位说明（可选） */
  args?: string;
}

/** 输入请求：一次输入等待的参数集合 */
export interface InputRequest {
  /** 提示文案（如「你 > 」） */
  message: string;
  /** 建议回调：按当前输入行与光标位置返回候选列表 */
  suggest?: (input: string, cursor: number) => InputSuggestion[];
  /** 输入历史数组引用（调用方持有并追加；缺省时不支持 ↑/↓ 回溯） */
  history?: string[];
  /**
   * 中断信号：abort 时安全收尾输入组件并以 InputAbortedError 拒绝，携带当前草稿供调用方还原；
   * 用于「后台任务完成自动唤醒」时打断输入等待
   */
  signal?: AbortSignal;
  /** 初始草稿：预填输入行（被打断后还原未提交内容） */
  initialInput?: string;
}

/** 输入通道：接收用户输入 */
export interface InputChannel {
  /**
   * 等待用户输入一行文本
   * @param {string | InputRequest} [request] - 提示文案，或完整的输入请求参数
   * @returns {Promise<string>} 用户输入的文本（trim 后非空）
   */
  readLine(request?: string | InputRequest): Promise<string>;
  /**
   * 判断当前输入端是否处于可交互终端环境
   *
   * 由各端自行判定（CLI 依 TTY 与 CI 环境变量，云端/桌面端依各自会话形态）；
   * core 只消费该结论，不直接读取进程终端属性
   * @returns {boolean} 可交互时为 true
   */
  isInteractive(): boolean;
  /**
   * 关闭输入通道
   * @returns {void}
   */
  close(): void;
}

/**
 * 交互提示通道：需要用户确认的交互
 *
 * 取消语义契约：用户主动取消（Ctrl+C / Esc 等）时必须抛 CancelError，
 * 以便 core 的回合取消机制（markTurnCancelled / throwIfTurnCancelled）感知到取消并中止整轮；
 * 用户答「否」属正常作答，返回 false 而非抛异常
 */
export interface PromptChannel {
  /**
   * 确认对话（是 / 否）
   * @param {string} message - 提示信息
   * @param {boolean} [initial] - 默认值（默认 false）
   * @returns {Promise<boolean>} 用户选择（true=是，false=否）
   */
  confirm(message: string, initial?: boolean): Promise<boolean>;
  /**
   * 选择对话（从选项中选择一项）
   * @param {string} message - 提示信息
   * @param {Array<{ title: string; value: T }>} choices - 选项列表（value 可为任意类型）
   * @returns {Promise<T>} 用户选择的值
   */
  select<T = string>(
    message: string,
    choices: Array<{ title: string; value: T }>,
  ): Promise<T>;
  /**
   * 输入对话（自由文本输入）
   * @param {string} message - 提示信息
   * @param {string} [defaultValue] - 默认值
   * @returns {Promise<string>} 用户输入的文本
   */
  input(message: string, defaultValue?: string): Promise<string>;
}

/** 会话通道集合：一次会话需要的所有 I/O */
export interface SessionChannels {
  /** 输入通道 */
  input: InputChannel;
  /** 输出通道 */
  output: OutputChannel;
  /** 交互提示通道 */
  prompt: PromptChannel;
}

/** 输入等待被外部中断（非用户取消）：携带打断时的草稿，调用方据此还原输入行 */
export class InputAbortedError extends Error {
  /** 打断时的输入行草稿（可能为空串） */
  readonly draft: string;

  /**
   * @param {string} draft - 打断时的草稿
   */
  constructor(draft: string) {
    super("输入等待被外部中断");
    this.name = "InputAbortedError";
    this.draft = draft;
  }
}
