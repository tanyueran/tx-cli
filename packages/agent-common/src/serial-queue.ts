/**
 * 串行执行队列：保证同一队列内的异步任务按提交顺序逐个执行
 * 前序失败不阻断后续（错误由各调用方自行处理）
 */
export class SerialQueue {
  /** 队列尾：始终指向最后一个已提交任务的完成 Promise */
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * 把函数排入队列，前序完成后再执行
   * @param {() => Promise<T>} task - 待串行执行的异步函数
   * @returns {Promise<T>} task 的执行结果
   */
  run<T>(task: () => Promise<T>): Promise<T> {
    const chained = this.tail.then(task, task);
    this.tail = chained.catch(() => undefined);
    return chained;
  }
}
