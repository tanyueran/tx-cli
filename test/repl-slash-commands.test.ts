import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSlashCommands,
  buildSkillTask,
  buildCommandSuggestions,
  buildSkillSuggestions,
  filterInlineSkillSuggestions,
  filterSuggestions,
  matchSlashCommand,
  parseSkillArgs,
  printHelp,
} from "../src/core/conversation/common/slash-commands";
import { SkillCatalog } from "../src/core/skills";
import type { SlashCommandDeps } from "../src/core/conversation/common/slash-commands";
import type { TodoToolHandle } from "../src/core/tools";

/** 构造无沙箱、无任务清单、none 思考风格的最小依赖（档位经 lastLevel 观测），可按用例覆盖字段 */
function makeDeps(
  catalog: SkillCatalog,
  overrides: Partial<SlashCommandDeps> = {},
): SlashCommandDeps {
  return {
    sandbox: undefined,
    bashEnabled: true,
    catalog,
    todoHandle: undefined,
    thinkingStyle: "none",
    getThinkingLevel: () => "low",
    setThinkingLevel: (level) => {
      lastLevel = level;
    },
    ...overrides,
  };
}

/** 记录 /think 设置的最新档位 */
let lastLevel: string;

/** console.log/error 捕获器：避免用例输出噪音并支持内容断言 */
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  lastLevel = "low";
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
});

describe("parseSkillArgs", () => {
  it("拆分技能名与任务描述", () => {
    expect(parseSkillArgs("/skill review 检查这段代码")).toEqual({
      name: "review",
      task: "检查这段代码",
    });
  });

  it("仅技能名时任务为 undefined", () => {
    expect(parseSkillArgs("/skill review")).toEqual({ name: "review" });
  });

  it("无参数时技能名为空", () => {
    expect(parseSkillArgs("/skill")).toEqual({ name: "" });
  });

  it("任务描述内部空格保持完整", () => {
    expect(parseSkillArgs("/skill review  重点看  性能 问题")).toEqual({
      name: "review",
      task: "重点看  性能 问题",
    });
  });
});

describe("buildSkillTask", () => {
  it("无任务时提示等待后续请求", () => {
    const task = buildSkillTask("review", "# 手册\n内容", undefined);
    expect(task).toContain("技能「review」的手册正文");
    expect(task).toContain("等待我的后续请求");
    expect(task).toContain("# 手册");
    expect(task).not.toContain("【任务】");
  });

  it("有任务时附加任务段", () => {
    const task = buildSkillTask("review", "# 手册", "检查这段代码");
    expect(task).toContain("执行文末任务");
    expect(task).toContain("【任务】检查这段代码");
  });
});

describe("filterSuggestions", () => {
  // 模拟 chat 模式：无沙箱、无任务清单、无技能
  const chatCommands = buildSlashCommands(makeDeps(new SkillCatalog([])));
  // 模拟 agent 模式：装配任务清单 + 有可用技能
  const agentCatalog = new SkillCatalog([
    { name: "review", description: "评审", source: "project", path: "review.md" },
  ]);
  const agentCommands = buildSlashCommands(
    makeDeps(agentCatalog, { todoHandle: {} as TodoToolHandle }),
  );

  it("非 / 开头的输入不弹面板", () => {
    expect(filterSuggestions("普通问题", chatCommands, [])).toEqual([]);
    expect(filterSuggestions("", chatCommands, [])).toEqual([]);
  });

  it("输入 / 时仅展示 available 的命令（chat 模式不含 /todos、/permissions）", () => {
    const result = filterSuggestions("/", chatCommands, []);
    expect(result.map((item) => item.name)).toEqual(["/think", "/help"]);
  });

  it("装配 todoHandle 与技能后 /todos、/skills 进入面板", () => {
    const result = filterSuggestions("/", agentCommands, []);
    expect(result.map((item) => item.name)).toEqual([
      "/think",
      "/skill",
      "/skills",
      "/todos",
      "/help",
    ]);
  });

  it("按名称前缀过滤", () => {
    const result = filterSuggestions("/sk", agentCommands, []);
    expect(result.map((item) => item.name)).toEqual(["/skill", "/skills"]);
  });

  it("描述命中的候选排在前缀命中之后", () => {
    // "/任" 无名称前缀命中：「加载技能手册后执行任务」与「查看任务清单」描述均包含「任」，
    // 二者同等级时按注册表顺序稳定排序
    const result = filterSuggestions("/任", agentCommands, []);
    expect(result.map((item) => item.name)).toEqual(["/skill", "/todos"]);
  });

  it("最多返回 10 条", () => {
    expect(filterSuggestions("/", agentCommands, []).length).toBeLessThanOrEqual(10);
  });

  it("/skill 空格后进入技能二级过滤", () => {
    const skills = [
      { name: "review", description: "评审", group: "skill" as const },
      { name: "refactor", description: "重构", group: "skill" as const },
    ];
    expect(
      filterSuggestions("/skill ", agentCommands, skills).map((item) => item.name),
    ).toEqual(["review", "refactor"]);
    expect(
      filterSuggestions("/skill re", agentCommands, skills).map((item) => item.name),
    ).toEqual(["review", "refactor"]);
    expect(
      filterSuggestions("/skill rev", agentCommands, skills).map((item) => item.name),
    ).toEqual(["review"]);
  });

  it("/skill 二级过滤不返回命令", () => {
    expect(filterSuggestions("/skill ", chatCommands, [])).toEqual([]);
  });
});

describe("filterInlineSkillSuggestions", () => {
  const skills = [
    { name: "review", description: "评审", group: "skill" as const },
    { name: "refactor", description: "重构", group: "skill" as const },
  ];

  it("中途空格后输入 / 触发技能建议，建议项带 / 前缀", () => {
    const input = "帮我 /";
    const result = filterInlineSkillSuggestions(input, input.length, skills);
    expect(result.map((item) => item.name)).toEqual(["/review", "/refactor"]);
  });

  it("按 / 后的前缀过滤技能名", () => {
    const input = "帮我 /rev";
    const result = filterInlineSkillSuggestions(input, input.length, skills);
    expect(result.map((item) => item.name)).toEqual(["/review"]);
  });

  it("光标在 token 中间时按光标前片段过滤", () => {
    // 光标位于 "/rev" 之后（"帮我 " 3 个 code unit + "/rev" 4 个）
    const result = filterInlineSkillSuggestions("帮我 /rev 一下", 7, skills);
    expect(result.map((item) => item.name)).toEqual(["/review"]);
  });

  it("行首 / 不由本函数处理（交给 filterSuggestions）", () => {
    expect(filterInlineSkillSuggestions("/re", 3, skills)).toEqual([]);
  });

  it("单词内的 /（路径、URL）与普通文本不触发", () => {
    expect(filterInlineSkillSuggestions("打开 a/b", 6, skills)).toEqual([]);
    expect(filterInlineSkillSuggestions("普通问题", 4, skills)).toEqual([]);
  });
});

describe("matchSlashCommand", () => {
  const commands = buildSlashCommands(makeDeps(new SkillCatalog([])));

  it("精确匹配命令名", () => {
    expect(matchSlashCommand("/think", commands)?.name).toBe("/think");
    expect(matchSlashCommand("/help", commands)?.name).toBe("/help");
  });

  it("命令名加空格前缀也匹配", () => {
    expect(matchSlashCommand("/think high", commands)?.name).toBe("/think");
    expect(matchSlashCommand("/skill review 任务", commands)?.name).toBe(
      "/skill",
    );
  });

  it("前缀相似但不构成命令的输入不匹配", () => {
    // /thinking 不应被 /think 吞掉，应作为普通问题发给模型
    expect(matchSlashCommand("/thinking", commands)).toBeUndefined();
    expect(matchSlashCommand("/tips", commands)).toBeUndefined();
  });

  it("未命中返回 undefined", () => {
    expect(matchSlashCommand("/notexist", commands)).toBeUndefined();
    expect(matchSlashCommand("普通问题", commands)).toBeUndefined();
  });
});

describe("buildCommandSuggestions / buildSkillSuggestions", () => {
  it("available=false 的命令不进入建议列表", () => {
    const commands = buildSlashCommands(makeDeps(new SkillCatalog([])));
    const names = buildCommandSuggestions(commands).map((item) => item.name);
    expect(names).toContain("/think");
    expect(names).not.toContain("/skills");
    expect(names).not.toContain("/todos");
    expect(names).not.toContain("/permissions");
  });

  it("技能建议描述含来源标注", () => {
    const catalog = new SkillCatalog([
      { name: "a", description: "技能A", source: "project", path: "a.md" },
      { name: "b", description: "技能B", source: "user", path: "b.md" },
    ]);
    const suggestions = buildSkillSuggestions(catalog);
    expect(suggestions[0]).toMatchObject({
      name: "a",
      description: "技能A（项目级）",
      group: "skill",
    });
    expect(suggestions[1].description).toBe("技能B（用户级）");
  });
});

describe("buildSlashCommands 执行体", () => {
  it("/think 无参打印当前档位且不修改", async () => {
    const commands = buildSlashCommands(makeDeps(new SkillCatalog([])));
    const result = await commands
      .find((command) => command.name === "/think")!
      .execute("/think");
    expect(result).toEqual({ kind: "handled" });
    expect(lastLevel).toBe("low");
    // none 风格不打印档位行，但折算警告文案中携带档位
    expect(logSpy.mock.calls.join("\n")).toContain("思考档位为 low");
  });

  it("/think <level> 切换档位", async () => {
    const commands = buildSlashCommands(makeDeps(new SkillCatalog([])));
    const result = await commands
      .find((command) => command.name === "/think")!
      .execute("/think high");
    expect(result).toEqual({ kind: "handled" });
    expect(lastLevel).toBe("high");
  });

  it("/think 非法值提示错误并保留原档位", async () => {
    const commands = buildSlashCommands(makeDeps(new SkillCatalog([])));
    await commands.find((command) => command.name === "/think")!.execute("/think bad");
    expect(lastLevel).toBe("low");
    expect(errorSpy.mock.calls.join("\n")).toContain("思考档位");
  });

  it("/skill 未知名提示未找到并返回 handled", async () => {
    const commands = buildSlashCommands(makeDeps(new SkillCatalog([])));
    const result = await commands
      .find((command) => command.name === "/skill")!
      .execute("/skill nope");
    expect(result).toEqual({ kind: "handled" });
    expect(logSpy.mock.calls.join("\n")).toContain("未找到技能「nope」");
  });

  it("/skill 无参数提示用法", async () => {
    const commands = buildSlashCommands(makeDeps(new SkillCatalog([])));
    const result = await commands
      .find((command) => command.name === "/skill")!
      .execute("/skill");
    expect(result).toEqual({ kind: "handled" });
    expect(logSpy.mock.calls.join("\n")).toContain("用法：/skill <name>");
  });

  it("/skill <name> 读取手册后返回任务文本", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tx-cli-slash-test-"));
    try {
      const skillPath = join(dir, "review.md");
      await writeFile(skillPath, "---\nname: review\ndescription: 评审\n---\n# 评审手册正文");
      const catalog = new SkillCatalog([
        { name: "review", description: "评审", source: "project", path: skillPath },
      ]);
      const commands = buildSlashCommands(makeDeps(catalog));
      const result = (await commands
        .find((command) => command.name === "/skill")!
        .execute("/skill review 检查代码")) as { kind: string; task?: string };
      expect(result.kind).toBe("send");
      expect(result.task).toContain("# 评审手册正文");
      expect(result.task).toContain("【任务】检查代码");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("/permissions 未启用沙箱时打印未启用提示", async () => {
    const commands = buildSlashCommands(makeDeps(new SkillCatalog([])));
    const result = await commands
      .find((command) => command.name === "/permissions")!
      .execute("/permissions");
    expect(result).toEqual({ kind: "handled" });
    expect(logSpy.mock.calls.join("\n")).toContain("本会话未启用沙箱");
  });

  it("/todos 未装配任务清单时打印提示", async () => {
    const commands = buildSlashCommands(makeDeps(new SkillCatalog([])));
    const result = await commands
      .find((command) => command.name === "/todos")!
      .execute("/todos");
    expect(result).toEqual({ kind: "handled" });
    expect(logSpy.mock.calls.join("\n")).toContain("未启用任务清单工具");
  });

  it("/help 打印命令清单与退出方式", async () => {
    const commands = buildSlashCommands(makeDeps(new SkillCatalog([])));
    const result = await commands
      .find((command) => command.name === "/help")!
      .execute("/help");
    expect(result).toEqual({ kind: "handled" });
    const output = logSpy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
    expect(output).toContain("斜杠命令");
    expect(output).toContain("/think");
    expect(output).toContain("/help");
    expect(output).toContain("exit / quit");
    // 不可用命令不进 /help 清单
    expect(output).not.toContain("/permissions");
  });

  it("/help 附带技能统计行", async () => {
    const catalog = new SkillCatalog([
      { name: "a", description: "技能A", source: "user", path: "a.md" },
    ]);
    const commands = buildSlashCommands(makeDeps(catalog));
    await commands.find((command) => command.name === "/help")!.execute("/help");
    expect(logSpy.mock.calls.join("\n")).toContain("1 个技能可用");
  });
});

describe("printHelp", () => {
  it("标签按显示宽度对齐，含参数占位的命令完整展示", () => {
    const catalog = new SkillCatalog([
      { name: "review", description: "评审", source: "project", path: "review.md" },
    ]);
    const commands = buildSlashCommands(makeDeps(catalog));
    printHelp(commands, catalog);
    const output = logSpy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n");
    // 每个可用命令行都应出现（含参数占位）
    expect(output).toContain("/think <off|low|medium|high>");
    expect(output).toContain("/skill <name> [任务...]");
    expect(output).toContain("/help");
    // 技能统计行
    expect(output).toContain("1 个技能可用");
  });
});
