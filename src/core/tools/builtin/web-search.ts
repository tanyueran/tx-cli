import type { Tool, ToolOutput } from "../types";

/** Exa 托管 MCP 服务的无状态端点：无需 initialize 握手，匿名可用（付费场景经 Authorization 请求头传 Key） */
const EXA_MCP_ENDPOINT = "https://mcp.exa.ai/mcp";

/** 单次搜索的请求级超时（毫秒）：需小于执行器 30s 兜底超时，留出结果处理余量 */
const SEARCH_TIMEOUT_MS = 25_000;

/** 返回结果条数缺省值 */
const DEFAULT_NUM_RESULTS = 8;

/** 返回结果条数上限：防止结果过多撑爆上下文 */
const MAX_NUM_RESULTS = 10;

/**
 * 解析 JSON-RPC 响应：响应可能是纯 JSON，也可能是 SSE（event: message / data: {...} 行）
 * @param {string} text - 响应原始文本
 * @returns {any} 解析出的 JSON-RPC 响应对象
 * @throws {Error} 文本无法解析出含 result/error 的 JSON-RPC 响应时抛出
 */
function parseRpcResponse(text: string): any {
  if (!text.startsWith("event:")) {
    return JSON.parse(text);
  }
  // SSE 响应：逐行取 data: 载荷，命中首个含 result/error 的 JSON-RPC 响应即返回
  const dataLines = text.split("\n").filter((line) => line.startsWith("data:"));
  for (const line of dataLines) {
    const json = JSON.parse(line.slice(5));
    if (
      json &&
      typeof json === "object" &&
      ("result" in json || "error" in json)
    ) {
      return json;
    }
  }
  throw new Error("SSE 响应中未找到 JSON-RPC 结果");
}

/**
 * 从 JSON-RPC 响应中提取文本结果：result.content 为文本块数组（"标题+URL+高亮"）
 * @param {any} json - JSON-RPC 响应对象
 * @returns {string} 拼接后的文本结果，无有效内容时为空串
 */
function extractContentText(json: any): string {
  const content = json?.result?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((block: any) => (typeof block?.text === "string" ? block.text : ""))
    .filter(Boolean)
    .join("\n");
}

/**
 * 内置工具：联网搜索最新信息
 * 走 Exa 托管的 MCP 服务（无状态端点），返回"标题+URL+内容摘要"形式的结果；
 * 适用于模型知识截止日期之后的问题与实时信息（天气、新闻、版本发布等）
 */
export const webSearchTool: Tool = {
  name: "web_search",
  description:
    '搜索互联网获取实时或最新信息（如天气、新闻、新版本发布等），返回"标题+URL+内容摘要"形式的结果',
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "搜索关键词，建议完整描述查询意图",
      },
      numResults: {
        type: "number",
        description: "返回结果条数（1-10），缺省 8",
      },
    },
    required: ["query"],
  },
  /**
   * 执行搜索：参数缺失、服务报错、网络异常均转为失败输出回传模型
   * 注意：JSON-RPC 消息体顶层不允许加自定义字段（如 exaApiKey），否则服务端报 -32700 解析错误
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {Promise<ToolOutput>} 搜索结果文本或失败说明
   */
  async execute(args: Record<string, unknown>): Promise<ToolOutput> {
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) {
      return { ok: false, output: "缺少必填参数 query（搜索关键词）" };
    }
    // 条数兜底：非法值回退缺省，并钳制在 1-10 之间
    let numResults = DEFAULT_NUM_RESULTS;
    if (
      typeof args.numResults === "number" &&
      Number.isFinite(args.numResults)
    ) {
      numResults = Math.min(
        Math.max(Math.trunc(args.numResults), 1),
        MAX_NUM_RESULTS,
      );
    }

    try {
      const res = await fetch(EXA_MCP_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
        },
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: {
            name: "web_search_exa",
            arguments: {
              query,
              type: "auto",
              numResults,
              livecrawl: "fallback",
            },
          },
        }),
      });

      const text = await res.text();
      if (!res.ok) {
        return {
          ok: false,
          output: `搜索服务返回 HTTP ${res.status}: ${text.slice(0, 200)}`,
        };
      }

      const json = parseRpcResponse(text);
      if (json.error) {
        return {
          ok: false,
          output: `搜索服务报错: ${json.error.message ?? JSON.stringify(json.error)}`,
        };
      }

      const output = extractContentText(json);
      if (!output) {
        return { ok: true, output: `未搜索到相关结果（关键词：${query}）` };
      }
      return { ok: true, output };
    } catch (err) {
      const message = (err as Error)?.message ?? String(err);
      return {
        ok: false,
        output: `网页搜索失败: ${message}（关键词：${query}）`,
      };
    }
  },
};
