/**
 * cli/channels 模块：CLI 侧的会话通道实现
 * core 的会话机制只依赖 channels 接口，CLI 在此提供终端实现
 */
import type { SessionChannels } from "@tanyueran/agent-core";
import { CliInputChannel } from "./cli-input";
import { CliOutputChannel } from "./cli-output";
import { CliPromptChannel } from "./cli-prompt";

export { CliInputChannel } from "./cli-input";
export { CliOutputChannel } from "./cli-output";
export { CliPromptChannel } from "./cli-prompt";
export { askConfirm, askSelect, askText } from "./prompts-prompt";

/**
 * 创建 CLI 会话通道集合：终端输入、终端输出与 prompts 交互提示
 * @returns {SessionChannels} 会话通道集合
 */
export function createCliChannels(): SessionChannels {
  return {
    input: new CliInputChannel(),
    output: new CliOutputChannel(),
    prompt: new CliPromptChannel(),
  };
}
