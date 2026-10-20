import { connectMcpServers } from "../../mcp";
import type { McpManager } from "../../mcp";
import { createSandboxContext } from "../../sandbox";
import type { SandboxCliOptions } from "../../sandbox";
import type { SandboxContext } from "../../sandbox/gate";
import type { Tool } from "../../tools";
import { setupSkillContext } from "./skill-context";
import type { SkillContext } from "./skill-context";

/**
 * 对话会话运行时：MCP 连接、沙箱上下文与技能装配结果的组合体
 * 随会话创建（createConversationRuntime）与释放（disposeConversationRuntime）
 */
export interface ConversationRuntime {
  /** MCP 连接管理器（禁用或无配置时为 undefined） */
  manager: McpManager | undefined;
  /** 会话级沙箱上下文（未启用沙箱时为 undefined） */
  sandbox: SandboxContext | undefined;
  /** MCP 适配后的工具（已并入 skill.tools，单独保留用于会话信息展示） */
  mcpTools: Tool[];
  /** 技能装配结果（system 提示词、工具列表、技能目录、扫描警告） */
  skill: SkillContext;
}

/**
 * 装配对话会话运行时：连接 MCP 服务器 → 创建沙箱上下文 → 装配技能（提示词与工具列表）
 * 任一步失败时按相反顺序释放已建立的资源，避免 MCP stdio 子进程残留；
 * 成功后的释放由调用方经 disposeConversationRuntime 完成
 * @param {string} basePrompt - 场景基础提示词（chat、agent 等命令各自定义人设）
 * @param {boolean} mcpEnabled - 是否启用 MCP 服务器（--no-mcp 关闭）
 * @param {SandboxCliOptions} sandboxCli - 沙箱 CLI 选项（--sandbox/--no-bash 等），缺省按配置文件装配
 * @returns {Promise<ConversationRuntime>} 会话运行时
 */
export async function createConversationRuntime(
  basePrompt: string,
  mcpEnabled: boolean,
  sandboxCli?: SandboxCliOptions,
): Promise<ConversationRuntime> {
  const { manager, tools: mcpTools } = await connectMcpServers(mcpEnabled);
  let sandbox: SandboxContext | undefined;
  try {
    sandbox = await createSandboxContext(sandboxCli);
    const skill = setupSkillContext(basePrompt, mcpTools, sandbox);
    return { manager, sandbox, mcpTools, skill };
  } catch (err) {
    // 引导中途失败：已建立的资源立即释放，避免泄漏到顶层报错之后
    await sandbox?.dispose();
    await manager?.closeAll();
    throw err;
  }
}

/**
 * 释放对话会话运行时：先关沙箱再断 MCP 连接（stdio 子进程随之退出）
 * 供调用方在 finally 中使用，异常路径同样释放
 * @param {ConversationRuntime} runtime - 会话运行时
 * @returns {Promise<void>}
 */
export async function disposeConversationRuntime(
  runtime: ConversationRuntime,
): Promise<void> {
  await runtime.sandbox?.dispose();
  await runtime.manager?.closeAll();
}
