import pico from "picocolors";
import { createResponsesTurn } from "./responses-turn";
import { createStreamRenderer, createToolCallLogger, createSoftConvergeNotice } from "./renderer";
import { runAgentLoop, DEFAULT_MAX_ITERATIONS } from "./loop";
import { resolveThinkingLevel, warnThinkingFallback } from "./thinking";
import {
  createConversationRuntime,
  disposeConversationRuntime,
} from "./runtime";
import type { ConversationRuntime } from "./runtime";
import type { ConversationModeConfig } from "./mode";
import type { SandboxContext } from "../../sandbox/gate";
import type { SandboxCliOptions } from "../../sandbox";
import { formatTodoList } from "../../tools";
import type { TodoToolHandle, Tool } from "../../tools";
import { CancelError, CliError } from "../../../shared/errors";
import { askText } from "../../../shared/prompt";
import { printWarnings } from "../../../shared/warnings";
import {
  parseThinkingLevel,
  resolveResponsesThinkingFields,
  resolveThinkingStyle,
  THINKING_LEVELS,
} from "../../llm";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
  ThinkingStyle,
} from "../../../types/llm";

/** REPL 会话上下文：会话期间不变的依赖打包，避免逐参数透传 */
interface ReplSession {
  /** LLM 接入配置 */
  config: LlmConfig;
  /** 思考协议风格（会话内不变，启动时解析一次） */
  style: ThinkingStyle;
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
  config: LlmConfig;
  /** 会话运行时（MCP、沙箱、技能装配结果），生命周期由调用方管理 */
  runtime: ConversationRuntime;
  /** 思考协议风格（启动时解析一次） */
  style: ThinkingStyle;
  /** 初始思考档位（/think 切换后下一轮使用新档位） */
  initialLevel: ThinkingLevel;
  /** 模式标签（欢迎语展示，如「对话模式」「Agent 模式」） */
  modeLabel: string;
  /** 工具调用轮数上限（来自模式配置，如 chat 8 轮、agent 20 轮） */
  maxIterations: number;
}

/**
 * 执行多轮对话的一轮：Responses API 无状态模式 + agentic loop，工具调用按会话装配的工具带开启
 * store=false：服务端不留存会话，历史由本地维护并每轮全量发送，跨轮经共享 history 数组衔接；
 * 深度思考内容以暗色流式输出（模型未返回时不输出），instructions 每轮重传
 * @param {ReplSession} session - 会话上下文（配置、协议风格、提示词、工具列表）
 * @param {ResponseHistoryItem[]} history - 跨轮共享的对话历史（本函数向其追加内容）
 * @param {string} input - 本轮用户输入
 * @param {ThinkingLevel} thinkingLevel - 本轮思考档位（/think 切换后下一轮使用新档位）
 * @returns {Promise<void>}
 */
async function runReplTurn(
  session: ReplSession,
  history: ResponseHistoryItem[],
  input: string,
  thinkingLevel: ThinkingLevel,
): Promise<void> {
  const renderer = createStreamRenderer();
  const runTurn = createResponsesTurn({
    config: session.config,
    input,
    history,
    instructions: session.systemPrompt,
    extraBody: resolveResponsesThinkingFields(
      thinkingLevel,
      session.style,
      session.config.thinkingEffortMap,
    ),
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
 * @param {ThinkingLevel} level - 目标档位
 * @param {ThinkingStyle} style - 思考协议风格
 * @returns {void}
 */
function printThinkingNotice(level: ThinkingLevel, style: ThinkingStyle): void {
  // none 风格的警告已含档位信息，不重复打印档位行
  if (style !== "none") {
    console.log(pico.cyan(`思考档位：${level}`));
  }
  warnThinkingFallback(level, style);
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

/**
 * 多轮对话 REPL 主循环（chat、agent 命令共用）：循环提问，直到用户输入 exit/quit 或按 Ctrl+C 退出
 * 基于 Responses API（无状态模式）+ agentic loop：历史由本地维护、每轮全量发送，
 * 模型可在任意一轮发起工具调用，工具带与沙箱由调用方经会话运行时按模式装配
 * 支持内联命令 /think（查看/切换思考档位）、/skills（列出技能）、/todos（查看任务清单）、/permissions（查看沙箱与权限状态）
 * 单轮请求失败（网络抖动、限流等可预期错误）只提示不终止会话，避免丢失整个对话上下文
 * @param {ReplOptions} opts - 启动参数（配置、会话运行时、思考风格与初始档位、模式标签）
 * @returns {Promise<void>}
 */
export async function runConversationRepl(opts: ReplOptions): Promise<void> {
  const { config, runtime, style, modeLabel } = opts;
  // 档位由 /think 在会话内切换，仅本函数持有可变状态
  let currentLevel = opts.initialLevel;
  const { systemPrompt, tools, catalog, warnings, todoHandle } = runtime.skill;
  const { sandbox, mcpTools } = runtime;
  printWarnings(warnings);
  const skillNote = catalog.size > 0 ? `，已发现 ${catalog.size} 个技能` : "";
  const mcpNote =
    mcpTools.length > 0 ? `，已连接 MCP 工具 ${mcpTools.length} 个` : "";
  console.log(
    pico.green(
      `已连接模型 ${config.model}（${modeLabel}），思考档位 ${currentLevel}，支持工具调用${skillNote}${mcpNote}，输入问题开始对话，输入 exit 或按 Ctrl+C 退出`,
    ),
  );
  const hints = [
    `/think 查看思考档位，/think <${THINKING_LEVELS.join("|")}> 切换`,
  ];
  if (catalog.size > 0) {
    hints.push("/skills 查看可用技能");
  }
  if (sandbox) {
    hints.push("/permissions 查看沙箱与权限状态");
  }
  if (todoHandle) {
    hints.push("/todos 查看任务清单");
  }
  console.log(pico.cyan(`提示：${hints.join("；")}`));
  // 服务能力折算警告：off 档位本就对应关闭，此时不提示
  warnThinkingFallback(currentLevel, style);
  const session: ReplSession = {
    config,
    style,
    systemPrompt,
    tools,
    todoHandle,
    maxIterations: opts.maxIterations,
  };
  // 本地维护的对话历史：store=false 模式下每轮全量发送给服务端，跨轮累积
  const history: ResponseHistoryItem[] = [];

  for (;;) {
    let input: string;
    try {
      // askText 已保证返回值去除首尾空格且非空，命令匹配无需再 trim
      input = await askText(pico.green("你 > "));
    } catch (err) {
      // 用户按 Ctrl+C 取消输入：视为正常退出对话，不沿用顶层"未做任何修改"的取消文案
      if (err instanceof CancelError) {
        console.log(pico.yellow("已退出对话"));
        return;
      }
      throw err;
    }

    const lower = input.toLowerCase();
    if (lower === "exit" || lower === "quit") {
      console.log(pico.yellow("已退出对话"));
      return;
    }

    // 内联命令 /permissions：查看当前会话的沙箱与权限状态（只读展示）
    if (lower === "/permissions") {
      printPermissions(sandbox);
      continue;
    }

    // 内联命令 /todos：查看当前任务清单（write_todos 工具的会话状态，只读展示）
    if (lower === "/todos") {
      printTodos(todoHandle);
      continue;
    }

    // 内联命令 /skills：列出可用技能及来源，便于确认模型可加载的手册清单
    if (lower === "/skills") {
      if (catalog.size === 0) {
        console.log(
          pico.yellow(
            "未发现可用技能（扫描目录：~/.tx-cli/skills、./.tx-cli/skills）",
          ),
        );
      } else {
        for (const skill of catalog.list()) {
          const source = skill.source === "project" ? "项目级" : "用户级";
          console.log(
            `${pico.cyan(skill.name)}（${source}）${skill.description}`,
          );
        }
      }
      continue;
    }

    // 内联命令 /think：查看或切换思考档位，非法值提示后保留原档位，不退出会话
    // 精确匹配 /think 或 /think <档位>：/thinking 等前缀相似的输入应当作普通问题发给模型
    if (lower === "/think" || lower.startsWith("/think ")) {
      const arg = input.slice("/think".length).trim();
      if (!arg) {
        printThinkingNotice(currentLevel, style);
        continue;
      }
      try {
        // arg 已确认非空：parseThinkingLevel 只会返回档位或抛 CliError，不会返回 undefined
        const nextLevel = parseThinkingLevel(arg);
        if (nextLevel) {
          currentLevel = nextLevel;
        }
        printThinkingNotice(currentLevel, style);
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
      await runReplTurn(session, history, input, currentLevel);
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

/**
 * 多轮对话入口（chat、agent 命令共用的 REPL 薄入口）：解析档位 → 装配会话运行时 → 进入 REPL 循环
 * 模式差异（人设、标签、bash 装配策略）由 mode 决定；运行时生命周期在本函数内管理
 * @param {LlmConfig} config - LLM 接入配置
 * @param {ConversationModeConfig} mode - 模式配置（人设、标签、bash 装配策略）
 * @param {ThinkingLevel | undefined} thinkingLevel - 命令行指定的思考档位，未指定时回退配置默认
 * @param {boolean} mcpEnabled - 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启
 * @param {SandboxCliOptions} sandboxCli - 沙箱 CLI 选项（agent 命令的 --sandbox 等），缺省按配置文件装配
 * @returns {Promise<void>}
 */
export async function runReplConversation(
  config: LlmConfig,
  mode: ConversationModeConfig,
  thinkingLevel?: ThinkingLevel,
  mcpEnabled = true,
  sandboxCli?: SandboxCliOptions,
): Promise<void> {
  const currentLevel = resolveThinkingLevel(thinkingLevel, config);
  const style = resolveThinkingStyle(config);
  const runtime = await createConversationRuntime(mode.basePrompt, {
    mcpEnabled,
    bashEnabled: mode.bashEnabled,
    todosEnabled: mode.todosEnabled,
    sandboxCli,
  });
  try {
    await runConversationRepl({
      config,
      runtime,
      style,
      initialLevel: currentLevel,
      modeLabel: mode.modeLabel,
      maxIterations: mode.maxIterations ?? DEFAULT_MAX_ITERATIONS,
    });
  } finally {
    await disposeConversationRuntime(runtime);
  }
}
