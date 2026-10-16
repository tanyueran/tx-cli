import OpenAI from "openai";
import { CliError } from "../../shared/errors";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ToolCall,
  ToolDefinition,
} from "../../types/llm";

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

/** 响应式流式对话参数（Responses API，无状态模式） */
interface StreamResponseParams {
  /** LLM 接入配置 */
  config: LlmConfig;
  /**
   * 完整对话历史（无状态模式：服务端不留存会话，每轮全量发送）
   * 含用户/assistant 消息与 function_call / function_call_output 工具轮次
   */
  input: ResponseHistoryItem[];
  /** system 提示词：服务端不留存会话，每轮请求都需传入 */
  instructions?: string;
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
  /** 模型请求的工具调用列表；为空表示模型直接给出了回答 */
  toolCalls: ToolCall[];
}

/**
 * 把内部历史项转换为 Responses API 的 input 输入项
 * 重点是工具相关的两种形态：function_call 调用项与 function_call_output 结果项
 * @param {ResponseHistoryItem[]} items - 内部对话历史
 * @returns {object[]} Responses API 格式的输入项数组
 */
function toResponsesInput(
  items: ResponseHistoryItem[],
): OpenAI.Responses.ResponseInputItem[] {
  return items.map((item) => {
    if (item.type === "function_call") {
      return {
        type: "function_call" as const,
        call_id: item.callId,
        name: item.name,
        arguments: item.arguments,
      };
    }
    if (item.type === "function_call_output") {
      return {
        type: "function_call_output" as const,
        call_id: item.callId,
        output: item.output,
      };
    }
    return { role: item.role, content: item.content };
  });
}

/**
 * 发起一次响应式流式对话（Responses API，无状态模式）
 * 思考参数等协议扩展经 extraBody 原样下发（由 thinking 适配层按档位与风格生成）
 * store 置 false：服务端不留存会话，历史由调用方本地维护并每轮全量发送
 * 传入 tools 后模型可能以工具调用代替直接回答，调用方执行后需将结果以
 * function_call_output 历史项追加、连同完整历史再次调用本函数
 * @param {StreamResponseParams} params - 对话参数（配置、完整历史、扩展字段、增量回调、工具列表）
 * @returns {Promise<StreamResponseResult>} 回答文本与模型请求的工具调用列表
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
      input: toResponsesInput(params.input),
      instructions: params.instructions || undefined,
      // store：关闭服务端会话存储，避免对话数据留在服务端；历史由调用方每轮全量发送
      store: false,
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
    const toolCalls: ToolCall[] = [];
    for await (const event of stream) {
      switch (event.type) {
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
    return { reply, toolCalls };
  } catch (err) {
    throw toCliError(err);
  }
}
