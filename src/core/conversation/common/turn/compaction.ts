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
}

/**
 * 必要时压缩会话历史：达到阈值时把早期轮次摘要为一条消息，原地替换 history
 *
 * 只做安全切分（切分点落在用户提问上，绝不切断 function_call 与 function_call_output 配对）；
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
  const split = findCompactionSplit(history, config.keepRecentTurns);
  if (split === 0) {
    return { status: "skipped", reason: "not-enough-turns" };
  }

  const generator =
    options.summaryGenerator ??
    createLlmSummaryGenerator(options.llmConfig, config.summaryMaxChars);
  try {
    const { summary, usage } = await generateSummary(
      buildSummaryTranscript(history.slice(0, split)),
      generator,
      config.summaryMaxChars,
    );
    const beforeMessages = history.length;
    const summaryMessage = createSummaryMessage(summary, config.summaryMaxChars);
    // 原地替换早期历史：保留最近轮次原文，首部插入一条摘要消息
    history.splice(0, split, summaryMessage);
    if (usage) {
      options.onUsage?.(usage);
    }
    return {
      status: "compacted",
      beforeMessages,
      afterMessages: history.length,
      compactedMessages: split,
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
