import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "../tools/types";

/** MCP 工具执行超时（毫秒）：外部工具可能涉及网络请求或子进程，比内置工具放宽 */
export const MCP_TOOL_TIMEOUT_MS = 60_000;

/** 工具名中的非法字符（除字母数字下划线连字符外全部替换） */
const UNSAFE_NAME_RE = /[^a-zA-Z0-9_-]/g;

/**
 * 净化名称中的非法字符：非字母数字下划线连字符一律替换为下划线；
 * 净化后为空串（原名称全为非法字符）时兜底为 unnamed，避免生成空段工具名
 * @param {string} name - 原始名称（服务器名或远端工具名）
 * @returns {string} 净化后的名称
 */
function sanitizeName(name: string): string {
  const sanitized = name.replace(UNSAFE_NAME_RE, "_");
  return sanitized || "unnamed";
}

/**
 * 判断值是否为普通对象（作为 inputSchema 的最低形状要求）
 * @param {unknown} value - 待判断的值
 * @returns {boolean} 是非 null、非数组的对象时为 true
 */
function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 把单个远端 MCP 工具适配为内部 Tool
 * 命名规则 mcp__<server>__<tool>，与内置工具天然隔离；描述带来源前缀帮助模型区分；
 * inputSchema 来自第三方进程且协议仅为约定：非法形状兜底为空对象 schema，
 * 避免非法定义一路透传到 LLM 请求时才炸出难懂的接口报错；
 * 声明 permission（整工具级规则键）：在 setupSkillContext 装配沙箱时经权限门卫包装，
 * 无沙箱会话（sandbox 为 undefined）不包装、行为不变
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
  const name = `mcp__${sanitizeName(serverName)}__${sanitizeName(mcpTool.name)}`;
  return {
    name,
    description: `[MCP:${serverName}] ${mcpTool.description ?? ""}`.trim(),
    parameters: isJsonObject(mcpTool.inputSchema)
      ? mcpTool.inputSchema
      : { type: "object", properties: {} },
    timeoutMs: MCP_TOOL_TIMEOUT_MS,
    permission: {
      // MCP 工具的真实能力未知（外部进程），按保守口径标注 net + exec；
      // 规则键为整工具级（无细粒度 spec），用户按 mcp__server__tool 粒度配置
      capabilities: ["net", "exec"],
      // 涉及外部副作用且默认走审批：判定+审批+执行进会话串行队列，
      // 避免同轮多调用并发弹审批窗交互错乱（与 bash 工具对齐）
      serial: true,
      /**
       * 生成规则键：整工具级（远端参数结构不可知，不做细粒度拆分）
       * @returns {string} 形如 mcp__server__tool 的规则键
       */
      ruleKey(): string {
        return name;
      },
    },
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
