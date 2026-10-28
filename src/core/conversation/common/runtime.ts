import { buildMcpRoots, connectMcpServers } from "../../mcp";
import type { McpConnectSummary, McpManager } from "../../mcp";
import { createSandboxContext } from "../../sandbox";
import type { SandboxCliOptions } from "../../sandbox";
import type { SandboxContext } from "../../sandbox/runtime/context";
import { setupSkillContext } from "./skill-context";
import type { SkillContext } from "./skill-context";

/**
 * 对话会话运行时：MCP 连接、沙箱上下文与技能装配结果的组合体
 * 随会话创建（createConversationRuntime）与释放（disposeConversationRuntime）
 */
export interface ConversationRuntime {
  /** MCP 连接管理器（禁用或无配置时为 undefined） */
  mcpManager: McpManager | undefined;
  /** 会话级沙箱上下文（未启用沙箱时为 undefined） */
  sandbox: SandboxContext | undefined;
  /** 技能装配结果（system 提示词、工具列表、技能目录、扫描警告） */
  skill: SkillContext;
  /** MCP 连接状态摘要（禁用或未配置服务器时为 undefined，就绪面板展示） */
  mcpSummary: McpConnectSummary | undefined;
  /** 装配阶段警告（沙箱装载、MCP 连接等），由 REPL 就绪面板统一展示 */
  bootWarnings: string[];
}

/** 会话装配选项：chat、agent 命令各自的模式差异项 */
export interface ConversationOptions {
  /** 是否启用 MCP 服务器（--no-mcp 关闭，缺省开启） */
  mcpEnabled: boolean;
  /** CLI 传入的沙箱选项（agent 命令的 --sandbox/--approval/--no-bash/--sandbox-missing），缺省按 env/配置装配 */
  cliSandboxOptions?: SandboxCliOptions;
  /** bash 工具是否装配；未指定时回退 cliSandboxOptions/配置默认，chat 模式固定传 false */
  bashEnabled?: boolean;
  /** 任务清单工具（write_todos）是否装配；agent 模式传 true，chat 模式不装配 */
  todosEnabled?: boolean;
  /** 写侧内置工具（write_file / edit_file）是否装配；未指定时装配，chat 模式固定传 false */
  writeToolsEnabled?: boolean;
}

/**
 * 装配对话会话运行时：创建沙箱上下文 → 连接 MCP 服务器（stdio 进程直启裸跑，审批/规则链控制其工具调用）→ 装配技能（提示词与工具列表）
 * 任一步失败时按相反顺序释放已建立的资源，避免 MCP stdio 子进程残留；
 * 成功后的释放由调用方经 disposeConversationRuntime 完成；
 * bash 工具按 bashEnabled 装配（chat 模式固定 false，agent 模式跟随 cliSandboxOptions/配置），
 * 写侧内置工具按 writeToolsEnabled 装配（chat 模式固定 false，只读语义不依赖沙箱配置），
 * 沙箱上下文始终按配置装配（承担只读工具的 fs 门卫）；
 * 强制无 bash 的模式（chat）跳过 bash 专用装载（Provider）并抑制 bash 相关警告
 * @param {string} basePrompt - 场景基础提示词（chat、agent 等命令各自定义人设）
 * @param {ConversationOptions} options - 会话装配选项（MCP 开关、沙箱 CLI 选项、bash 开关、写侧工具开关）
 * @returns {Promise<ConversationRuntime>} 会话运行时
 */
export async function createConversationRuntime(
  basePrompt: string,
  options: ConversationOptions,
): Promise<ConversationRuntime> {
  const {
    sandbox,
    bashEnabled,
    warnings: sandboxWarnings,
  } = await createSandboxContext(options.cliSandboxOptions, {
    bashForcedOff: options.bashEnabled === false,
  });
  let mcpManager: McpManager | undefined;
  try {
    // roots 按沙箱档位联动：read-only 档不放权，其余下发项目根与 OS 临时目录
    const mcpConnectResult = await connectMcpServers(
      options.mcpEnabled,
      buildMcpRoots(sandbox?.level, sandbox?.rootDir ?? process.cwd()),
    );
    mcpManager = mcpConnectResult.manager;
    const skill = setupSkillContext({
      basePrompt,
      extraTools: mcpConnectResult.tools,
      sandbox,
      assembly: {
        bashEnabled: options.bashEnabled ?? bashEnabled,
        todosEnabled: options.todosEnabled,
        writeToolsEnabled: options.writeToolsEnabled,
      },
    });
    return {
      mcpManager,
      sandbox,
      skill,
      mcpSummary: mcpConnectResult.summary,
      bootWarnings: [...sandboxWarnings, ...mcpConnectResult.warnings],
    };
  } catch (err) {
    // 引导中途失败：已建立的资源立即释放，避免泄漏到顶层报错之后
    await mcpManager?.closeAll();
    await sandbox?.dispose();
    throw err;
  }
}

/**
 * 释放对话会话运行时：先断 MCP 连接（stdio 子进程随之退出）再关沙箱
 * 供调用方在 finally 中使用，异常路径同样释放
 * @param {ConversationRuntime} runtime - 会话运行时
 * @returns {Promise<void>}
 */
export async function disposeConversationRuntime(
  runtime: ConversationRuntime,
): Promise<void> {
  await runtime.mcpManager?.closeAll();
  await runtime.sandbox?.dispose();
}
