import prompts from "prompts";
import { CancelError } from "./errors";

/**
 * prompts 的统一封装：用户取消（Ctrl+C / Esc）时抛出 CancelError
 * 说明：原生 prompts 被取消时只会返回缺字段的对象，调用方极易误把空值当成默认值继续执行
 * @param {prompts.PromptObject | prompts.PromptObject[]} questions - 问题配置
 * @returns {Promise<prompts.Answers<string>>} 用户的完整作答结果
 */
export async function ask(
  questions: prompts.PromptObject | prompts.PromptObject[]
): Promise<prompts.Answers<string>> {
  return prompts(questions, {
    onCancel: () => {
      throw new CancelError();
    },
  });
}

/**
 * 询问一个必填的文本值，空白输入会重新提示
 * @param {string} message - 提示文案
 * @returns {Promise<string>} 去除首尾空格后的非空字符串
 */
export async function askText(message: string): Promise<string> {
  const { value } = await ask({
    type: "text",
    name: "value",
    message,
    validate: (input: string) => (input?.trim() ? true : "不能为空"),
  });
  return String(value).trim();
}

/**
 * 从候选项中选择一项
 * @param {string} message - 提示文案
 * @param {Array<{ title: string; value: T }>} choices - 候选项列表
 * @returns {Promise<T>} 被选中的值
 */
export async function askSelect<T>(
  message: string,
  choices: { title: string; value: T }[]
): Promise<T> {
  const { value } = await ask({
    type: "select",
    name: "value",
    message,
    choices: choices as prompts.Choice[],
  });
  return value as T;
}

/**
 * 询问一个是/否确认
 * @param {string} message - 提示文案
 * @param {boolean} initial - 默认值
 * @returns {Promise<boolean>} 用户确认结果
 */
export async function askConfirm(
  message: string,
  initial = false
): Promise<boolean> {
  const { value } = await ask({
    type: "confirm",
    name: "value",
    message,
    initial,
  });
  return Boolean(value);
}
