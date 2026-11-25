/**
 * cli/conversation/agent：agent 命令的终端多轮任务入口
 * 模式配置与单次入口在 core（AGENT_MODE_CONFIG / runOneShotAgent），
 * 本模块只承载终端 REPL 薄包装
 */
import { AGENT_MODE_CONFIG } from "@tx-cli/core";
import type {
  LlmConfig,
  SandboxCliOptions,
  SessionChannels,
  ThinkingLevel,
} from "@tx-cli/core";
import { runReplConversation } from "./repl/repl";

/** runReplAgent 入参对象 */
interface ReplAgentOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 命令行指定的思考档位，未指定时回退配置默认 */
  thinkingLevel?: ThinkingLevel;
  /** 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启 */
  mcpEnabled?: boolean;
  /** CLI 传入的沙箱选项（--sandbox/--approval/--no-bash 等），缺省按配置文件装配 */
  cliSandboxOptions?: SandboxCliOptions;
  /** 会话通道集合：输入 / 输出 / 交互提示的抽象出口，由各端注入 */
  channels: SessionChannels;
}

/**
 * agent 命令的多轮任务模式（REPL 入口），会话循环复用终端 runReplConversation
 * @param {ReplAgentOptions} options - 入参对象（字段说明见接口定义）
 * @returns {Promise<void>}
 */
export async function runReplAgent({
  llmConfig,
  thinkingLevel,
  mcpEnabled = true,
  cliSandboxOptions,
  channels,
}: ReplAgentOptions): Promise<void> {
  await runReplConversation({
    llmConfig,
    modeConfig: AGENT_MODE_CONFIG,
    thinkingLevel,
    mcpEnabled,
    cliSandboxOptions,
    channels,
  });
}
