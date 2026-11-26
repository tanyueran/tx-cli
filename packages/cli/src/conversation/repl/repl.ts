/**
 * cli/conversation/repl/repl：终端多轮对话 REPL 主循环
 * 职责：步骤编排（采集输入 → 斜杠命令分发 → 执行回合）与会话入口（runReplConversation）；
 * 回合执行、历史、压缩与子 Agent 调度由 core 的 ConversationSession 统一承担，
 * 终端展示见 panel.ts、输入竞速见 background.ts、终端状态见 state.ts
 */
import {
  ConversationSession,
  buildBackgroundNotice,
  printTaskEventLines,
  warnThinkingFallback,
} from "@tanyueran/agent-core";
import type {
  ConversationModeConfig,
  LlmConfig,
  SandboxCliOptions,
  SessionChannels,
  ThinkingLevel,
} from "@tanyueran/agent-core";
import {
  MAX_AUTO_CONTINUE_TURNS,
  waitForInputOrBackground,
} from "./background";
import { printReadyPanel, printTurnUsage } from "./panel";
import { matchSlashCommand } from "./slash-commands";
import { createReplState } from "./state";
import type { ReplOptions, ReplState } from "./state";

/**
 * 步骤二：斜杠命令查表分发
 * 注册表按「精确命令名或命令名+空格前缀」匹配，/thinking 等相似前缀不会误吞，
 * 未命中按普通问题原样返回；/skill <name> [任务...] 返回注入技能手册后的任务文本
 * @param {ReplState} state - 终端 REPL 状态
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
 * 步骤三：执行一个对话回合（委托无头会话）并展示本轮用量
 * 取消与可预期失败由会话内部兜底（提示但不终止），此处跳过用量表格展示
 * @param {ReplState} state - 终端 REPL 状态
 * @param {string} userInput - 本轮用户输入
 * @returns {Promise<void>}
 */
async function runTurnCycle(
  state: ReplState,
  userInput: string,
): Promise<void> {
  const { session } = state.options;
  const result = await session.runTurn(userInput);
  if (result.status !== "completed") {
    return;
  }
  // 本轮结束后展示「本轮 + 累计」用量（含配置单价时的费用估算）
  printTurnUsage(
    result.turnUsage,
    session.usage.current,
    session.llmConfig.pricing,
    state.options.channels.output,
  );
}

/**
 * 多轮对话 REPL 主循环（chat、agent 命令共用）：循环「采集输入 → 命令分发 → 执行回合」直到退出
 *
 * 稳定骨架与可变扩展分离（开闭原则）：新增斜杠命令只需注册进命令注册表（buildSlashCommands），
 * 新增回合前后关注点只需在 runTurnCycle 增加步骤函数，主循环骨架不感知具体命令与步骤
 * @param {ReplOptions} options - 启动参数（无头会话、模式标签、通道）
 * @param {{ current?: ReplState }} stateRef - 状态引用（后台事件唤醒槽的延迟绑定）
 * @returns {Promise<void>}
 */
export async function runConversationRepl(
  options: ReplOptions,
  stateRef: { current?: ReplState },
): Promise<void> {
  const { output } = options.channels;
  const { session } = options;
  // 装配终端状态：输入历史、斜杠命令注册表与后台唤醒槽
  const state = createReplState(options);
  stateRef.current = state;
  // 就绪面板：标题、模型/用量/技能/MCP 信息行与命令提示，装配阶段警告统一缩进展示在其下
  printReadyPanel(
    options,
    session.thinkingLevel,
    state.commands,
    session.usage.current,
    output,
  );
  // 服务能力折算警告：off 档位本就对应关闭，此时不提示
  warnThinkingFallback(session.thinkingLevel, session.thinkingStyle, output);

  for (;;) {
    // 步骤 1：采集输入，与后台任务事件竞速（用户纯等待时事件先到则自动唤醒）
    const wait = await waitForInputOrBackground(state);
    if (wait.type === "exit") {
      // 退出前等待运行中的后台任务完成，避免结果无声丢失
      await session.awaitBackgroundTasksOnExit();
      return;
    }
    if (wait.type === "background") {
      // 后台任务完成自动继续：收割事件，以通知文本作为本轮输入发起回合，
      // 模型基于结论汇报或继续此前承诺的后续步骤；连续超过上限只注入不自动执行，
      // 防止「任务派任务」形成无人值守的自动链（真实用户输入会清零计数）
      const events = session.drainBackgroundEvents();
      if (events.length === 0) {
        continue;
      }
      if (state.autoTurnCount >= MAX_AUTO_CONTINUE_TURNS) {
        session.ingestBackgroundEvents(events);
        output.warn(
          `已连续自动继续 ${state.autoTurnCount} 轮，暂停自动执行；结果已带入对话，请输入指示后继续`,
        );
        continue;
      }
      state.autoTurnCount += 1;
      printTaskEventLines(events, output);
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
    // 步骤 3：执行回合（无头会话内部：收割事件 → 压缩 → 回合 → 错误兜底）
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
  /** 会话通道集合：输入 / 输出 / 交互提示的抽象出口，由各端注入 */
  channels: SessionChannels;
}

/**
 * 多轮对话入口（chat、agent 命令共用的 REPL 薄入口）：装配无头会话 → 进入 REPL 循环
 * 模式差异（人设、标签、工具带装配策略）由 modeConfig 决定；会话生命周期在本函数内管理
 * @param {ReplConversationOptions} options - 入参对象（字段说明见接口定义）
 * @returns {Promise<void>}
 */
export async function runReplConversation(
  options: ReplConversationOptions,
): Promise<void> {
  // 状态引用提前声明：会话的后台事件回调经它触发输入等待的唤醒槽（装配早于状态创建）
  const stateRef: { current?: ReplState } = {};
  const session = await ConversationSession.create({
    ...options,
    onBackgroundEvent: () => stateRef.current?.backgroundWake?.(),
  });
  try {
    await runConversationRepl(
      {
        session,
        modeLabel: options.modeConfig.modeLabel,
        channels: options.channels,
      },
      stateRef,
    );
  } finally {
    await session.dispose();
  }
}
