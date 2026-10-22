import pico from "picocolors";
import { askConfirm, askSelect } from "../../../shared/interactive-prompt";
import type {
  ApprovalAskContext,
  ApprovalChoice,
  Approver,
} from "../types";

/**
 * 交互式审批器：prompts 实现，供 TTY 环境使用
 */
export const interactiveApprover: Approver = {
  /**
   * 征询命令审批：一次/本会话/始终/拒绝
   * MCP 工具改为服务器级粒度（本会话/始终允许整个服务器），
   * 避免同一服务器多个工具逐个弹窗
   * @param {string} ruleKey - 规则键
   * @param {string} reason - 判定说明
   * @param {ApprovalAskContext} context - 问询上下文（MCP 工具时携带服务器信息）
   * @returns {Promise<ApprovalChoice>} 用户选择
   */
  async ask(
    ruleKey: string,
    reason: string,
    context?: ApprovalAskContext,
  ): Promise<ApprovalChoice> {
    const mcp = context?.mcp;
    console.log(
      pico.yellow(`\n${mcp ? "MCP 工具" : "命令"}需要审批：${ruleKey}`),
    );
    console.log(pico.gray(`原因：${reason}`));
    if (mcp) {
      const choice = await askSelect("是否允许执行？", [
        { title: "本次允许", value: "once" as const },
        {
          title: `本会话允许服务器 ${mcp.server} 的全部工具`,
          value: "session-server" as const,
        },
        {
          title: `始终允许服务器 ${mcp.server} 的全部工具（写入项目配置）`,
          value: "always-server" as const,
        },
        { title: "拒绝执行", value: "deny" as const },
      ]);
      return { kind: choice };
    }
    const choice = await askSelect("是否允许执行？", [
      { title: "本次允许", value: "once" as const },
      { title: "本会话内允许同类命令", value: "session" as const },
      { title: "始终允许同类命令（写入配置）", value: "always" as const },
      { title: "拒绝执行", value: "deny" as const },
    ]);
    return { kind: choice };
  },
  /**
   * 沙箱内失败后的升级问询
   * @param {string} commandText - 命令文本
   * @param {string} reason - 失败说明
   * @returns {Promise<boolean>} 批准脱离沙箱重跑时为 true
   */
  async askEscalation(commandText: string, reason: string): Promise<boolean> {
    console.log(pico.yellow(`\n命令在沙箱内失败：${commandText}`));
    console.log(pico.gray(reason));
    return askConfirm("是否脱离沙箱重跑本次命令？（风险自担）", false);
  },
};

/**
 * 判断当前环境是否可交互（TTY 且非 CI）
 * @returns {boolean} 可交互时为 true
 */
export function detectInteractive(): boolean {
  if (process.env.CI || process.env.TX_SANDBOX_HEADLESS) {
    return false;
  }
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}
