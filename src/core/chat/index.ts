import pico from "picocolors";
import {
  createChatCompletionsTurn,
  createResponsesTurn,
  runAgentLoop,
} from "../conversation";
import {
  describeThinkingStyle,
  isToggleOnlyStyle,
  parseThinkingLevel,
  resolveChatThinkingFields,
  resolveResponsesThinkingFields,
  resolveThinkingStyle,
} from "../llm";
import { createBuiltinRegistry } from "../tools";
import { CancelError, CliError } from "../../shared/errors";
import { askText } from "../../shared/prompt";
import type {
  ChatMessage,
  LlmConfig,
  ThinkingLevel,
  ToolCall,
} from "../../types/llm";

/** 对话的 system 提示词 */
const SYSTEM_PROMPT = "你是 tx-cli 内置的 AI 助手，用简洁的中文回答问题。";

/** 思考档位缺省值：配置与命令行均未指定时使用 */
const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/**
 * 创建流式渲染器：正文按原样输出，深度思考内容以暗色流式输出
 * 思考内容懒触发：模型未返回思考增量时不产生任何额外输出
 * @returns {object} 渲染器：onDelta 正文增量、onReasoningDelta 思考增量、endThinking 结束思考块
 */
function createStreamRenderer() {
  // 上一段输出的流类型：用于在思考块与正文之间插入换行分隔
  let last: "reasoning" | "content" | undefined;
  const endThinking = (): void => {
    if (last === "reasoning") {
      process.stdout.write("\n");
      last = undefined;
    }
  };
  return {
    onDelta: (text: string): void => {
      endThinking();
      process.stdout.write(text);
      last = "content";
    },
    onReasoningDelta: (text: string): void => {
      if (last !== "reasoning") {
        // 首个思考增量：以暗色省略号标记思考块开始
        process.stdout.write(pico.dim("…… "));
      }
      process.stdout.write(pico.dim(text));
      last = "reasoning";
    },
    endThinking,
  };
}

/**
 * 构造初始消息列表（system 提示词 + 可选的首个用户问题）
 * @param {string | undefined} question - 单次问答模式下的问题
 * @returns {ChatMessage[]} 初始消息列表
 */
function buildInitialMessages(question?: string): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  if (question) {
    messages.push({ role: "user", content: question });
  }
  return messages;
}

/**
 * 打印工具调用提示：两种对话模式共用的渲染样式
 * @param {ToolCall} call - 模型发起的调用请求
 * @returns {void}
 */
function printToolCall(call: ToolCall): void {
  console.log(pico.cyan(`→ 调用 ${call.name}(${call.arguments})`));
}

/**
 * 单次问答：走 Chat Completions 接口 + agentic loop，工具调用默认开启（内置 read_file 等）
 * 思考档位取值：命令行 > 配置文件 > medium，经 thinking 适配层翻译为协议扩展字段下发
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
  const level = thinkingLevel ?? config.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
  const style = resolveThinkingStyle(config);
  const renderer = createStreamRenderer();
  const tools = createBuiltinRegistry().list();
  const runTurn = createChatCompletionsTurn({
    config,
    messages: buildInitialMessages(question),
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
    onToolCall: (call: ToolCall) => {
      renderer.endThinking();
      printToolCall(call);
    },
  });
  process.stdout.write("\n");
}

/**
 * 执行多轮对话的一轮：Responses API store 会话 + agentic loop，工具调用开启（内置 read_file 等）
 * store 会话模式：每轮只发送本轮输入，历史上下文由服务端通过 responseId 链衔接；
 * 深度思考内容以暗色流式输出（模型未返回时不输出），instructions 每轮重传以规避其不随会话延续的问题
 * @param {LlmConfig} config - LLM 接入配置
 * @param {string} input - 本轮用户输入
 * @param {string | undefined} previousResponseId - 上一轮响应 ID，首轮不传
 * @param {ThinkingLevel} thinkingLevel - 本轮思考档位（/think 切换后下一轮使用新档位）
 * @returns {Promise<string | undefined>} 本轮会话最新的响应 ID，用于下一轮衔接上下文
 */
async function runReplTurn(
  config: LlmConfig,
  input: string,
  previousResponseId: string | undefined,
  thinkingLevel: ThinkingLevel,
): Promise<string | undefined> {
  const renderer = createStreamRenderer();
  const tools = createBuiltinRegistry().list();
  const turn = createResponsesTurn({
    config,
    input,
    instructions: SYSTEM_PROMPT,
    extraBody: resolveResponsesThinkingFields(
      thinkingLevel,
      resolveThinkingStyle(config),
      config.thinkingEffortMap,
    ),
    previousResponseId,
    tools,
    onDelta: renderer.onDelta,
    onReasoningDelta: renderer.onReasoningDelta,
  });
  await runAgentLoop({
    runTurn: turn.runTurn,
    tools,
    onToolCall: (call: ToolCall) => {
      renderer.endThinking();
      printToolCall(call);
    },
  });
  process.stdout.write("\n\n");
  // 流异常结束可能未收到 response.created：turn 内部保留上一轮衔接，避免下一轮发出空的 previous_response_id
  return turn.getResponseId();
}

/**
 * 打印思考档位切换/设置结果与服务能力折算提示
 * @param {ThinkingLevel} level - 目标档位
 * @param {LlmConfig} config - LLM 接入配置（用于确定协议风格）
 * @returns {void}
 */
function printThinkingNotice(level: ThinkingLevel, config: LlmConfig): void {
  const style = resolveThinkingStyle(config);
  if (style === "none") {
    console.log(
      pico.yellow(
        `思考档位为 ${level}，但${describeThinkingStyle(style)}，思考字段不会下发`,
      ),
    );
    return;
  }
  console.log(pico.cyan(`思考档位：${level}`));
  if (isToggleOnlyStyle(style) && level !== "off") {
    console.log(pico.yellow(`注意：当前服务${describeThinkingStyle(style)}`));
  }
}

/**
 * 多轮对话模式（REPL）：循环提问，直到用户输入 exit/quit 或按 Ctrl+C 退出
 * 基于 Responses API 的 store 会话 + agentic loop：每轮只发送新输入，经 responseId 链衔接历史，
 * 模型可在任意一轮发起工具调用（read_file 等），与单次问答模式能力一致
 * 支持内联命令 /think：无参查看当前思考档位，带参切换（如 /think high，下一轮生效）
 * 单轮请求失败（网络抖动、限流等可预期错误）只提示不终止会话，避免丢失整个对话上下文
 * @param {LlmConfig} config - LLM 接入配置
 * @param {ThinkingLevel | undefined} thinkingLevel - 命令行指定的思考档位，未指定时回退配置默认
 * @returns {Promise<void>}
 */
export async function runReplChat(
  config: LlmConfig,
  thinkingLevel?: ThinkingLevel,
): Promise<void> {
  // 档位为会话内可变状态：/think 切换后下一轮请求生效
  let currentLevel =
    thinkingLevel ?? config.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
  const style = resolveThinkingStyle(config);
  console.log(
    pico.green(
      `已连接模型 ${config.model}，思考档位 ${currentLevel}，支持工具调用，输入问题开始对话，输入 exit 或按 Ctrl+C 退出`,
    ),
  );
  console.log(
    pico.cyan("提示：/think 查看思考档位，/think <off|low|medium|high> 切换"),
  );
  if (style === "none" || isToggleOnlyStyle(style)) {
    console.log(pico.yellow(`注意：当前服务${describeThinkingStyle(style)}`));
  }
  let previousResponseId: string | undefined;

  for (;;) {
    let input: string;
    try {
      input = await askText(pico.green("你 > "));
    } catch (err) {
      // 用户按 Ctrl+C 取消输入：视为正常退出对话，不沿用顶层"未做任何修改"的取消文案
      if (err instanceof CancelError) {
        console.log(pico.yellow("已退出对话"));
        return;
      }
      throw err;
    }

    if (input.toLowerCase() === "exit" || input.toLowerCase() === "quit") {
      console.log(pico.yellow("已退出对话"));
      return;
    }

    // 内联命令 /think：查看或切换思考档位，非法值提示后保留原档位，不退出会话
    if (input.trim().toLowerCase().startsWith("/think")) {
      const arg = input.trim().slice("/think".length).trim();
      if (!arg) {
        printThinkingNotice(currentLevel, config);
        continue;
      }
      try {
        currentLevel = parseThinkingLevel(arg) ?? currentLevel;
        printThinkingNotice(currentLevel, config);
      } catch (err) {
        if (!(err instanceof CliError)) {
          throw err;
        }
        console.error(pico.red(err.message));
      }
      continue;
    }

    try {
      previousResponseId = await runReplTurn(
        config,
        input,
        previousResponseId,
        currentLevel,
      );
    } catch (err) {
      // 仅吞可预期的业务错误（网络、接口报错）；未预期错误仍上抛，避免代码 bug 被无限循环掩盖
      if (!(err instanceof CliError)) {
        throw err;
      }
      // 换行避免错误提示接在残缺的流式输出之后
      process.stdout.write("\n");
      console.error(pico.red(err.message));
    }
  }
}
