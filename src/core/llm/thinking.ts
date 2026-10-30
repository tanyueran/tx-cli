import pico from "picocolors";
import { CliError } from "../../shared/errors";
import type { LlmConfig, ThinkingLevel, ThinkingStyle } from "./types";

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
 * 解析枚举选项的通用实现：空白输入视为未指定，非字符串或不在合法值内时报错列出候选
 * 配置文件中的非字符串值同样在此拦截为友好报错，
 * 避免对非字符串调用字符串方法导致整个 CLI 以 TypeError 崩溃
 * @param {string | undefined} value - 用户输入（命令行或配置文件）
 * @param {readonly T[]} allowed - 合法值集合（帮助文案与校验共用）
 * @param {string} label - 报错文案中的选项名（如「思考档位」）
 * @param {boolean} normalize - 是否做大小写与首尾空格归一化
 * @returns {T | undefined} 命中的合法值；未指定时为 undefined
 * @throws {CliError} 输入非字符串或无法识别时抛出
 */
function parseEnumChoice<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  label: string,
  normalize = false,
): T | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new CliError(
      `${label}配置类型非法（需为字符串，实际为 ${typeof value}），可选：${allowed.join(" | ")}`,
    );
  }
  const normalized = normalize ? value.trim().toLowerCase() : value;
  if (!(allowed as readonly string[]).includes(normalized)) {
    throw new CliError(
      `无法识别的${label} "${value}"，可选：${allowed.join(" | ")}`,
    );
  }
  return normalized as T;
}

/**
 * 解析用户输入的思考档位（支持大小写与首尾空格归一化）
 * @param {string | undefined} levelInput - 用户输入（如 "low"）；不传或空串返回 undefined
 * @returns {ThinkingLevel | undefined} 档位；未指定时为 undefined
 * @throws {CliError} 输入非字符串或无法识别的档位时抛出
 */
export function parseThinkingLevel(
  levelInput: string | undefined,
): ThinkingLevel | undefined {
  return parseEnumChoice(levelInput, THINKING_LEVELS, "思考档位", true);
}

/** 全部合法的思考协议风格 */
const THINKING_STYLES: readonly ThinkingStyle[] = [
  "reasoning_effort",
  "thinking",
  "enable_thinking",
  "none",
];

/**
 * 解析用户输入的思考协议风格（不做归一化，需精确匹配）
 * @param {string | undefined} styleInput - 用户输入；不传或空串返回 undefined（表示未指定，走 baseUrl 推断）
 * @returns {ThinkingStyle | undefined} 风格；未指定时为 undefined
 * @throws {CliError} 输入非字符串或无法识别的风格时抛出
 */
export function parseThinkingStyle(
  styleInput: string | undefined,
): ThinkingStyle | undefined {
  return parseEnumChoice(styleInput, THINKING_STYLES, "思考协议风格");
}

/**
 * 决定思考协议风格：显式配置优先，否则按 baseUrl 推断，默认走 reasoning_effort（最大公约数）
 * @param {LlmConfig} llmConfig - LLM 接入配置
 * @returns {ThinkingStyle} 思考协议风格
 */
export function resolveThinkingStyle(llmConfig: LlmConfig): ThinkingStyle {
  if (llmConfig.thinkingStyle) {
    return llmConfig.thinkingStyle;
  }
  const matchedRule = STYLE_INFERENCE_RULES.find((rule) =>
    rule.pattern.test(llmConfig.baseUrl),
  );
  return matchedRule?.style ?? "reasoning_effort";
}

/** resolveResponsesThinkingFields 入参对象 */
export interface ResolveResponsesThinkingFieldsOptions {
  /** 思考档位 */
  thinkingLevel: ThinkingLevel;
  /** 思考协议风格 */
  thinkingStyle: ThinkingStyle;
  /** 高级映射，优先于内置映射 */
  thinkingEffortMap?: Partial<Record<ThinkingLevel, string>>;
}

/**
 * 按档位与风格生成 Responses API 的附加请求字段
 * off 在 reasoning_effort/none 风格下不发任何字段，最大化兼容不支持思考扩展的服务；
 * thinking/enable_thinking 为开关式风格，low/medium/high 均折算为开启
 * @param {ResolveResponsesThinkingFieldsOptions} options - 入参对象（thinkingLevel/thinkingStyle/thinkingEffortMap 字段说明见接口定义）
 * @returns {Record<string, unknown>} 附加请求字段，空对象表示不下发
 */
export function resolveResponsesThinkingFields({
  thinkingLevel,
  thinkingStyle,
  thinkingEffortMap,
}: ResolveResponsesThinkingFieldsOptions): Record<string, unknown> {
  switch (thinkingStyle) {
    case "reasoning_effort": {
      if (thinkingLevel === "off") {
        return {};
      }
      // reasoning_effort 风格映射为嵌套的 reasoning.effort 字段
      return {
        reasoning: {
          effort: thinkingEffortMap?.[thinkingLevel] ?? thinkingLevel,
        },
      };
    }
    case "thinking": {
      const type =
        thinkingEffortMap?.[thinkingLevel] ??
        (thinkingLevel === "off" ? "disabled" : "enabled");
      return { thinking: { type } };
    }
    case "enable_thinking":
      return { enable_thinking: thinkingLevel !== "off" };
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

/** 思考档位缺省值：配置与命令行均未指定时使用（chat、agent 等命令共用） */
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";

/** resolveThinkingLevel 入参对象 */
export interface ResolveThinkingLevelOptions {
  /** 命令行指定的档位，未指定时回退配置默认 */
  cliLevel?: ThinkingLevel;
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 配置也未指定时的兜底档位（chat 为 low，其余为 medium） */
  fallback?: ThinkingLevel;
}

/**
 * 解析生效的思考档位：命令行 --think > 配置文件（项目 > 全局）> 模式内置默认值
 * @param {ResolveThinkingLevelOptions} options - 入参对象（cliLevel/llmConfig/fallback 字段说明见接口定义）
 * @returns {ThinkingLevel} 生效的思考档位
 */
export function resolveThinkingLevel({
  cliLevel,
  llmConfig,
  fallback = DEFAULT_THINKING_LEVEL,
}: ResolveThinkingLevelOptions): ThinkingLevel {
  return cliLevel ?? llmConfig.thinkingLevel ?? fallback;
}

/**
 * 打印思考档位的服务能力折算警告：服务完全支持分档思考时静默
 * none 风格说明思考字段不会下发；开关式风格仅在非 off 档位时提示折算（off 本就对应关闭，无需提示）
 * @param {ThinkingLevel} thinkingLevel - 生效的思考档位
 * @param {ThinkingStyle} thinkingStyle - 思考协议风格
 * @returns {void}
 */
export function warnThinkingFallback(
  thinkingLevel: ThinkingLevel,
  thinkingStyle: ThinkingStyle,
): void {
  if (thinkingStyle === "none") {
    console.log(
      pico.yellow(
        `思考档位为 ${thinkingLevel}，但${describeThinkingStyle(thinkingStyle)}`,
      ),
    );
    return;
  }
  if (isToggleOnlyStyle(thinkingStyle) && thinkingLevel !== "off") {
    console.log(
      pico.yellow(`注意：当前服务${describeThinkingStyle(thinkingStyle)}`),
    );
  }
}
