import pico from "picocolors";
import { CliError } from "@tx-cli/shared";
import { isInBackgroundScope } from "@tx-cli/shared";
import type { SessionChannels } from "../../channels";
import type {
  ApprovalAskContext,
  ApprovalChoice,
  Approver,
} from "../types";

/** 后台任务触发交互审批时的统一失败说明（提示主 Agent 改用前台执行或调整审批策略） */
function backgroundApprovalRejected(): never {
  throw new CliError(
    "后台任务不支持交互审批（会与主会话输入抢终端）：" +
      "请前台同步执行该步骤，或调整审批策略（--approval）与沙箱档位（--sandbox）后重新派生",
  );
}

/**
 * 创建交互式审批器：问询文案经输出通道展示、选择经交互提示通道收集
 *
 * 各端注入各自的通道实现（CLI 用 prompts，桌面端用弹窗，云端用 WebSocket 往返），
 * core 的审批链路只依赖通道接口
 * @param {SessionChannels} channels - 会话通道集合
 * @returns {Approver} 交互式审批器
 */
export function createInteractiveApprover(channels: SessionChannels): Approver {
  const { output, prompt } = channels;
  return {
    /**
     * 征询命令审批：一次/本会话/始终/拒绝
     * MCP 工具改为服务器级粒度，避免同一服务器多个工具逐个弹窗
     * 后台任务作用域内直接失败（v1 不做审批排队），避免问询与 REPL 输入框抢 stdin
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
      if (isInBackgroundScope()) {
        backgroundApprovalRejected();
      }
      const mcpMeta = context?.mcp;
      output.text(
        pico.yellow(`\n${mcpMeta ? "MCP 工具" : "命令"}需要审批：${ruleKey}`),
      );
      output.text(pico.gray(`原因：${reason}`));
      if (mcpMeta) {
        const choice = await prompt.select<ApprovalChoice["kind"]>(
          "是否允许执行？",
          [
            { title: "本次允许", value: "once" },
            {
              title: `本会话允许服务器 ${mcpMeta.serverName} 的全部工具`,
              value: "session-server",
            },
            {
              title: `始终允许服务器 ${mcpMeta.serverName} 的全部工具（写入项目配置）`,
              value: "always-server",
            },
            { title: "拒绝执行", value: "deny" },
          ],
        );
        return { kind: choice };
      }
      const choice = await prompt.select<ApprovalChoice["kind"]>(
        "是否允许执行？",
        [
          { title: "本次允许", value: "once" },
          { title: "本会话内允许同类命令", value: "session" },
          { title: "始终允许同类命令（写入配置）", value: "always" },
          { title: "拒绝执行", value: "deny" },
        ],
      );
      return { kind: choice };
    },
    /**
     * 沙箱内失败后的升级问询
     * @param {string} commandText - 命令文本
     * @param {string} reason - 失败说明
     * @returns {Promise<boolean>} 批准脱离沙箱重跑时为 true
     */
    async askEscalation(
      commandText: string,
      reason: string,
    ): Promise<boolean> {
      if (isInBackgroundScope()) {
        backgroundApprovalRejected();
      }
      output.text(pico.yellow(`\n命令在沙箱内失败：${commandText}`));
      output.text(pico.gray(reason));
      return prompt.confirm("是否脱离沙箱重跑本次命令？（风险自担）", false);
    },
  };
}
