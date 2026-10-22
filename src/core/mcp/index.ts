/**
 * core/mcp 模块的桶导出：对外统一入口
 * 说明：模块内部文件互相引用时，仍直接走具体文件
 */
export { loadMcpServers } from "./config";
export type { McpServersResult } from "./config";
export { McpManager } from "./manager";
export type { McpManagerOptions } from "./manager";
export { createMcpTool, MCP_TOOL_TIMEOUT_MS } from "./tool-adapter";
export { connectMcpServers } from "./setup";
export type { McpSetupResult } from "./setup";
export type {
  HttpServerConfig,
  McpServerConfig,
  McpServerStatus,
  StdioServerConfig,
} from "./types";
