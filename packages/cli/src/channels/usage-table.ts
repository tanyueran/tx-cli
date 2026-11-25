/**
 * cli/channels/usage-table：终端专用的用量表格渲染
 * core 的 llm/usage 只保留用量计算与汇总，表格对齐与着色由 CLI 展示层承担
 */
import pico from "picocolors";
import { displayWidth, padToWidth } from "@tx-cli/shared";
import { estimateCost, formatCost, formatTokenCount } from "@tx-cli/core";
import type { LlmPricing, TokenUsage } from "@tx-cli/core";

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
