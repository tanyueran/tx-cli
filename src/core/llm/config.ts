import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pico from "picocolors";
import { runSetupWizard } from "./config-wizard";
import { parseThinkingLevel, parseThinkingStyle } from "./thinking";
import type { LlmConfig, ThinkingLevel, ThinkingStyle } from "../../types/llm";

/** 配置文件结构：llm 段存放大模型接入配置，其余段位预留给后续功能 */
interface LlmFileConfig {
  llm?: Partial<LlmConfig>;
}

/**
 * 解析用户级配置文件路径：~/.tx-cli/config.json
 * @returns {string} 配置文件的绝对路径
 */
export function resolveUserConfigPath(): string {
  return join(homedir(), ".tx-cli", "config.json");
}

/**
 * 读取配置文件，文件不存在或内容损坏时返回空对象
 * @returns {LlmFileConfig} 配置文件内容（解析失败时为空对象）
 */
function readConfigFile(): LlmFileConfig {
  const path = resolveUserConfigPath();
  if (!existsSync(path)) {
    return {};
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as LlmFileConfig;
  } catch {
    console.warn(pico.yellow(`配置文件 ${path} 解析失败，已忽略，可重新配置`));
    return {};
  }
}

/**
 * 按优先级解析 LLM 配置：环境变量 > 配置文件
 * 空字符串视为未配置（避免环境变量置空时覆盖掉文件配置）
 * @returns {Partial<LlmConfig>} 解析结果，任一项都可能为空
 */
function resolveConfigFromSources(): Partial<LlmConfig> {
  const file = readConfigFile();
  return {
    apiKey: process.env.TX_LLM_API_KEY || file.llm?.apiKey,
    baseUrl: process.env.TX_LLM_BASE_URL || file.llm?.baseUrl,
    model: process.env.TX_LLM_MODEL || file.llm?.model,
    // 思考档位/风格为可选配置：env 覆盖文件；合法性与格式校验统一在装载时进行
    thinkingLevel: (process.env.TX_LLM_THINKING_LEVEL ||
      file.llm?.thinkingLevel) as ThinkingLevel | undefined,
    thinkingStyle: (process.env.TX_LLM_THINKING_STYLE ||
      file.llm?.thinkingStyle) as ThinkingStyle | undefined,
    thinkingEffortMap: file.llm?.thinkingEffortMap,
  };
}

/**
 * 保存 LLM 配置到用户级配置文件
 * @param {LlmConfig} config - 完整配置
 * @returns {void}
 */
function saveConfigFile(config: LlmConfig): void {
  const path = resolveUserConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  // 0o600：文件含密钥，仅允许当前用户读写
  writeFileSync(path, `${JSON.stringify({ llm: config }, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(pico.green(`配置已保存到 ${path}`));
}

/**
 * 加载 LLM 配置：环境变量优先于配置文件；必填三项（apiKey/baseUrl/model）任一缺失时进入引导流程
 * 可选思考配置（thinkingLevel/thinkingStyle/thinkingEffortMap）不参与引导，
 * 装载时统一校验并随完整配置返回，向导补全后原样保留以免落盘丢失
 * @returns {Promise<LlmConfig>} 完整可用的 LLM 配置
 * @throws {CliError} 思考档位或风格配置非法时抛出
 */
export async function loadLlmConfig(): Promise<LlmConfig> {
  const partial = resolveConfigFromSources();
  // 思考配置装载即校验：非法值直接报错，避免静默失效
  const thinkingLevel = parseThinkingLevel(partial.thinkingLevel);
  const thinkingStyle = parseThinkingStyle(partial.thinkingStyle);
  const thinking = {
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(thinkingStyle ? { thinkingStyle } : {}),
    ...(partial.thinkingEffortMap
      ? { thinkingEffortMap: partial.thinkingEffortMap }
      : {}),
  };
  if (partial.apiKey && partial.baseUrl && partial.model) {
    return {
      apiKey: partial.apiKey,
      baseUrl: partial.baseUrl,
      model: partial.model,
      ...thinking,
    };
  }
  const config = await runSetupWizard(partial);
  // 向导只收集必填三项，可选思考配置原样合并保留
  const merged = { ...config, ...thinking };
  saveConfigFile(merged);
  return merged;
}
