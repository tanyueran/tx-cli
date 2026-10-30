import pico from "picocolors";
import { formatTodoList } from "../../../tools";
import type { TodoToolHandle } from "../../../tools";
import type { SandboxContext } from "../../../sandbox/runtime/sandbox-context";
import type { SkillCatalog } from "../../../skills";
import {
  parseThinkingLevel,
  warnThinkingFallback,
  THINKING_LEVELS,
} from "../../../llm";
import type { ThinkingLevel, ThinkingStyle } from "../../../llm/types";
import { CliError } from "../../../../shared/errors";
import { displayWidth, padToWidth } from "../../../../shared/string";

/** 斜杠命令执行结果：handled 表示命令已就地处理完，send 表示要把任务文本交给模型处理 */
export type SlashCommandResult =
  | { kind: "handled" }
  | { kind: "send"; task: string };

/** 斜杠命令定义：注册表单一事实来源，补全面板、/help、REPL 分发共用 */
export interface SlashCommand {
  /** 命令名（含 / 前缀），如 "/think" */
  name: string;
  /** 参数占位说明（用于补全面板与 /help 展示），如 "<level>"；无参数命令省略 */
  args?: string;
  /** 一句话描述 */
  description: string;
  /** 是否在补全面板、/help、就绪面板中展示（仅控制广告位，命令本身始终可执行） */
  available: boolean;
  /**
   * 执行命令
   * @param {string} input - 用户输入的完整命令行（含命令名与参数）
   * @returns {SlashCommandResult | Promise<SlashCommandResult>} handled 或 send（带任务文本）
   */
  execute(
    input: string,
  ): SlashCommandResult | Promise<SlashCommandResult>;
}

/** 补全建议项：命令或技能在面板中的一行 */
export interface SlashSuggestion {
  /** 建议主体（含 / 前缀的命令名或技能名） */
  name: string;
  /** 描述（可选） */
  description?: string;
  /** 参数占位说明（可选，仅命令有） */
  args?: string;
  /** 建议分组：command=斜杠命令，skill=技能 */
  group: "command" | "skill";
}

/** 补全面板最多展示的建议条数 */
export const MAX_SUGGESTIONS = 10;

/** 斜杠命令依赖集合：命令执行体所需的会话上下文与可变状态读写器 */
export interface SlashCommandDeps {
  /** 会话级沙箱上下文（未启用沙箱时为 undefined） */
  sandbox: SandboxContext | undefined;
  /** bash 工具是否装配（/permissions 展示 Provider 行时区分「未装配」与「失败关闭」） */
  bashEnabled: boolean;
  /** 技能目录（/skill 执行与 /skills 列表读取） */
  catalog: SkillCatalog;
  /** 任务清单工具句柄（未装配时为 undefined） */
  todoHandle: TodoToolHandle | undefined;
  /** 思考协议风格（会话内不变） */
  thinkingStyle: ThinkingStyle;
  /** 读取当前思考档位 */
  getThinkingLevel(): ThinkingLevel;
  /** 写入新的思考档位（/think 切换） */
  setThinkingLevel(level: ThinkingLevel): void;
}

/**
 * 拼装技能任务文本：请模型先读手册正文再执行任务（或等待后续请求）
 * @param {string} skillName - 技能名
 * @param {string} body - 技能手册正文（Markdown）
 * @param {string | undefined} task - 用户附加的任务描述（缺省时仅加载手册）
 * @returns {string} 发送给模型的完整任务文本
 */
export function buildSkillTask(
  skillName: string,
  body: string,
  task?: string,
): string {
  const parts = [
    `请先阅读技能「${skillName}」的手册正文，再按手册指引${
      task ? "执行文末任务" : "等待我的后续请求"
    }。`,
    "",
    "【技能手册正文】",
    body.trim(),
  ];
  if (task) {
    parts.push("", `【任务】${task}`);
  }
  return parts.join("\n");
}

/**
 * 解析 /skill 命令参数：拆出技能名与可选任务描述
 * @param {string} input - 用户输入的完整命令行（如 "/skill review 检查这段代码"）
   * @returns {{ name: string; task?: string }} 技能名与任务描述（无任务时 task 为 undefined）
 */
export function parseSkillArgs(input: string): {
  name: string;
  task?: string;
} {
  const rest = input.slice("/skill".length).trim();
  const spaceIndex = rest.search(/\s/);
  if (spaceIndex === -1) {
    return { name: rest };
  }
  return {
    name: rest.slice(0, spaceIndex),
    task: rest.slice(spaceIndex).trim() || undefined,
  };
}

/**
 * 构建全部斜杠命令注册表（单一事实来源：补全面板、/help、就绪面板、REPL 分发共用）
 * 命令「不可用」时不从注册表移除，执行体内部对能力缺失打印优雅提示，保持旧有行为
 * @param {SlashCommandDeps} deps - 命令执行体所需的会话依赖
 * @returns {SlashCommand[]} 命令列表（/help 的执行体闭包引用本列表自身）
 */
export function buildSlashCommands(deps: SlashCommandDeps): SlashCommand[] {
  const {
    sandbox,
    bashEnabled,
    catalog,
    todoHandle,
    thinkingStyle,
    getThinkingLevel,
    setThinkingLevel,
  } = deps;
  const commands: SlashCommand[] = [
    {
      name: "/think",
      args: `<${THINKING_LEVELS.join("|")}>`,
      description: "查看或切换思考档位",
      available: true,
      execute(input) {
        const thinkLevelArg = input.slice("/think".length).trim();
        if (!thinkLevelArg) {
          printThinkingNotice(getThinkingLevel(), thinkingStyle);
          return { kind: "handled" };
        }
        try {
          const nextLevel = parseThinkingLevel(thinkLevelArg);
          if (nextLevel) {
            setThinkingLevel(nextLevel);
          }
          printThinkingNotice(getThinkingLevel(), thinkingStyle);
        } catch (err) {
          if (!(err instanceof CliError)) {
            throw err;
          }
          console.error(pico.red(err.message));
        }
        return { kind: "handled" };
      },
    },
    {
      name: "/skill",
      args: "<name> [任务...]",
      description: "加载技能手册后执行任务",
      available: catalog.size > 0,
      async execute(input) {
        const { name, task } = parseSkillArgs(input);
        if (!name) {
          console.log(
            pico.yellow(
              `用法：/skill <name> [任务...]（输入 "/skill " 可从面板选择技能）`,
            ),
          );
          return { kind: "handled" };
        }
        const skill = catalog.get(name);
        if (!skill) {
          console.log(
            pico.yellow(
              `未找到技能「${name}」，输入 /skills 查看可用技能清单`,
            ),
          );
          return { kind: "handled" };
        }
        let body: string | undefined;
        try {
          body = await catalog.readBody(name);
        } catch (err) {
          console.error(
            pico.red(
              `读取技能「${name}」手册失败：${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return { kind: "handled" };
        }
        if (!body) {
          console.log(pico.yellow(`技能「${name}」没有可读的手册正文`));
          return { kind: "handled" };
        }
        return { kind: "send", task: buildSkillTask(name, body, task) };
      },
    },
    {
      name: "/skills",
      description: "列出可用技能及来源",
      available: catalog.size > 0,
      execute() {
        if (catalog.size === 0) {
          console.log(
            pico.yellow(
              "未发现可用技能（扫描目录：~/.tx-cli/skills、./.tx-cli/skills）",
            ),
          );
          return { kind: "handled" };
        }
        for (const skill of catalog.list()) {
          const skillSource = skill.source === "project" ? "项目级" : "用户级";
          console.log(
            `${pico.cyan(skill.name)}（${skillSource}）${skill.description}`,
          );
        }
        return { kind: "handled" };
      },
    },
    {
      name: "/todos",
      description: "查看任务清单",
      available: todoHandle !== undefined,
      execute() {
        printTodos(todoHandle);
        return { kind: "handled" };
      },
    },
    {
      name: "/permissions",
      description: "查看沙箱与权限状态",
      available: sandbox !== undefined,
      execute() {
        printPermissions(sandbox, bashEnabled);
        return { kind: "handled" };
      },
    },
    {
      name: "/help",
      description: "列出全部斜杠命令",
      available: true,
      execute() {
        printHelp(commands, catalog);
        return { kind: "handled" };
      },
    },
  ];
  return commands;
}

/**
 * 打印思考档位切换/设置结果与服务能力折算提示
 * @param {ThinkingLevel} thinkingLevel - 目标档位
 * @param {ThinkingStyle} thinkingStyle - 思考协议风格
 * @returns {void}
 */
export function printThinkingNotice(
  thinkingLevel: ThinkingLevel,
  thinkingStyle: ThinkingStyle,
): void {
  // none 风格的警告已含档位信息，不重复打印档位行
  if (thinkingStyle !== "none") {
    console.log(pico.cyan(`思考档位：${thinkingLevel}`));
  }
  warnThinkingFallback(thinkingLevel, thinkingStyle);
}

/**
 * 打印规则列表段（/permissions 展示用）：空段显示占位说明
 * @param {string} title - 段标题（如「允许」「询问」「拒绝」）
 * @param {string[]} rules - 规则原文列表
 * @returns {void}
 */
function printRuleSection(title: string, rules: string[]): void {
  if (rules.length === 0) {
    console.log(pico.gray(`  ${title}：（空）`));
    return;
  }
  console.log(pico.cyan(`  ${title}：`));
  for (const rule of rules) {
    console.log(`    ${rule}`);
  }
}

/**
 * 打印当前会话的沙箱与权限状态（/permissions 内联命令）
 * 展示：档位、审批策略、Provider、fs 边界、三段规则（allow 含会话与持久授权合并）
 * @param {SandboxContext | undefined} sandbox - 会话级沙箱上下文
 * @param {boolean} bashEnabled - bash 工具是否装配（区分 Provider「未装载」的两种原因）
 * @returns {void}
 */
export function printPermissions(
  sandbox: SandboxContext | undefined,
  bashEnabled: boolean,
): void {
  if (!sandbox) {
    console.log(pico.yellow("本会话未启用沙箱（bash 与权限门卫均未装配）"));
    return;
  }
  const providerName = !bashEnabled
    ? "未装载（本会话未装配 bash 工具）"
    : sandbox.provider
      ? `${sandbox.provider.name}${sandbox.provider.name === "noop" ? "（直通无隔离）" : ""}`
      : "无（bash 以失败关闭模式运行）";
  console.log(pico.cyan(`沙箱档位：${sandbox.level}`));
  console.log(pico.cyan(`审批策略：${sandbox.approval}`));
  console.log(pico.cyan(`沙箱 Provider：${providerName}`));
  console.log(pico.cyan("文件系统边界："));
  console.log(
    pico.gray(`  禁读：${sandbox.tier.denyRead.join("、") || "（无）"}`),
  );
  if (sandbox.level === "read-only") {
    console.log(pico.gray("  可写：（无，禁止一切写入）"));
  } else {
    console.log(
      pico.gray(`  可写：${sandbox.tier.allowWrite.join("、") || "（无）"}`),
    );
    console.log(
      pico.gray(`  禁写：${sandbox.tier.denyWrite.join("、") || "（无）"}`),
    );
  }
  const rules = sandbox.listRules();
  console.log(
    pico.cyan("权限规则（allow 含会话授权与「始终允许」的持久授权）："),
  );
  printRuleSection("允许", rules.allow);
  printRuleSection("询问", rules.ask);
  printRuleSection("拒绝", rules.deny);
}

/**
 * 打印当前任务清单（/todos 内联命令）：复用 write_todos 的清单视图符号
 * @param {TodoToolHandle | undefined} todoHandle - 任务清单工具句柄（未装配时为 undefined）
 * @returns {void}
 */
export function printTodos(todoHandle: TodoToolHandle | undefined): void {
  if (!todoHandle) {
    console.log(pico.yellow("本次会话未启用任务清单工具（仅 Agent 模式装配）"));
    return;
  }
  const todos = todoHandle.getTodos();
  if (todos.length === 0) {
    console.log(pico.gray("任务清单为空"));
    return;
  }
  console.log(pico.cyan(`任务清单（${todos.length} 项）`));
  console.log(formatTodoList(todos));
}

/**
 * 匹配输入对应的斜杠命令：精确命令名，或命令名 + 空格前缀
 * 前缀匹配保证「/thinking」这类相似输入不会被 /think 误吞
 * @param {string} input - 用户输入（已 trim）
 * @param {SlashCommand[]} commands - 命令注册表
 * @returns {SlashCommand | undefined} 命中的命令，未命中时为 undefined
 */
export function matchSlashCommand(
  input: string,
  commands: SlashCommand[],
): SlashCommand | undefined {
  return commands.find(
    (command) => input === command.name || input.startsWith(`${command.name} `),
  );
}

/**
 * 命令建议的匹配优先级：0=名称前缀命中、1=名称包含命中、2=描述包含命中
 * 名称按完整 token 匹配；描述按去掉 / 前缀后的关键词匹配（支持「/任务」按描述找到 /todos）
 * @param {string} token - 过滤关键词（已转小写，含 / 前缀）
 * @param {SlashCommand} command - 待排序的命令
 * @returns {number} 匹配等级（越小越靠前）；完全不匹配时返回 Infinity
 */
function commandMatchRank(token: string, command: SlashCommand): number {
  const name = command.name.toLowerCase();
  if (name.startsWith(token)) {
    return 0;
  }
  if (name.includes(token)) {
    return 1;
  }
  const descToken = token.startsWith("/") ? token.slice(1) : token;
  if (descToken !== "" && command.description.toLowerCase().includes(descToken)) {
    return 2;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * 计算补全面板当前应展示的建议列表
 * 规则：
 * - 非 "/" 开头的输入不弹面板（普通对话输入）
 * - available=false 的命令不进入面板（如 chat 模式无任务清单时不显示 /todos）
 * - "/skill " 前缀进入二级过滤：按最后一个词过滤技能名
 * - 其余按第一个词过滤命令（含描述匹配），超过 max 条时截断
 * @param {string} input - 当前输入行原文
 * @param {SlashCommand[]} commands - 命令注册表
 * @param {SlashSuggestion[]} skills - 技能建议列表（buildSkillSuggestions 的产物）
 * @param {number} max - 最多返回条数（默认 MAX_SUGGESTIONS）
 * @returns {SlashSuggestion[]} 排序后的建议列表（可能为空数组）
 */
export function filterSuggestions(
  input: string,
  commands: SlashCommand[],
  skills: SlashSuggestion[],
  max: number = MAX_SUGGESTIONS,
): SlashSuggestion[] {
  if (!input.startsWith("/")) {
    return [];
  }
  // 二级过滤：/skill 后按最后一个词筛选技能
  if (input.startsWith("/skill ")) {
    const token = input.slice("/skill".length).trim().split(/\s+/).pop() ?? "";
    const query = token.toLowerCase();
    return skills
      .filter(
        (suggestion) =>
          !query || suggestion.name.toLowerCase().startsWith(query),
      )
      .slice(0, max);
  }
  const firstWord = input.split(/\s+/)[0] ?? "";
  const token = firstWord.toLowerCase();
  // 同级按注册表顺序稳定排序：先按匹配等级，再按原始下标；available=false 的命令不进面板
  const ordered = commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => command.available)
    .filter(({ command }) =>
      token ? Number.isFinite(commandMatchRank(token, command)) : true,
    )
    .sort(
      (a, b) =>
        commandMatchRank(token, a.command) - commandMatchRank(token, b.command) ||
        a.index - b.index,
    )
    .map(({ command }) => ({
      name: command.name,
      description: command.description,
      args: command.args,
      group: "command" as const,
    }));
  return ordered.slice(0, max);
}

/**
 * 中途输入的技能补全：光标左侧 token 以「空格 + /」开头时，按 / 后的前缀过滤技能名
 * 建议项 name 带 / 前缀，Tab 补全后输入行中保留完整技能提及（如「帮我 /review 检查」）；
 * 仅服务中途场景：行首以 / 开头的输入由 filterSuggestions 处理（命令 + /skill 二级补全）
 * @param {string} input - 当前输入行原文
 * @param {number} cursor - 光标下标（按 code unit 计）
 * @param {SlashSuggestion[]} skills - 技能建议列表（buildSkillSuggestions 的产物）
 * @param {number} max - 最多返回条数（默认 MAX_SUGGESTIONS）
 * @returns {SlashSuggestion[]} 前缀匹配的技能建议（不满足触发条件时为空数组）
 */
export function filterInlineSkillSuggestions(
  input: string,
  cursor: number,
  skills: SlashSuggestion[],
  max: number = MAX_SUGGESTIONS,
): SlashSuggestion[] {
  // token 口径与 repl-input 的 Tab 补全一致：以空格为界取光标左侧片段
  const tokenStart = input.lastIndexOf(" ", Math.max(0, cursor - 1)) + 1;
  const token = input.slice(tokenStart, cursor);
  // 行首交给 filterSuggestions；token 不以 / 开头（普通词、URL、路径片段）不弹面板
  if (tokenStart === 0 || !token.startsWith("/")) {
    return [];
  }
  const query = token.slice(1).toLowerCase();
  return skills
    .filter(
      (suggestion) =>
        !query || suggestion.name.toLowerCase().startsWith(query),
    )
    .map((suggestion) => ({ ...suggestion, name: `/${suggestion.name}` }))
    .slice(0, max);
}

/**
 * 从命令注册表构建命令建议列表（仅含 available 的命令，供面板广告位使用）
 * @param {SlashCommand[]} commands - 命令注册表
 * @returns {SlashSuggestion[]} 命令建议列表
 */
export function buildCommandSuggestions(
  commands: SlashCommand[],
): SlashSuggestion[] {
  return commands
    .filter((command) => command.available)
    .map((command) => ({
      name: command.name,
      description: command.description,
      args: command.args,
      group: "command" as const,
    }));
}

/**
 * 从技能目录构建技能建议列表（供 /skill 二级补全使用）
 * @param {SkillCatalog} catalog - 技能目录
 * @returns {SlashSuggestion[]} 技能建议列表（描述含来源标注）
 */
export function buildSkillSuggestions(
  catalog: SkillCatalog,
): SlashSuggestion[] {
  return catalog.list().map((skill) => ({
    name: skill.name,
    description: `${skill.description}（${skill.source === "project" ? "项目级" : "用户级"}）`,
    group: "skill" as const,
  }));
}

/**
 * 打印 /help：命令标签按显示宽度对齐，灰色描述；附带退出方式与技能统计
 * @param {SlashCommand[]} commands - 命令注册表（仅展示 available 的命令）
 * @param {SkillCatalog} catalog - 技能目录（统计行展示）
 * @returns {void}
 */
export function printHelp(commands: SlashCommand[], catalog: SkillCatalog): void {
  const visible = commands.filter((command) => command.available);
  const labelWidth = Math.max(
    ...visible.map((command) =>
      displayWidth(
        command.args ? `${command.name} ${command.args}` : command.name,
      ),
    ),
  );
  console.log(pico.cyan("斜杠命令"));
  for (const command of visible) {
    const label = command.args
      ? `${command.name} ${command.args}`
      : command.name;
    console.log(
      `  ${pico.cyan(padToWidth(label, labelWidth))}  ${pico.gray(command.description)}`,
    );
  }
  console.log(`  ${pico.gray("exit / quit")}  ${pico.gray("退出会话")}`);
  if (catalog.size > 0) {
    console.log("");
    console.log(
      pico.gray(
        `另有 ${catalog.size} 个技能可用：/skill <name> [任务...] 加载手册，/skills 查看清单`,
      ),
    );
  }
}
