/**
 * token 用量统计：零值构造、累加、格式化与费用估算
 * 纯计算模块，不做 IO；供对话层（REPL / 单次会话）展示每轮与累计用量
 */
import pico from "picocolors";
import { displayWidth, padToWidth } from "../../shared/string";
import type { LlmPricing, TokenUsage } from "./types";

/**
 * 创建零值用量
 * @returns {TokenUsage} 各字段均为 0 的用量对象
 */
export function createEmptyUsage(): TokenUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  };
}

/**
 * 累加两次用量：返回新对象，不修改入参
 * @param {TokenUsage} base - 基准用量
 * @param {TokenUsage} delta - 需要累加的用量
 * @returns {TokenUsage} 累加后的用量
 */
export function addUsage(base: TokenUsage, delta: TokenUsage): TokenUsage {
  return {
    inputTokens: base.inputTokens + delta.inputTokens,
    outputTokens: base.outputTokens + delta.outputTokens,
    totalTokens: base.totalTokens + delta.totalTokens,
    cachedTokens: base.cachedTokens + delta.cachedTokens,
    reasoningTokens: base.reasoningTokens + delta.reasoningTokens,
  };
}

/**
 * 判断是否产生了有效用量：三个主字段均为 0 时视为无数据（服务未返回 usage）
 * @param {TokenUsage} usage - 待判断的用量
 * @returns {boolean} 是否为空用量
 */
export function isEmptyUsage(usage: TokenUsage): boolean {
  return (
    usage.inputTokens === 0 && usage.outputTokens === 0 && usage.totalTokens === 0
  );
}

/** 用量累加器：多来源 usage 汇入同一份累计，避免「x = addUsage(x, u)」散落各处 */
export interface UsageAccumulator {
  /** 累加一条用量 */
  add(delta: TokenUsage): void;
  /** 当前累计值（只读快照，每次访问返回最新累计） */
  readonly current: TokenUsage;
  /** 清零（REPL /clear 重置会话统计时使用） */
  reset(): void;
}

/**
 * 创建 token 用量累加器：主循环、压缩摘要请求、子 Agent 等多来源的用量统一汇入
 * @returns {UsageAccumulator} 累加器实例
 */
export function createUsageAccumulator(): UsageAccumulator {
  let current = createEmptyUsage();
  return {
    add: (delta) => {
      current = addUsage(current, delta);
    },
    get current() {
      return current;
    },
    reset: () => {
      current = createEmptyUsage();
    },
  };
}

/** 紧凑单位的进位阈值：千（k）与百万（M），与主流 Agent CLI 的用量展示口径一致 */
const THOUSAND = 1_000;
const MILLION = 1_000_000;
const BILLION = 1_000_000_000;

/**
 * 去掉定点小数末尾多余的 0：1.0 → 1，1.5 → 1.5
 * @param {number} value - 数值
 * @param {number} digits - 小数位数
 * @returns {string} 去掉尾零的文本
 */
function trimFixed(value: number, digits: number): string {
  return value.toFixed(digits).replace(/\.0$/, "");
}

/**
 * 格式化 token 数字：大数值使用 k / M / B 紧凑单位，避免长数字挤占终端宽度
 * 小于 1000 原样展示，保留一位小数并去掉尾零
 * @param {number} count - token 数
 * @returns {string} 形如 999、1.2k、3M 的文本
 */
export function formatTokenCount(count: number): string {
  const value = Math.max(0, Math.round(count));
  if (value < THOUSAND) {
    return String(value);
  }
  if (value < MILLION) {
    // 999.95k 四舍五入会变成 1000k，此时进位为 M，避免出现「1000k」
    return value >= 999_950
      ? `${trimFixed(value / MILLION, 1)}M`
      : `${trimFixed(value / THOUSAND, 1)}k`;
  }
  if (value < BILLION) {
    return `${trimFixed(value / MILLION, 1)}M`;
  }
  return `${trimFixed(value / BILLION, 1)}B`;
}

/**
 * 估算费用：仅当配置了对应档位单价时返回，未配置时返回 undefined
 * @param {TokenUsage} usage - 用量
 * @param {LlmPricing | undefined} pricing - 单价配置
 * @returns {number | undefined} 估算费用；无法估算时为 undefined
 */
export function estimateCost(
  usage: TokenUsage,
  pricing: LlmPricing | undefined,
): number | undefined {
  if (!pricing) {
    return undefined;
  }
  const inputPrice = validPrice(pricing.inputPerMillion);
  const outputPrice = validPrice(pricing.outputPerMillion);
  if (inputPrice === undefined && outputPrice === undefined) {
    return undefined;
  }
  return (
    (usage.inputTokens / 1_000_000) * (inputPrice ?? 0) +
    (usage.outputTokens / 1_000_000) * (outputPrice ?? 0)
  );
}

/**
 * 校验单价字段：有限非负数才视为有效
 * @param {number | undefined} value - 配置值
 * @returns {number | undefined} 有效单价或 undefined
 */
function validPrice(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/**
 * 格式化金额：小额保留 4 位小数，其余保留 2 位；小到无法展示时给出下限提示
 * @param {number} cost - 估算费用
 * @param {string} [currency] - 币种符号，缺省 ¥
 * @returns {string} 形如 ¥0.0123 的文本
 */
export function formatCost(cost: number, currency = "¥"): string {
  if (cost > 0 && cost < 0.0001) {
    return `${currency}<0.0001`;
  }
  return `${currency}${cost.toFixed(cost > 0 && cost < 0.01 ? 4 : 2)}`;
}

/**
 * 格式化用量摘要：输入/输出 token，配置单价时附带费用估算
 * @param {TokenUsage} usage - 用量
 * @param {LlmPricing | undefined} pricing - 单价配置
 * @returns {string} 形如「输入 1.2k · 输出 456 · 约 ¥0.0123」的文本
 */
export function formatUsageSummary(
  usage: TokenUsage,
  pricing?: LlmPricing,
): string {
  const tokens = `输入 ${formatTokenCount(usage.inputTokens)} · 输出 ${formatTokenCount(usage.outputTokens)}`;
  const cost = estimateCost(usage, pricing);
  if (cost === undefined) {
    return tokens;
  }
  return `${tokens} · 约 ${formatCost(cost, pricing?.currency)}`;
}

/**
 * 描述费用估算是否可用（REPL 就绪面板展示用）
 * @param {LlmPricing | undefined} pricing - 单价配置
 * @returns {string} 配置状态说明
 */
export function describePricing(pricing?: LlmPricing): string {
  return pricing
    ? "含费用估算"
    : "未配置 llm.pricing，仅统计 token";
}

/** 用量表格数据行 */
export interface UsageTableRow {
  /** 行标签（如「本轮」「累计」「本次」） */
  label: string;
  /** 该行用量 */
  usage: TokenUsage;
  /** 是否高亮标签：本轮/本次高亮，累计弱化 */
  emphasis?: boolean;
}

/**
 * 格式化费用单元格：未配置单价时用 - 表示不估算（用 ASCII 字符避免全角破折号宽度歧义）
 * @param {TokenUsage} usage - 用量
 * @param {LlmPricing} [pricing] - 单价配置
 * @returns {string} 金额文本或 -
 */
function formatCostCell(usage: TokenUsage, pricing?: LlmPricing): string {
  const cost = estimateCost(usage, pricing);
  return cost === undefined ? "-" : formatCost(cost, pricing?.currency);
}

/**
 * 渲染用量表格：项目 / 输入 / 输出 / 费用 四列，按显示宽度对齐以兼容中文全角
 * @param {UsageTableRow[]} rows - 数据行
 * @param {LlmPricing} [pricing] - 单价配置，未配置时费用列显示 -
 * @returns {string} 可直接打印的多行表格文本
 */
export function formatUsageTable(
  rows: UsageTableRow[],
  pricing?: LlmPricing,
): string {
  const headers = ["项目", "输入", "输出", "费用"];
  const cells = rows.map((row) => [
    row.label,
    formatTokenCount(row.usage.inputTokens),
    formatTokenCount(row.usage.outputTokens),
    formatCostCell(row.usage, pricing),
  ]);
  // 列宽按表头与所有单元格的最大显示宽度计算（中文按 2 列计）
  const widths = headers.map((header, index) =>
    Math.max(
      displayWidth(header),
      ...cells.map((cell) => displayWidth(cell[index] ?? "")),
    ),
  );
  const border = (left: string, middle: string, right: string): string =>
    pico.gray(
      `${left}${widths.map((width) => "─".repeat(width + 2)).join(middle)}${right}`,
    );
  const renderRow = (
    values: string[],
    labelColor?: (text: string) => string,
  ): string => {
    const colored = values.map((value, index) => {
      const padded = padToWidth(value, widths[index] ?? 0);
      // 只给首列标签上色：颜色码不参与列宽计算，表格仍保持对齐
      return index === 0 && labelColor ? labelColor(padded) : padded;
    });
    return `${pico.gray("│")} ${colored.join(` ${pico.gray("│")} `)} ${pico.gray("│")}`;
  };

  const lines = [
    border("┌", "┬", "┐"),
    renderRow(headers),
    border("├", "┼", "┤"),
    ...rows.map((row, index) =>
      renderRow(cells[index] ?? [], row.emphasis ? pico.cyan : pico.gray),
    ),
    border("└", "┴", "┘"),
  ];
  return lines.join("\n");
}
