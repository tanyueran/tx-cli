import pico from "picocolors";
import {
  readGlobalConfig,
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
  updateConfigSection,
} from "../../shared/user-config";
import { mergeRecords } from "../../shared/config-merge";
import { runSetupWizard } from "./config-wizard";
import { parseThinkingLevel, parseThinkingStyle } from "./thinking";
import type {
  LlmConfig,
  LlmPricing,
  ThinkingLevel,
  ThinkingStyle,
} from "./types";

/** 配置文件结构：llm 段存放大模型接入配置，其余段位预留给后续功能 */
interface LlmFileConfig {
  llm?: Partial<LlmConfig>;
}

/**
 * 读取指定配置文件的 llm 段：文件读取与 JSON 解析由共享模块完成，此处只做段收窄
 * @param {string} configPath - 配置文件路径
 * @returns {LlmFileConfig} llm 段内容（文件不存在或损坏时为空对象）
 */
function readLlmFileConfig(configPath: string): LlmFileConfig {
  const { configData: fileConfig, warnings } = readGlobalConfig(configPath);
  for (const warning of warnings) {
    console.warn(pico.yellow(warning));
  }
  const { llm } = fileConfig;
  return {
    llm:
      typeof llm === "object" && llm !== null && !Array.isArray(llm)
        ? (llm as Partial<LlmConfig>)
        : undefined,
  };
}

/**
 * 判断字符串配置项是否有效：空字符串视为未配置
 * @param {string | undefined} configValue - 配置原始值
 * @returns {string | undefined} 有效值或 undefined
 */
function normalizeText(configValue: string | undefined): string | undefined {
  return configValue ? configValue : undefined;
}

/**
 * 校验并归一化费用单价配置：只保留有限非负数的单价字段
 * 无任何有效单价时返回 undefined（仅统计 token，不估算费用）
 * @param {LlmPricing | undefined} raw - 配置文件中的原始 pricing 段
 * @returns {LlmPricing | undefined} 归一化后的单价配置
 */
function normalizePricing(raw: LlmPricing | undefined): LlmPricing | undefined {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const pricing: LlmPricing = {};
  let hasPrice = false;
  for (const key of ["inputPerMillion", "outputPerMillion"] as const) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
      pricing[key] = value;
      hasPrice = true;
    } else {
      console.warn(
        pico.yellow(`llm.pricing.${key} 配置非法（需为非负数），已忽略`),
      );
    }
  }
  if (typeof raw.currency === "string" && raw.currency.trim()) {
    pricing.currency = raw.currency.trim();
  }
  return hasPrice ? pricing : undefined;
}

/**
 * 按优先级合并两级配置文件的 llm 段：项目配置 > 全局配置
 *
 * 标量字段高层覆盖低层，thinkingEffortMap 按 key 合并（项目同名覆盖全局）
 * @param {string} globalPath - 全局配置文件路径
 * @param {string | undefined} projectPath - 项目配置文件路径（缺省跳过项目层）
 * @returns {Partial<LlmConfig>} 解析结果，任一项都可能为空
 */
function resolveConfigFromSources(
  globalPath: string,
  projectPath?: string,
): Partial<LlmConfig> {
  const globalLlm = readLlmFileConfig(globalPath).llm;
  const projectLlm = projectPath
    ? readLlmFileConfig(projectPath).llm
    : undefined;
  return {
    apiKey:
      normalizeText(projectLlm?.apiKey) ?? normalizeText(globalLlm?.apiKey),
    baseUrl:
      normalizeText(projectLlm?.baseUrl) ?? normalizeText(globalLlm?.baseUrl),
    model: normalizeText(projectLlm?.model) ?? normalizeText(globalLlm?.model),
    thinkingLevel: (projectLlm?.thinkingLevel ?? globalLlm?.thinkingLevel) as
      | ThinkingLevel
      | undefined,
    thinkingStyle: (projectLlm?.thinkingStyle ?? globalLlm?.thinkingStyle) as
      | ThinkingStyle
      | undefined,
    thinkingEffortMap:
      projectLlm?.thinkingEffortMap || globalLlm?.thinkingEffortMap
        ? mergeRecords(
            globalLlm?.thinkingEffortMap ?? {},
            projectLlm?.thinkingEffortMap ?? {},
          )
        : undefined,
    // 单价配置整体覆盖（项目 > 全局），非法字段在校验时丢弃
    pricing: normalizePricing(projectLlm?.pricing ?? globalLlm?.pricing),
  };
}

/**
 * 保存 LLM 配置到用户级配置文件（统一写入口只替换 llm 段，其他段与缓存由共享模块处理）
 * @param {LlmConfig} llmConfig - 完整配置
 * @returns {void}
 */
function saveConfigFile(llmConfig: LlmConfig): void {
  updateConfigSection("llm", llmConfig);
  console.log(pico.green(`配置已保存到 ${resolveGlobalConfigPath()}`));
}

/**
 * 加载 LLM 配置：项目配置优先于全局配置（CLI 选项在命令层更优先）
 *
 * 必填三项（apiKey/baseUrl/model）任一缺失时进入交互向导补全并写盘；
 * 可选思考配置不参与引导，装载时统一校验，向导补全后原样合并保留以免落盘丢失
 *
 * @param {string} globalPath - 全局配置文件路径（缺省 ~/.tx-cli/config.json，测试可注入）
 * @param {string} projectPath - 项目配置文件路径（缺省 <cwd>/.tx-cli/config.json，测试可注入）
 * @returns {Promise<LlmConfig>} 完整可用的 LLM 配置
 * @throws {CliError} 思考档位或风格配置非法时抛出
 */
export async function loadLlmConfig(
  globalPath: string = resolveGlobalConfigPath(),
  projectPath: string = resolveProjectConfigPath(process.cwd()),
): Promise<LlmConfig> {
  const partialLlmConfig = resolveConfigFromSources(globalPath, projectPath);
  const thinkingLevel = parseThinkingLevel(partialLlmConfig.thinkingLevel);
  const thinkingStyle = parseThinkingStyle(partialLlmConfig.thinkingStyle);
  const thinkingConfig = {
    ...(thinkingLevel ? { thinkingLevel } : {}),
    ...(thinkingStyle ? { thinkingStyle } : {}),
    ...(partialLlmConfig.thinkingEffortMap
      ? { thinkingEffortMap: partialLlmConfig.thinkingEffortMap }
      : {}),
    // 可选费用单价不参与引导，装载时原样保留
    ...(partialLlmConfig.pricing ? { pricing: partialLlmConfig.pricing } : {}),
  };
  if (
    partialLlmConfig.apiKey &&
    partialLlmConfig.baseUrl &&
    partialLlmConfig.model
  ) {
    return {
      apiKey: partialLlmConfig.apiKey,
      baseUrl: partialLlmConfig.baseUrl,
      model: partialLlmConfig.model,
      ...thinkingConfig,
    };
  }
  const wizardConfig = await runSetupWizard(partialLlmConfig);
  const mergedLlmConfig = { ...wizardConfig, ...thinkingConfig };
  saveConfigFile(mergedLlmConfig);
  return mergedLlmConfig;
}
