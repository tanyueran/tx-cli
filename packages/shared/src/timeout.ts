import { AsyncLocalStorage } from "node:async_hooks";

/**
 * 给 Promise 加超时：超时后以指定消息拒绝，原 Promise 的迟到结果被丢弃
 * 竞速败者的迟到拒绝会被显式吞掉（race 不会把败者标记为已处理），
 * 避免底层 Promise（如 MCP 连接/工具调用）稍后 reject 成为 unhandled rejection
 * 而在 Node ≥ 15 默认行为下直接崩溃进程
 * @param {Promise<T>} promise - 受约束的 Promise
 * @param {number} timeoutMs - 超时毫秒数
 * @param {string} message - 超时时用于拒绝的错误消息
 * @returns {Promise<T>} 原结果或超时拒绝
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
  // 空 catch 仅为把败者标记为已处理：不影响 race 的胜负结果，
  // 原 Promise 胜出时错误仍由 race 正常抛给调用方
  promise.catch(() => {});
  return (async () => {
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  })();
}

/** 可暂停的超时控制器：交互问询（审批等待）期间暂停计时，避免把用户思考时间计入超时 */
export interface PausableTimeoutController {
  /** 暂停计时（重复调用或已结束时为 no-op） */
  pause(): void;
  /** 恢复计时，按剩余时间重新起算（未暂停或已结束时为 no-op） */
  resume(): void;
}

/**
 * 工具执行链上的超时控制器存储：AsyncLocalStorage 按执行链隔离，
 * 并发执行的多个工具各自持有控制器，互不干扰；
 * 审批层（guard / askEscalation）据此暂停与恢复当前执行的计时
 */
const toolTimeoutStorage = new AsyncLocalStorage<PausableTimeoutController>();

/**
 * 给 Promise 加可暂停的超时：语义同 withTimeout，但把控制器绑定到本次执行的
 * 异步链上（AsyncLocalStorage），异步链内的审批层可在交互问询期间暂停计时，
 * 用户思考时间不计入超时；底层任务的实际执行仍受超时约束。
 * 注意：接收任务工厂而非 Promise 实例——任务必须在控制器上下文内创建并启动，
 * 其内部 await 延续才能继承上下文（提前创建的任务读不到控制器，暂停失效）
 * @param {() => Promise<T>} taskFactory - 任务工厂（在控制器上下文内调用）
 * @param {number} timeoutMs - 超时毫秒数（不含暂停期间）
 * @param {string} message - 超时时用于拒绝的错误消息
 * @returns {Promise<T>} 原结果或超时拒绝
 */
export function withPausableTimeout<T>(
  taskFactory: () => Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let remaining = timeoutMs;
  let startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let paused = false;
  let settled = false;
  let rejectTimeout!: (err: Error) => void;
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
    timer = setTimeout(() => rejectTimeout(new Error(message)), remaining);
  });
  const controller: PausableTimeoutController = {
    pause(): void {
      if (paused || settled) {
        return;
      }
      paused = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      remaining -= Date.now() - startedAt;
    },
    resume(): void {
      if (!paused || settled) {
        return;
      }
      paused = false;
      startedAt = Date.now();
      timer = setTimeout(
        () => rejectTimeout(new Error(message)),
        Math.max(remaining, 0),
      );
    },
  };
  return toolTimeoutStorage.run(controller, async () => {
    const promise = taskFactory();
    // 空 catch 仅为把败者标记为已处理，语义同 withTimeout
    promise.catch(() => {});
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
    }
  });
}

/**
 * 暂停当前工具执行的超时计时（审批问询前调用）
 * 当前异步链不在工具执行上下文内（无控制器）时为 no-op，不影响其他调用方
 * @returns {void}
 */
export function pauseToolTimeout(): void {
  toolTimeoutStorage.getStore()?.pause();
}

/**
 * 恢复当前工具执行的超时计时（审批问询结束后调用，按剩余时间重新起算）
 * 当前异步链不在工具执行上下文内（无控制器）时为 no-op
 * @returns {void}
 */
export function resumeToolTimeout(): void {
  toolTimeoutStorage.getStore()?.resume();
}
