import { executeConversationTurn } from "./loop/execute-turn";
import {
  createConversationRuntime,
  disposeConversationRuntime,
} from "./session/runtime";
import type { ConversationModeConfig } from "./session/mode";
import { printWarnings } from "@tx-cli/shared";
import {
  createUsageAccumulator,
  formatUsageTable,
  isEmptyUsage,
  resolveResponsesThinkingFields,
  resolveThinkingLevel,
  resolveThinkingStyle,
  warnThinkingFallback,
} from "../llm";
import { attachSubAgentIfEnabled } from "./sub-agent/attach";
import type { SandboxCliOptions } from "../sandbox";
import type {
  LlmConfig,
  LlmPricing,
  ResponseHistoryItem,
  ThinkingLevel,
  ThinkingStyle,
  TokenUsage,
} from "../llm/types";

/** runOneShotConversation 入参对象 */
export interface OneShotConversationOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 模式配置（人设、标签、工具带装配策略，差异项说明见 ConversationModeConfig） */
  modeConfig: ConversationModeConfig;
  /** 用户问题或任务 */
  userInput: string;
  /** 命令行指定的思考档位，未指定时回退配置默认 */
  thinkingLevel?: ThinkingLevel;
  /** 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启 */
  mcpEnabled?: boolean;
  /** CLI 传入的沙箱选项（agent 命令的 --sandbox 等），缺省按配置文件装配 */
  cliSandboxOptions?: SandboxCliOptions;
}

/** 单次会话的思考配置：档位、协议风格与 Responses 扩展字段（一次性解析，会话内不变） */
interface OneShotThinking {
  /** 生效思考档位 */
  level: ThinkingLevel;
  /** 思考协议风格 */
  style: ThinkingStyle;
  /** Responses API 思考扩展字段 */
  fields: Record<string, unknown> | undefined;
}

/**
 * 解析单次会话的思考配置：CLI 档位 → 配置默认 → 人设缺省，
 * 并打印服务能力折算警告（服务不支持分档思考时避免用户误以为档位真实生效）
 * @param {LlmConfig} llmConfig - LLM 接入配置
 * @param {ConversationModeConfig} modeConfig - 模式配置（提供默认档位回退）
 * @param {ThinkingLevel} [cliLevel] - 命令行指定的思考档位
 * @returns {OneShotThinking} 解析后的思考配置
 */
function resolveOneShotThinking(
  llmConfig: LlmConfig,
  modeConfig: ConversationModeConfig,
  cliLevel?: ThinkingLevel,
): OneShotThinking {
  const level = resolveThinkingLevel({
    cliLevel,
    llmConfig,
    fallback: modeConfig.defaultThinkingLevel,
  });
  const style = resolveThinkingStyle(llmConfig);
  warnThinkingFallback(level, style);
  return {
    level,
    style,
    fields: resolveResponsesThinkingFields({
      thinkingLevel: level,
      thinkingStyle: style,
      thinkingEffortMap: llmConfig.thinkingEffortMap,
    }),
  };
}

/**
 * 单次会话收尾：补换行避免后续输出粘在残缺的流式输出之后，再打印本次用量表格
 * 服务未返回 usage（无有效用量）时不输出噪音
 * @param {TokenUsage} usage - 本次会话累计用量（含子 Agent）
 * @param {LlmPricing} [pricing] - 费用单价配置
 * @returns {void}
 */
function printOneShotUsage(usage: TokenUsage, pricing?: LlmPricing): void {
  process.stdout.write("\n");
  if (!isEmptyUsage(usage)) {
    console.log(
      formatUsageTable([{ label: "本次", usage, emphasis: true }], pricing),
    );
  }
}

/**
 * 单次会话（chat、agent 命令共用的单次入口）：走 Responses API（无状态模式）+ agentic loop
 *
 * 执行步骤：解析思考配置 → 创建会话运行时 → 输出装配警告 → 装配会话工具带
 * → 执行对话回合 → 收尾（用量表格 + 释放运行时）；
 * 对话历史仅在本函数内存活，会话结束即丢弃；
 * 技能扫描与装配阶段警告（沙箱降级、Provider 不可用、MCP 连接失败等）在对话开始前一并输出
 *
 * @param {OneShotConversationOptions} options - 入参对象（字段说明见接口定义）
 * @returns {Promise<void>}
 */
export async function runOneShotConversation({
  llmConfig,
  modeConfig,
  userInput,
  thinkingLevel,
  mcpEnabled = true,
  cliSandboxOptions,
}: OneShotConversationOptions): Promise<void> {
  // 步骤 1：解析思考配置（档位回退 + 协议风格 + 扩展字段）
  const thinking = resolveOneShotThinking(llmConfig, modeConfig, thinkingLevel);
  // 步骤 2：创建会话运行时（MCP 连接与沙箱），finally 中统一释放；工具带装配由模式决定
  const runtime = await createConversationRuntime(modeConfig.basePrompt, {
    mcpEnabled,
    bashEnabled: modeConfig.bashEnabled,
    todosEnabled: modeConfig.todosEnabled,
    writeToolsEnabled: modeConfig.writeToolsEnabled,
    cliSandboxOptions,
  });
  // 本次会话的 token 用量：主循环与子 Agent 等多来源经累加器汇入
  const usage = createUsageAccumulator();
  try {
    // 步骤 3：输出装配阶段警告（与 REPL 面板保持一致）
    printWarnings([...runtime.assembly.scanWarnings, ...runtime.bootWarnings]);
    // 步骤 4：装配会话工具带（子 Agent 按模式开关，三个工具增量合并进 runtime.assembly 的两份列表；
    // 单次会话档位固定，扩展字段直接闭包捕获；
    // 后台派生禁用：单次会话执行完即退出，后台任务无处等待与收割结果）
    const { handle } = attachSubAgentIfEnabled({
      enabled: modeConfig.subAgentEnabled,
      llmConfig,
      tools: runtime.assembly.tools,
      advertisedTools: runtime.assembly.advertisedTools,
      skills: runtime.assembly.catalog.list(),
      extraBody: () => thinking.fields,
      backgroundEnabled: false,
    });
    // 子 Agent 的 LLM 用量计入「本次」统计
    handle?.setUsageReporter((delta) => usage.add(delta));
    // 步骤 5：执行唯一的对话回合；工具集单一事实源为 runtime.assembly（已含子 Agent 增量），
    // 历史仅在本函数内存活，不跨次共享
    const history: ResponseHistoryItem[] = [];
    await executeConversationTurn({
      llmConfig,
      thinkingLevel: thinking.level,
      thinkingStyle: thinking.style,
      history,
      userInput,
      instructions: runtime.assembly.systemPrompt,
      tools: runtime.assembly.tools,
      advertisedTools: runtime.assembly.advertisedTools,
      maxIterations: modeConfig.maxIterations,
      onUsage: (delta) => usage.add(delta),
      // 压缩摘要请求的用量同样计入「本次」统计，且不参与 lastInputTokens 口径
      onCompactionUsage: (delta) => usage.add(delta),
    });
  } finally {
    // 步骤 6：收尾（补换行 + 用量表格），随后释放运行时
    printOneShotUsage(usage.current, llmConfig.pricing);
    await disposeConversationRuntime(runtime);
  }
}
