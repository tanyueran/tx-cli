/**
 * conversation/repl/repl：多轮对话 REPL 主循环
 * 职责：步骤编排（采集输入 → 斜杠命令分发 → 执行回合）与会话入口（runReplConversation）；
 * 会话状态与装配见 state.ts、终端展示见 panel.ts、后台事件与输入竞速见 background.ts
 */
import pico from "picocolors";
import { executeConversationTurn } from "../loop/execute-turn";
import { DEFAULT_MAX_ITERATIONS } from "../loop/loop";
import {
  formatCompactionNotice,
  maybeCompactHistory,
} from "../loop/compaction";
import {
  createConversationRuntime,
  disposeConversationRuntime,
} from "../session/runtime";
import type { ConversationModeConfig } from "../session/mode";
import type { SandboxCliOptions } from "../../sandbox";
import {
  createUsageAccumulator,
  resolveThinkingLevel,
  resolveThinkingStyle,
  warnThinkingFallback,
} from "../../llm";
import type { UsageAccumulator } from "../../llm";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
  TokenUsage,
} from "../../llm/types";
import { CancelError, CliError } from "../../../shared/errors";
import {
  awaitBackgroundTasksOnExit,
  buildBackgroundNotice,
  ingestBackgroundEvents,
  ingestEvents,
  MAX_AUTO_CONTINUE_TURNS,
  printTaskEventLines,
  waitForInputOrBackground,
} from "./background";
import { printReadyPanel, printTurnUsage } from "./panel";
import { matchSlashCommand } from "./slash-commands";
import { createReplState } from "./state";
import type { ReplOptions, ReplState } from "./state";

/** runReplTurn 入参对象 */
interface ReplTurnOptions {
  /** 会话上下文（配置、协议风格、提示词、工具列表） */
  session: ReplState["session"];
  /** 跨轮共享的对话历史（本函数向其追加内容） */
  history: ResponseHistoryItem[];
  /** 本轮用户输入 */
  userInput: string;
  /** 本轮思考档位（/think 切换后下一轮使用新档位） */
  thinkingLevel: ThinkingLevel;
  /** token 用量回调（可选）：每次 LLM 请求返回 usage 时触发，供会话层累加并更新压缩口径 */
  onUsage?: (usage: TokenUsage) => void;
  /** 压缩摘要请求的用量回调（可选）：只计入统计，不更新 lastInputTokens（口径隔离，防重复压缩） */
  onCompactionUsage?: (usage: TokenUsage) => void;
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
  onCompactionUsage,
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
    onCompactionUsage,
  });
  process.stdout.write("\n\n");
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
 * 步骤三：执行一个对话回合（收割后台事件 → 压缩历史 → 设置子 Agent 上报器 → 回合 → 用量展示 → 错误兜底）
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
  // 回合开始收割后台任务事件：打印通知行并注入历史，本轮请求即可见（含用户打字期间完成的任务）
  ingestBackgroundEvents(state);
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
        // 口径约定：lastInputTokens 只按真实请求更新（见 state.ts 字段说明）
        state.lastInputTokens = usage.inputTokens;
      },
      // 压缩摘要请求的用量只计入统计：摘要 inputTokens ≈ 被压缩段原大小，
      // 回流 lastInputTokens 会让下一轮 compactBeforeTurn 误判而重复压缩
      onCompactionUsage: (usage) => {
        turnUsage.add(usage);
        state.usage.add(usage);
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
    // 期间完成的后台任务事件留在队列：主循环的输入等待会立即感知——
    // 自动继续（通知文本作为下轮输入）或用户先输入（下一回合开始注入），打印与注入恰好各一次；
    // 此处若 drain 打印会吞掉事件，模型永远看不到结论
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
    // 步骤 1：采集输入，与后台任务事件竞速（用户纯等待时事件先到则自动唤醒）
    const wait = await waitForInputOrBackground(state);
    if (wait.type === "exit") {
      // 退出前等待运行中的后台任务完成，避免结果无声丢失
      await awaitBackgroundTasksOnExit(state);
      return;
    }
    if (wait.type === "background") {
      // 后台任务完成自动继续：收割事件，以通知文本作为本轮输入发起回合，
      // 模型基于结论汇报或继续此前承诺的后续步骤；连续超过上限只注入不自动执行，
      // 防止「任务派任务」形成无人值守的自动链（真实用户输入会清零计数）
      const events = state.subAgentDispatcher?.drainEvents() ?? [];
      if (events.length === 0) {
        continue;
      }
      if (state.autoTurnCount >= MAX_AUTO_CONTINUE_TURNS) {
        ingestEvents(state, events);
        console.log(
          pico.yellow(
            `已连续自动继续 ${state.autoTurnCount} 轮，暂停自动执行；结果已带入对话，请输入指示后继续`,
          ),
        );
        continue;
      }
      state.autoTurnCount += 1;
      printTaskEventLines(events);
      await runTurnCycle(state, buildBackgroundNotice(events));
      continue;
    }
    // 真实用户输入：清零自动继续计数
    state.autoTurnCount = 0;
    // 步骤 2：斜杠命令分发（未命中按普通问题进入回合）
    const task = await dispatchSlashCommand(state, wait.value);
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
