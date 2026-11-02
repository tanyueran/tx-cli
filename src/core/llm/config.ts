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
  LlmContextConfig,
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
 * 校验并归一化上下文压缩配置：逐字段丢弃非法值，全部无效时返回 undefined
 * maxContextTokens 是启用开关，缺失该项时压缩整体关闭
 * @param {LlmContextConfig | undefined} raw - 配置文件中的原始 context 段
 * @returns {LlmContextConfig | undefined} 归一化后的配置
 */
function normalizeContext(
  raw: LlmContextConfig | undefined,
): LlmContextConfig | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const context: LlmContextConfig = {};
  const numericFields: Array<[keyof LlmContextConfig, string]> = [
    ["maxContextTokens", "大于 0 的整数"],
    ["compactAt", "大于 0 的数值（≤1 按窗口比例，>1 为绝对 token 数）"],
    ["keepRecentTurns", "大于 0 的整数"],
    ["summaryMaxChars", "大于 0 的整数"],
  ];
  for (const [key, expectation] of numericFields) {
    const value = raw[key];
    if (value === undefined) {
      continue;
    }
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      context[key] = value;
    } else {
      console.warn(
        pico.yellow(`llm.context.${key} 配置非法（需为${expectation}），已忽略`),
      );
    }
  }
  return Object.keys(context).length > 0 ? context : undefined;
}

/**
 * 合并两级上下文压缩配置：先各自校验，项目配置仅覆盖有效字段
 * 无效字段在归一化阶段已丢弃，不会因项目层的非法值把全局层的合法值冲掉
 * @param {LlmContextConfig | undefined} globalContext - 全局配置 context 段
 * @param {LlmContextConfig | undefined} projectContext - 项目配置 context 段
 * @returns {LlmContextConfig | undefined} 合并后的配置
 */
function mergeContextConfig(
  globalContext: LlmContextConfig | undefined,
  projectContext: LlmContextConfig | undefined,
): LlmContextConfig | undefined {
  const globalCtx = normalizeContext(globalContext);
  const projectCtx = normalizeContext(projectContext);
  if (!globalCtx && !projectCtx) {
    return undefined;
  }
  return { ...globalCtx, ...projectCtx };
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
    // 上下文压缩配置逐字段合并（项目覆盖全局），非法字段在校验时丢弃
    context: mergeContextConfig(globalLlm?.context, projectLlm?.context),
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
    // 可选上下文压缩配置不参与引导，装载时原样保留
    ...(partialLlmConfig.context ? { context: partialLlmConfig.context } : {}),
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
