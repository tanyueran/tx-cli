/**
 * conversation/repl/background：后台子 Agent 事件与输入等待的协同
 * 事件收割与历史注入（ingestEvents / ingestBackgroundEvents / flushBackgroundEvents）、
 * 退出前等待（awaitBackgroundTasksOnExit）、输入等待与后台事件的竞速唤醒
 * （waitForInputOrBackground，含被打断草稿的保存与还原）
 */
import pico from "picocolors";
import { CancelError } from "@tx-cli/shared";
import { formatElapsed } from "./panel";
import { askReplLine, ReplInputAbortedError } from "./input";
import {
  filterInlineSkillSuggestions,
  filterSuggestions,
} from "./slash-commands";
import type { SubAgentNodeEvent } from "../sub-agent/dispatcher";
import type { ReplState } from "./state";

/** 输入等待的可选参数：中断信号与还原草稿（后台自动唤醒打断输入行时使用） */
interface ReplInputWaitOptions {
  /** 中断信号：后台事件唤醒时 abort，安全收尾输入组件并携带草稿 */
  signal?: AbortSignal;
  /** 初始草稿：预填输入行（还原上次被打断时用户未提交的内容） */
  initialInput?: string;
}

/**
 * 步骤一：采集一条用户输入（补全面板由 askReplLine 提供）
 * Ctrl+C 取消输入视为正常退出；exit/quit 指令退出会话；输入行记入输入历史（上限 200 条）；
 * 输入等待被后台事件中断（ReplInputAbortedError）时原样上抛，由输入等待方处理
 * @param {ReplState} state - 会话状态
 * @param {ReplInputWaitOptions} [waitOptions] - 中断信号与还原草稿（可选）
 * @returns {Promise<string | undefined>} 用户输入；undefined 表示退出会话
 */
async function readReplInput(
  state: ReplState,
  waitOptions?: ReplInputWaitOptions,
): Promise<string | undefined> {
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
      signal: waitOptions?.signal,
      initialInput: waitOptions?.initialInput,
    });
  } catch (err) {
    // 用户按 Ctrl+C 取消输入：视为正常退出对话，不沿用顶层"未做任何修改"的取消文案
    if (err instanceof CancelError) {
      console.log(pico.yellow("已退出对话"));
      return undefined;
    }
    throw err;
  }
  // 草稿已被提交消费：清除待还原草稿
  state.pendingDraft = undefined;
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

/** 后台结论注入历史的截断上限：超长结论只注入前若干字，全文用 task_status 收割 */
const NOTICE_OUTPUT_MAX_CHARS = 4_000;

/**
 * 渲染一条后台任务终态事件的终端通知行
 * @param {SubAgentNodeEvent} event - 节点终态事件
 * @returns {string} 通知行（带颜色标记）
 */
function formatTaskEventLine(event: SubAgentNodeEvent): string {
  const elapsed = formatElapsed(event.elapsedMs);
  if (event.kind === "completed") {
    return pico.cyan(
      `✓ 后台任务 ${event.nodeId} 完成（${elapsed}）：${event.preview} —— 结论 ${(event.output ?? "").length} 字，将自动带入对话`,
    );
  }
  if (event.kind === "failed") {
    return pico.yellow(
      `✗ 后台任务 ${event.nodeId} 失败（${elapsed}）：${event.error ?? "未知原因"}`,
    );
  }
  return pico.yellow(
    `■ 后台任务 ${event.nodeId} 已停止（${elapsed}）：${event.preview}`,
  );
}

/**
 * 把一批后台终态事件组装为注入历史的系统通知文本（user 角色承载，前缀标记说明来源）；
 * 历史项类型不含 system 角色，以「[后台任务通知]」前缀区分于真实用户输入
 * @param {SubAgentNodeEvent[]} events - 节点终态事件
 * @returns {string} 注入文本
 */
export function buildBackgroundNotice(events: SubAgentNodeEvent[]): string {
  const lines = [
    "[后台任务通知] 以下后台子任务已结束（本条为系统通知，非用户输入），相关信息供你直接使用：",
  ];
  for (const event of events) {
    if (event.kind === "completed" && event.output !== undefined) {
      const output =
        event.output.length > NOTICE_OUTPUT_MAX_CHARS
          ? `${event.output.slice(0, NOTICE_OUTPUT_MAX_CHARS)}…（结论已截断，全文 ${event.output.length} 字，可用 task_status 收割全文）`
          : event.output;
      lines.push(
        `- ${event.nodeId}「${event.preview}」已完成（${formatElapsed(event.elapsedMs)}），结论：`,
        output,
      );
    } else if (event.kind === "failed") {
      lines.push(
        `- ${event.nodeId}「${event.preview}」失败（${formatElapsed(event.elapsedMs)}）：${event.error ?? "未知原因"}`,
      );
    } else {
      lines.push(`- ${event.nodeId}「${event.preview}」已停止，没有产出`);
    }
  }
  return lines.join("\n");
}

/**
 * 打印一批后台任务通知行（前后留空行，与流式输出区隔）
 * @param {SubAgentNodeEvent[]} events - 节点终态事件
 * @returns {void}
 */
export function printTaskEventLines(events: SubAgentNodeEvent[]): void {
  console.log("");
  for (const event of events) {
    console.log(formatTaskEventLine(event));
  }
  console.log("");
}

/**
 * 打印已完成的后台任务通知（不注入历史）：仅会话退出路径使用——
 * 正常流程中事件由输入等待感知后统一收割（自动继续或下一回合开始注入），打印与注入恰好各一次
 * @param {ReplState} state - 会话状态
 * @returns {void}
 */
function flushBackgroundEvents(state: ReplState): void {
  const events = state.subAgentDispatcher?.drainEvents() ?? [];
  if (events.length > 0) {
    printTaskEventLines(events);
  }
}

/** 后台事件自动继续的连续轮数上限：防止「任务派任务」形成无人值守的自动链失控 */
export const MAX_AUTO_CONTINUE_TURNS = 3;

/**
 * 把一批后台终态事件打印通知行并注入历史（user 角色承载的系统通知），
 * 由回合开始收割与「自动继续达上限」两条路径共用
 * @param {ReplState} state - 会话状态
 * @param {SubAgentNodeEvent[]} events - 节点终态事件
 * @returns {void}
 */
export function ingestEvents(state: ReplState, events: SubAgentNodeEvent[]): void {
  printTaskEventLines(events);
  state.history.push({
    type: "message",
    role: "user",
    content: buildBackgroundNotice(events),
  });
}

/**
 * 回合开始安全点：收割后台任务终态事件，打印通知行并注入历史
 * 注入发生在 historyStart 记录之前——回合被取消回滚时通知保留，
 * 下一轮模型仍可见，事件不会因取消而丢失
 * @param {ReplState} state - 会话状态
 * @returns {void}
 */
export function ingestBackgroundEvents(state: ReplState): void {
  const events = state.subAgentDispatcher?.drainEvents() ?? [];
  if (events.length === 0) {
    return;
  }
  ingestEvents(state, events);
}

/**
 * 会话退出前等待后台任务：先 flush 已完成事件；仍有运行中任务时等待全部结束再退出，
 * 等待期间产生的终态事件最后统一打印（用户可再次 Ctrl+C 强制退出）
 * @param {ReplState} state - 会话状态
 * @returns {Promise<void>}
 */
export async function awaitBackgroundTasksOnExit(
  state: ReplState,
): Promise<void> {
  const dispatcher = state.subAgentDispatcher;
  if (!dispatcher) {
    return;
  }
  flushBackgroundEvents(state);
  if (!dispatcher.hasRunning()) {
    return;
  }
  console.log(
    pico.yellow(
      "存在运行中的后台任务，等待完成后再退出…（如需放弃等待请再按一次 Ctrl+C）",
    ),
  );
  await dispatcher.waitForAll();
  flushBackgroundEvents(state);
}

/** 输入等待结果：用户输入 / 后台事件唤醒 / 退出会话 */
export type ReplWaitOutcome =
  | { type: "input"; value: string }
  | { type: "background" }
  | { type: "exit" };

/**
 * 输入等待与后台事件的竞速：用户停在提示符纯等待时，后台任务完成即唤醒，
 * 打断输入等待（安全恢复终端）并交由主循环自动继续后续步骤
 *
 * 机制：
 * - 队列已有待处理事件 → 直接返回 background（不进入竞速）；
 * - 无运行中任务且队列空 → 纯输入等待（无未来事件，竞速无意义）；
 * - 否则构造 AbortController 竞速：输入先落定按输入/退出处理；
 *   事件先到则 abort 输入等待，草稿经 ReplInputAbortedError 捕获后存入
 *   state.pendingDraft，下一次输入等待预填还原；
 * - 非 TTY 环境（管道/CI）不竞速：后台事件仍在回合边界收割，行为与之前一致
 * @param {ReplState} state - 会话状态
 * @returns {Promise<ReplWaitOutcome>} 等待结果
 */
export async function waitForInputOrBackground(
  state: ReplState,
): Promise<ReplWaitOutcome> {
  const dispatcher = state.subAgentDispatcher;
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!dispatcher || !interactive) {
    const value = await readReplInput(state);
    return value === undefined ? { type: "exit" } : { type: "input", value };
  }
  // 队列已有事件（如上一回合结束后到达）：直接唤醒
  if (dispatcher.hasPendingEvents()) {
    return { type: "background" };
  }
  // 无运行中任务：不可能有新事件，纯输入等待（避免无谓的信号监听）
  if (!dispatcher.hasRunning()) {
    const value = await readReplInput(state);
    return value === undefined ? { type: "exit" } : { type: "input", value };
  }

  const abortController = new AbortController();
  let wakeInputWait!: () => void;
  const backgroundSignal = new Promise<void>((resolve) => {
    wakeInputWait = resolve;
  });
  state.backgroundWake = wakeInputWait;
  // 输入 promise 独立挂 no-op catch：竞速被 background 赢下后，
  // abort 造成的 ReplInputAbortedError / 迟到的 CancelError 不会变成未处理拒绝；
  // 草稿还原必须在 catch 回调内完成——abort 的拒绝是微任务，晚于 finally 执行
  const inputPromise = readReplInput(state, {
    signal: abortController.signal,
    initialInput: state.pendingDraft,
  });
  inputPromise.catch((err: unknown) => {
    if (err instanceof ReplInputAbortedError) {
      // 中断时用户可能已键入草稿：存入待还原槽，下一次输入等待预填
      state.pendingDraft = err.draft || state.pendingDraft;
    }
  });
  try {
    return await Promise.race([
      inputPromise.then(
        (value): ReplWaitOutcome =>
          value === undefined ? { type: "exit" } : { type: "input", value },
      ),
      backgroundSignal.then((): ReplWaitOutcome => ({ type: "background" })),
    ]);
  } finally {
    state.backgroundWake = undefined;
    // background 赢下竞速时打断输入行；输入已自行落定（提交/取消）则 abort 为空操作
    // （提交/取消路径的 settle 已移除 abort 监听，不会误触发）
    abortController.abort();
  }
}
