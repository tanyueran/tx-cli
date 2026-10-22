import pico from "picocolors";
import type { Tool } from "../tools/types";
import { printWarnings } from "../../shared/warnings";
import { loadMcpServers } from "./config";
import type { McpRoot } from "./manager";
import { McpManager } from "./manager";

/** connectMcpServers 的返回值：管理器供会话结束时关闭连接，工具供并入会话工具列表 */
export interface McpSetupResult {
  /** 已连接的管理器；禁用或无配置时为 undefined */
  manager: McpManager | undefined;
  /** 适配后的内部工具（禁用或无配置时为空数组） */
  tools: Tool[];
}

/**
 * 加载配置并连接全部 MCP 服务器，返回适配后的工具
 * 供 one-shot 与 repl 共用：禁用（--no-mcp）或未配置时直接返回空结果；
 * 配置警告与连接失败黄字提示、连接成功绿字提示
 * @param {boolean} enabled - 是否启用 MCP
 * @param {McpRoot[]} [roots] - 下发给服务器的目录白名单（MCP roots capability，按沙箱档位由装配层生成）
 * @returns {Promise<McpSetupResult>} 管理器与工具列表
 */
export async function connectMcpServers(
  enabled: boolean,
  roots?: McpRoot[],
): Promise<McpSetupResult> {
  if (!enabled) {
    return { manager: undefined, tools: [] };
  }
  const { servers, warnings } = loadMcpServers();
  printWarnings(warnings);
  if (servers.size === 0) {
    return { manager: undefined, tools: [] };
  }
  const manager = new McpManager(servers, { roots });
  const statuses = await manager.connectAll();
  const okCount = statuses.filter((status) => status.ok).length;
  if (okCount > 0) {
    const toolTotal = statuses.reduce(
      (sum, status) => sum + status.toolCount,
      0,
    );
    console.log(
      pico.green(
        `已连接 ${okCount}/${statuses.length} 个 MCP 服务器（${toolTotal} 个工具）`,
      ),
    );
  }
  for (const status of statuses) {
    if (!status.ok) {
      console.warn(
        pico.yellow(`MCP 服务器 ${status.name} 连接失败：${status.error}`),
      );
    }
  }
  const { tools, warnings: toolWarnings } = manager.listTools();
  printWarnings(toolWarnings);
  return { manager, tools };
}
