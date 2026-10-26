import { createResponsesTurn } from "./responses-turn";
import { createStreamRenderer, createToolCallLogger, createSoftConvergeNotice } from "./renderer";
import { runAgentLoop, DEFAULT_MAX_ITERATIONS } from "./loop";
import {
  createConversationRuntime,
  disposeConversationRuntime,
} from "./runtime";
import type { ConversationModeConfig } from "./mode";
import { printWarnings } from "../../../shared/warnings";
import {
  resolveResponsesThinkingFields,
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
  config: LlmConfig;
  /** 模式配置（人设、标签、bash 装配策略） */
  mode: ConversationModeConfig;
  /** 用户问题或任务 */
  input: string;
  /** 命令行指定的思考档位，未指定时回退配置默认 */
  thinkingLevel?: ThinkingLevel;
  /** 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启 */
  mcpEnabled?: boolean;
  /** 沙箱 CLI 选项（agent 命令的 --sandbox 等），缺省按配置文件装配 */
  sandboxCli?: SandboxCliOptions;
}

/**
 * 单次会话（chat、agent 命令共用的单次入口）：走 Responses API（无状态模式）+ agentic loop
 * store=false：服务端不留存会话，历史由本地维护，会话结束即丢弃；
 * 思考档位取值：命令行 > 配置文件（项目 > 全局）> 模式内置默认（chat low / agent medium），
 * 经 thinking 适配层翻译为协议扩展字段下发；
 * 服务不支持分档思考时先打印折算警告，避免用户误以为 high 等档位真实生效；
 * 深度思考内容以暗色流式输出（模型未返回时不输出）
 * @param {OneShotConversationOptions} options - 入参对象（config/mode/input/thinkingLevel/mcpEnabled/sandboxCli 字段说明见接口定义）
 * @returns {Promise<void>}
 */
export async function runOneShotConversation({
  config,
  mode,
  input,
  thinkingLevel,
  mcpEnabled = true,
  sandboxCli,
}: OneShotConversationOptions): Promise<void> {
  const level = resolveThinkingLevel({
    cliLevel: thinkingLevel,
    config,
    fallback: mode.defaultThinkingLevel,
  });
  const style = resolveThinkingStyle(config);
  warnThinkingFallback(level, style);
  const renderer = createStreamRenderer();
  // 会话运行时（MCP 连接与沙箱）随会话创建，finally 中统一释放；bash 装配由模式决定
  const runtime = await createConversationRuntime(mode.basePrompt, {
    mcpEnabled,
    bashEnabled: mode.bashEnabled,
    todosEnabled: mode.todosEnabled,
    sandboxCli,
  });
  try {
    const { systemPrompt, tools, warnings } = runtime.skill;
    printWarnings(warnings);
    // 单次会话的历史仅在本函数内存活：不跨次共享，会话结束即丢弃
    const history: ResponseHistoryItem[] = [];
    const runTurn = createResponsesTurn({
      config,
      input,
      history,
      instructions: systemPrompt,
      tools,
      extraBody: resolveResponsesThinkingFields({
        level,
        style,
        effortMap: config.thinkingEffortMap,
      }),
      onDelta: renderer.onDelta,
      onReasoningDelta: renderer.onReasoningDelta,
    });
    // 回答由 onDelta 流式输出；每次工具调用前结束思考块并打印一行提示，避免中间轮静默无输出
    // 轮数上限由模式决定（chat 8 轮、agent 20 轮），未指定时回退 loop 默认值；进入软收敛轮时提示用户
    const maxIterations = mode.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    await runAgentLoop({
      runTurn,
      tools,
      maxIterations,
      onToolCall: createToolCallLogger(renderer),
      onSoftConverge: createSoftConvergeNotice(renderer, maxIterations),
    });
  } finally {
    // 成功与异常路径都先补换行，避免后续输出（错误提示等）粘在残缺的流式输出之后
    process.stdout.write("\n");
    await disposeConversationRuntime(runtime);
  }
}
