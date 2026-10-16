/**
 * 给 Promise 加超时：超时后以指定消息拒绝，原 Promise 的迟到结果被丢弃
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
  return (async () => {
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  })();
}
