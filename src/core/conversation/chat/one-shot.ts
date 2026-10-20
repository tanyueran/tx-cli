import {
  createConversationRuntime,
  createResponsesTurn,
  createStreamRenderer,
  createToolCallLogger,
  disposeConversationRuntime,
  resolveThinkingLevel,
  runAgentLoop,
  warnThinkingFallback,
} from "../common";
import { printWarnings } from "../../../shared/warnings";
import {
  resolveResponsesThinkingFields,
  resolveThinkingStyle,
} from "../../llm";
import type { SandboxCliOptions } from "../../sandbox";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
} from "../../../types/llm";
import { SYSTEM_PROMPT } from "./constants";

/**
 * 单次问答：走 Responses API（无状态模式）+ agentic loop，工具调用默认开启（内置 read_file 等）
 * 思考档位取值：命令行 > 配置文件 > medium，经 thinking 适配层翻译为协议扩展字段下发；
 * 服务不支持分档思考时先打印折算警告，避免用户误以为 high 等档位真实生效
 * 深度思考内容以暗色流式输出（模型未返回时不输出）
 * @param {LlmConfig} config - LLM 接入配置
 * @param {string} question - 用户问题
 * @param {ThinkingLevel | undefined} thinkingLevel - 命令行指定的思考档位，未指定时回退配置默认
 * @param {boolean} mcpEnabled - 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启
 * @param {SandboxCliOptions} sandboxCli - 沙箱 CLI 选项（--sandbox/--no-bash 等），缺省按配置文件装配
 * @returns {Promise<void>}
 */
export async function runOneShotChat(
  config: LlmConfig,
  question: string,
  thinkingLevel?: ThinkingLevel,
  mcpEnabled = true,
  sandboxCli?: SandboxCliOptions,
): Promise<void> {
  const level = resolveThinkingLevel(thinkingLevel, config);
  const style = resolveThinkingStyle(config);
  warnThinkingFallback(level, style);
  const renderer = createStreamRenderer();
  // 会话运行时（MCP 连接与沙箱）随会话创建，finally 中统一释放
  const runtime = await createConversationRuntime(
    SYSTEM_PROMPT,
    mcpEnabled,
    sandboxCli,
  );
  try {
    const { systemPrompt, tools, warnings } = runtime.skill;
    printWarnings(warnings);
    // 单次问答的历史仅在本函数内存活：不跨轮共享，问答结束即丢弃
    const history: ResponseHistoryItem[] = [];
    const runTurn = createResponsesTurn({
      config,
      input: question,
      history,
      instructions: systemPrompt,
      tools,
      extraBody: resolveResponsesThinkingFields(
        level,
        style,
        config.thinkingEffortMap,
      ),
      onDelta: renderer.onDelta,
      onReasoningDelta: renderer.onReasoningDelta,
    });
    // 回答由 onDelta 流式输出；每次工具调用前结束思考块并打印一行提示，避免中间轮静默无输出
    await runAgentLoop({
      runTurn,
      tools,
      onToolCall: createToolCallLogger(renderer),
    });
  } finally {
    // 成功与异常路径都先补换行，避免后续输出（错误提示等）粘在残缺的流式输出之后
    process.stdout.write("\n");
    await disposeConversationRuntime(runtime);
  }
}
