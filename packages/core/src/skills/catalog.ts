import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { extractSkillBody } from "./discovery";
import type { SkillMeta } from "./discovery";

/**
 * 拼装技能目录头部标注：告知模型技能所在目录，
 * @param {SkillMeta} meta - 技能元数据（path 为 SKILL.md 绝对路径）
 * @returns {string} 头部标注行
 */
function buildSkillDirHeader(meta: SkillMeta): string {
  return `技能目录：${dirname(meta.path)}`;
}

/**
 * 技能目录：按名查找元数据、按需读取正文
 * 元数据常驻 system prompt，正文仅在模型调用 load_skill 时读取（首次读取后缓存）
 */
export class SkillCatalog {
  private readonly skills = new Map<string, SkillMeta>();
  private readonly rawBodyCache = new Map<string, string>();

  /**
   * @param {SkillMeta[]} skills - discoverSkills 扫描得到的技能列表
   */
  constructor(skills: SkillMeta[]) {
    for (const skill of skills) {
      this.skills.set(skill.name, skill);
    }
  }

  /**
   * 按名查找技能元数据
   * @param {string} name - 技能名
   * @returns {SkillMeta | undefined} 命中的元数据，不存在时为 undefined
   */
  get(name: string): SkillMeta | undefined {
    return this.skills.get(name);
  }

  /**
   * 列出全部技能元数据
   * @returns {SkillMeta[]} 技能列表（项目级在前，用户级在后）
   */
  list(): SkillMeta[] {
    return [...this.skills.values()];
  }

  /**
   * 技能数量
   * @returns {number} 已收录的技能数
   */
  get size(): number {
    return this.skills.size;
  }

  /**
   * 读取技能正文原文（frontmatter 之后的 Markdown 部分），首次读取后缓存
   * 供 load_skill 按行分页返回；正文按行切分时行号与缓存内容一致
   * @param {string} name - 技能名
   * @returns {Promise<string | undefined>} 技能正文；技能不存在时为 undefined
   * @throws 文件读取失败时抛出，由调用方转为失败输出回传模型
   */
  async readRawBody(name: string): Promise<string | undefined> {
    const meta = this.skills.get(name);
    if (!meta) {
      return undefined;
    }
    const cached = this.rawBodyCache.get(name);
    if (cached !== undefined) {
      return cached;
    }
    const body = extractSkillBody(await readFile(meta.path, "utf-8"));
    this.rawBodyCache.set(name, body);
    return body;
  }

  /**
   * 读取技能正文（frontmatter 之后的 Markdown 部分），首部附带技能目录标注，首次读取后缓存
   * @param {string} name - 技能名
   * @returns {Promise<string | undefined>} 带目录标注的技能正文；技能不存在时为 undefined
   * @throws 文件读取失败时抛出，由调用方转为失败输出回传模型
   */
  async readBody(name: string): Promise<string | undefined> {
    const meta = this.skills.get(name);
    if (!meta) {
      return undefined;
    }
    const body = await this.readRawBody(name);
    return `${buildSkillDirHeader(meta)}\n\n${body}`;
  }
}
