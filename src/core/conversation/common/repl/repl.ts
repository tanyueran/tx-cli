import pico from "picocolors";
import { executeConversationTurn } from "../turn/execute-turn";
import { DEFAULT_MAX_ITERATIONS } from "../turn/loop";
import {
  formatCompactionNotice,
  maybeCompactHistory,
} from "../turn/compaction";
import { attachSubAgentIfEnabled } from "../turn/sub-agent";
import type { SubAgentToolHandle } from "../turn/sub-agent";
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
  resolveResponsesThinkingFields,
  resolveCompactionConfig,
  createUsageAccumulator,
  describePricing,
  formatUsageSummary,
  formatUsageTable,
  isEmptyUsage,
} from "../../../llm";
import type { CompactionConfig, UsageAccumulator } from "../../../llm";
import type {
  LlmConfig,
  LlmPricing,
  ResponseHistoryItem,
  ThinkingLevel,
  ThinkingStyle,
  TokenUsage,
} from "../../../llm/types";
import { displayWidth } from "../../../../shared/string";
import { askReplLine } from "./repl-input";
import { writeSessionMarkdown } from "./session-export";
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
  /** 是否装配子 Agent 工具（delegate_task）；agent 模式开启，chat 只读问答不装配 */
  subAgentEnabled?: boolean;
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
  /** token 用量回调（可选）：每次 LLM 请求返回 usage 时触发，供会话层累加 */
  onUsage?: (usage: TokenUsage) => void;
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
  onUsage,
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
    onUsage,
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
 * 打印本轮与累计 token 用量：拆成两行并对齐标签，本轮高亮、累计弱化，避免混在一行难以区分
 * 服务未返回 usage（本轮无数据）时不输出噪音
 * @param {TokenUsage} turnUsage - 本轮累计用量（可能包含 agentic 循环的多轮请求）
 * @param {TokenUsage} totalUsage - 会话累计用量
 * @param {LlmPricing} [pricing] - 费用单价配置，未配置时只展示 token
 * @returns {void}
 */
function printTurnUsage(
  turnUsage: TokenUsage,
  totalUsage: TokenUsage,
  pricing?: LlmPricing,
): void {
  if (isEmptyUsage(turnUsage)) {
    return;
  }
  // 表格展示本轮与累计：标签列对齐，本轮高亮、累计弱化
  console.log(
    formatUsageTable(
      [
        { label: "本轮", usage: turnUsage, emphasis: true },
        { label: "累计", usage: totalUsage },
      ],
      pricing,
    ),
  );
  console.log("");
}

/**
 * 打印 REPL 启动就绪面板：信息分组行（模式/模型/用量/技能/MCP）与命令提示行
 *
 * 命令提示行由斜杠命令注册表按 available 过滤生成（与补全面板、/help 单一事实来源）；
 * 装配阶段警告（技能扫描、沙箱装载、MCP 连接）统一缩进展示在面板下方，默认状态只保留面板主体
 * @param {ReplOptions} options - 启动参数（配置、会话运行时、模式标签）
 * @param {ThinkingLevel} thinkingLevel - 初始思考档位
 * @param {SlashCommand[]} commands - 斜杠命令注册表
 * @param {TokenUsage} usage - 当前会话累计用量
 * @returns {void}
 */
function printReadyPanel(
  options: ReplOptions,
  thinkingLevel: ThinkingLevel,
  commands: SlashCommand[],
  usage: TokenUsage,
): void {
  const { llmConfig, runtime } = options;
  const { mcpSummary, bootWarnings } = runtime;
  const { catalog, scanWarnings } = runtime.assembly;

  const usageText = isEmptyUsage(usage)
    ? `${formatUsageSummary(usage)} · ${describePricing(llmConfig.pricing)}`
    : `累计 ${formatUsageSummary(usage, llmConfig.pricing)}`;
  const rows: Array<[string, string]> = [
    ["模式", options.modeLabel],
    ["模型", `${llmConfig.model} · 思考 ${thinkingLevel}`],
    ["用量", usageText],
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

/** REPL 会话状态：主循环各步骤共享的会话内状态，可变项集中在对象属性上 */
interface ReplState {
  /** 启动参数（模式标签、会话运行时、配置） */
  options: ReplOptions;
  /** 会话上下文（配置、协议风格、提示词、工具列表） */
  session: ReplSession;
  /** 当前思考档位持有者：/think 写入，回合与子 Agent 扩展字段读取同一份 */
  level: { current: ThinkingLevel };
  /** 跨轮对话历史：store=false 模式下每轮全量发送给服务端，跨轮累积 */
  history: ResponseHistoryItem[];
  /** 输入历史（面板关闭时 ↑/↓ 回溯），上限 200 条 */
  inputHistory: string[];
  /** 会话累计用量：主循环、压缩摘要、子 Agent 多来源汇入 */
  usage: UsageAccumulator;
  /** 上一次主会话请求的 input token：压缩判定优先用它（含系统提示与工具定义，口径最准） */
  lastInputTokens?: number;
  /** 压缩配置：未配置 llm.context.maxContextTokens 时为 undefined，压缩完全不介入 */
  compactionConfig?: CompactionConfig;
  /** 子 Agent 工具句柄：按轮设置用量上报器，未装配时为 undefined */
  subAgentHandle?: SubAgentToolHandle;
  /** 斜杠命令注册表：补全面板、/help、就绪面板与分发共用 */
  commands: SlashCommand[];
  /** 技能建议列表（/skill 二级补全）：技能清单会话内不变，构建一次 */
  skillSuggestions: ReturnType<typeof buildSkillSuggestions>;
}

/**
 * 创建 REPL 会话状态：装配子 Agent 工具带、初始化历史/用量/压缩口径、构建斜杠命令注册表
 * @param {ReplOptions} options - 启动参数（配置、会话运行时、思考风格与初始档位、模式标签）
 * @returns {ReplState} 会话状态
 */
function createReplState(options: ReplOptions): ReplState {
  const { llmConfig, runtime, thinkingStyle } = options;
  const { systemPrompt, catalog, todoHandle } = runtime.assembly;
  // 档位持有者先建：子 Agent 的扩展字段闭包与 /think 命令读写同一份可变档位
  const level: { current: ThinkingLevel } = {
    current: options.initialThinkingLevel,
  };
  // 子 Agent 工具按模式装配：扩展字段闭包读取当前档位，/think 切换后子 Agent 同步生效
  const {
    tools,
    advertisedTools,
    handle: subAgentHandle,
  } = attachSubAgentIfEnabled({
    enabled: options.subAgentEnabled,
    llmConfig,
    tools: runtime.assembly.tools,
    advertisedTools: runtime.assembly.advertisedTools,
    skills: catalog.list(),
    extraBody: () =>
      resolveResponsesThinkingFields({
        thinkingLevel: level.current,
        thinkingStyle,
        thinkingEffortMap: llmConfig.thinkingEffortMap,
      }),
  });
  const state: ReplState = {
    options,
    session: {
      llmConfig,
      thinkingStyle,
      systemPrompt,
      tools,
      advertisedTools,
      todoHandle,
      maxIterations: options.maxIterations,
    },
    level,
    history: [],
    inputHistory: [],
    usage: createUsageAccumulator(),
    compactionConfig: resolveCompactionConfig(llmConfig.context),
    subAgentHandle,
    commands: [],
    skillSuggestions: buildSkillSuggestions(catalog),
  };
  // 斜杠命令注册表：经闭包桥接会话状态（档位读写、/clear 重置、/export 存档）
  state.commands = buildSlashCommands({
    sandbox: runtime.sandbox,
    bashEnabled: runtime.assembly.bashEnabled,
    catalog,
    todoHandle,
    thinkingStyle,
    getThinkingLevel: () => state.level.current,
    setThinkingLevel: (next) => {
      state.level.current = next;
    },
    // /clear：只重置会话状态，保留运行时（system 提示词、工具、MCP、沙箱）
    clearSession: () => {
      const cleared = state.history.length;
      state.history.length = 0;
      state.usage.reset();
      state.lastInputTokens = undefined;
      state.inputHistory.length = 0;
      todoHandle?.resetTodos();
      return cleared;
    },
    // /export：把当前历史与累计用量写入当前目录的 Markdown 存档
    exportSession: async () => {
      if (state.history.length === 0) {
        return undefined;
      }
      return writeSessionMarkdown(state.history, {
        modeLabel: options.modeLabel,
        model: llmConfig.model,
        thinkingLevel: state.level.current,
        usage: state.usage.current,
        pricing: llmConfig.pricing,
      });
    },
  });
  return state;
}

/**
 * 步骤一：采集一条用户输入（补全面板由 askReplLine 提供）
 * Ctrl+C 取消输入视为正常退出；exit/quit 指令退出会话；输入行记入输入历史（上限 200 条）
 * @param {ReplState} state - 会话状态
 * @returns {Promise<string | undefined>} 用户输入；undefined 表示退出会话
 */
async function readReplInput(state: ReplState): Promise<string | undefined> {
  let userInput: string;
  try {
    userInput = await askReplLine({
      message: pico.green("你 > "),
      // 行首 /：命令与 /skill 二级补全；行中「空格 + /」：仅技能补全（技能提及）
      suggest: (input, cursor) =>
        input.startsWith("/")
          ? filterSuggestions(input, state.commands, state.skillSuggestions)
          : filterInlineSkillSuggestions(input, cursor, state.skillSuggestions),
      history: state.inputHistory,
    });
  } catch (err) {
    // 用户按 Ctrl+C 取消输入：视为正常退出对话，不沿用顶层"未做任何修改"的取消文案
    if (err instanceof CancelError) {
      console.log(pico.yellow("已退出对话"));
      return undefined;
    }
    throw err;
  }
  // 记录到输入历史（含斜杠命令行，↑ 可回溯重用），超上限丢弃最旧一条
  state.inputHistory.push(userInput);
  if (state.inputHistory.length > 200) {
    state.inputHistory.shift();
  }
  const lowerInput = userInput.toLowerCase();
  if (lowerInput === "exit" || lowerInput === "quit") {
    console.log(pico.yellow("已退出对话"));
    return undefined;
  }
  return userInput;
}

/**
 * 步骤二：斜杠命令查表分发
 * 注册表按「精确命令名或命令名+空格前缀」匹配，/thinking 等相似前缀不会误吞，
 * 未命中按普通问题原样返回；/skill <name> [任务...] 返回注入技能手册后的任务文本
 * @param {ReplState} state - 会话状态
 * @param {string} userInput - 用户输入
 * @returns {Promise<string | undefined>} 进入回合的任务文本；undefined 表示命令已处理完毕
 */
async function dispatchSlashCommand(
  state: ReplState,
  userInput: string,
): Promise<string | undefined> {
  const command = matchSlashCommand(userInput, state.commands);
  if (!command) {
    return userInput;
  }
  const result = await command.execute(userInput);
  return result.kind === "send" ? result.task : undefined;
}

/**
 * 步骤三（回合前）：压缩早期历史
 * 回合开始前是安全点：上一轮已完整结束，此时压缩不会切断工具调用配对
 * @param {ReplState} state - 会话状态
 * @param {UsageAccumulator} turnUsage - 本轮用量累加器：摘要请求的用量计入本轮
 * @returns {Promise<void>}
 */
async function compactBeforeTurn(
  state: ReplState,
  turnUsage: UsageAccumulator,
): Promise<void> {
  if (!state.compactionConfig) {
    return;
  }
  const outcome = await maybeCompactHistory({
    llmConfig: state.session.llmConfig,
    history: state.history,
    config: state.compactionConfig,
    lastInputTokens: state.lastInputTokens,
    onUsage: (usage) => {
      // 摘要请求同样消耗 token：计入本轮与会话累计，保证统计口径完整
      turnUsage.add(usage);
      state.usage.add(usage);
    },
  });
  const notice = formatCompactionNotice(outcome);
  if (notice) {
    console.log(
      outcome.status === "failed" ? pico.yellow(notice) : pico.cyan(notice),
    );
  }
}

/**
 * 步骤三：执行一个对话回合（压缩历史 → 设置子 Agent 上报器 → 回合 → 用量展示 → 错误兜底）
 * 单轮请求失败（网络抖动、限流等可预期错误）只提示不终止会话，避免丢失整个对话上下文；
 * 交互中取消（Ctrl+C）回滚本轮历史后继续会话
 * @param {ReplState} state - 会话状态
 * @param {string} userInput - 本轮用户输入
 * @returns {Promise<void>}
 */
async function runTurnCycle(
  state: ReplState,
  userInput: string,
): Promise<void> {
  // 本轮用量：agentic 循环一次用户输入可能发生多次 LLM 请求，按回调逐次累加
  const turnUsage = createUsageAccumulator();
  // 回合前压缩早期历史（安全点）
  await compactBeforeTurn(state, turnUsage);
  // 记录本轮开始前历史长度：本轮被取消时回滚，避免残留未配对的用户输入或工具调用项
  // 必须在压缩之后记录：压缩会缩短历史，若以压缩前长度为基准回滚会把摘要一并裁掉
  const historyStart = state.history.length;
  // 回合开始前设置子 Agent 用量上报器：子 Agent 用量计入本轮与累计，
  // 但不覆盖 lastInputTokens（压缩阈值只按主会话请求口径判断）
  state.subAgentHandle?.setUsageReporter((usage) => {
    turnUsage.add(usage);
    state.usage.add(usage);
  });
  try {
    await runReplTurn({
      session: state.session,
      history: state.history,
      userInput,
      thinkingLevel: state.level.current,
      onUsage: (usage) => {
        turnUsage.add(usage);
        state.usage.add(usage);
        state.lastInputTokens = usage.inputTokens;
      },
    });
    // 本轮结束后展示「本轮 + 累计」用量（含配置单价时的费用估算）
    printTurnUsage(
      turnUsage.current,
      state.usage.current,
      state.session.llmConfig.pricing,
    );
  } catch (err) {
    // 审批等交互中按 Ctrl+C：只中断本轮并回滚本轮历史，会话继续
    if (err instanceof CancelError) {
      state.history.length = historyStart;
      process.stdout.write("\n");
      console.log(pico.yellow("已取消本轮"));
      return;
    }
    // 仅吞可预期的业务错误（网络、接口报错）；未预期错误仍上抛，避免代码 bug 被无限循环掩盖
    if (!(err instanceof CliError)) {
      throw err;
    }
    // 换行避免错误提示接在残缺的流式输出之后
    process.stdout.write("\n");
    console.error(pico.red(err.message));
  } finally {
    // 回合结束即撤销上报器：避免子 Agent 用量混入后续轮次统计
    state.subAgentHandle?.setUsageReporter(undefined);
  }
}

/**
 * 多轮对话 REPL 主循环（chat、agent 命令共用）：循环「采集输入 → 命令分发 → 执行回合」直到退出
 *
 * 稳定骨架与可变扩展分离（开闭原则）：新增斜杠命令只需注册进命令注册表（buildSlashCommands），
 * 新增回合前后关注点只需在 runTurnCycle 增加步骤函数，主循环骨架不感知具体命令与步骤
 * @param {ReplOptions} options - 启动参数（配置、会话运行时、思考风格与初始档位、模式标签）
 * @returns {Promise<void>}
 */
export async function runConversationRepl(options: ReplOptions): Promise<void> {
  // 装配会话状态：子 Agent 工具带、斜杠命令注册表、压缩配置与用量口径
  const state = createReplState(options);
  // 就绪面板：标题、模型/用量/技能/MCP 信息行与命令提示，装配阶段警告统一缩进展示在其下
  printReadyPanel(
    options,
    state.level.current,
    state.commands,
    state.usage.current,
  );
  // 服务能力折算警告：off 档位本就对应关闭，此时不提示
  warnThinkingFallback(state.level.current, options.thinkingStyle);

  for (;;) {
    // 步骤 1：采集输入（Ctrl+C 或 exit/quit 退出会话）
    const userInput = await readReplInput(state);
    if (userInput === undefined) {
      return;
    }
    // 步骤 2：斜杠命令分发（未命中按普通问题进入回合）
    const task = await dispatchSlashCommand(state, userInput);
    if (task === undefined) {
      continue;
    }
    // 步骤 3：执行回合（压缩 → 上报器 → 回合 → 用量展示 → 错误兜底）
    await runTurnCycle(state, task);
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
      subAgentEnabled: modeConfig.subAgentEnabled,
    });
  } finally {
    await disposeConversationRuntime(runtime);
  }
}
