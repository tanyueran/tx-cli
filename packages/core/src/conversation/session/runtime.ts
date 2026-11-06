import { buildMcpRoots, connectMcpServers } from "../../mcp";
import type { McpConnectSummary, McpManager } from "../../mcp";
import { createSandboxContext } from "../../sandbox";
import type { SandboxCliOptions } from "../../sandbox";
import type { SandboxContext } from "../../sandbox/runtime/sandbox-context";
import { assembleSessionContext } from "./session-assembly";
import type { SessionAssembly } from "./session-assembly";

/**
 * 对话会话运行时：MCP 连接、沙箱上下文与会话装配结果的组合体
 * 随会话创建（createConversationRuntime）与释放（disposeConversationRuntime）
 */
export interface ConversationRuntime {
  /** MCP 连接管理器（禁用或无配置时为 undefined） */
  mcpManager: McpManager | undefined;
  /** 会话级沙箱上下文（未启用沙箱时为 undefined） */
  sandbox: SandboxContext | undefined;
  /** 会话装配结果（system 提示词、工具带、技能目录、扫描警告） */
  assembly: SessionAssembly;
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
  /** bash 工具是否装配，三态约定见 ConversationModeConfig.bashEnabled（runtime/mode.ts） */
  bashEnabled?: boolean;
  /** 任务清单工具（write_todos）是否装配；agent 模式传 true，chat 模式不装配 */
  todosEnabled?: boolean;
  /** 写侧内置工具（write_file / edit_file）是否装配；未指定时装配，chat 模式固定传 false */
  writeToolsEnabled?: boolean;
}

/**
 * 装配对话会话运行时：创建沙箱上下文 → 连接 MCP 服务器（stdio 进程直启裸跑，审批/规则链控制其工具调用）→ 装配会话（提示词与工具带）
 * 任一步失败时按相反顺序释放已建立的资源，避免 MCP stdio 子进程残留；
 * 成功后的释放由调用方经 disposeConversationRuntime 完成；
 * 工具带按模式裁剪：bash 与写侧内置工具的开关约定见 ConversationModeConfig（runtime/mode.ts），
 * 沙箱上下文始终按配置装配（承担只读工具的 fs 门卫）
 * @param {string} basePrompt - 场景基础提示词（chat、agent 等命令各自定义人设）
 * @param {ConversationOptions} options - 会话装配选项（MCP 开关、沙箱 CLI 选项、bash 开关、写侧工具开关）
 * @returns {Promise<ConversationRuntime>} 会话运行时
 */
export async function createConversationRuntime(
  basePrompt: string,
  options: ConversationOptions,
): Promise<ConversationRuntime> {
  // 创建沙箱上下文
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
    // 装配会话（提示词与工具带）
    const assembly = assembleSessionContext({
      basePrompt,
      extraTools: mcpConnectResult.tools,
      sandbox,
      assembly: {
        bashEnabled: options.bashEnabled ?? bashEnabled,
        todosEnabled: options.todosEnabled,
        writeToolsEnabled: options.writeToolsEnabled,
      },
    });
    // 沙箱未启用时写侧内置工具的权限门卫失效（L2 规则与 L3 审批依赖沙箱上下文，无沙箱时原样放行），
    // 与 agent 命令「默认 read-only 档」的宣称矛盾，装配期明确提示避免静默直通
    const bootWarnings = [...sandboxWarnings, ...mcpConnectResult.warnings];
    if (!sandbox && options.writeToolsEnabled !== false) {
      bootWarnings.push(
        "沙箱未启用（sandbox.enabled=false 且未传 --sandbox）：write_file / edit_file 将无隔离且不经审批直接生效，如需管控请启用沙箱或传 --sandbox <level>",
      );
    }
    return {
      mcpManager,
      sandbox,
      assembly,
      mcpSummary: mcpConnectResult.summary,
      bootWarnings,
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
