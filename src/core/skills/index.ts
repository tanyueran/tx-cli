/**
 * core/skills 模块的桶导出：对外统一入口
 * 说明：模块内部文件互相引用时，仍直接走具体文件
 */
export {
  discoverSkills,
  extractSkillBody,
  resolveProjectSkillsDir,
  resolveUserSkillsDir,
  MAX_SKILL_DESCRIPTION_CHARS,
} from "./discovery";
export type { SkillDiscoveryResult, SkillMeta, SkillSource } from "./discovery";
export { SkillCatalog } from "./catalog";
export { createLoadSkillTool } from "./loader-tool";
