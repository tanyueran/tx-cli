import OpenAI from "openai";
import { CliError } from "../../shared/errors";
import type {
  ChatMessage,
  LlmConfig,
  ResponseToolResult,
  ToolCall,
  ToolDefinition,
} from "../../types/llm";

/** 流式对话参数（Chat Completions 接口） */
interface StreamChatParams {
  /** LLM 接入配置 */
  config: LlmConfig;
  /** 完整对话历史（含 system 提示词与工具调用轮次） */
  messages: ChatMessage[];
  /** 可供模型调用的工具列表；传入后模型可能以工具调用代替直接回答 */
  tools?: ToolDefinition[];
  /** 协议扩展字段（思考参数等）：由 thinking 适配层生成，原样附加到请求体，空对象表示不下发 */
  extraBody?: Record<string, unknown>;
  /** 每收到一段增量回答文本时的回调，用于实时渲染 */
  onDelta: (text: string) => void;
  /**
   * 每收到一段增量深度思考文本时的回调（可选）
   * 模型不支持深度思考（无 reasoning_content）时不会被触发
   */
  onReasoningDelta?: (text: string) => void;
}

/** Chat Completions 流式对话结果 */
export interface StreamChatResult {
  /** 助手的完整回答文本（不含深度思考内容；模型请求工具时可能为空） */
  reply: string;
  /** 模型请求的工具调用列表；为空表示模型直接给出了回答 */
  toolCalls: ToolCall[];
}

/**
 * DeepSeek、Kimi 等服务在流式 delta 中扩展的深度思考字段
 * 说明：该字段为国内厂商对 OpenAI 协议的常见扩展，官方 SDK 类型未收录，需本地补齐
 */
interface ReasoningDelta {
  reasoning_content?: string | null;
}

/**
 * 把 openai SDK / 网络层抛出的原始错误转换为带友好提示的 CliError
 * @param {unknown} err - 原始错误
 * @returns {CliError} 可直接向用户展示的业务错误
 */
function toCliError(err: unknown): CliError {
  if (err instanceof OpenAI.APIError) {
    if (err.status === 401) {
      return new CliError("API Key 无效或未授权，请检查配置");
    }
    if (err.status === 404) {
      return new CliError("接口地址或模型名称不存在，请检查配置");
    }
    if (err.status === 429) {
      return new CliError("请求过于频繁或额度不足，请稍后再试");
    }
    return new CliError(
      `大模型接口请求失败（HTTP ${err.status ?? "unknown"}）: ${err.message}`,
    );
  }
  // fetch 层网络错误（DNS 解析失败、连接被拒等）在 Node 中的统一表现
  if (err instanceof Error && err.message === "fetch failed") {
    return new CliError("网络请求失败，请检查网络连接与 Base URL 是否可达");
  }
  return new CliError(
    `大模型接口请求失败: ${(err as Error)?.message ?? String(err)}`,
  );
}

/**
 * 把内部 ChatMessage 转换为 Chat Completions 接口的消息格式
 * 重点是两个工具相关的形态：带 tool_calls 的 assistant 消息与 role 为 tool 的结果消息
 * @param {ChatMessage[]} messages - 内部对话历史
 * @returns {object[]} OpenAI Chat Completions 格式的消息数组
 */
function toOpenAiMessages(
  messages: ChatMessage[],
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  return messages.map((msg) => {
    if (msg.role === "assistant" && msg.toolCalls?.length) {
      return {
        role: "assistant" as const,
        // 带 tool_calls 的 assistant 消息正文为空，接口要求传 null
        content: msg.content || null,
        tool_calls: msg.toolCalls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.name, arguments: tc.arguments },
        })),
      };
    }
    if (msg.role === "tool") {
      return {
        role: "tool" as const,
        content: msg.content,
        tool_call_id: msg.toolCallId ?? "",
      };
    }
    return { role: msg.role, content: msg.content };
  });
}

/**
 * 发起一次流式对话（Chat Completions 接口）：逐段回调增量文本用于实时输出
 * 思考参数等协议扩展经 extraBody 原样下发（由 thinking 适配层按档位与风格生成）
 * 深度思考不计入返回值，也不应写入对话历史
 * 传入 tools 后模型可能以工具调用代替直接回答，调用方执行后需将结果以
 * assistant(toolCalls) + tool(toolCallId) 消息追加进历史再次调用本函数
 * @param {StreamChatParams} params - 对话参数（配置、历史消息、工具列表、扩展字段、增量回调）
 * @returns {Promise<StreamChatResult>} 回答文本与模型请求的工具调用列表
 * @throws {CliError} 接口请求或网络失败时抛出
 */
export async function streamChat(
  params: StreamChatParams,
): Promise<StreamChatResult> {
  const client = new OpenAI({
    apiKey: params.config.apiKey,
    baseURL: params.config.baseUrl,
  });

  try {
    // thinking 等协议扩展字段由适配层生成：以交叉类型断言附加，规避官方 SDK 类型不含这些字段
    const stream = await client.chat.completions.create({
      model: params.config.model,
      messages: toOpenAiMessages(params.messages),
      // 工具定义转换为 Chat Completions 的嵌套格式（function.name/description/parameters）
      ...(params.tools
        ? {
            tools: params.tools.map((tool) => ({
              type: "function" as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
          }
        : {}),
      stream: true,
      ...params.extraBody,
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsStreaming);

    let full = "";
    // 工具调用增量按 index 聚合：id/name 仅首段携带，arguments 分多段追加
    const pendingToolCalls = new Map<
      number,
      { id: string; name: string; args: string }
    >();
    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      // 深度思考增量：先于回答输出，模型未返回时为空串
      const reasoning =
        (delta as ReasoningDelta | undefined)?.reasoning_content ?? "";
      if (reasoning && params.onReasoningDelta) {
        params.onReasoningDelta(reasoning);
      }

      for (const tc of delta?.tool_calls ?? []) {
        const acc = pendingToolCalls.get(tc.index) ?? {
          id: "",
          name: "",
          args: "",
        };
        if (tc.id) {
          acc.id = tc.id;
        }
        if (tc.function?.name) {
          acc.name = tc.function.name;
        }
        if (tc.function?.arguments) {
          acc.args += tc.function.arguments;
        }
        pendingToolCalls.set(tc.index, acc);
      }

      const content = delta?.content ?? "";
      if (content) {
        full += content;
        params.onDelta(content);
      }
    }

    const toolCalls: ToolCall[] = [...pendingToolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, acc]) => ({
        id: acc.id,
        name: acc.name,
        arguments: acc.args,
      }));
    return { reply: full, toolCalls };
  } catch (err) {
    throw toCliError(err);
  }
}

/** 响应式流式对话参数（Responses API，store 会话模式） */
interface StreamResponseParams {
  /** LLM 接入配置 */
  config: LlmConfig;
  /**
   * 本轮输入：store 模式下每轮只发送新内容，历史上下文由服务端维护
   * 用户文本直接传字符串；回传工具执行结果时传结果列表，
   * 服务端会依据 previous_response_id 找到对应的 function_call 配对
   */
  input: string | ResponseToolResult[];
  /**
   * system 提示词
   * 说明：previous_response_id 不会延续 instructions，多轮场景每轮都需传入
   */
  instructions?: string;
  /** 上一轮响应 ID：传入后服务端自动衔接历史对话，无需重发历史消息 */
  previousResponseId?: string;
  /** 协议扩展字段（思考参数等）：由 thinking 适配层生成，原样附加到请求体，空对象表示不下发 */
  extraBody?: Record<string, unknown>;
  /** 每收到一段增量回答文本时的回调，用于实时渲染 */
  onDelta: (text: string) => void;
  /**
   * 每收到一段增量深度思考文本时的回调（可选）
   * 模型不输出思考内容（无 reasoning 事件）时不会被触发
   */
  onReasoningDelta?: (text: string) => void;
  /** 可供模型调用的工具列表，模型发起调用时通过返回值的 toolCalls 交给调用方执行 */
  tools?: ToolDefinition[];
}

/** 响应式流式对话结果 */
export interface StreamResponseResult {
  /** 助手的完整回答文本（不含深度思考内容；模型请求工具时可能为空） */
  reply: string;
  /** 本次响应 ID：多轮对话时作为下一轮的 previousResponseId 传入 */
  responseId: string;
  /** 模型请求的工具调用列表；为空表示模型直接给出了回答 */
  toolCalls: ToolCall[];
}

/**
 * 发起一次响应式流式对话（Responses API，store 会话模式）
 * 思考参数等协议扩展经 extraBody 原样下发（由 thinking 适配层按档位与风格生成）
 * 通过 store + previous_response_id 让服务端维护多轮上下文，每轮只发送增量输入
 * 传入 tools 后模型可能以工具调用代替直接回答，调用方执行后需将结果以
 * ResponseToolResult 列表作为 input、携带本次 responseId 再次调用本函数
 * @param {StreamResponseParams} params - 对话参数（配置、本轮输入、响应 ID 衔接、扩展字段、增量回调、工具列表）
 * @returns {Promise<StreamResponseResult>} 回答文本、本次响应 ID 与模型请求的工具调用列表
 * @throws {CliError} 接口请求或网络失败时抛出
 */
export async function streamResponse(
  params: StreamResponseParams,
): Promise<StreamResponseResult> {
  const client = new OpenAI({
    apiKey: params.config.apiKey,
    baseURL: params.config.baseUrl,
  });

  try {
    const stream = await client.responses.create({
      model: params.config.model,
      // 工具结果回传：转换为 function_call_output 输入项，靠 call_id 与历史调用配对
      input: Array.isArray(params.input)
        ? params.input.map((result) => ({
            type: "function_call_output" as const,
            call_id: result.callId,
            output: result.output,
          }))
        : params.input,
      instructions: params.instructions || undefined,
      // 空串等同未传，避免把非法的 previous_response_id 发给接口
      previous_response_id: params.previousResponseId || undefined,
      // store：开启服务端会话存储，配合 previous_response_id 实现增量多轮对话
      store: true,
      // strict 置 false：自定义 JSON Schema 不保证满足严格模式的全量约束
      tools: params.tools?.map((tool) => ({
        type: "function" as const,
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: false,
      })),
      stream: true,
      // thinking 等协议扩展字段由适配层生成，原样附加（spread 属性不触发 SDK 的多余属性检查）
      ...params.extraBody,
    });

    let reply = "";
    let responseId = "";
    const toolCalls: ToolCall[] = [];
    for await (const event of stream) {
      switch (event.type) {
        case "response.created":
          responseId = event.response.id;
          break;
        // 思考内容：openai 开源系模型走 reasoning_text，官方模型走 reasoning_summary_text
        case "response.reasoning_text.delta":
        case "response.reasoning_summary_text.delta":
          if (params.onReasoningDelta) {
            params.onReasoningDelta(event.delta);
          }
          break;
        case "response.output_text.delta":
          reply += event.delta;
          params.onDelta(event.delta);
          break;
        case "response.output_item.done":
          // 模型请求的工具调用：由调用方本地执行后回传结果
          if (event.item.type === "function_call") {
            toolCalls.push({
              id: event.item.call_id,
              name: event.item.name,
              arguments: event.item.arguments,
            });
          }
          break;
        default:
          break;
      }
    }
    return { reply, responseId, toolCalls };
  } catch (err) {
    throw toCliError(err);
  }
}
