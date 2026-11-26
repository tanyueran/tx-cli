/**
 * CLI 交互提示通道：把 core 的 PromptChannel 接口落到 prompts 实现
 * 用户取消（Ctrl+C / Esc）时沿用 shared 的 CancelError 语义
 */
import type { PromptChannel } from "@tanyueran/agent-core";
import { askConfirm, askSelect, askText } from "./prompts-prompt";

/**
 * CLI 交互提示通道：确认、选择、文本输入三类问询
 */
export class CliPromptChannel implements PromptChannel {
  /**
   * 确认对话（是 / 否）
   * @param {string} message - 提示信息
   * @param {boolean} [initial] - 默认值（默认 false）
   * @returns {Promise<boolean>} 用户选择（true=是，false=否）
   */
  async confirm(message: string, initial = false): Promise<boolean> {
    return askConfirm(message, initial);
  }

  /**
   * 选择对话（从选项中选择一项）
   * @param {string} message - 提示信息
   * @param {Array<{ title: string; value: T }>} choices - 选项列表（value 可为任意类型）
   * @returns {Promise<T>} 用户选择的值
   */
  async select<T = string>(
    message: string,
    choices: Array<{ title: string; value: T }>,
  ): Promise<T> {
    return askSelect<T>(message, choices);
  }

  /**
   * 输入对话（自由文本输入，空白输入会重新提示）
   * @param {string} message - 提示信息
   * @param {string} [defaultValue] - 预填的默认值（回车直接采用）
   * @returns {Promise<string>} 用户输入的文本
   */
  async input(message: string, defaultValue?: string): Promise<string> {
    return askText(message, defaultValue);
  }
}
