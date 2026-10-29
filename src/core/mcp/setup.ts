import type { Tool } from "../tools/types";
import {
  resolveGlobalConfigPath,
  resolveProjectConfigPath,
} from "../../shared/user-config";
import { loadMcpServers } from "./config";
import type { McpRoot } from "./manager";
import { McpManager } from "./manager";

/** MCP 连接状态摘要：就绪面板与连接耗时展示用 */
export interface McpConnectSummary {
  /** 连接成功的服务器数 */
  okCount: number;
  /** 配置的服务器总数 */
  totalCount: number;
  /** 全部服务器列举出的工具总数 */
  toolCount: number;
  /** 建连总耗时（毫秒，含传输建立、协议握手与首次工具列举） */
  elapsedMs: number;
}

/** connectMcpServers 的返回值：管理器供会话结束时关闭连接，工具供并入会话工具列表 */
export interface McpSetupResult {
  /** 已连接的管理器；禁用或无配置时为 undefined */
  manager: McpManager | undefined;
  /** 适配后的内部工具（禁用或无配置时为空数组） */
  tools: Tool[];
  /** 连接状态摘要；禁用或未配置服务器时为 undefined */
  summary: McpConnectSummary | undefined;
  /** 装配过程警告（配置解析、连接失败、工具列举），由调用方统一展示 */
  warnings: string[];
}

/**
 * 加载配置并连接全部 MCP 服务器，返回适配后的工具
 * 供 repl 会话装配共用：禁用（--no-mcp）或未配置时直接返回空结果；
 * 警告与连接摘要不做本地打印，统一交给调用方（REPL 就绪面板）展示
 * @param {boolean} enabled - 是否启用 MCP
 * @param {McpRoot[]} [roots] - 下发给服务器的目录白名单（MCP roots capability，按沙箱档位由装配层生成）
 * @returns {Promise<McpSetupResult>} 管理器、工具列表、连接摘要与装配警告
 */
export async function connectMcpServers(
  enabled: boolean,
  roots?: McpRoot[],
): Promise<McpSetupResult> {
  if (!enabled) {
    return { manager: undefined, tools: [], summary: undefined, warnings: [] };
  }
  // 加载 MCP 服务器
  const { servers, warnings } = loadMcpServers({
    globalConfigPath: resolveGlobalConfigPath(),
    projectConfigPath: resolveProjectConfigPath(process.cwd()),
  });
  if (servers.size === 0) {
    return { manager: undefined, tools: [], summary: undefined, warnings };
  }
  const manager = new McpManager(servers, { roots });
  const startedAt = Date.now();
  const statuses = await manager.connectAll();
  const elapsedMs = Date.now() - startedAt;
  const okCount = statuses.filter((status) => status.ok).length;
  const toolTotal = statuses.reduce((sum, status) => sum + status.toolCount, 0);
  for (const status of statuses) {
    if (!status.ok) {
      warnings.push(`MCP 服务器 ${status.name} 连接失败：${status.error}`);
    }
  }
  const { tools, warnings: toolWarnings } = manager.listTools();
  warnings.push(...toolWarnings);
  return {
    manager,
    tools,
    summary: {
      okCount,
      totalCount: statuses.length,
      toolCount: toolTotal,
      elapsedMs,
    },
    warnings,
  };
}
