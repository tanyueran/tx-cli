import {
  buildSummaryTranscript,
  createLlmSummaryGenerator,
  createSummaryMessage,
  findCompactionSplit,
  generateSummary,
  resolveCompactionConfig,
  shouldCompact,
} from "../../../llm/context";
import type { CompactionConfig, SummaryGenerator } from "../../../llm/context";
import type {
  LlmConfig,
  ResponseHistoryItem,
  TokenUsage,
} from "../../../llm/types";

/** 跳过的原因：功能未配置 / 未达阈值 / 可压缩轮次不足 */
export type CompactionSkipReason = "disabled" | "below-threshold" | "not-enough-turns";

/**
 * 历史切分策略：
 * - user-turns：主会话多轮对话，切分点落在用户提问上（findCompactionSplit）
 * - tool-rounds：子 Agent 单任务多轮工具交互，切分点落在工具调用块边界上（findSubAgentCompactionSplit）
 */
export type CompactionSplitStrategy = "user-turns" | "tool-rounds";

/** 一次压缩尝试的结果 */
export type CompactionOutcome =
  | { status: "skipped"; reason: CompactionSkipReason }
  | {
      status: "compacted";
      /** 压缩前历史条数 */
      beforeMessages: number;
      /** 压缩后历史条数 */
      afterMessages: number;
      /** 被摘要替换掉的历史条数 */
      compactedMessages: number;
      /** 摘要字符数 */
      summaryChars: number;
      /** 摘要请求的用量（服务未返回时为 undefined） */
      usage?: TokenUsage;
    }
  | { status: "failed"; message: string };

/** maybeCompactHistory 入参 */
export interface MaybeCompactOptions {
  /** LLM 接入配置（缺省摘要生成器使用） */
  llmConfig: LlmConfig;
  /** 会话历史：原地替换，保持数组引用（调用方可能持有同一引用） */
  history: ResponseHistoryItem[];
  /** 提前解析好的压缩配置；缺省从 llmConfig.context 解析 */
  config?: CompactionConfig;
  /** 上一轮请求的真实 input token（优先于字符估算） */
  lastInputTokens?: number;
  /** 摘要请求用量回调，供会话层累计（压缩成本同样计入 token 统计） */
  onUsage?: (usage: TokenUsage) => void;
  /** 摘要生成器（测试或自定义实现可注入，缺省走真实 LLM 请求） */
  summaryGenerator?: SummaryGenerator;
  /**
   * 历史切分策略，缺省 user-turns（主会话多轮对话口径）；
   * 子 Agent 传 tool-rounds：历史只有一条用户消息，按用户消息切分永远不触发，需按工具交互轮次切分
   */
  splitStrategy?: CompactionSplitStrategy;
}

/**
 * 必要时压缩会话历史：达到阈值时把早期轮次摘要为一条消息，原地替换 history
 *
 * 只做安全切分（user-turns 策略切分点落在用户提问上、tool-rounds 策略落在工具交互轮次边界上，
 * 均不切断 function_call 与 function_call_output 配对）；
 * 摘要失败时保持原历史不变并把失败原因交给调用方展示，不中断会话；
 * 摘要请求本身的 token 用量经 onUsage 上报，保证统计口径完整
 * @param {MaybeCompactOptions} options - 入参（字段说明见接口定义）
 * @returns {Promise<CompactionOutcome>} 压缩结果：已压缩 / 跳过 / 失败
 */
export async function maybeCompactHistory(
  options: MaybeCompactOptions,
): Promise<CompactionOutcome> {
  const { history } = options;
  const config =
    options.config ?? resolveCompactionConfig(options.llmConfig.context);
  if (!config) {
    return { status: "skipped", reason: "disabled" };
  }
  if (!shouldCompact(history, config, options.lastInputTokens)) {
    return { status: "skipped", reason: "below-threshold" };
  }
  // 压缩区间：user-turns 覆盖 [0, split)；tool-rounds 保留首条用户消息（子任务描述），覆盖 [1, split)
  const isToolRounds = options.splitStrategy === "tool-rounds";
  const split = isToolRounds
    ? findSubAgentCompactionSplit(history, config.keepRecentTurns)
    : findCompactionSplit(history, config.keepRecentTurns);
  if (split === 0) {
    return { status: "skipped", reason: "not-enough-turns" };
  }
  const compactFrom = isToolRounds ? 1 : 0;

  const generator =
    options.summaryGenerator ??
    createLlmSummaryGenerator(options.llmConfig, config.summaryMaxChars);
  try {
    const { summary, usage } = await generateSummary(
      buildSummaryTranscript(history.slice(compactFrom, split)),
      generator,
      config.summaryMaxChars,
    );
    const beforeMessages = history.length;
    const summaryMessage = createSummaryMessage(summary, config.summaryMaxChars);
    // 原地替换早期历史：保留最近轮次原文，压缩区间替换为一条摘要消息
    history.splice(compactFrom, split - compactFrom, summaryMessage);
    if (usage) {
      options.onUsage?.(usage);
    }
    return {
      status: "compacted",
      beforeMessages,
      afterMessages: history.length,
      compactedMessages: split - compactFrom,
      summaryChars: summary.length,
      usage,
    };
  } catch (err) {
    return {
      status: "failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 计算子 Agent 历史的压缩切分点：保留首条用户消息（子任务描述）与最近 N 轮工具交互，
 * 返回压缩区间右边界（绝对索引，压缩区间为 [1, split)）
 *
 * 子 Agent 的历史只有一条用户消息（任务描述），后续是「function_call 块 + function_call_output 块」
 * 交替的工具交互轮次，主会话按用户消息切分的策略永远凑不齐第二个切分点；
 * 因此切分点改为落在工具交互轮次的起点上（function_call 块首项，或其前的 assistant 消息），
 * 绝不拆散 function_call 与 function_call_output 的配对；
 * 安全切分点数不足（≤ 保留轮数）时返回 0（不压缩）
 * @param {ResponseHistoryItem[]} history - 子 Agent 历史（首条为用户任务消息）
 * @param {number} keepRecentTurns - 需要保留的最近工具交互轮数
 * @returns {number} 切分点（保留区起点索引），0 表示不压缩
 */
export function findSubAgentCompactionSplit(
  history: ResponseHistoryItem[],
  keepRecentTurns: number,
): number {
  // 收集安全切分点：紧随用户消息或 function_call_output 之后、且以
  // function_call 或 assistant 消息开头的位置（即一轮新交互的开始）
  const safeCuts: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1];
    const curr = history[i];
    const prevIsBoundary =
      (prev.type === "message" && prev.role === "user") ||
      prev.type === "function_call_output";
    const currStartsRound =
      curr.type === "function_call" ||
      (curr.type === "message" && curr.role === "assistant");
    if (prevIsBoundary && currStartsRound) {
      safeCuts.push(i);
    }
  }
  const keep = Math.max(1, keepRecentTurns);
  if (safeCuts.length <= keep) {
    return 0;
  }
  // 倒数第 keep 个安全切分点：其后的最近 keep 轮交互保持原文
  // （beforeIteration 时点末尾可能是未回传结果的 function_call 块，属于最后一轮，必被保留）
  const split = safeCuts[safeCuts.length - keep];
  return split !== undefined && split > 0 ? split : 0;
}

/**
 * 生成压缩结果提示文本（纯文本，不含颜色，由调用方决定配色）
 * @param {CompactionOutcome} outcome - 压缩结果
 * @returns {string | undefined} 提示文本；跳过的压缩不产生提示
 */
export function formatCompactionNotice(
  outcome: CompactionOutcome,
): string | undefined {
  if (outcome.status === "compacted") {
    return (
      `已压缩上下文：早期 ${outcome.compactedMessages} 条消息 → 1 条摘要` +
      `（${outcome.summaryChars} 字），当前历史 ${outcome.afterMessages} 条`
    );
  }
  if (outcome.status === "failed") {
    return `上下文压缩失败：${outcome.message}（本轮继续使用完整历史）`;
  }
  return undefined;
}
