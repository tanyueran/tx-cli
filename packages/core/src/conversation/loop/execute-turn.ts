import pico from "picocolors";
import { createResponsesTurn } from "./responses-turn";
import {
  createStreamRenderer,
  createToolCallLogger,
  createSoftConvergeNotice,
} from "./renderer";
import { formatCompactionNotice, maybeCompactHistory } from "./compaction";
import { runAgentLoop, DEFAULT_MAX_ITERATIONS, type RunTurn } from "./loop";
import { resolveCompactionConfig, resolveResponsesThinkingFields } from "../../llm";
import type { Tool } from "../../tools";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
  ThinkingStyle,
  TokenUsage,
} from "../../llm/types";

/** executeConversationTurn 入参对象 */
export interface ConversationTurnOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 生效的思考档位（经 resolveThinkingLevel 解析） */
  thinkingLevel: ThinkingLevel;
  /** 思考协议风格（经 resolveThinkingStyle 解析） */
  thinkingStyle: ThinkingStyle;
  /** 对话历史：单次会话为本地数组，REPL 跨轮共享，由回合函数向其追加 */
  history: ResponseHistoryItem[];
  /** 本轮用户输入 */
  userInput: string;
  /** system 提示词（无状态模式每轮随请求重传） */
  instructions: string;
  /** 会话可执行工具列表（全量，含未激活的 MCP 工具） */
  tools: Tool[];
  /** 下发给模型的工具清单（MCP 折叠时仅含 discover_mcp_tools 与已激活工具） */
  advertisedTools: Tool[];
  /** 工具调用轮数上限，超出后软收敛为直接作答；缺省 DEFAULT_MAX_ITERATIONS */
  maxIterations?: number;
  /** token 用量回调（可选）：每次 LLM 请求返回 usage 时触发，供调用方累计展示 */
  onUsage?: (usage: TokenUsage) => void;
  /**
   * 压缩摘要请求的用量回调（可选）：只供统计累计，不参与 lastInputTokens 口径——
   * 摘要的 inputTokens ≈ 被压缩段原大小（仍超阈值），若回流到主会话的
   * lastInputTokens 会让后续压缩判定误判，造成刚生成的摘要被再次压缩
   */
  onCompactionUsage?: (usage: TokenUsage) => void;
}

/**
 * 执行一轮对话回合：渲染器 + Responses 回合函数 + agentic loop 的共用 wiring（单次会话与 REPL 每轮共用）
 * 思考档位与协议风格在此折算为协议扩展字段下发；回答与深度思考流式渲染，
 * 工具调用前打印提示行，首次进入软收敛轮时提示用户
 * @param {ConversationTurnOptions} options - 入参对象（字段说明见接口定义）
 * @returns {Promise<string>} 模型的最终回答文本
 */
export async function executeConversationTurn(
  options: ConversationTurnOptions,
): Promise<string> {
  const renderer = createStreamRenderer();
  // 上下文压缩配置：未配置 llm.context.maxContextTokens 时为空，compress 完全不介入
  const compactionConfig = resolveCompactionConfig(options.llmConfig.context);
  // 上一次请求的真实 input token：压缩判定优先用它（含系统提示与工具定义，口径最准）
  let lastInputTokens: number | undefined;
  const handleUsage = (usage: TokenUsage): void => {
    lastInputTokens = usage.inputTokens;
    options.onUsage?.(usage);
  };
  const runTurn = createResponsesTurn({
    llmConfig: options.llmConfig,
    userInput: options.userInput,
    history: options.history,
    instructions: options.instructions,
    extraBody: resolveResponsesThinkingFields({
      thinkingLevel: options.thinkingLevel,
      thinkingStyle: options.thinkingStyle,
      thinkingEffortMap: options.llmConfig.thinkingEffortMap,
    }),
    tools: options.advertisedTools,
    onDelta: renderer.onDelta,
    onReasoningDelta: renderer.onReasoningDelta,
    onUsage: handleUsage,
  });
  const maxIterations = options.maxIterations ?? DEFAULT_MAX_ITERATIONS;
  // 每次模型请求发出前启动 loading 动画（填补请求发出到首个流式增量之间的空窗），
  // 首个增量到达时由渲染器自动收起；finally 兜底清理请求失败 / 取消等无输出场景，
  // 避免「思考中…」状态行残留在屏幕上
  const runTurnWithLoading: RunTurn = async (toolResults, toolsDisabled) => {
    renderer.startLoading();
    try {
      return await runTurn(toolResults, toolsDisabled);
    } finally {
      renderer.stopLoading();
    }
  };
  return runAgentLoop({
    runTurn: runTurnWithLoading,
    tools: options.tools,
    maxIterations,
    onToolCall: createToolCallLogger(renderer),
    onSoftConverge: createSoftConvergeNotice(renderer, maxIterations),
    // agentic 循环内部的安全点（首轮由会话层在进入回合前处理，此处从第二次请求开始）
    beforeIteration: async (iteration) => {
      if (iteration === 0 || !compactionConfig) {
        return;
      }
      const outcome = await maybeCompactHistory({
        llmConfig: options.llmConfig,
        history: options.history,
        config: compactionConfig,
        lastInputTokens,
        // 摘要用量走独立回调（只累计），不走 onUsage——后者的语义是「真实请求口径」，
        // REPL 侧会在其中更新 lastInputTokens，摘要用量回流会引发重复压缩
        onUsage: options.onCompactionUsage,
      });
      const notice = formatCompactionNotice(outcome);
      if (notice) {
        console.log(
          outcome.status === "failed" ? pico.yellow(notice) : pico.cyan(notice),
        );
      }
    },
  });
}
