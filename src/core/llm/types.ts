/**
 * LLM 接入配置：任何 OpenAI 兼容接口均可（DeepSeek、Kimi、GLM、OpenAI 等）
 */
export interface LlmConfig {
  /** API 密钥 */
  apiKey: string;
  /** 接口地址，如 https://api.deepseek.com/v1 */
  baseUrl: string;
  /** 模型名称，如 deepseek-chat */
  model: string;
  /** 全局默认思考档位，缺省 medium（chat --think 可按次覆盖） */
  thinkingLevel?: ThinkingLevel;
  /** 思考协议风格，缺省按 baseUrl 推断 */
  thinkingStyle?: ThinkingStyle;
  /** 档位 → 服务端实际值的高级映射，优先于内置映射（适配仅支持部分档位的服务） */
  thinkingEffortMap?: Partial<Record<ThinkingLevel, string>>;
  /** 费用单价配置（可选）：未配置时只统计 token，不估算费用 */
  pricing?: LlmPricing;
}

/**
 * 费用单价配置（每百万 token 单价）：用于 token 用量的费用估算
 * 未配置或对应档位单价缺失时，该档位按 0 计
 */
export interface LlmPricing {
  /** 输入 token 每百万单价（按服务端返回的 input_tokens 全量口径计） */
  inputPerMillion?: number;
  /** 输出 token 每百万单价 */
  outputPerMillion?: number;
  /** 币种符号，缺省 ¥ */
  currency?: string;
}

/**
 * token 用量：单次 LLM 调用或会话累计的统计口径
 * 无状态模式下 input 为整段历史的全量重传量，即真实计费口径
 */
export interface TokenUsage {
  /** 输入 token 数 */
  inputTokens: number;
  /** 输出 token 数（含思考内容） */
  outputTokens: number;
  /** 总 token 数（服务端未返回时按输入 + 输出推算） */
  totalTokens: number;
  /** 命中缓存读取的输入 token（服务未返回时为 0） */
  cachedTokens: number;
  /** 思考内容 token（服务未返回时为 0） */
  reasoningTokens: number;
}

/**
 * 思考档位：面向用户的统一抽象，与具体厂商协议解耦
 * off 不思考；low/medium/high 思考强度递增
 */
export type ThinkingLevel = "off" | "low" | "medium" | "high";

/**
 * 思考协议风格：决定档位翻译成哪种请求字段
 * - reasoning_effort：OpenAI 官方（o 系列/gpt-5）、OpenRouter、vLLM 等，档位即强度
 * - thinking：火山方舟（豆包）、智谱 GLM 的 thinking.type 扩展，仅开/关
 * - enable_thinking：阿里 Qwen DashScope 兼容模式，仅开/关
 * - none：DeepSeek 等不支持开关的服务，不发任何思考字段（靠换模型切换）
 */
export type ThinkingStyle =
  | "reasoning_effort"
  | "thinking"
  | "enable_thinking"
  | "none";

/**
 * 工具定义：遵循 OpenAI function calling 的 JSON Schema 结构（为 agent 命令预留）
 */
export interface ToolDefinition {
  /** 工具名称，如 read_file */
  name: string;
  /** 工具功能描述，供模型理解何时调用 */
  description: string;
  /** 参数的 JSON Schema 定义，如 { type: "object", properties: {...} } */
  parameters: Record<string, unknown>;
}

/**
 * 模型发起的工具调用请求（Responses API 的内部统一表示）
 */
export interface ToolCall {
  /** 调用 ID：结果回传时用于配对（对应 Responses API 的 call_id） */
  callId: string;
  /** 工具名称 */
  name: string;
  /** 参数的 JSON 字符串：保持服务端原始格式，回传时原样使用 */
  arguments: string;
}

/**
 * Responses API 无状态模式（store=false）的对话历史输入项
 * 服务端不留存会话，调用方本地维护完整历史并每轮全量发送
 */
export type ResponseHistoryItem =
  /** 用户/助手消息 */
  | { type: "message"; role: "user" | "assistant"; content: string }
  /** 模型发起的工具调用（与结果项靠 callId 配对） */
  | {
      type: "function_call";
      callId: string;
      name: string;
      arguments: string;
    }
  /** 工具执行结果 */
  | { type: "function_call_output"; callId: string; output: string };
