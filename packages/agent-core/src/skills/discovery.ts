import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 技能描述的长度上限（字符数）：超出静默截断，防止元数据清单膨胀拖大每轮请求 */
export const MAX_SKILL_DESCRIPTION_CHARS = 200;

/** frontmatter 块：文件必须以 --- 起始行开头、以 --- 行结束 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

/** 技能来源：user 用户级（~/.tx-cli/skills），project 项目级（<cwd>/.tx-cli/skills） */
export type SkillSource = "user" | "project";

/**
 * 技能元数据：SKILL.md frontmatter 的解析结果
 * 元数据常驻 system prompt 供模型判断是否加载，正文由 load_skill 工具按需读取
 */
export interface SkillMeta {
  /** 技能名（与所在目录名一致） */
  name: string;
  /** 技能描述：模型决定是否加载的唯一依据 */
  description: string;
  /** 来源级别：项目级优先于用户级 */
  source: SkillSource;
  /** SKILL.md 的绝对路径 */
  path: string;
  /**
   * 声明依赖的技能名（frontmatter requires 字段）
   * 加载本技能时一并告知依赖技能的元数据，免去模型自行探查目录
   */
  requires: string[];
}

/** 技能目录扫描结果：成功解析的技能与各非法项的跳过原因 */
export interface SkillDiscoveryResult {
  /** 合法技能列表（项目级在前，用户级在后） */
  skills: SkillMeta[];
  /** 扫描过程中的警告（非法项跳过原因、重名忽略等） */
  warnings: string[];
}

/**
 * 解析用户级技能目录路径：~/.tx-cli/skills
 * @returns {string} 用户级技能目录的绝对路径
 */
export function resolveUserSkillsDir(): string {
  return join(homedir(), ".tx-cli", "skills");
}

/**
 * 解析项目级技能目录路径：<cwd>/.tx-cli/skills
 * @param {string} cwd - 项目根目录
 * @returns {string} 项目级技能目录的绝对路径
 */
export function resolveProjectSkillsDir(cwd: string): string {
  return join(cwd, ".tx-cli", "skills");
}

/**
 * 解析 frontmatter 的 requires 字段：支持 `a, b` 与 `[a, b]` 两种单行写法
 * @param {string | undefined} raw - 原始字段值
 * @returns {string[]} 依赖技能名列表（去重、保持书写顺序）
 */
function parseRequires(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const inner = raw.trim().replace(/^\[/, "").replace(/\]$/, "");
  const names = inner
    .split(/[,，、\s]+/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  return [...new Set(names)];
}

/**
 * 校验依赖声明：剔除不存在的依赖与自依赖，并收集警告
 * @param {SkillMeta[]} skills - 已发现的技能列表（就地修改 requires）
 * @param {Map<string, SkillMeta>} skillsByName - 按名索引的技能集合
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {void}
 */
function pruneRequires(
  skills: SkillMeta[],
  skillsByName: Map<string, SkillMeta>,
  warnings: string[],
): void {
  for (const skill of skills) {
    const kept: string[] = [];
    for (const dep of skill.requires) {
      if (dep === skill.name) {
        warnings.push(`技能 ${skill.name} 的 requires 包含自身，已忽略`);
        continue;
      }
      if (!skillsByName.has(dep)) {
        warnings.push(`技能 ${skill.name} 声明的依赖技能 ${dep} 不存在，已忽略`);
        continue;
      }
      kept.push(dep);
    }
    skill.requires = kept;
  }
}

/**
 * 解析 SKILL.md 的 frontmatter 与正文
 * 仅支持 key: value 单行字段（成对首尾引号可去除），多行 YAML 语法不在约定范围内
 * @param {string} fileContent - SKILL.md 全文
 * @returns {{ fields: Record<string, string>; body: string } | undefined} 字段表与正文；无 frontmatter 时为 undefined
 */
function parseFrontmatter(
  fileContent: string,
): { fields: Record<string, string>; body: string } | undefined {
  const match = FRONTMATTER_RE.exec(fileContent);
  if (!match) {
    return undefined;
  }
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep <= 0) {
      continue;
    }
    const key = line.slice(0, sep).trim();
    let value = line.slice(sep + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    if (key) {
      fields[key] = value;
    }
  }
  return { fields, body: fileContent.slice(match[0].length).trim() };
}

/**
 * 提取 SKILL.md 正文（frontmatter 之后的 Markdown 部分）
 * @param {string} fileContent - SKILL.md 全文
 * @returns {string} 正文（无 frontmatter 时为全文去空白后的内容）
 */
export function extractSkillBody(fileContent: string): string {
  const match = FRONTMATTER_RE.exec(fileContent);
  return (match ? fileContent.slice(match[0].length) : fileContent).trim();
}

/**
 * 解析单个 SKILL.md 为技能元数据
 * 校验规则：frontmatter 必须存在；name 与目录名一致；description 非空（超长截断）；正文非空
 * @param {string} dirName - 技能所在目录名
 * @param {string} skillFile - SKILL.md 的绝对路径
 * @param {SkillSource} source - 来源标注
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {SkillMeta | undefined} 合法时返回元数据，否则为 undefined
 */
function parseSkillFile(
  dirName: string,
  skillFile: string,
  source: SkillSource,
  warnings: string[],
): SkillMeta | undefined {
  let fileContent: string;
  try {
    fileContent = readFileSync(skillFile, "utf-8");
  } catch (err) {
    warnings.push(
      `技能 ${dirName} 读取失败：${(err as Error).message}，已跳过`,
    );
    return undefined;
  }
  const frontmatter = parseFrontmatter(fileContent);
  if (!frontmatter) {
    warnings.push(`技能 ${dirName} 的 SKILL.md 缺少 frontmatter，已跳过`);
    return undefined;
  }
  const { name, description } = frontmatter.fields;
  if (!name || name !== dirName) {
    warnings.push(
      `技能 ${dirName} 的 name（${name || "缺失"}）与目录名不一致，已跳过`,
    );
    return undefined;
  }
  if (!description) {
    warnings.push(
      `技能 ${dirName} 缺少 description（模型据此判断是否加载），已跳过`,
    );
    return undefined;
  }
  if (!frontmatter.body) {
    warnings.push(`技能 ${dirName} 缺少正文，已跳过`);
    return undefined;
  }
  // 描述超长仅静默截断（防止元数据清单膨胀拖大每轮请求），不产生警告噪音
  let truncatedDescription = description;
  if (truncatedDescription.length > MAX_SKILL_DESCRIPTION_CHARS) {
    truncatedDescription = `${truncatedDescription.slice(0, MAX_SKILL_DESCRIPTION_CHARS)}…`;
  }
  return {
    name,
    description: truncatedDescription,
    source,
    path: skillFile,
    requires: parseRequires(frontmatter.fields.requires),
  };
}

/**
 * 扫描单个技能根目录：每个含 SKILL.md 的子目录为一个技能，非法项跳过并记录警告
 * @param {string} dir - 技能根目录
 * @param {SkillSource} source - 来源标注
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {SkillMeta[]} 合法技能列表
 */
function scanSkillDir(
  dir: string,
  source: SkillSource,
  warnings: string[],
): SkillMeta[] {
  if (!existsSync(dir)) {
    return [];
  }
  const skills: SkillMeta[] = [];
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const skillFile = join(dir, dirent.name, "SKILL.md");
    if (!existsSync(skillFile)) {
      continue;
    }
    const meta = parseSkillFile(dirent.name, skillFile, source, warnings);
    if (meta) {
      skills.push(meta);
    }
  }
  return skills;
}

/**
 * 发现全部可用技能：先项目级后用户级，同名时项目级胜出、用户级忽略并告警
 * 单个技能非法只跳过并告警，不影响其他技能与整个会话（失败隔离）
 * 项目级与用户级目录为同一路径时（如 cwd 恰为用户主目录）只扫描一次，避免重复告警
 * @param {string} cwd - 项目根目录（缺省为当前工作目录）
 * @param {string} userDir - 用户级技能目录（缺省 ~/.tx-cli/skills，测试可注入）
 * @returns {SkillDiscoveryResult} 技能列表与扫描警告
 */
export function discoverSkills(
  cwd: string = process.cwd(),
  userDir: string = resolveUserSkillsDir(),
): SkillDiscoveryResult {
  const warnings: string[] = [];
  const skillsByName = new Map<string, SkillMeta>();
  const projectDir = resolveProjectSkillsDir(cwd);
  const isSameDir = projectDir === userDir;
  for (const meta of scanSkillDir(projectDir, "project", warnings)) {
    skillsByName.set(meta.name, meta);
  }
  if (!isSameDir) {
    for (const meta of scanSkillDir(userDir, "user", warnings)) {
      if (skillsByName.has(meta.name)) {
        warnings.push(`用户级技能 ${meta.name} 与项目级重名，已忽略用户级`);
        continue;
      }
      skillsByName.set(meta.name, meta);
    }
  }
  const skills = [...skillsByName.values()];
  pruneRequires(skills, skillsByName, warnings);
  return { skills, warnings };
}
