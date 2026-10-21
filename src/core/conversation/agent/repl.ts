import { runReplConversation } from "../common";
import type { SandboxCliOptions } from "../../sandbox";
import type { LlmConfig, ThinkingLevel } from "../../../types/llm";
import { AGENT_MODE } from "./constants";

/**
 * 多轮任务模式（REPL，agent 命令的 Agent 模式入口）：全量工具带，bash 受沙箱与审批管控，
 * 沙箱档位与审批策略按 CLI/env/配置装配；会话循环复用 common 的 runReplConversation
 * @param {LlmConfig} config - LLM 接入配置
 * @param {ThinkingLevel | undefined} thinkingLevel - 命令行指定的思考档位，未指定时回退配置默认
 * @param {boolean} mcpEnabled - 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启
 * @param {SandboxCliOptions} sandboxCli - 沙箱 CLI 选项（--sandbox/--approval/--no-bash 等），缺省按配置文件装配
 * @returns {Promise<void>}
 */
export async function runReplAgent(
  config: LlmConfig,
  thinkingLevel?: ThinkingLevel,
  mcpEnabled = true,
  sandboxCli?: SandboxCliOptions,
): Promise<void> {
  await runReplConversation(config, AGENT_MODE, thinkingLevel, mcpEnabled, sandboxCli);
}
