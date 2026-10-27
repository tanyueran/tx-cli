import pico from "picocolors";
import { ask } from "../../shared/interactive-prompt";
import type { LlmConfig } from "./types";

/** 必填文本的统一校验：空白输入不允许通过 */
function required(userInput: string): true | string {
  return userInput?.trim() ? true : "不能为空";
}

/**
 * 首次使用的交互式引导：补全缺失的 LLM 配置（只负责收集答案，不落盘）
 * @param {Partial<LlmConfig>} partialConfig - 已解析出的部分配置，作为引导的默认值
 * @returns {Promise<LlmConfig>} 引导补全后的完整配置
 */
export async function runSetupWizard(
  partialConfig: Partial<LlmConfig>
): Promise<LlmConfig> {
  console.log(
    pico.yellow("首次使用需要配置大模型服务（支持任何 OpenAI 兼容接口）")
  );

  const answers = await ask([
    {
      type: "text",
      name: "apiKey",
      message: "API Key",
      initial: partialConfig.apiKey,
      validate: required,
    },
    {
      type: "text",
      name: "baseUrl",
      message: "Base URL（OpenAI 兼容接口地址）",
      initial: partialConfig.baseUrl,
      validate: required,
    },
    {
      type: "text",
      name: "model",
      message: "模型名称",
      initial: partialConfig.model,
      validate: required,
    },
  ]);

  return {
    apiKey: String(answers.apiKey).trim(),
    baseUrl: String(answers.baseUrl).trim(),
    model: String(answers.model).trim(),
  };
}
