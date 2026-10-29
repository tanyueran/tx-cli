import type { Tool, ToolOutput } from "../tools/types";

/** 目录中单条工具描述的最大长度（超出截断，控制目录体积） */
const CATALOG_DESCRIPTION_LIMIT = 80;

/**
 * 截断目录用的工具描述：去换行并限制长度
 * @param {string} text - 工具描述原文
 * @returns {string} 单行、长度受限的描述
 */
function clipDescription(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > CATALOG_DESCRIPTION_LIMIT
    ? `${singleLine.slice(0, CATALOG_DESCRIPTION_LIMIT)}…`
    : singleLine;
}

/**
 * 创建 MCP 工具发现工具：检索目录并按需激活
 *
 * 背景：MCP 工具较多时全量下发定义会让每轮请求都背上大量 schema。
 * 折叠模式下只有本工具常驻下发，模型先检索目录、再用 activate 激活目标工具，
 * 被激活的工具对象会被推入 advertisedTools（与后续请求共享同一数组引用），
 * 从下一轮起携带完整定义；执行侧始终持有全量工具，权限链不变。
 * @param {Tool[]} pool - 全部可激活的 MCP 工具（已按会话安全策略包装）
 * @param {Tool[]} advertisedTools - 下发给模型的工具清单（激活时原地追加）
 * @returns {Tool} discover_mcp_tools 工具实例
 */
export function createMcpDiscoveryTool(
  pool: Tool[],
  advertisedTools: Tool[],
): Tool {
  return {
    name: "discover_mcp_tools",
    description:
      "检索并按需激活外部 MCP 工具。未激活的 MCP 工具不在可用工具列表中：先用 query/server 检索目录，再用 activate 激活目标工具（激活当次返回完整参数 schema），之后即可按工具名直接调用",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "关键词，匹配工具名与描述（不区分大小写），缺省列出全部",
        },
        server: {
          type: "string",
          description: "MCP 服务器名，精确过滤该服务器下的工具",
        },
        activate: {
          type: "array",
          items: { type: "string" },
          description:
            "要激活的工具完整名称数组；激活后下一轮请求即携带其完整定义，可直接调用",
        },
      },
      required: [],
    },
    /**
     * 检索目录或激活工具
     * @param {Record<string, unknown>} args - query/server/activate 参数
     * @returns {Promise<ToolOutput>} 目录清单或激活结果（含参数 schema）
     */
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const activate = Array.isArray(args.activate)
        ? args.activate.filter((name): name is string => typeof name === "string")
        : [];
      if (activate.length > 0) {
        const advertised = new Set(advertisedTools.map((tool) => tool.name));
        const lines: string[] = [];
        for (const name of activate) {
          const tool = pool.find((candidate) => candidate.name === name);
          if (!tool) {
            lines.push(`未找到工具：${name}（可先用 query 检索确认完整名称）`);
            continue;
          }
          lines.push(
            advertised.has(name)
              ? `已处于激活状态：${name}`
              : `已激活：${name}`,
          );
          if (!advertised.has(name)) {
            advertisedTools.push(tool);
            advertised.add(name);
          }
          lines.push(`参数 schema：${JSON.stringify(tool.parameters)}`);
        }
        lines.push("已激活的工具从下一轮请求起出现在可用工具列表中，可直接按名称调用。");
        return { ok: true, output: lines.join("\n") };
      }
      const query =
        typeof args.query === "string" ? args.query.trim().toLowerCase() : "";
      const server =
        typeof args.server === "string" ? args.server.trim() : "";
      const matched = pool.filter((tool) => {
        // 工具描述由适配器统一加 [MCP:服务器名] 前缀，据此做服务器精确过滤
        if (server && !tool.description.startsWith(`[MCP:${server}]`)) {
          return false;
        }
        if (!query) {
          return true;
        }
        return (
          tool.name.toLowerCase().includes(query) ||
          tool.description.toLowerCase().includes(query)
        );
      });
      if (matched.length === 0) {
        return { ok: true, output: "未匹配到 MCP 工具，请调整 query 或 server" };
      }
      const catalog = matched
        .map((tool) => `- ${tool.name}：${clipDescription(tool.description)}`)
        .join("\n");
      return {
        ok: true,
        output: `匹配到 ${matched.length}/${pool.length} 个 MCP 工具（定义默认不展开）：\n${catalog}\n\n需要调用时先激活：discover_mcp_tools({ "activate": ["工具完整名称"] })，激活后即可按名称直接调用`,
      };
    },
  };
}
