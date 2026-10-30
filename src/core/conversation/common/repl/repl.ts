import pico from "picocolors";
import { executeConversationTurn } from "../turn/execute-turn";
import { DEFAULT_MAX_ITERATIONS } from "../turn/loop";
import {
  createConversationRuntime,
  disposeConversationRuntime,
} from "../runtime/runtime";
import type { ConversationRuntime } from "../runtime/runtime";
import type { ConversationModeConfig } from "../runtime/mode";
import type { SandboxCliOptions } from "../../../sandbox";
import type { TodoToolHandle, Tool } from "../../../tools";
import { CancelError, CliError } from "../../../../shared/errors";
import { printWarnings } from "../../../../shared/warnings";
import {
  warnThinkingFallback,
  resolveThinkingLevel,
  resolveThinkingStyle,
} from "../../../llm";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
  ThinkingStyle,
} from "../../../llm/types";
import { displayWidth } from "../../../../shared/string";
import { askReplLine } from "./repl-input";
import {
  buildSlashCommands,
  buildSkillSuggestions,
  filterInlineSkillSuggestions,
  filterSuggestions,
  matchSlashCommand,
} from "./slash-commands";
import type { SlashCommand } from "./slash-commands";

/** REPL 会话上下文：会话期间不变的依赖打包，避免逐参数透传 */
interface ReplSession {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 思考协议风格（会话内不变，启动时解析一次） */
  thinkingStyle: ThinkingStyle;
  /** 组装后的 system 提示词（含技能元数据清单） */
  systemPrompt: string;
  /** 本会话可执行的工具列表（全量，含未激活的 MCP 工具） */
  tools: Tool[];
  /** 下发给模型的工具清单（MCP 折叠时仅含 discover_mcp_tools 与已激活工具，与请求层共享引用） */
  advertisedTools: Tool[];
  /** 任务清单工具句柄（agent 模式装配 write_todos 时存在，/todos 读取清单状态） */
  todoHandle?: TodoToolHandle;
  /** 工具调用轮数上限（按模式装配：chat 8 轮、agent 40 轮），超出后软收敛为直接作答 */
  maxIterations: number;
}

/** REPL 启动参数：会话运行时与模式差异项（欢迎语标签） */
export interface ReplOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 会话运行时（MCP、沙箱、技能装配结果），生命周期由调用方管理 */
  runtime: ConversationRuntime;
  /** 思考协议风格（启动时解析一次） */
  thinkingStyle: ThinkingStyle;
  /** 初始思考档位（/think 切换后下一轮使用新档位） */
  initialThinkingLevel: ThinkingLevel;
  /** 模式标签（就绪面板「模式」行展示，如「对话模式」「Agent 模式」） */
  modeLabel: string;
  /** 工具调用轮数上限（来自模式配置，如 chat 8 轮、agent 40 轮） */
  maxIterations: number;
}

/** runReplTurn 入参对象 */
interface ReplTurnOptions {
  /** 会话上下文（配置、协议风格、提示词、工具列表） */
  session: ReplSession;
  /** 跨轮共享的对话历史（本函数向其追加内容） */
  history: ResponseHistoryItem[];
  /** 本轮用户输入 */
  userInput: string;
  /** 本轮思考档位（/think 切换后下一轮使用新档位） */
  thinkingLevel: ThinkingLevel;
}

/**
 * 执行多轮对话的一轮：回合执行复用 executeConversationTurn，工具带按会话装配开启
 * store=false：服务端不留存会话，历史由本地维护并每轮全量发送，跨轮经共享 history 数组衔接
 * @param {ReplTurnOptions} options - 入参对象（session/history/userInput/thinkingLevel 字段说明见接口定义）
 * @returns {Promise<void>}
 */
async function runReplTurn({
  session,
  history,
  userInput,
  thinkingLevel,
}: ReplTurnOptions): Promise<void> {
  await executeConversationTurn({
    llmConfig: session.llmConfig,
    thinkingLevel,
    thinkingStyle: session.thinkingStyle,
    history,
    userInput,
    instructions: session.systemPrompt,
    tools: session.tools,
    advertisedTools: session.advertisedTools,
    maxIterations: session.maxIterations,
  });
  process.stdout.write("\n\n");
}

/** 面板标签列的目标显示宽度（列数）：全角字符按 2 列计，当前标签最宽为「模型」等 4 列 */
const PANEL_LABEL_WIDTH = 4;
/** 标签列与内容列之间的间隙（空格数） */
const PANEL_LABEL_GAP = 3;

/**
 * 补齐面板标签到统一宽度并拼接列间隙，保证各行内容纵向对齐
 * @param {string} label - 行标签（如「模型」「MCP」「提示」）
 * @returns {string} 补齐后的标签前缀（标签 + 填充空格 + 列间隙）
 */
function padPanelLabel(label: string): string {
  const padding = " ".repeat(
    Math.max(0, PANEL_LABEL_WIDTH - displayWidth(label)),
  );
  return `${label}${padding}${" ".repeat(PANEL_LABEL_GAP)}`;
}

/**
 * 格式化连接耗时展示：不足 1 秒显示毫秒整数，达到 1 秒显示保留一位小数的秒
 * @param {number} ms - 耗时（毫秒）
 * @returns {string} 形如「820ms」「1.8s」的展示文本
 */
function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 打印 REPL 启动就绪面板：信息分组行（模式/模型/技能/MCP）与命令提示行
 *
 * 命令提示行由斜杠命令注册表按 available 过滤生成（与补全面板、/help 单一事实来源）；
 * 装配阶段警告（技能扫描、沙箱装载、MCP 连接）统一缩进展示在面板下方，默认状态只保留面板主体
 * @param {ReplOptions} options - 启动参数（配置、会话运行时、模式标签）
 * @param {ThinkingLevel} thinkingLevel - 初始思考档位
 * @param {SlashCommand[]} commands - 斜杠命令注册表
 * @returns {void}
 */
function printReadyPanel(
  options: ReplOptions,
  thinkingLevel: ThinkingLevel,
  commands: SlashCommand[],
): void {
  const { llmConfig, runtime } = options;
  const { mcpSummary, bootWarnings } = runtime;
  const { catalog, scanWarnings } = runtime.skill;

  const rows: Array<[string, string]> = [
    ["模式", options.modeLabel],
    ["模型", `${llmConfig.model} · 思考 ${thinkingLevel}`],
  ];
  if (catalog.size > 0) {
    rows.push(["技能", `${catalog.size} 个`]);
  }
  if (mcpSummary) {
    rows.push([
      "MCP",
      `${mcpSummary.okCount}/${mcpSummary.totalCount} 已连接 · ${mcpSummary.toolCount} 个工具 · ${formatElapsed(mcpSummary.elapsedMs)}`,
    ]);
  }
  for (const [label, rowContent] of rows) {
    console.log(`  ${pico.gray(padPanelLabel(label))}${rowContent}`);
  }

  console.log("");
  const hints = commands
    .filter((command) => command.available)
    .map((command) => command.name);
  hints.push("exit 或 Ctrl+C 退出");
  console.log(
    `  ${pico.gray(padPanelLabel("提示"))}${pico.cyan(hints.join(" · "))}`,
  );

  const allWarnings = [...scanWarnings, ...bootWarnings];
  if (allWarnings.length > 0) {
    console.log("");
    printWarnings(allWarnings, "  ");
  }
}

/**
 * 多轮对话 REPL 主循环（chat、agent 命令共用）：循环采集输入并执行回合，直到用户退出
 *
 * 输入行由 askReplLine 采集：行首 "/" 弹出斜杠命令/技能补全面板（≤10 条、↑↓ 选择、Tab 补全），
 * 行中「空格 + /」弹出技能补全面板（仅技能提及，补全为 /name 纯文本）；
 * 命令分发经注册表查表执行（/think、/skill、/skills、/todos、/permissions、/help），未命中按普通问题发给模型；
 * 单轮请求失败（网络抖动、限流等可预期错误）只提示不终止会话，避免丢失整个对话上下文；
 * 交互中取消（Ctrl+C）回滚本轮历史后继续会话
 * @param {ReplOptions} options - 启动参数（配置、会话运行时、思考风格与初始档位、模式标签）
 * @returns {Promise<void>}
 */
export async function runConversationRepl(options: ReplOptions): Promise<void> {
  const { llmConfig, runtime, thinkingStyle } = options;
  // 档位由 /think 在会话内切换，仅本函数持有可变状态
  let currentLevel = options.initialThinkingLevel;
  const { systemPrompt, tools, advertisedTools, catalog, todoHandle } =
    runtime.skill;
  const { sandbox } = runtime;
  // 斜杠命令注册表：补全面板、/help、就绪面板与分发共用；档位读写经闭包桥接本函数的 currentLevel
  const commands = buildSlashCommands({
    sandbox,
    bashEnabled: runtime.skill.bashEnabled,
    catalog,
    todoHandle,
    thinkingStyle,
    getThinkingLevel: () => currentLevel,
    setThinkingLevel: (level) => {
      currentLevel = level;
    },
  });
  // 技能建议列表（/skill 二级补全）：技能清单会话内不变，构建一次
  const skillSuggestions = buildSkillSuggestions(catalog);
  // 就绪面板：标题、模型/技能/MCP 信息行与命令提示，装配阶段警告统一缩进展示在其下
  printReadyPanel(options, currentLevel, commands);
  // 服务能力折算警告：off 档位本就对应关闭，此时不提示
  warnThinkingFallback(currentLevel, thinkingStyle);
  const session: ReplSession = {
    llmConfig,
    thinkingStyle,
    systemPrompt,
    tools,
    advertisedTools,
    todoHandle,
    maxIterations: options.maxIterations,
  };
  // 本地维护的对话历史：store=false 模式下每轮全量发送给服务端，跨轮累积
  const history: ResponseHistoryItem[] = [];
  // 输入历史（面板关闭时 ↑/↓ 回溯）：仅会话内内存记录，上限 200 条
  const inputHistory: string[] = [];

  for (;;) {
    let userInput: string;
    try {
      // askReplLine 已保证返回值去除首尾空格且非空，命令匹配无需再 trim
      userInput = await askReplLine({
        message: pico.green("你 > "),
        // 行首 /：命令与 /skill 二级补全；行中「空格 + /」：仅技能补全（技能提及）
        suggest: (input, cursor) =>
          input.startsWith("/")
            ? filterSuggestions(input, commands, skillSuggestions)
            : filterInlineSkillSuggestions(input, cursor, skillSuggestions),
        history: inputHistory,
      });
    } catch (err) {
      // 用户按 Ctrl+C 取消输入：视为正常退出对话，不沿用顶层"未做任何修改"的取消文案
      if (err instanceof CancelError) {
        console.log(pico.yellow("已退出对话"));
        return;
      }
      throw err;
    }
    // 记录到输入历史（含斜杠命令行，↑ 可回溯重用），超上限丢弃最旧一条
    inputHistory.push(userInput);
    if (inputHistory.length > 200) {
      inputHistory.shift();
    }

    const lowerInput = userInput.toLowerCase();
    if (lowerInput === "exit" || lowerInput === "quit") {
      console.log(pico.yellow("已退出对话"));
      return;
    }

    // 斜杠命令查表分发：注册表按「精确命令名或命令名+空格前缀」匹配，
    // /thinking 等相似前缀不会误吞，未命中时按普通问题发给模型
    const command = matchSlashCommand(userInput, commands);
    if (command) {
      const result = await command.execute(userInput);
      if (result.kind === "send") {
        // /skill <name> [任务...]：技能手册已注入任务文本，按普通回合发送给模型
        userInput = result.task;
      } else {
        continue;
      }
    }

    // 记录本轮开始前历史长度：本轮被取消时回滚，避免残留未配对的用户输入或工具调用项
    const historyStart = history.length;
    try {
      await runReplTurn({
        session,
        history,
        userInput,
        thinkingLevel: currentLevel,
      });
    } catch (err) {
      // 审批等交互中按 Ctrl+C：只中断本轮并回滚本轮历史，会话继续
      if (err instanceof CancelError) {
        history.length = historyStart;
        process.stdout.write("\n");
        console.log(pico.yellow("已取消本轮"));
        continue;
      }
      // 仅吞可预期的业务错误（网络、接口报错）；未预期错误仍上抛，避免代码 bug 被无限循环掩盖
      if (!(err instanceof CliError)) {
        throw err;
      }
      // 换行避免错误提示接在残缺的流式输出之后
      process.stdout.write("\n");
      console.error(pico.red(err.message));
    }
  }
}

/** runReplConversation 入参对象 */
export interface ReplConversationOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 模式配置（人设、标签、bash 装配策略） */
  modeConfig: ConversationModeConfig;
  /** 命令行指定的思考档位，未指定时回退配置默认 */
  thinkingLevel?: ThinkingLevel;
  /** 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启 */
  mcpEnabled?: boolean;
  /** CLI 传入的沙箱选项（agent 命令的 --sandbox 等），缺省按配置文件装配 */
  cliSandboxOptions?: SandboxCliOptions;
}

/**
 * 多轮对话入口（chat、agent 命令共用的 REPL 薄入口）：解析档位 → 装配会话运行时 → 进入 REPL 循环
 * 模式差异（人设、标签、工具带装配策略）由 modeConfig 决定；运行时生命周期在本函数内管理
 * @param {ReplConversationOptions} options - 入参对象（字段说明见接口定义）
 * @returns {Promise<void>}
 */
export async function runReplConversation({
  llmConfig,
  modeConfig,
  thinkingLevel,
  mcpEnabled = true,
  cliSandboxOptions,
}: ReplConversationOptions): Promise<void> {
  // 获取最终生效的思考档位
  const currentLevel = resolveThinkingLevel({
    cliLevel: thinkingLevel,
    llmConfig: llmConfig,
    fallback: modeConfig.defaultThinkingLevel,
  });
  // 获取最终生效的思考样式
  const thinkingStyle = resolveThinkingStyle(llmConfig);
  const runtime = await createConversationRuntime(modeConfig.basePrompt, {
    mcpEnabled,
    bashEnabled: modeConfig.bashEnabled,
    todosEnabled: modeConfig.todosEnabled,
    writeToolsEnabled: modeConfig.writeToolsEnabled,
    cliSandboxOptions,
  });
  try {
    await runConversationRepl({
      llmConfig,
      runtime,
      thinkingStyle,
      initialThinkingLevel: currentLevel,
      modeLabel: modeConfig.modeLabel,
      maxIterations: modeConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    });
  } finally {
    await disposeConversationRuntime(runtime);
  }
}
