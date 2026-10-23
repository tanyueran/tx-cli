import pico from "picocolors";
import {
  readUserConfig,
  resolveProjectConfigPath,
  resolveUserConfigPath,
  updateConfigSection,
} from "../../shared/user-config";
import { mergeRecords } from "../../shared/config-merge";
import { runSetupWizard } from "./config-wizard";
import { parseThinkingLevel, parseThinkingStyle } from "./thinking";
import type { LlmConfig, ThinkingLevel, ThinkingStyle } from "./types";

/** 配置文件结构：llm 段存放大模型接入配置，其余段位预留给后续功能 */
interface LlmFileConfig {
  llm?: Partial<LlmConfig>;
}

/**
 * 读取指定配置文件的 llm 段：文件读取与 JSON 解析由共享模块完成，此处只做段收窄
 * @param {string} configPath - 配置文件路径
 * @returns {LlmFileConfig} llm 段内容（文件不存在或损坏时为空对象）
 */
function readLlmSection(configPath: string): LlmFileConfig {
  const { data, warnings } = readUserConfig(configPath);
  for (const warning of warnings) {
    console.warn(pico.yellow(warning));
  }
  const { llm } = data;
  return {
    llm:
      typeof llm === "object" && llm !== null && !Array.isArray(llm)
        ? (llm as Partial<LlmConfig>)
        : undefined,
  };
}

/**
 * 判断字符串配置项是否有效：空字符串视为未配置
 * @param {string | undefined} value - 配置原始值
 * @returns {string | undefined} 有效值或 undefined
 */
function normalizeText(
  value: string | undefined,
): string | undefined {
  return value ? value : undefined;
}

/**
 * 按优先级合并两级配置文件的 llm 段：项目配置 > 全局配置
 * 标量字段（apiKey/baseUrl/model/thinkingLevel/thinkingStyle）高层覆盖低层，
 * thinkingEffortMap 对象按 key 合并（项目同名覆盖全局）
 * @param {string} globalPath - 全局配置文件路径
 * @param {string | undefined} projectPath - 项目配置文件路径（缺省跳过项目层）
 * @returns {Partial<LlmConfig>} 解析结果，任一项都可能为空
 */
function resolveConfigFromSources(
  globalPath: string,
  projectPath?: string,
): Partial<LlmConfig> {
  const global = readLlmSection(globalPath).llm;
  const project = projectPath ? readLlmSection(projectPath).llm : undefined;
  return {
    apiKey: normalizeText(project?.apiKey) ?? normalizeText(global?.apiKey),
    baseUrl: normalizeText(project?.baseUrl) ?? normalizeText(global?.baseUrl),
    model: normalizeText(project?.model) ?? normalizeText(global?.model),
    // 思考档位/风格为可选配置：项目覆盖全局；合法性与格式校验统一在装载时进行
    thinkingLevel: (project?.thinkingLevel ??
      global?.thinkingLevel) as ThinkingLevel | undefined,
    thinkingStyle: (project?.thinkingStyle ??
      global?.thinkingStyle) as ThinkingStyle | undefined,
    thinkingEffortMap:
      project?.thinkingEffortMap || global?.thinkingEffortMap
        ? mergeRecords(global?.thinkingEffortMap ?? {}, project?.thinkingEffortMap ?? {})
        : undefined,
  };
}

/**
 * 保存 LLM 配置到用户级配置文件
 * 走统一写入口：只替换 llm 段，mcpServers 等其他段由共享模块负责保留，缓存同步刷新
 * @param {LlmConfig} config - 完整配置
 * @returns {void}
 */
function saveConfigFile(config: LlmConfig): void {
  updateConfigSection("llm", config);
  console.log(pico.green(`配置已保存到 ${resolveUserConfigPath()}`));
}

/**
 * 加载 LLM 配置：项目配置优先于全局配置（CLI 选项在命令层更优先）；必填三项（apiKey/baseUrl/model）任一缺失时进入引导流程
 * 可选思考配置（thinkingLevel/thinkingStyle/thinkingEffortMap）不参与引导，
 * 装载时统一校验并随完整配置返回，向导补全后原样保留以免落盘丢失
 * @param {string} globalPath - 全局配置文件路径（缺省 ~/.tx-cli/config.json，测试可注入）
 * @param {string} projectPath - 项目配置文件路径（缺省 <cwd>/.tx-cli/config.json，测试可注入）
 * @returns {Promise<LlmConfig>} 完整可用的 LLM 配置
 * @throws {CliError} 思考档位或风格配置非法时抛出
 */
export async function loadLlmConfig(
  globalPath: string = resolveUserConfigPath(),
  projectPath: string = resolveProjectConfigPath(process.cwd()),
): Promise<LlmConfig> {
  const partial = resolveConfigFromSources(globalPath, projectPath);
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
