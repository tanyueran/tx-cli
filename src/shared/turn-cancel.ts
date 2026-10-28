import { AsyncLocalStorage } from "node:async_hooks";
import { CancelError } from "./errors";

/** 回合取消状态：同轮工具执行链共享同一可变状态对象 */
interface TurnCancellationState {
  cancelled: boolean;
}

/**
 * 回合级取消状态存储：AsyncLocalStorage 按执行链隔离，
 * 每个 agentic 循环持有独立的取消状态，并发执行的多个工具链共享同一状态对象
 * （属性置位对所有子链可见），REPL 多轮之间互不影响
 */
const turnCancellationStorage = new AsyncLocalStorage<TurnCancellationState>();

/**
 * 在回合级取消上下文中运行回调：包裹整个 agentic 循环，
 * 任一工具链中的用户取消（CancelError）经 markTurnCancelled 置位后，
 * 同轮尚未启动的工具、串行队列中排队的任务与待审批的问询都会被
 * throwIfTurnCancelled 短路，实现「取消一轮即中止整轮」
 * @template T - 回调返回值类型
 * @param {() => Promise<T>} fn - 回调（整个 agentic 循环）
 * @returns {Promise<T>} 回调结果
 */
export async function runWithTurnCancellation<T>(
  fn: () => Promise<T>,
): Promise<T> {
  return turnCancellationStorage.run({ cancelled: false }, fn);
}

/**
 * 标记当前回合已取消：由捕获 CancelError 的回合层调用（loop 的工具执行 wrapper）
 * 当前执行链不在回合上下文内时为 no-op
 * @returns {void}
 */
export function markTurnCancelled(): void {
  const store = turnCancellationStorage.getStore();
  if (store) {
    store.cancelled = true;
  }
}

/**
 * 回合已取消时抛出 CancelError：用于串行队列的任务启动点（permission 层，
 * 阻止取消后同轮排队工具继续执行）与审批问询前（context 层，取消后不再弹新审批窗），
 * JS 无法终止已在执行的 Promise，正在执行的只读工具会照常完成但结果被丢弃
 * @returns {void}
 * @throws {CancelError} 当前回合已取消时抛出
 */
export function throwIfTurnCancelled(): void {
  if (turnCancellationStorage.getStore()?.cancelled) {
    throw new CancelError("回合已取消");
  }
}
