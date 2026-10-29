import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createLoadSkillTool,
  discoverSkills,
  MAX_SKILL_DESCRIPTION_CHARS,
  SkillCatalog,
} from "../src/core/skills";

/** 项目根目录（临时目录），其 .tx-cli/skills 为项目级技能目录 */
let cwd: string;
/** 用户级技能目录（临时目录，注入替代 ~/.tx-cli/skills） */
let userDir: string;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "tx-cli-skills-cwd-"));
  userDir = mkdtempSync(join(tmpdir(), "tx-cli-skills-user-"));
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

/**
 * 构造合法的 SKILL.md 文本
 * @param {string} name - 技能名
 * @param {string} description - 技能描述
 * @param {string} body - 正文
 * @returns {string} SKILL.md 全文
 */
function skillContent(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

/**
 * 在指定技能根目录下创建一个技能
 * @param {string} root - 技能根目录
 * @param {string} name - 技能名（目录名）
 * @param {string} content - SKILL.md 全文
 * @returns {string} SKILL.md 的绝对路径
 */
function writeSkill(root: string, name: string, content: string): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "SKILL.md");
  writeFileSync(file, content);
  return file;
}

/** 项目级技能根目录路径 */
function projectRoot(): string {
  return join(cwd, ".tx-cli", "skills");
}

describe("discoverSkills", () => {
  it("目录不存在时返回空结果且无警告", () => {
    const { skills, warnings } = discoverSkills(cwd, userDir);

    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("扫描项目级与用户级技能并标注来源，项目级排前", () => {
    writeSkill(userDir, "user-skill", skillContent("user-skill", "用户级", "U"));
    writeSkill(
      projectRoot(),
      "proj-skill",
      skillContent("proj-skill", "项目级", "P"),
    );

    const { skills, warnings } = discoverSkills(cwd, userDir);

    expect(warnings).toEqual([]);
    expect(skills.map((s) => s.name)).toEqual(["proj-skill", "user-skill"]);
    expect(skills[0].source).toBe("project");
    expect(skills[1].source).toBe("user");
  });

  it("项目级与用户级重名时项目级胜出并告警", () => {
    writeSkill(userDir, "dup", skillContent("dup", "用户级描述", "U"));
    writeSkill(projectRoot(), "dup", skillContent("dup", "项目级描述", "P"));

    const { skills, warnings } = discoverSkills(cwd, userDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].source).toBe("project");
    expect(skills[0].description).toBe("项目级描述");
    expect(warnings.some((w) => w.includes("重名"))).toBe(true);
  });

  it("非法技能跳过并告警，不影响其他合法技能", () => {
    writeSkill(userDir, "no-frontmatter", "没有 frontmatter 的内容");
    writeSkill(userDir, "bad-name", skillContent("other-name", "描述", "正文"));
    writeSkill(userDir, "no-desc", `---\nname: no-desc\n---\n\n正文\n`);
    writeSkill(userDir, "no-body", `---\nname: no-body\ndescription: 缺正文\n---\n`);
    writeSkill(userDir, "good", skillContent("good", "合法技能", "正文"));

    const { skills, warnings } = discoverSkills(cwd, userDir);

    expect(skills.map((s) => s.name)).toEqual(["good"]);
    expect(warnings).toHaveLength(4);
  });

  it("description 超长时静默截断且不产生警告", () => {
    const longDesc = "描".repeat(MAX_SKILL_DESCRIPTION_CHARS + 10);
    writeSkill(userDir, "long-desc", skillContent("long-desc", longDesc, "正文"));

    const { skills, warnings } = discoverSkills(cwd, userDir);

    expect(skills).toHaveLength(1);
    expect(skills[0].description).toHaveLength(MAX_SKILL_DESCRIPTION_CHARS + 1);
    expect(warnings).toEqual([]);
  });

  it("frontmatter 字段支持成对引号包裹", () => {
    writeSkill(
      userDir,
      "quoted",
      `---\nname: "quoted"\ndescription: '带引号的描述'\n---\n\n正文\n`,
    );

    const { skills, warnings } = discoverSkills(cwd, userDir);

    expect(warnings).toEqual([]);
    expect(skills[0].description).toBe("带引号的描述");
  });

  it("项目级与用户级为同一目录时只扫描一次，不产生重名或重复告警", () => {
    // 模拟 cwd 恰为用户主目录：项目级与用户级目录解析为同一路径
    const shared = projectRoot();
    writeSkill(shared, "shared", skillContent("shared", "共享技能", "正文"));
    writeSkill(shared, "broken", "没有 frontmatter 的内容");

    const { skills, warnings } = discoverSkills(cwd, shared);

    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "shared", source: "project" });
    expect(warnings).toEqual([
      "技能 broken 的 SKILL.md 缺少 frontmatter，已跳过",
    ]);
  });

  it("requires 支持逗号与方括号写法，并剔除不存在的依赖", () => {
    writeSkill(
      userDir,
      "a",
      `---\nname: a\ndescription: 甲\nrequires: b, c\n---\n\n正文\n`,
    );
    writeSkill(
      userDir,
      "b",
      `---\nname: b\ndescription: 乙\n---\n\n正文\n`,
    );
    writeSkill(
      userDir,
      "c",
      `---\nname: c\ndescription: 丙\nrequires: [a, missing]\n---\n\n正文\n`,
    );

    const { skills, warnings } = discoverSkills(cwd, userDir);

    expect(skills.find((skill) => skill.name === "a")?.requires).toEqual([
      "b",
      "c",
    ]);
    expect(skills.find((skill) => skill.name === "c")?.requires).toEqual(["a"]);
    expect(warnings).toEqual([
      "技能 c 声明的依赖技能 missing 不存在，已忽略",
    ]);
  });
});

describe("SkillCatalog", () => {
  it("readBody 返回带技能目录标注的正文", async () => {
    writeSkill(userDir, "vue", skillContent("vue", "Vue 规范", "# 步骤\n1. 先做这个"));
    const catalog = new SkillCatalog(discoverSkills(cwd, userDir).skills);

    const body = await catalog.readBody("vue");

    expect(body).toBe(
      `技能目录：${join(userDir, "vue")}\n\n# 步骤\n1. 先做这个`,
    );
  });

  it("readBody 对未知名返回 undefined", async () => {
    const catalog = new SkillCatalog([]);

    expect(await catalog.readBody("nope")).toBeUndefined();
  });

  it("正文首次读取后走缓存，文件后续变更不影响", async () => {
    const file = writeSkill(userDir, "cached", skillContent("cached", "缓存", "旧正文"));
    const catalog = new SkillCatalog(discoverSkills(cwd, userDir).skills);

    const first = await catalog.readBody("cached");
    writeFileSync(file, skillContent("cached", "缓存", "新正文"));
    const second = await catalog.readBody("cached");

    const expected = `技能目录：${join(userDir, "cached")}\n\n旧正文`;
    expect(first).toBe(expected);
    expect(second).toBe(expected);
  });
});

describe("createLoadSkillTool", () => {
  it("加载存在的技能返回带目录标注的正文", async () => {
    writeSkill(userDir, "vue", skillContent("vue", "Vue 规范", "# 规范正文"));
    const catalog = new SkillCatalog(discoverSkills(cwd, userDir).skills);
    const tool = createLoadSkillTool(catalog);

    const result = await tool.execute({ name: "vue" });

    expect(result.ok).toBe(true);
    expect(result.output).toBe(
      `技能目录：${join(userDir, "vue")}\n\n# 规范正文`,
    );
  });

  it("技能不存在时返回失败并列出可用技能", async () => {
    writeSkill(userDir, "vue", skillContent("vue", "Vue 规范", "正文"));
    const catalog = new SkillCatalog(discoverSkills(cwd, userDir).skills);
    const tool = createLoadSkillTool(catalog);

    const result = await tool.execute({ name: "react" });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("未找到技能 react");
    expect(result.output).toContain("vue");
  });

  it("缺少 name 参数时返回失败", async () => {
    const tool = createLoadSkillTool(new SkillCatalog([]));

    const result = await tool.execute({});

    expect(result).toEqual({
      ok: false,
      output: "缺少必填参数 name（技能名称）",
    });
  });

  it("正文超长时按字符预算分页，并给出可续读的 offset", async () => {
    const body = Array.from(
      { length: 400 },
      (_, index) => `第 ${index + 1} 行 ${"x".repeat(30)}`,
    ).join("\n");
    writeSkill(userDir, "long", skillContent("long", "长技能", body));
    const catalog = new SkillCatalog(discoverSkills(cwd, userDir).skills);
    const tool = createLoadSkillTool(catalog);

    const first = await tool.execute({ name: "long" });
    expect(first.ok).toBe(true);
    expect(first.output).toContain("技能正文共 400 行");
    expect(first.output).toContain('续读请调用 load_skill(name="long", offset=');
    const offsetMatch = /offset=(\d+)\)/.exec(first.output);
    expect(offsetMatch).not.toBeNull();
    const nextOffset = Number(offsetMatch?.[1]);

    const second = await tool.execute({ name: "long", offset: nextOffset });
    expect(second.ok).toBe(true);
    expect(second.output).toContain(`已返回第 ${nextOffset}-`);
  });

  it("offset 超出正文行数时返回失败并说明总行数", async () => {
    writeSkill(userDir, "short", skillContent("short", "短技能", "a\nb"));
    const catalog = new SkillCatalog(discoverSkills(cwd, userDir).skills);
    const tool = createLoadSkillTool(catalog);

    const result = await tool.execute({ name: "short", offset: 10 });

    expect(result.ok).toBe(false);
    expect(result.output).toContain("共 2 行");
  });

  it("加载技能时附带 requires 声明的依赖技能元数据", async () => {
    writeSkill(userDir, "base", skillContent("base", "基础技能", "基础正文"));
    writeSkill(
      userDir,
      "main",
      `---\nname: main\ndescription: 主技能\nrequires: base\n---\n\n主正文\n`,
    );
    const catalog = new SkillCatalog(discoverSkills(cwd, userDir).skills);
    const tool = createLoadSkillTool(catalog);

    const result = await tool.execute({ name: "main" });

    expect(result.ok).toBe(true);
    expect(result.output).toContain("依赖技能");
    expect(result.output).toContain("base：基础技能");
    expect(result.output).toContain(join(userDir, "base", "SKILL.md"));
  });
});
