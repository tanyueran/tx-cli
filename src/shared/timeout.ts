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
