import { executeConversationTurn } from "./turn/execute-turn";
import {
  createConversationRuntime,
  disposeConversationRuntime,
} from "./runtime/runtime";
import type { ConversationModeConfig } from "./runtime/mode";
import { printWarnings } from "../../../shared/warnings";
import {
  resolveThinkingLevel,
  resolveThinkingStyle,
  warnThinkingFallback,
} from "../../llm";
import type { SandboxCliOptions } from "../../sandbox";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
} from "../../llm/types";

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

/**
 * 单次会话（chat、agent 命令共用的单次入口）：走 Responses API（无状态模式）+ agentic loop
 *
 * 对话历史仅在本函数内存活，会话结束即丢弃；
 * 服务不支持分档思考时先打印折算警告，避免用户误以为档位真实生效；
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
  const effectiveThinkingLevel = resolveThinkingLevel({
    cliLevel: thinkingLevel,
    llmConfig: llmConfig,
    fallback: modeConfig.defaultThinkingLevel,
  });
  const thinkingStyle = resolveThinkingStyle(llmConfig);
  warnThinkingFallback(effectiveThinkingLevel, thinkingStyle);
  // 会话运行时（MCP 连接与沙箱）随会话创建，finally 中统一释放；工具带装配由模式决定
  const runtime = await createConversationRuntime(modeConfig.basePrompt, {
    mcpEnabled,
    bashEnabled: modeConfig.bashEnabled,
    todosEnabled: modeConfig.todosEnabled,
    writeToolsEnabled: modeConfig.writeToolsEnabled,
    cliSandboxOptions,
  });
  try {
    const { systemPrompt, tools, scanWarnings } = runtime.skill;
    // 与 REPL 面板保持一致：技能扫描警告与装配阶段警告一并输出
    printWarnings([...scanWarnings, ...runtime.bootWarnings]);
    // 单次会话的历史仅在本函数内存活：不跨次共享，会话结束即丢弃
    const history: ResponseHistoryItem[] = [];
    await executeConversationTurn({
      llmConfig,
      thinkingLevel: effectiveThinkingLevel,
      thinkingStyle,
      history,
      userInput,
      instructions: systemPrompt,
      tools,
      advertisedTools: runtime.skill.advertisedTools,
      maxIterations: modeConfig.maxIterations,
    });
  } finally {
    // 成功与异常路径都先补换行，避免后续输出（错误提示等）粘在残缺的流式输出之后
    process.stdout.write("\n");
    await disposeConversationRuntime(runtime);
  }
}
