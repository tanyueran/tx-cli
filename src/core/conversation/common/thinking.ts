import pico from "picocolors";
import { describeThinkingStyle, isToggleOnlyStyle } from "../../llm";
import { DEFAULT_THINKING_LEVEL } from "./constants";
import type {
  LlmConfig,
  ThinkingLevel,
  ThinkingStyle,
} from "../../../types/llm";

/**
 * 解析生效的思考档位：命令行 --think > 配置文件 llm.thinkingLevel > 内置默认值
 * @param {ThinkingLevel | undefined} cliLevel - 命令行指定的档位，未指定时回退配置默认
 * @param {LlmConfig} config - LLM 接入配置
 * @returns {ThinkingLevel} 生效的思考档位
 */
export function resolveThinkingLevel(
  cliLevel: ThinkingLevel | undefined,
  config: LlmConfig
): ThinkingLevel {
  return cliLevel ?? config.thinkingLevel ?? DEFAULT_THINKING_LEVEL;
}

/**
 * 打印思考档位的服务能力折算警告：服务完全支持分档思考时静默
 * none 风格说明思考字段不会下发；开关式风格仅在非 off 档位时提示折算（off 本就对应关闭，无需提示）
 * @param {ThinkingLevel} level - 生效的思考档位
 * @param {ThinkingStyle} style - 思考协议风格
 * @returns {void}
 */
export function warnThinkingFallback(
  level: ThinkingLevel,
  style: ThinkingStyle
): void {
  if (style === "none") {
    console.log(
      pico.yellow(`思考档位为 ${level}，但${describeThinkingStyle(style)}`)
    );
    return;
  }
  if (isToggleOnlyStyle(style) && level !== "off") {
    console.log(pico.yellow(`注意：当前服务${describeThinkingStyle(style)}`));
  }
}
