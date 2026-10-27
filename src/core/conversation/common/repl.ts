import pico from "picocolors";
import { createResponsesTurn } from "./responses-turn";
import {
  createStreamRenderer,
  createToolCallLogger,
  createSoftConvergeNotice,
} from "./renderer";
import { runAgentLoop, DEFAULT_MAX_ITERATIONS } from "./loop";
import {
  createConversationRuntime,
  disposeConversationRuntime,
} from "./runtime";
import type { ConversationRuntime } from "./runtime";
import type { ConversationModeConfig } from "./mode";
import type { SandboxContext } from "../../sandbox/runtime/context";
import type { SandboxCliOptions } from "../../sandbox";
import { formatTodoList } from "../../tools";
import type { TodoToolHandle, Tool } from "../../tools";
import { CancelError, CliError } from "../../../shared/errors";
import { askText } from "../../../shared/interactive-prompt";
import { printWarnings } from "../../../shared/warnings";
import {
  parseThinkingLevel,
  resolveResponsesThinkingFields,
  resolveThinkingLevel,
  resolveThinkingStyle,
  THINKING_LEVELS,
  warnThinkingFallback,
} from "../../llm";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
  ThinkingStyle,
} from "../../llm/types";

/** REPL 会话上下文：会话期间不变的依赖打包，避免逐参数透传 */
interface ReplSession {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 思考协议风格（会话内不变，启动时解析一次） */
  thinkingStyle: ThinkingStyle;
  /** 组装后的 system 提示词（含技能元数据清单） */
  systemPrompt: string;
  /** 本会话可用的工具列表（按模式装配：内置 + load_skill + write_todos + bash + MCP） */
  tools: Tool[];
  /** 任务清单工具句柄（agent 模式装配 write_todos 时存在，/todos 读取清单状态） */
  todoHandle?: TodoToolHandle;
  /** 工具调用轮数上限（按模式装配：chat 8 轮、agent 20 轮），超出后软收敛为直接作答 */
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
  /** 模式标签（欢迎语展示，如「对话模式」「Agent 模式」） */
  modeLabel: string;
  /** 工具调用轮数上限（来自模式配置，如 chat 8 轮、agent 20 轮） */
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
 * 执行多轮对话的一轮：Responses API 无状态模式 + agentic loop，工具调用按会话装配的工具带开启
 * store=false：服务端不留存会话，历史由本地维护并每轮全量发送，跨轮经共享 history 数组衔接；
 * 深度思考内容以暗色流式输出（模型未返回时不输出），instructions 每轮重传
 * @param {ReplTurnOptions} options - 入参对象（session/history/userInput/thinkingLevel 字段说明见接口定义）
 * @returns {Promise<void>}
 */
async function runReplTurn({
  session,
  history,
  userInput,
  thinkingLevel,
}: ReplTurnOptions): Promise<void> {
  const renderer = createStreamRenderer();
  const runTurn = createResponsesTurn({
    llmConfig: session.llmConfig,
    userInput,
    history,
    instructions: session.systemPrompt,
    extraBody: resolveResponsesThinkingFields({
      thinkingLevel,
      thinkingStyle: session.thinkingStyle,
      thinkingEffortMap: session.llmConfig.thinkingEffortMap,
    }),
    tools: session.tools,
    onDelta: renderer.onDelta,
    onReasoningDelta: renderer.onReasoningDelta,
  });
  await runAgentLoop({
    runTurn,
    tools: session.tools,
    maxIterations: session.maxIterations,
    onToolCall: createToolCallLogger(renderer),
    onSoftConverge: createSoftConvergeNotice(renderer, session.maxIterations),
  });
  process.stdout.write("\n\n");
}

/**
 * 打印思考档位切换/设置结果与服务能力折算提示
 * @param {ThinkingLevel} thinkingLevel - 目标档位
 * @param {ThinkingStyle} thinkingStyle - 思考协议风格
 * @returns {void}
 */
function printThinkingNotice(
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
 * @returns {void}
 */
function printPermissions(sandbox: SandboxContext | undefined): void {
  if (!sandbox) {
    console.log(pico.yellow("本会话未启用沙箱（bash 与权限门卫均未装配）"));
    return;
  }
  const providerName = sandbox.provider
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
function printTodos(todoHandle: TodoToolHandle | undefined): void {
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

/** 面板标签列的目标显示宽度（列数）：全角字符按 2 列计，当前标签最宽为「模型」等 4 列 */
const PANEL_LABEL_WIDTH = 4;
/** 标签列与内容列之间的间隙（空格数） */
const PANEL_LABEL_GAP = 3;

/**
 * 计算字符串的终端显示宽度：全角（CJK 等）字符按 2 列、其余按 1 列计
 * @param {string} text - 待测宽度的字符串
 * @returns {number} 显示宽度（列数）
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += char.charCodeAt(0) > 0xff ? 2 : 1;
  }
  return width;
}

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
 * 打印 REPL 启动就绪面板：信息分组行（模型/技能/MCP）与命令提示行，
 * 装配阶段警告（技能扫描、沙箱装载、MCP 连接）统一缩进展示在面板下方，
 * 替代原先分散的连接日志与长句欢迎语，默认状态只保留面板主体
 * @param {ReplOptions} options - 启动参数（配置、会话运行时）
 * @param {ThinkingLevel} thinkingLevel - 初始思考档位
 * @returns {void}
 */
function printReadyPanel(options: ReplOptions, thinkingLevel: ThinkingLevel): void {
  const { llmConfig, runtime } = options;
  const { sandbox, mcpSummary, bootWarnings } = runtime;
  const { catalog, scanWarnings, todoHandle } = runtime.skill;

  const rows: Array<[string, string]> = [
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
  const hints = [`/think <${THINKING_LEVELS.join("|")}>`];
  if (catalog.size > 0) {
    hints.push("/skills");
  }
  if (sandbox) {
    hints.push("/permissions");
  }
  if (todoHandle) {
    hints.push("/todos");
  }
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
 * 多轮对话 REPL 主循环（chat、agent 命令共用）：循环提问，直到用户输入 exit/quit 或按 Ctrl+C 退出
 * 基于 Responses API（无状态模式）+ agentic loop：历史由本地维护、每轮全量发送，
 * 模型可在任意一轮发起工具调用，工具带与沙箱由调用方经会话运行时按模式装配
 * 支持内联命令 /think（查看/切换思考档位）、/skills（列出技能）、/todos（查看任务清单）、/permissions（查看沙箱与权限状态）
 * 单轮请求失败（网络抖动、限流等可预期错误）只提示不终止会话，避免丢失整个对话上下文
 * @param {ReplOptions} options - 启动参数（配置、会话运行时、思考风格与初始档位、模式标签）
 * @returns {Promise<void>}
 */
export async function runConversationRepl(options: ReplOptions): Promise<void> {
  const { llmConfig, runtime, thinkingStyle } = options;
  // 档位由 /think 在会话内切换，仅本函数持有可变状态
  let currentLevel = options.initialThinkingLevel;
  const { systemPrompt, tools, catalog, todoHandle } = runtime.skill;
  const { sandbox } = runtime;
  // 就绪面板：标题、模型/技能/MCP 信息行与命令提示，装配阶段警告统一缩进展示在其下
  printReadyPanel(options, currentLevel);
  // 服务能力折算警告：off 档位本就对应关闭，此时不提示
  warnThinkingFallback(currentLevel, thinkingStyle);
  const session: ReplSession = {
    llmConfig,
    thinkingStyle,
    systemPrompt,
    tools,
    todoHandle,
    maxIterations: options.maxIterations,
  };
  // 本地维护的对话历史：store=false 模式下每轮全量发送给服务端，跨轮累积
  const history: ResponseHistoryItem[] = [];

  for (;;) {
    let userInput: string;
    try {
      // askText 已保证返回值去除首尾空格且非空，命令匹配无需再 trim
      userInput = await askText(pico.green("你 > "));
    } catch (err) {
      // 用户按 Ctrl+C 取消输入：视为正常退出对话，不沿用顶层"未做任何修改"的取消文案
      if (err instanceof CancelError) {
        console.log(pico.yellow("已退出对话"));
        return;
      }
      throw err;
    }

    const lowerInput = userInput.toLowerCase();
    if (lowerInput === "exit" || lowerInput === "quit") {
      console.log(pico.yellow("已退出对话"));
      return;
    }

    // 内联命令 /permissions：查看当前会话的沙箱与权限状态（只读展示）
    if (lowerInput === "/permissions") {
      printPermissions(sandbox);
      continue;
    }

    // 内联命令 /todos：查看当前任务清单（write_todos 工具的会话状态，只读展示）
    if (lowerInput === "/todos") {
      printTodos(todoHandle);
      continue;
    }

    // 内联命令 /skills：列出可用技能及来源，便于确认模型可加载的手册清单
    if (lowerInput === "/skills") {
      if (catalog.size === 0) {
        console.log(
          pico.yellow(
            "未发现可用技能（扫描目录：~/.tx-cli/skills、./.tx-cli/skills）",
          ),
        );
      } else {
        for (const skill of catalog.list()) {
          const skillSource = skill.source === "project" ? "项目级" : "用户级";
          console.log(
            `${pico.cyan(skill.name)}（${skillSource}）${skill.description}`,
          );
        }
      }
      continue;
    }

    // 内联命令 /think：查看或切换思考档位，非法值提示后保留原档位，不退出会话
    // 精确匹配 /think 或 /think <档位>：/thinking 等前缀相似的输入应当作普通问题发给模型
    if (lowerInput === "/think" || lowerInput.startsWith("/think ")) {
      const thinkLevelArg = userInput.slice("/think".length).trim();
      if (!thinkLevelArg) {
        printThinkingNotice(currentLevel, thinkingStyle);
        continue;
      }
      try {
        // thinkLevelArg 已确认非空：parseThinkingLevel 只会返回档位或抛 CliError，不会返回 undefined
        const nextLevel = parseThinkingLevel(thinkLevelArg);
        if (nextLevel) {
          currentLevel = nextLevel;
        }
        printThinkingNotice(currentLevel, thinkingStyle);
      } catch (err) {
        if (!(err instanceof CliError)) {
          throw err;
        }
        console.error(pico.red(err.message));
      }
      continue;
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
 * 模式差异（人设、标签、bash 装配策略）由 modeConfig 决定；运行时生命周期在本函数内管理
 * @param {ReplConversationOptions} options - 入参对象（llmConfig/modeConfig/thinkingLevel/mcpEnabled/cliSandboxOptions 字段说明见接口定义）
 * @returns {Promise<void>}
 */
export async function runReplConversation({
  llmConfig,
  modeConfig,
  thinkingLevel,
  mcpEnabled = true,
  cliSandboxOptions,
}: ReplConversationOptions): Promise<void> {
  const currentLevel = resolveThinkingLevel({
    cliLevel: thinkingLevel,
    llmConfig: llmConfig,
    fallback: modeConfig.defaultThinkingLevel,
  });
  const thinkingStyle = resolveThinkingStyle(llmConfig);
  const runtime = await createConversationRuntime(modeConfig.basePrompt, {
    mcpEnabled,
    bashEnabled: modeConfig.bashEnabled,
    todosEnabled: modeConfig.todosEnabled,
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
