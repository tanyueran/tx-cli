import { CliError } from "../../shared/errors";
import type { LlmConfig, ThinkingLevel, ThinkingStyle } from "../../types/llm";

/** 全部合法的思考档位（帮助文案与校验共用，避免多处硬编码漂移） */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  "off",
  "low",
  "medium",
  "high",
];

/** baseUrl → 思考协议风格的推断规则（按声明顺序首个命中生效） */
const STYLE_INFERENCE_RULES: Array<{ pattern: RegExp; style: ThinkingStyle }> =
  [
    // 火山方舟（豆包）、智谱 GLM：thinking.type 开关式扩展
    { pattern: /volces\.com|doubao|bigmodel\.cn/i, style: "thinking" },
    // 阿里 Qwen DashScope 兼容模式：enable_thinking 布尔开关
    { pattern: /dashscope\.aliyuncs\.com/i, style: "enable_thinking" },
  ];

/** 各协议风格的用户可读说明（用于折算提示） */
const STYLE_DESCRIPTIONS: Record<ThinkingStyle, string> = {
  reasoning_effort: "档位直接作为 reasoning_effort 下发",
  thinking: "仅支持开/关（thinking.type），low/medium/high 均按 enabled 折算",
  enable_thinking:
    "仅支持开/关（enable_thinking），low/medium/high 均按开启折算",
  none: "不支持思考开关，思考字段不会下发（可换 reasoner 类模型）",
};

/**
 * 解析用户输入的思考档位：仅接受 off/low/medium/high，非法值抛错并列出合法档位
 * @param {string | undefined} input - 用户输入（如 "low"）；不传或空串返回 undefined（表示未指定）
 * @returns {ThinkingLevel | undefined} 档位；未指定时为 undefined
 * @throws {CliError} 输入了无法识别的档位时抛出
 */
export function parseThinkingLevel(
  input: string | undefined,
): ThinkingLevel | undefined {
  if (!input) {
    return undefined;
  }
  const value = input.trim().toLowerCase();
  if (!(THINKING_LEVELS as readonly string[]).includes(value)) {
    throw new CliError(
      `无法识别的思考档位 "${input}"，可选：${THINKING_LEVELS.join(" | ")}`,
    );
  }
  return value as ThinkingLevel;
}

/** 全部合法的思考协议风格 */
const THINKING_STYLES: readonly ThinkingStyle[] = [
  "reasoning_effort",
  "thinking",
  "enable_thinking",
  "none",
];

/**
 * 解析用户输入的思考协议风格：非法值抛错并列出合法风格
 * @param {string | undefined} input - 用户输入；不传或空串返回 undefined（表示未指定，走 baseUrl 推断）
 * @returns {ThinkingStyle | undefined} 风格；未指定时为 undefined
 * @throws {CliError} 输入了无法识别的风格时抛出
 */
export function parseThinkingStyle(
  input: string | undefined,
): ThinkingStyle | undefined {
  if (!input) {
    return undefined;
  }
  if (!(THINKING_STYLES as readonly string[]).includes(input)) {
    throw new CliError(
      `无法识别的思考协议风格 "${input}"，可选：${THINKING_STYLES.join(" | ")}`,
    );
  }
  return input as ThinkingStyle;
}

/**
 * 决定思考协议风格：显式配置优先，否则按 baseUrl 推断，默认走 reasoning_effort（最大公约数）
 * @param {LlmConfig} config - LLM 接入配置
 * @returns {ThinkingStyle} 思考协议风格
 */
export function resolveThinkingStyle(config: LlmConfig): ThinkingStyle {
  if (config.thinkingStyle) {
    return config.thinkingStyle;
  }
  const hit = STYLE_INFERENCE_RULES.find((rule) =>
    rule.pattern.test(config.baseUrl),
  );
  return hit?.style ?? "reasoning_effort";
}

/**
 * 按档位与风格生成 Responses API 的附加请求字段
 * off 在 reasoning_effort/none 风格下不发任何字段，最大化兼容不支持思考扩展的服务；
 * thinking/enable_thinking 为开关式风格，low/medium/high 均折算为开启
 * @param {ThinkingLevel} level - 思考档位
 * @param {ThinkingStyle} style - 思考协议风格
 * @param {Partial<Record<ThinkingLevel, string>>} [effortMap] - 高级映射，优先于内置映射
 * @returns {Record<string, unknown>} 附加请求字段，空对象表示不下发
 */
export function resolveResponsesThinkingFields(
  level: ThinkingLevel,
  style: ThinkingStyle,
  effortMap?: Partial<Record<ThinkingLevel, string>>,
): Record<string, unknown> {
  switch (style) {
    case "reasoning_effort": {
      if (level === "off") {
        return {};
      }
      // reasoning_effort 风格映射为嵌套的 reasoning.effort 字段
      return { reasoning: { effort: effortMap?.[level] ?? level } };
    }
    case "thinking": {
      const type =
        effortMap?.[level] ?? (level === "off" ? "disabled" : "enabled");
      return { thinking: { type } };
    }
    case "enable_thinking":
      return { enable_thinking: level !== "off" };
    case "none":
      return {};
  }
}

/**
 * 判断风格是否只有开/关两档（无强度概念）
 * @param {ThinkingStyle} style - 思考协议风格
 * @returns {boolean} true 表示 low/medium/high 会被折算为同一行为
 */
export function isToggleOnlyStyle(style: ThinkingStyle): boolean {
  return style === "thinking" || style === "enable_thinking";
}

/**
 * 获取协议风格的用户可读说明，用于 REPL 启动与切换时的折算提示
 * @param {ThinkingStyle} style - 思考协议风格
 * @returns {string} 说明文本
 */
export function describeThinkingStyle(style: ThinkingStyle): string {
  return STYLE_DESCRIPTIONS[style];
}
