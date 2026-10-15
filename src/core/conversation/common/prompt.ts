import type { SkillMeta } from "../../skills";
import type { ChatMessage } from "../../../types/llm";

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
  const lines = skills.map((skill) => `- ${skill.name}: ${skill.description}`);
  return [
    basePrompt,
    "",
    "你可以使用 load_skill 工具加载以下技能手册，当任务匹配某个技能的描述时，先调用 load_skill 加载对应手册，再按手册指引执行：",
    ...lines,
  ].join("\n");
}

/**
 * 构造初始消息列表（system 提示词 + 可选的首个用户问题）
 * @param {string} systemPrompt - 组装后的 system 提示词
 * @param {string | undefined} question - 首个用户问题（单次问答模式传入）
 * @returns {ChatMessage[]} 初始消息列表
 */
export function buildInitialMessages(
  systemPrompt: string,
  question?: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];
  if (question) {
    messages.push({ role: "user", content: question });
  }
  return messages;
}
