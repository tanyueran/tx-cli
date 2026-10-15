import {
  buildInitialMessages,
  createChatCompletionsTurn,
  createStreamRenderer,
  createToolCallLogger,
  printSkillWarnings,
  resolveThinkingLevel,
  runAgentLoop,
  setupSkillContext,
  warnThinkingFallback,
} from "../common";
import { resolveChatThinkingFields, resolveThinkingStyle } from "../../llm";
import type { LlmConfig, ThinkingLevel } from "../../../types/llm";
import { SYSTEM_PROMPT } from "./constants";

/**
 * 单次问答：走 Chat Completions 接口 + agentic loop，工具调用默认开启（内置 read_file 等）
 * 思考档位取值：命令行 > 配置文件 > medium，经 thinking 适配层翻译为协议扩展字段下发；
 * 服务不支持分档思考时先打印折算警告，避免用户误以为 high 等档位真实生效
 * 深度思考内容以暗色流式输出（模型未返回时不输出）
 * @param {LlmConfig} config - LLM 接入配置
 * @param {string} question - 用户问题
 * @param {ThinkingLevel | undefined} thinkingLevel - 命令行指定的思考档位，未指定时回退配置默认
 * @returns {Promise<void>}
 */
export async function runOneShotChat(
  config: LlmConfig,
  question: string,
  thinkingLevel?: ThinkingLevel,
): Promise<void> {
  const level = resolveThinkingLevel(thinkingLevel, config);
  const style = resolveThinkingStyle(config);
  warnThinkingFallback(level, style);
  const renderer = createStreamRenderer();
  const { systemPrompt, tools, warnings } = setupSkillContext(SYSTEM_PROMPT);
  printSkillWarnings(warnings);
  const runTurn = createChatCompletionsTurn({
    config,
    messages: buildInitialMessages(systemPrompt, question),
    tools,
    extraBody: resolveChatThinkingFields(
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
  process.stdout.write("\n");
}
