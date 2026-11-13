import pico from "picocolors";
import { CliError } from "@tx-cli/shared";
import type { SessionChannels } from "../channels";
import type { LlmConfig } from "./types";

/**
 * 首次使用的交互式引导：补全缺失的 LLM 配置（只负责收集答案，不落盘）
 *
 * 逐项经交互提示通道收集，各端可换成弹窗 / 表单 / WebSocket 往返；
 * 未提供通道时直接报错——core 不持有任何终端实现，无通道即无法完成引导
 * @param {Partial<LlmConfig>} partialConfig - 已解析出的部分配置，作为引导的默认值
 * @param {SessionChannels} [channels] - 会话通道集合（缺省时抛错）
 * @returns {Promise<LlmConfig>} 引导补全后的完整配置
 * @throws {CliError} 未提供会话通道时抛出
 */
export async function runSetupWizard(
  partialConfig: Partial<LlmConfig>,
  channels?: SessionChannels,
): Promise<LlmConfig> {
  if (!channels) {
    throw new CliError("缺少交互通道，无法完成首次使用配置向导");
  }

  const { prompt, output } = channels;
  output.text(
    pico.yellow("首次使用需要配置大模型服务（支持任何 OpenAI 兼容接口）"),
  );
  const apiKey = await prompt.input("API Key", partialConfig.apiKey);
  const baseUrl = await prompt.input(
    "Base URL（OpenAI 兼容接口地址）",
    partialConfig.baseUrl,
  );
  const model = await prompt.input("模型名称", partialConfig.model);
  return {
    apiKey: apiKey.trim(),
    baseUrl: baseUrl.trim(),
    model: model.trim(),
  };
}
