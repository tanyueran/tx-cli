import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { CliError } from "../../shared/errors";
import { getVersion } from "../../shared/paths";
import type { Tool } from "../tools/types";
import { createMcpTool } from "./tool-adapter";
import type { McpServerConfig, McpServerStatus } from "../../types/mcp";

/** 单服务器连接超时（毫秒）：覆盖建立传输、协议握手与首次工具列举 */
const CONNECT_TIMEOUT_MS = 10_000;

/** 传输工厂选项：把服务器配置翻译为 Transport 实例，测试可注入 InMemoryTransport */
export interface McpManagerOptions {
  createTransport?: (config: McpServerConfig) => Promise<Transport>;
}

/**
 * 给 Promise 加超时：超时后以指定消息拒绝，原 Promise 的迟到结果被丢弃
 * @param {Promise<T>} promise - 受约束的 Promise
 * @param {number} timeoutMs - 超时毫秒数
 * @param {string} message - 超时时用于拒绝的错误消息
 * @returns {Promise<T>} 原结果或超时拒绝
 */
function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, timeoutMs);
  });
  return (async () => {
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  })();
}

/**
 * MCP 连接管理器：负责全部服务器的连接、工具列举与生命周期收尾
 * 单服务器失败只记入状态不阻塞其他服务器（失败隔离）
 */
export class McpManager {
  private readonly servers: Map<string, McpServerConfig>;
  private readonly options: McpManagerOptions | undefined;
  private readonly clients = new Map<string, Client>();
  /** 连接成功时缓存的远端工具定义：listTools 基于缓存适配，避免重复请求远端 */
  private readonly remoteTools = new Map<string, McpTool[]>();

  /** 各服务器最近一次连接的结果（供横幅与 /mcp 命令展示） */
  readonly statuses: McpServerStatus[] = [];

  /**
   * @param {Map<string, McpServerConfig>} servers - 服务器名 → 配置
   * @param {McpManagerOptions} [options] - 可选注入项（测试用）
   */
  constructor(
    servers: Map<string, McpServerConfig>,
    options?: McpManagerOptions,
  ) {
    this.servers = servers;
    this.options = options;
  }

  /**
   * 并发连接所有服务器
   * SDK 模块加载失败属于环境异常（依赖未安装），直接抛出；
   * 单个服务器连接失败仅记入状态，不阻塞其他服务器
   * @returns {Promise<McpServerStatus[]>} 每个服务器的连接结果
   * @throws {CliError} MCP SDK 加载失败时抛出
   */
  async connectAll(): Promise<McpServerStatus[]> {
    let ClientCtor: typeof Client;
    try {
      ({ Client: ClientCtor } = await import(
        "@modelcontextprotocol/sdk/client/index.js"
      ));
    } catch (err) {
      throw new CliError(
        `MCP SDK 加载失败：${
          err instanceof Error ? err.message : String(err)
        }，请确认依赖已安装`,
      );
    }
    this.statuses.length = 0;
    const statuses = await Promise.all(
      [...this.servers.entries()].map(([name, config]) =>
        this.connectOne(name, config, ClientCtor),
      ),
    );
    this.statuses.push(...statuses);
    return statuses;
  }

  /**
   * 连接单个服务器：建立传输 → 协议握手 → 列举工具，全程受连接超时约束
   * @param {string} name - 服务器名
   * @param {McpServerConfig} config - 服务器配置
   * @param {typeof Client} ClientCtor - SDK Client 构造器
   * @returns {Promise<McpServerStatus>} 连接结果（失败时含原因）
   */
  private async connectOne(
    name: string,
    config: McpServerConfig,
    ClientCtor: typeof Client,
  ): Promise<McpServerStatus> {
    const client = new ClientCtor({ name: "tx-cli", version: getVersion() });
    try {
      const transport = await this.createTransportFor(config);
      const { tools } = await withTimeout(
        (async () => {
          await client.connect(transport);
          return client.listTools();
        })(),
        CONNECT_TIMEOUT_MS,
        `连接超时（超过 ${CONNECT_TIMEOUT_MS / 1000} 秒）`,
      );
      this.clients.set(name, client);
      this.remoteTools.set(name, tools);
      return { name, type: config.type, ok: true, toolCount: tools.length };
    } catch (err) {
      // 尽力清理半开连接：close 自身失败可接受（对端已退出或网络已断）
      client.close().catch(() => {});
      return {
        name,
        type: config.type,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        toolCount: 0,
      };
    }
  }

  /**
   * 按配置创建传输：注入了 createTransport 时优先使用（测试）；
   * 否则 stdio 走本地子进程（环境变量与当前进程合并），http 走 Streamable HTTP
   * @param {McpServerConfig} config - 服务器配置
   * @returns {Promise<Transport>} 就绪的传输实例
   */
  private async createTransportFor(
    config: McpServerConfig,
  ): Promise<Transport> {
    if (this.options?.createTransport) {
      return this.options.createTransport(config);
    }
    if (config.type === "stdio") {
      const { StdioClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/stdio.js"
      );
      return new StdioClientTransport({
        command: config.command,
        ...(config.args ? { args: config.args } : {}),
        // 完整继承当前进程环境再叠加服务器私有变量，保证 PATH 等基础变量可用
        env: { ...(process.env as Record<string, string>), ...config.env },
      });
    }
    const { StreamableHTTPClientTransport } = await import(
      "@modelcontextprotocol/sdk/client/streamableHttp.js"
    );
    return new StreamableHTTPClientTransport(new URL(config.url), {
      ...(config.headers
        ? { requestInit: { headers: config.headers } }
        : {}),
    });
  }

  /**
   * 汇总全部已连接服务器的工具并适配为内部 Tool
   * 基于连接时缓存的远端定义；跨服务器同名工具保留先注册者并记入警告
   * @returns {{ tools: Tool[]; warnings: string[] }} 适配后的工具与去重警告
   */
  listTools(): { tools: Tool[]; warnings: string[] } {
    const tools: Tool[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    for (const [serverName, mcpTools] of this.remoteTools) {
      const client = this.clients.get(serverName);
      if (!client) {
        continue;
      }
      for (const mcpTool of mcpTools) {
        const tool = createMcpTool(serverName, client, mcpTool);
        if (seen.has(tool.name)) {
          warnings.push(`MCP 工具 ${tool.name} 跨服务器重名，已保留先注册者`);
          continue;
        }
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return { tools, warnings };
  }

  /**
   * 关闭所有已建立的连接（会话结束前调用）：单个关闭失败不影响其他服务器
   * @returns {Promise<void>}
   */
  async closeAll(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map((client) =>
        client.close().catch(() => {}),
      ),
    );
    this.clients.clear();
    this.remoteTools.clear();
  }
}
