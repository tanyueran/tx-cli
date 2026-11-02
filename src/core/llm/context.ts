import { streamResponse } from "./client";
import type {
  LlmConfig,
  LlmContextConfig,
  ResponseHistoryItem,
  TokenUsage,
} from "./types";

/** 触发压缩的缺省比例：达到上下文窗口的 70% 时压缩 */
export const DEFAULT_COMPACT_RATIO = 0.7;

/** 压缩后保留的缺省轮数：最近 4 轮用户提问保持原文 */
export const DEFAULT_KEEP_RECENT_TURNS = 4;

/** 摘要缺省长度上限（字符） */
export const DEFAULT_SUMMARY_MAX_CHARS = 2_000;

/** 摘要消息的起始标记：导出与人工排查时便于识别压缩产物 */
export const SUMMARY_MARKER = "【历史摘要】";

/** 单条工具输出写入摘要素材时的截断长度（字符）：避免超长日志挤占摘要请求 */
const TRANSCRIPT_TOOL_OUTPUT_LIMIT = 1_000;

/** 归一化后的压缩配置：字段全部有确定值，可直接参与判定 */
export interface CompactionConfig {
  /** 上下文窗口上限（token） */
  maxContextTokens: number;
  /** 触发阈值（token）：由 compactAt 折算 */
  thresholdTokens: number;
  /** 压缩后保留的最近轮数（≥ 1） */
  keepRecentTurns: number;
  /** 摘要长度上限（字符） */
  summaryMaxChars: number;
}

/**
 * 判断配置值是否为有限正数
 * @param {unknown} value - 待判断的配置值
 * @returns {boolean} 有限正数时为 true
 */
function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * 解析并归一化上下文压缩配置：未配置有效的 maxContextTokens 时返回 undefined（功能关闭）
 * compactAt 缺省 0.7；≤1 按窗口比例折算，>1 视为绝对 token 数
 * @param {LlmContextConfig | undefined} raw - 配置文件中的 context 段
 * @returns {CompactionConfig | undefined} 归一化配置；未启用时为 undefined
 */
export function resolveCompactionConfig(
  raw: LlmContextConfig | undefined,
): CompactionConfig | undefined {
  if (!raw || typeof raw !== "object" || !isPositiveNumber(raw.maxContextTokens)) {
    return undefined;
  }
  const maxContextTokens = Math.floor(raw.maxContextTokens);
  const compactAt = isPositiveNumber(raw.compactAt)
    ? raw.compactAt
    : DEFAULT_COMPACT_RATIO;
  // 阈值至少 1 token，且不超过窗口上限，避免配置错误导致每轮都压缩或永不压缩
  const thresholdTokens = Math.min(
    maxContextTokens,
    Math.max(1, Math.floor(compactAt <= 1 ? maxContextTokens * compactAt : compactAt)),
  );
  const keepRecentTurns =
    isPositiveNumber(raw.keepRecentTurns) && raw.keepRecentTurns >= 1
      ? Math.floor(raw.keepRecentTurns)
      : DEFAULT_KEEP_RECENT_TURNS;
  const summaryMaxChars = isPositiveNumber(raw.summaryMaxChars)
    ? Math.max(200, Math.floor(raw.summaryMaxChars))
    : DEFAULT_SUMMARY_MAX_CHARS;
  return { maxContextTokens, thresholdTokens, keepRecentTurns, summaryMaxChars };
}

/**
 * 估算文本的 token 数：按每 2 字符 1 token 的保守口径（偏高于实际，利于提前压缩）
 * 服务端未返回 usage 时的兜底判定依据
 * @param {string} text - 待估算文本
 * @returns {number} 估算 token 数
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(Math.max(0, text.length) / 2);
}

/**
 * 估算整段历史的 token 数：消息正文、工具调用参数与工具结果全部计入
 * @param {ResponseHistoryItem[]} history - 对话历史
 * @returns {number} 估算 token 数
 */
export function estimateHistoryTokens(history: ResponseHistoryItem[]): number {
  let chars = 0;
  for (const item of history) {
    if (item.type === "message") {
      chars += item.content.length;
    } else if (item.type === "function_call") {
      chars += item.arguments.length + item.name.length;
    } else {
      chars += item.output.length;
    }
  }
  return Math.ceil(Math.max(0, chars) / 2);
}

/**
 * 判断当前历史是否需要压缩
 * 优先使用上一轮请求的真实 input token（含系统提示与工具定义，口径最准）；
 * 服务未返回 usage 时回退字符估算（仅计历史，可能略低估）
 * @param {ResponseHistoryItem[]} history - 对话历史
 * @param {CompactionConfig} config - 压缩配置
 * @param {number} [lastInputTokens] - 上一轮请求的真实 input token 数
 * @returns {boolean} 达到阈值时为 true
 */
export function shouldCompact(
  history: ResponseHistoryItem[],
  config: CompactionConfig,
  lastInputTokens?: number,
): boolean {
  const usedTokens =
    lastInputTokens && lastInputTokens > 0
      ? lastInputTokens
      : estimateHistoryTokens(history);
  return usedTokens >= config.thresholdTokens;
}

/**
 * 计算压缩切分点：保留最近 N 轮用户提问，返回需要被压缩掉的历史项数
 *
 * 切分点始终落在 user 消息上，因此不会切断 function_call 与 function_call_output 的配对；
 * 可压缩轮次不足 N+1 轮时返回 0（不压缩）
 * @param {ResponseHistoryItem[]} history - 对话历史
 * @param {number} keepRecentTurns - 需要保留的最近轮数
 * @returns {number} 切分索引；0 表示没有可压缩的完整轮次
 */
export function findCompactionSplit(
  history: ResponseHistoryItem[],
  keepRecentTurns: number,
): number {
  const userIndices: number[] = [];
  history.forEach((item, index) => {
    if (item.type === "message" && item.role === "user") {
      userIndices.push(index);
    }
  });
  if (userIndices.length <= Math.max(1, keepRecentTurns)) {
    return 0;
  }
  // 倒数第 keepRecentTurns 个用户消息的位置：它之前的完整轮次进入摘要
  const split = userIndices[userIndices.length - Math.max(1, keepRecentTurns)];
  return split !== undefined && split > 0 ? split : 0;
}

/**
 * 截断超长文本并标注原长度
 * @param {string} text - 原文
 * @param {number} limit - 最大字符数
 * @returns {string} 截断后的文本
 */
function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}…（已截断，原长度 ${text.length} 字符）`;
}

/**
 * 把早期历史拼接为摘要素材：按角色与工具调用顺序逐项展开
 * @param {ResponseHistoryItem[]} history - 待压缩的历史片段
 * @returns {string} 摘要素材文本
 */
export function buildSummaryTranscript(history: ResponseHistoryItem[]): string {
  return history
    .map((item) => {
      if (item.type === "message") {
        return `${item.role === "user" ? "用户" : "助手"}：${item.content}`;
      }
      if (item.type === "function_call") {
        return `工具调用 ${item.name}(${item.arguments})`;
      }
      return `工具结果：${truncateText(item.output, TRANSCRIPT_TOOL_OUTPUT_LIMIT)}`;
    })
    .join("\n\n");
}

/** 摘要生成结果：摘要正文与本次摘要请求的用量 */
export interface SummaryResult {
  /** 摘要正文 */
  summary: string;
  /** 摘要请求的 token 用量（服务未返回 usage 时为空） */
  usage?: TokenUsage;
}

/** 摘要生成器：由调用方注入，便于测试与替换实现 */
export type SummaryGenerator = (transcript: string) => Promise<SummaryResult>;

/**
 * 构造摘要提示词：约束摘要必须保留后续对话所需的信息，避免只做泛泛概括
 * @param {number} summaryMaxChars - 摘要长度上限（字符）
 * @returns {string} system 提示词
 */
function buildSummaryInstructions(summaryMaxChars: number): string {
  return [
    "你是会话上下文压缩助手。阅读用户提供的对话记录，输出一份供同一会话后续轮次继续使用的摘要。",
    "要求：",
    "1. 保留用户的目标、关键约束与偏好；",
    "2. 保留已经得出的结论、决定与产出（如文件路径、命令、关键代码片段、数据结果）；",
    "3. 保留未完成事项、待解决问题与下一步计划；",
    "4. 省略寒暄、重复过程与无关细节，不要编造记录中没有的内容；",
    `5. 只输出摘要正文，不要加前言、不要复述本提示，控制在 ${summaryMaxChars} 字以内。`,
  ].join("\n");
}

/**
 * 默认摘要生成器：用无工具的单次请求压缩早期历史（不流式展示，静默收集文本）
 * @param {LlmConfig} llmConfig - LLM 接入配置
 * @param {number} [summaryMaxChars] - 摘要长度上限（字符），写入提示词约束输出长度
 * @returns {SummaryGenerator} 摘要生成器
 */
export function createLlmSummaryGenerator(
  llmConfig: LlmConfig,
  summaryMaxChars: number = DEFAULT_SUMMARY_MAX_CHARS,
): SummaryGenerator {
  return async (transcript: string): Promise<SummaryResult> => {
    let summary = "";
    const response = await streamResponse({
      llmConfig,
      input: [{ type: "message", role: "user", content: transcript }],
      instructions: buildSummaryInstructions(summaryMaxChars),
      onDelta: (delta) => {
        summary += delta;
      },
    });
    return { summary: summary.trim(), usage: response.usage };
  };
}

/**
 * 构造摘要消息：以 user 角色放在历史首部，确保压缩后首项仍为 user（兼容性最好）
 * @param {string} summary - 摘要正文
 * @param {number} summaryMaxChars - 摘要长度上限（字符）
 * @returns {ResponseHistoryItem} 历史项
 */
export function createSummaryMessage(
  summary: string,
  summaryMaxChars: number,
): ResponseHistoryItem {
  const body = truncateText(summary.trim(), summaryMaxChars);
  return {
    type: "message",
    role: "user",
    content: `${SUMMARY_MARKER}（此前对话已压缩为以下摘要，用于延续上下文）\n\n${body}`,
  };
}

/**
 * 生成会话摘要：调用注入的生成器，空摘要视为失败（避免插入空消息污染上下文）
 * @param {string} transcript - 摘要素材
 * @param {SummaryGenerator} generator - 摘要生成器
 * @param {number} summaryMaxChars - 摘要长度上限（字符）
 * @returns {Promise<SummaryResult>} 非空摘要与用量
 * @throws {Error} 生成器返回空摘要时抛出
 */
export async function generateSummary(
  transcript: string,
  generator: SummaryGenerator,
  summaryMaxChars: number,
): Promise<SummaryResult> {
  const result = await generator(transcript);
  const summary = result.summary.trim();
  if (!summary) {
    throw new Error("摘要生成为空");
  }
  return {
    summary: truncateText(summary, summaryMaxChars),
    usage: result.usage,
  };
}
