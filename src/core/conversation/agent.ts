/**
 * conversation/agent：agent 命令的任务执行能力（Agent 模式）
 * 模式差异收敛为 AGENT_MODE_CONFIG 配置，单次/多轮机制复用 common
 */
import { runOneShotConversation, runReplConversation } from "./common";
import type { ConversationModeConfig } from "./common/mode";
import type { SandboxCliOptions } from "../sandbox";
import type { LlmConfig, ThinkingLevel } from "../llm/types";

/** agent 命令的基础 system 提示词（人设），经 setupSkillContext 组装技能清单后下发 */
export const SYSTEM_PROMPT =
  "你是 tx-cli 的任务执行 Agent。收到任务后自主拆解步骤，按需使用工具（读写文件、" +
  "执行 bash 命令、检索、MCP）逐步完成；创建或修改文件优先使用 write_file / edit_file 工具" +
  "（精确、可审计），仅在这些工具不可用时才考虑 bash 重定向或 heredoc；" +
  "删除、覆盖、推送等高危操作先向用户确认；" +
  "对 3 步以上的任务，先调用 write_todos 建立任务清单，此后每完成一项更新一次清单" +
  "（全量替换，同一时刻仅一项 in_progress），简单任务不必使用；" +
  "完成后简要汇报：做了什么、改了哪些文件、遗留什么风险。";

/** agent 模式配置：任务执行人设，全量工具带（bash 跟随 cliSandboxOptions/配置装配，write_todos 开启），任务拆解步骤多故放宽到 20 轮 */
export const AGENT_MODE_CONFIG: ConversationModeConfig = {
  basePrompt: SYSTEM_PROMPT,
  modeLabel: "Agent 模式",
  maxIterations: 20,
  todosEnabled: true,
};

/** runOneShotAgent 入参对象 */
interface OneShotAgentOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 用户任务 */
  task: string;
  /** 命令行指定的思考档位，未指定时回退配置默认 */
  thinkingLevel?: ThinkingLevel;
  /** 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启 */
  mcpEnabled?: boolean;
  /** CLI 传入的沙箱选项（--sandbox/--approval/--no-bash 等），缺省按配置文件装配 */
  cliSandboxOptions?: SandboxCliOptions;
}

/**
 * 单次任务执行（agent 命令的 Agent 模式入口）：全量工具带，bash 受沙箱与审批管控；
 * 具体流程复用 common 的 runOneShotConversation
 * @param {OneShotAgentOptions} options - 入参对象（llmConfig/task/thinkingLevel/mcpEnabled/cliSandboxOptions 字段说明见接口定义）
 * @returns {Promise<void>}
 */
export async function runOneShotAgent({
  llmConfig,
  task,
  thinkingLevel,
  mcpEnabled = true,
  cliSandboxOptions,
}: OneShotAgentOptions): Promise<void> {
  await runOneShotConversation({
    llmConfig,
    modeConfig: AGENT_MODE_CONFIG,
    userInput: task,
    thinkingLevel,
    mcpEnabled,
    cliSandboxOptions,
  });
}

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
}

/**
 * 多轮任务模式（REPL，agent 命令的 Agent 模式入口）：全量工具带，bash 受沙箱与审批管控，
 * 沙箱档位与审批策略按 CLI/env/配置装配；会话循环复用 common 的 runReplConversation
 * @param {ReplAgentOptions} options - 入参对象（llmConfig/thinkingLevel/mcpEnabled/cliSandboxOptions 字段说明见接口定义）
 * @returns {Promise<void>}
 */
export async function runReplAgent({
  llmConfig,
  thinkingLevel,
  mcpEnabled = true,
  cliSandboxOptions,
}: ReplAgentOptions): Promise<void> {
  await runReplConversation({
    llmConfig,
    modeConfig: AGENT_MODE_CONFIG,
    thinkingLevel,
    mcpEnabled,
    cliSandboxOptions,
  });
}
