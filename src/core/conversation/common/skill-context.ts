import pico from "picocolors";
import { createLoadSkillTool, discoverSkills, SkillCatalog } from "../../skills";
import { createBuiltinRegistry, type Tool } from "../../tools";
import { buildSystemPrompt } from "./prompt";

/** 技能装配结果：system 提示词、含 load_skill 的工具表、技能目录、扫描警告 */
export interface SkillContext {
  /** 组装后的 system 提示词（含技能元数据清单） */
  systemPrompt: string;
  /** 内置工具 + load_skill（无可用技能时仅内置工具） */
  tools: Tool[];
  /** 技能目录（/skills 内联命令展示用） */
  catalog: SkillCatalog;
  /** 扫描警告（启动时黄字提示） */
  warnings: string[];
}

/**
 * 发现技能并装配对话所需的提示词与工具列表
 * 仅当存在可用技能时才注册 load_skill，避免空技能场景多下发一个无用工具定义
 * @param {string} basePrompt - 场景基础提示词（chat、agent 等命令各自定义人设）
 * @returns {SkillContext} 装配结果
 */
export function setupSkillContext(basePrompt: string): SkillContext {
  const { skills, warnings } = discoverSkills();
  const catalog = new SkillCatalog(skills);
  const registry = createBuiltinRegistry();
  if (skills.length > 0) {
    registry.register(createLoadSkillTool(catalog));
  }
  return {
    systemPrompt: buildSystemPrompt(basePrompt, skills),
    tools: registry.list(),
    catalog,
    warnings,
  };
}

/**
 * 打印技能扫描警告：各对话模式共用的启动提示
 * @param {string[]} warnings - 扫描警告列表
 * @returns {void}
 */
export function printSkillWarnings(warnings: string[]): void {
  for (const warning of warnings) {
    console.warn(pico.yellow(warning));
  }
}
