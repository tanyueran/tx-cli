/**
 * conversation/repl/panel：REPL 终端展示
 * 启动就绪面板（printReadyPanel）与回合用量表格（printTurnUsage），
 * 以及标签对齐、耗时格式化等展示辅助（formatElapsed 同时被 background 的通知行复用）
 */
import pico from "picocolors";
import { printWarnings } from "../../../shared/warnings";
import { displayWidth } from "../../../shared/string";
import {
  describePricing,
  formatUsageSummary,
  formatUsageTable,
  isEmptyUsage,
} from "../../llm";
import type { LlmPricing, ThinkingLevel, TokenUsage } from "../../llm/types";
import type { ReplOptions } from "./state";
import type { SlashCommand } from "./slash-commands";

/** 面板标签列的目标显示宽度（列数）：全角字符按 2 列计，当前标签最宽为「模型」等 4 列 */
const PANEL_LABEL_WIDTH = 4;
/** 标签列与内容列之间的间隙（空格数） */
const PANEL_LABEL_GAP = 3;

/**
 * 补齐面板标签到统一宽度并拼接列间隙，保证各行内容纵向对齐
 * @param {string} label - 行标签（如「模型」「MCP」「提示」）
 * @returns {string} 补齐后的标签前缀（标签 + 填充空格 + 列间隙）
 */
function padPanelLabel(label: string): string {
  const padding = " ".repeat(
    Math.max(0, PANEL_LABEL_WIDTH - displayWidth(label)),
  );
  return `${label}${padding}${" ".repeat(PANEL_LABEL_GAP)}`;
}

/**
 * 格式化连接耗时展示：不足 1 秒显示毫秒整数，达到 1 秒显示保留一位小数的秒
 * @param {number} ms - 耗时（毫秒）
 * @returns {string} 形如「820ms」「1.8s」的展示文本
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 打印本轮与累计 token 用量：拆成两行并对齐标签，本轮高亮、累计弱化，避免混在一行难以区分
 * 服务未返回 usage（本轮无数据）时不输出噪音
 * @param {TokenUsage} turnUsage - 本轮累计用量（可能包含 agentic 循环的多轮请求）
 * @param {TokenUsage} totalUsage - 会话累计用量
 * @param {LlmPricing} [pricing] - 费用单价配置，未配置时只展示 token
 * @returns {void}
 */
export function printTurnUsage(
  turnUsage: TokenUsage,
  totalUsage: TokenUsage,
  pricing?: LlmPricing,
): void {
  if (isEmptyUsage(turnUsage)) {
    return;
  }
  // 表格展示本轮与累计：标签列对齐，本轮高亮、累计弱化
  console.log(
    formatUsageTable(
      [
        { label: "本轮", usage: turnUsage, emphasis: true },
        { label: "累计", usage: totalUsage },
      ],
      pricing,
    ),
  );
  console.log("");
}

/**
 * 打印 REPL 启动就绪面板：信息分组行（模式/模型/用量/技能/MCP）与命令提示行
 *
 * 命令提示行由斜杠命令注册表按 available 过滤生成（与补全面板、/help 单一事实来源）；
 * 装配阶段警告（技能扫描、沙箱装载、MCP 连接）统一缩进展示在面板下方，默认状态只保留面板主体
 * @param {ReplOptions} options - 启动参数（配置、会话运行时、模式标签）
 * @param {ThinkingLevel} thinkingLevel - 初始思考档位
 * @param {SlashCommand[]} commands - 斜杠命令注册表
 * @param {TokenUsage} usage - 当前会话累计用量
 * @returns {void}
 */
export function printReadyPanel(
  options: ReplOptions,
  thinkingLevel: ThinkingLevel,
  commands: SlashCommand[],
  usage: TokenUsage,
): void {
  const { llmConfig, runtime } = options;
  const { mcpSummary, bootWarnings } = runtime;
  const { catalog, scanWarnings } = runtime.assembly;

  const usageText = isEmptyUsage(usage)
    ? `${formatUsageSummary(usage)} · ${describePricing(llmConfig.pricing)}`
    : `累计 ${formatUsageSummary(usage, llmConfig.pricing)}`;
  const rows: Array<[string, string]> = [
    ["模式", options.modeLabel],
    ["模型", `${llmConfig.model} · 思考 ${thinkingLevel}`],
    ["用量", usageText],
  ];
  if (catalog.size > 0) {
    rows.push(["技能", `${catalog.size} 个`]);
  }
  if (mcpSummary) {
    rows.push([
      "MCP",
      `${mcpSummary.okCount}/${mcpSummary.totalCount} 已连接 · ${mcpSummary.toolCount} 个工具 · ${formatElapsed(mcpSummary.elapsedMs)}`,
    ]);
  }
  for (const [label, rowContent] of rows) {
    console.log(`  ${pico.gray(padPanelLabel(label))}${rowContent}`);
  }

  console.log("");
  const hints = commands
    .filter((command) => command.available)
    .map((command) => command.name);
  hints.push("exit 或 Ctrl+C 退出");
  console.log(
    `  ${pico.gray(padPanelLabel("提示"))}${pico.cyan(hints.join(" · "))}`,
  );

  const allWarnings = [...scanWarnings, ...bootWarnings];
  if (allWarnings.length > 0) {
    console.log("");
    printWarnings(allWarnings, "  ");
  }
}
