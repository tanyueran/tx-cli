/**
 * cli/conversation/repl/background：终端输入等待与后台事件的竞速唤醒
 * 输入采集（readReplInput，含输入历史与退出指令）与
 * waitForInputOrBackground（含被打断草稿的保存与还原）；
 * 后台事件的收割、历史注入与退出等待由 core 的 ConversationSession 统一承担
 */
import pico from "picocolors";
import { CancelError } from "@tx-cli/shared";
import { InputAbortedError } from "@tx-cli/core";
import {
  filterInlineSkillSuggestions,
  filterSuggestions,
} from "./slash-commands";
import type { ReplState } from "./state";

/** 后台事件自动继续的连续轮数上限：防止「任务派任务」形成无人值守的自动链失控 */
export const MAX_AUTO_CONTINUE_TURNS = 3;

/** 输入等待的可选参数：中断信号与还原草稿（后台自动唤醒打断输入行时使用） */
interface ReplInputWaitOptions {
  /** 中断信号：后台事件唤醒时 abort，安全收尾输入组件并携带草稿 */
  signal?: AbortSignal;
  /** 初始草稿：预填输入行（还原上次被打断时用户未提交的内容） */
  initialInput?: string;
}

/**
 * 步骤一：采集一条用户输入（补全面板由输入通道实现）
 * Ctrl+C 取消输入视为正常退出；exit/quit 指令退出会话；输入行记入输入历史（上限 200 条）；
 * 输入等待被后台事件中断（InputAbortedError）时原样上抛，由输入等待方处理
 * @param {ReplState} state - 终端 REPL 状态
 * @param {ReplInputWaitOptions} [waitOptions] - 中断信号与还原草稿（可选）
 * @returns {Promise<string | undefined>} 用户输入；undefined 表示退出会话
 */
async function readReplInput(
  state: ReplState,
  waitOptions?: ReplInputWaitOptions,
): Promise<string | undefined> {
  const { input: inputChannel, output } = state.options.channels;
  let userInput: string;
  try {
    userInput = await inputChannel.readLine({
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
      output.warn("已退出对话");
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
    output.warn("已退出对话");
    return undefined;
  }
  return userInput;
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
 *   事件先到则 abort 输入等待，草稿经 InputAbortedError 捕获后存入
 *   state.pendingDraft，下一次输入等待预填还原；
 * - 非交互环境（管道/CI）不竞速：后台事件仍在回合边界收割，行为与之前一致
 * @param {ReplState} state - 终端 REPL 状态
 * @returns {Promise<ReplWaitOutcome>} 等待结果
 */
export async function waitForInputOrBackground(
  state: ReplState,
): Promise<ReplWaitOutcome> {
  const dispatcher = state.options.session.subAgentDispatcher;
  const interactive = state.options.channels.input.isInteractive();
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
  // abort 造成的 InputAbortedError / 迟到的 CancelError 不会变成未处理拒绝；
  // 草稿还原必须在 catch 回调内完成——abort 的拒绝是微任务，晚于 finally 执行
  const inputPromise = readReplInput(state, {
    signal: abortController.signal,
    initialInput: state.pendingDraft,
  });
  inputPromise.catch((err: unknown) => {
    if (err instanceof InputAbortedError) {
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
