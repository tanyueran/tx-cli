/**
 * conversation/session/background-events：后台子 Agent 终态事件的通用处理
 * 通知文本组装（注入历史）、通知行打印（语义化输出，无终端色码）与耗时格式化；
 * 各端（CLI / 桌面 / 云端）复用同一份事件口径，展示样式由各自 Channel 决定
 */
import type { OutputChannel } from "../../channels";
import type { SubAgentNodeEvent } from "../sub-agent/dispatcher";

/** 后台结论注入历史的截断上限：超长结论只注入前若干字，全文用 task_status 收割 */
const NOTICE_OUTPUT_MAX_CHARS = 4_000;

/**
 * 格式化连接耗时展示：不足 1 秒显示毫秒整数，达到 1 秒显示保留一位小数的秒
 * @param {number} ms - 耗时（毫秒）
 * @returns {string} 形如「820ms」「1.8s」的展示文本
 */
export function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
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
 * 打印一批后台任务通知行（前后留空行，与流式输出区隔）：
 * 完成走 system（信息行），失败 / 停止走 warn（警告行），颜色由各端 Channel 映射
 * @param {SubAgentNodeEvent[]} events - 节点终态事件
 * @param {OutputChannel} output - 输出通道
 * @returns {void}
 */
export function printTaskEventLines(
  events: SubAgentNodeEvent[],
  output: OutputChannel,
): void {
  output.text("");
  for (const event of events) {
    const elapsed = formatElapsed(event.elapsedMs);
    if (event.kind === "completed") {
      output.system(
        `✓ 后台任务 ${event.nodeId} 完成（${elapsed}）：${event.preview} —— 结论 ${(event.output ?? "").length} 字，将自动带入对话`,
      );
    } else if (event.kind === "failed") {
      output.warn(
        `✗ 后台任务 ${event.nodeId} 失败（${elapsed}）：${event.error ?? "未知原因"}`,
      );
    } else {
      output.warn(`■ 后台任务 ${event.nodeId} 已停止（${elapsed}）：${event.preview}`);
    }
  }
  output.text("");
}
