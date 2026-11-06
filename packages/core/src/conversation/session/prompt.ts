import type { SkillMeta } from "../../skills";

/**
 * 组装 system 提示词：基础人设 + 技能元数据清单
 * 技能正文不常驻提示词，由模型通过 load_skill 工具按需加载，避免撑大每轮请求
 * @param {string} basePrompt - 场景基础提示词（chat、agent 等命令各自定义人设）
 * @param {SkillMeta[]} skills - 可用技能元数据（空数组时不追加清单段）
 * @returns {string} 完整 system 提示词
 */
export function buildSystemPrompt(
  basePrompt: string,
  skills: SkillMeta[],
): string {
  if (skills.length === 0) {
    return basePrompt;
  }
  const skillLines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return [
    basePrompt,
    "",
    "你可以使用 load_skill 工具加载以下技能手册，当任务匹配某个技能的描述时，先调用 load_skill 加载对应手册，再按手册指引执行：",
    ...skillLines,
  ].join("\n");
}
