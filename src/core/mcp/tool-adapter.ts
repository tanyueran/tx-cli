import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "../tools/types";

/** MCP 工具执行超时（毫秒）：外部工具可能涉及网络请求或子进程，比内置工具放宽 */
export const MCP_TOOL_TIMEOUT_MS = 60_000;

/** 工具名中的非法字符（除字母数字下划线连字符外全部替换） */
const UNSAFE_NAME_RE = /[^a-zA-Z0-9_-]/g;

/**
 * 净化名称中的非法字符：非字母数字下划线连字符一律替换为下划线
 * @param {string} name - 原始名称（服务器名或远端工具名）
 * @returns {string} 净化后的名称
 */
function sanitizeName(name: string): string {
  return name.replace(UNSAFE_NAME_RE, "_");
}

/**
 * 把单个远端 MCP 工具适配为内部 Tool
 * 命名规则 mcp__<server>__<tool>，与内置工具天然隔离；描述带来源前缀帮助模型区分
 * @param {string} serverName - 所属服务器名（配置中的键名）
 * @param {Client} client - 已连接的服务器客户端
 * @param {McpTool} mcpTool - 远端工具定义
 * @returns {Tool} 适配后的内部工具
 */
export function createMcpTool(
  serverName: string,
  client: Client,
  mcpTool: McpTool,
): Tool {
  return {
    name: `mcp__${sanitizeName(serverName)}__${sanitizeName(mcpTool.name)}`,
    description: `[MCP:${serverName}] ${mcpTool.description ?? ""}`.trim(),
    parameters: mcpTool.inputSchema as Record<string, unknown>,
    timeoutMs: MCP_TOOL_TIMEOUT_MS,
    async execute(args) {
      const result = await client.callTool({
        name: mcpTool.name,
        arguments: args,
      });
      // content 类型在 SDK 中为 unknown，按结构收窄后提取文本块
      const blocks = (result.content ?? []) as Array<{
        type: string;
        text?: string;
      }>;
      const output = blocks
        .map((block) =>
          block.type === "text" && typeof block.text === "string"
            ? block.text
            : `（收到不支持的 ${block.type} 类型输出）`,
        )
        .join("\n");
      if (result.isError) {
        return { ok: false, output: output || "MCP 工具执行失败（无输出说明）" };
      }
      return { ok: true, output: output || "（无文本输出）" };
    },
  };
}
