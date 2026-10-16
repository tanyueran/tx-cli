import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { McpManager } from "../src/core/mcp";
import type { McpServerConfig } from "../src/core/mcp";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

/** callTool 处理器的简化签名：按工具名与参数返回输出块（text 为文本块，其余为合法的非文本块） */
type CallHandler = (
  name: string,
  args: Record<string, unknown>,
) => {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
};

/**
 * 启动一个内存 MCP 测试服务器并返回其客户端侧传输
 * @param {McpTool[]} tools - 服务器暴露的工具定义
 * @param {CallHandler} onCall - CallTool 请求处理器
 * @returns {Promise<Transport>} 已连接到服务器的客户端侧传输
 */
async function startServer(
  tools: McpTool[],
  onCall: CallHandler,
): Promise<Transport> {
  const server = new Server(
    { name: "test-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
  server.setRequestHandler(CallToolRequestSchema, (request) =>
    onCall(request.params.name, request.params.arguments ?? {}),
  );
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  return clientTransport;
}

/**
 * 生成简单的文本工具定义
 * @param {string} name - 工具名
 * @param {string} description - 工具描述
 * @returns {McpTool} 工具定义
 */
function textTool(name: string, description: string): McpTool {
  return {
    name,
    description,
    inputSchema: { type: "object", properties: {} },
  };
}

/**
 * 以注入传输工厂的方式构造管理器
 * @param {Record<string, McpServerConfig>} servers - 服务器配置表
 * @param {(config: McpServerConfig) => Promise<Transport>} factory - 服务器配置 → 客户端侧传输
 * @returns {McpManager} 就绪的管理器
 */
function createManager(
  servers: Record<string, McpServerConfig>,
  factory: (config: McpServerConfig) => Promise<Transport>,
): McpManager {
  return new McpManager(new Map(Object.entries(servers)), {
    createTransport: (config) => factory(config),
  });
}

describe("McpManager", () => {
  it("连接成功后 listTools 返回带 mcp__ 前缀的适配工具", async () => {
    const transport = await startServer(
      [textTool("echo", "回显输入"), textTool("calc", "计算器")],
      (name) => ({ content: [{ type: "text", text: `called ${name}` }] }),
    );
    const manager = createManager(
      { demo: { type: "http", url: "https://example.com" } },
      async () => transport,
    );

    const statuses = await manager.connectAll();
    const { tools, warnings } = manager.listTools();

    expect(statuses).toEqual([
      { name: "demo", type: "http", ok: true, toolCount: 2 },
    ]);
    expect(warnings).toEqual([]);
    expect(tools.map((t) => t.name)).toEqual([
      "mcp__demo__echo",
      "mcp__demo__calc",
    ]);
    expect(tools[0].description).toBe("[MCP:demo] 回显输入");
    expect(tools[0].timeoutMs).toBe(60_000);
    expect(tools[0].parameters).toEqual({
      type: "object",
      properties: {},
    });
    await manager.closeAll();
  });

  it("适配工具执行时调用远端 callTool 并拼接文本输出", async () => {
    const transport = await startServer(
      [textTool("echo", "回显输入")],
      (name, args) => ({
        content: [
          { type: "text", text: `tool=${name}` },
          { type: "text", text: `msg=${String(args.msg)}` },
        ],
      }),
    );
    const manager = createManager(
      { demo: { type: "http", url: "https://example.com" } },
      async () => transport,
    );
    await manager.connectAll();
    const [tool] = manager.listTools().tools;

    const output = await tool.execute({ msg: "hi" });

    expect(output).toEqual({ ok: true, output: "tool=echo\nmsg=hi" });
    await manager.closeAll();
  });

  it("远端返回 isError 或非文本块时转为失败结果或占位说明", async () => {
    const transport = await startServer(
      [textTool("boom", "失败工具"), textTool("mixed", "混合输出")],
      (name) => {
        if (name === "boom") {
          return {
            content: [{ type: "text", text: "服务器内部错误" }],
            isError: true,
          };
        }
        return {
          content: [
            { type: "text", text: "说明" },
            // 合法的图片块：SDK 会对 callTool 结果做 schema 校验，缺 data/mimeType 会被拒
            { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
          ],
        };
      },
    );
    const manager = createManager(
      { demo: { type: "http", url: "https://example.com" } },
      async () => transport,
    );
    await manager.connectAll();
    const [boom, mixed] = manager.listTools().tools;

    const failure = await boom.execute({});
    const mixedOutput = await mixed.execute({});

    expect(failure).toEqual({ ok: false, output: "服务器内部错误" });
    expect(mixedOutput).toEqual({
      ok: true,
      output: "说明\n（收到不支持的 image 类型输出）",
    });
    await manager.closeAll();
  });

  it("单服务器连接失败只记入状态，不阻塞其他服务器", async () => {
    const okTransport = await startServer(
      [textTool("ping", "探活")],
      () => ({ content: [{ type: "text", text: "pong" }] }),
    );
    const manager = createManager(
      {
        broken: { type: "stdio", command: "none" },
        healthy: { type: "http", url: "https://example.com" },
      },
      async (config) => {
        // 工厂按配置区分：stdio 侧模拟传输建立失败
        if (config.type === "stdio") {
          throw new Error("spawn 失败");
        }
        return okTransport;
      },
    );

    const statuses = await manager.connectAll();
    const { tools } = manager.listTools();

    expect(statuses).toHaveLength(2);
    expect(statuses.find((s) => s.name === "broken")).toMatchObject({
      ok: false,
      error: "spawn 失败",
      toolCount: 0,
    });
    expect(statuses.find((s) => s.name === "healthy")?.ok).toBe(true);
    expect(tools.map((t) => t.name)).toEqual(["mcp__healthy__ping"]);
    await manager.closeAll();
  });

  it("sanitize 后同名工具去重并告警，保留先注册者", async () => {
    const transport = await startServer(
      [textTool("echo.dot", "点号名"), textTool("echo_dot", "下划线名")],
      (name) => ({ content: [{ type: "text", text: name }] }),
    );
    const manager = createManager(
      { demo: { type: "http", url: "https://example.com" } },
      async () => transport,
    );
    await manager.connectAll();

    const { tools, warnings } = manager.listTools();

    expect(tools.map((t) => t.name)).toEqual(["mcp__demo__echo_dot"]);
    expect(tools[0].description).toBe("[MCP:demo] 点号名");
    expect(warnings.some((w) => w.includes("重名"))).toBe(true);
    await manager.closeAll();
  });

  it("closeAll 后不再暴露任何工具", async () => {
    const transport = await startServer(
      [textTool("echo", "回显输入")],
      () => ({ content: [{ type: "text", text: "ok" }] }),
    );
    const manager = createManager(
      { demo: { type: "http", url: "https://example.com" } },
      async () => transport,
    );
    await manager.connectAll();
    await manager.closeAll();

    expect(manager.listTools().tools).toEqual([]);
  });
});
