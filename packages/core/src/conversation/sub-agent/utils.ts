/**
 * conversation/sub-agent/utils：子 Agent 模块的无副作用工具函数
 *
 * 提取自 attach.ts，供 attach / dispatcher / tools 共同引用，
 * 保持依赖方向 attach → dispatcher → types/utils，attach → tools → dispatcher。
 * 本文件只承载纯函数，不导入任何子 Agent 内部模块。
 */

/** 子任务预览的目标字符数（调度器的进度行、通知与状态列表共用） */
export const TASK_PREVIEW_CHARS = 80;

/**
 * 生成子任务预览：取首行并截断，用于调用提示与进度行
 * @param {unknown} rawTask - 模型给出的 task 参数
 * @returns {string} 预览文本（无有效任务时为空串）
 */
export function buildTaskPreview(rawTask: unknown): string {
  if (typeof rawTask !== "string") {
    return "";
  }
  const task = rawTask.trim();
  if (task.length <= TASK_PREVIEW_CHARS) {
    return task;
  }
  return `${task.slice(0, TASK_PREVIEW_CHARS)}…`;
}
