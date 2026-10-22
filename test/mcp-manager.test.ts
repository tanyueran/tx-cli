import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  CallToolRequestSchema,
  ListRootsResultSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMcpRoots, McpManager } from "../src/core/mcp";
import type { McpRoot, McpServerConfig } from "../src/core/mcp";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";

const { capturedStdioParams } = vi.hoisted(() => ({
  /** StdioClientTransport 桩捕获的构造参数（按调用顺序） */
  capturedStdioParams: [] as Array<{
    command: string;
    args?: string[];
    env?: Record<string, string>;
  }>,
}));

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  // 测试桩：只捕获构造参数不真正 spawn 子进程；start 即抛错使连接快速失败
  StdioClientTransport: class {
    /** 捕获的构造参数 */
    readonly captured: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };
    onclose?: () => void;
    onerror?: (error: Error) => void;
    onmessage?: (message: unknown) => void;

    /**
     * 记录构造参数供断言
     * @param {object} params - 传输构造参数
     */
    constructor(params: {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    }) {
      this.captured = params;
      capturedStdioParams.push(params);
    }

    /**
     * 启动即抛错：模拟子进程启动失败，使 connectAll 快速返回
     * @returns {Promise<void>} 永不 resolve
     */
    async start(): Promise<void> {
      throw new Error("测试桩：不真正启动子进程");
    }

    /**
     * 发送即抛错：测试桩不支持协议收发
     * @returns {Promise<void>} 永不 resolve
     */
    async send(): Promise<void> {
      throw new Error("测试桩：不支持发送");
    }

    /**
     * 关闭为空操作
     * @returns {Promise<void>}
     */
    async close(): Promise<void> {}
  },
}));

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

describe("McpManager 启动行为", () => {
  beforeEach(() => {
    capturedStdioParams.length = 0;
  });

  it("env 白名单：直启路径只透传基础白名单与配置 env，不继承其余 process.env", async () => {
    const prev = process.env.TX_TEST_SECRET;
    process.env.TX_TEST_SECRET = "s3cret";
    try {
      const manager = new McpManager(
        new Map<string, McpServerConfig>([
          [
            "demo",
            {
              type: "stdio",
              command: "demo-server",
              env: { NODE_TOKEN: "tok" },
            },
          ],
        ]),
      );

      await manager.connectAll();

      expect(capturedStdioParams).toHaveLength(1);
      expect(capturedStdioParams[0].command).toBe("demo-server");
      const env = capturedStdioParams[0].env ?? {};
      expect(env.PATH).toBe(process.env.PATH);
      expect(env.NODE_TOKEN).toBe("tok");
      expect(env.TX_TEST_SECRET).toBeUndefined();
    } finally {
      if (prev === undefined) {
        delete process.env.TX_TEST_SECRET;
      } else {
        process.env.TX_TEST_SECRET = prev;
      }
    }
  });
});

describe("MCP roots capability", () => {
  /**
   * 建立内存双端连接：返回服务器实例与已注入配置的管理器（工具列表为空即可）
   * @param {McpManagerOptions["roots"]} roots - 注入管理器的 roots 白名单
   * @returns {Promise<{ server: Server; manager: McpManager }>} 双端实例
   */
  async function setupRootsFixture(
    roots: McpRoot[],
  ): Promise<{ server: Server; manager: McpManager }> {
    const server = new Server(
      { name: "test-server", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [] }));
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const manager = new McpManager(
      new Map<string, McpServerConfig>([
        ["demo", { type: "http", url: "https://example.com" }],
      ]),
      { createTransport: async () => clientTransport, roots },
    );
    return { server, manager };
  }

  it("注入 roots 后服务器端经 roots/list 获取白名单", async () => {
    const roots: McpRoot[] = [
      { uri: "file:///tmp/workspace", name: "workspace" },
      { uri: "file:///private/tmp", name: "temp" },
    ];
    const { server, manager } = await setupRootsFixture(roots);
    await manager.connectAll();

    const result = await server.request(
      { method: "roots/list" },
      ListRootsResultSchema,
    );

    expect(result.roots).toEqual(roots);
    await manager.closeAll();
  });

  it("未注入 roots 时 roots/list 返回空列表", async () => {
    const { server, manager } = await setupRootsFixture([]);
    await manager.connectAll();

    const result = await server.request(
      { method: "roots/list" },
      ListRootsResultSchema,
    );

    expect(result.roots).toEqual([]);
    await manager.closeAll();
  });
});

describe("buildMcpRoots", () => {
  it("read-only 档不放权，返回空列表", () => {
    expect(buildMcpRoots("read-only", process.cwd())).toEqual([]);
  });

  it("workspace-write 档下发 realpath 规范化后的项目根与 OS 临时目录", () => {
    const roots = buildMcpRoots("workspace-write", process.cwd());

    expect(roots).toHaveLength(2);
    expect(roots[0]?.name).toBe("workspace");
    expect(roots[0]?.uri).toBe(pathToFileURL(realpathSync(process.cwd())).href);
    expect(roots[1]?.name).toBe("temp");
    expect(roots[1]?.uri).toBe(pathToFileURL(realpathSync(tmpdir())).href);
  });

  it("danger-full-access 与无沙箱（undefined）同权", () => {
    const full = buildMcpRoots("danger-full-access", process.cwd());
    const none = buildMcpRoots(undefined, process.cwd());

    expect(full).toEqual(none);
    expect(full).toHaveLength(2);
  });
});
