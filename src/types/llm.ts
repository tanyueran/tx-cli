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
  /** 全局默认思考档位，缺省 off（chat --think 可按次覆盖） */
  thinkingLevel?: ThinkingLevel;
  /** 思考协议风格，缺省按 baseUrl 推断 */
  thinkingStyle?: ThinkingStyle;
  /** 档位 → 服务端实际值的高级映射，优先于内置映射（适配仅支持部分档位的服务） */
  thinkingEffortMap?: Partial<Record<ThinkingLevel, string>>;
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
 * 模型发起的工具调用请求：两套接口（Chat Completions / Responses）的统一表示
 */
export interface ToolCall {
  /** 调用 ID：结果回传时用于配对（Chat Completions 为 tool_call_id，Responses 为 call_id） */
  id: string;
  /** 工具名称 */
  name: string;
  /** 参数的 JSON 字符串：保持服务端原始格式，回传时原样使用 */
  arguments: string;
}

/**
 * 对话消息：覆盖 chat 场景用到的角色与文本内容（两套接口的统一内部表示）
 */
export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** role 为 assistant 且模型请求了工具时携带的调用列表 */
  toolCalls?: ToolCall[];
  /** role 为 tool 时对应的调用 ID */
  toolCallId?: string;
}

/**
 * 深度思考开关：豆包、GLM 等服务对 Chat Completions 协议的常见扩展（thinking 字段）
 * disabled 不使用深度思考能力；enabled 使用；auto 由模型自行判断
 * 注意：不感知该字段的服务可能忽略或直接报错
 */
export type ThinkingType = "disabled" | "enabled" | "auto";

/**
 * 工具执行结果回传项（对应 Responses API 的 function_call_output 输入项）
 */
export interface ResponseToolResult {
  /** 对应的工具调用 ID（ToolCall.id） */
  callId: string;
  /** 工具输出：序列化后的文本，模型据此继续生成 */
  output: string;
}
