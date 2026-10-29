import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type {
  ListRootsRequestSchema,
  Root as McpRoot,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { CliError } from "../../shared/errors";
import { withTimeout } from "../../shared/timeout";
import { getVersion } from "../../shared/paths";
import type { SandboxLevel } from "../sandbox/types";
import type { Tool } from "../tools/types";
import { createHttpTransport } from "./http";
import { createStdioTransport } from "./stdio";
import { createMcpTool } from "./tool-adapter";
import type { McpServerConfig, McpServerStatus } from "./types";

/** 下发给 MCP 服务器的目录白名单条目（MCP roots capability 的 Root 结构） */
export type { McpRoot };

/** 单服务器连接超时（毫秒）：覆盖建立传输、协议握手与首次工具列举 */
const CONNECT_TIMEOUT_MS = 10_000;

/** 传输工厂选项：把服务器配置翻译为 Transport 实例，测试可注入 InMemoryTransport */
export interface McpManagerOptions {
  createTransport?: (config: McpServerConfig) => Promise<Transport>;
  /**
   * 下发给支持 roots capability 服务器的目录白名单（file:// URI 列表）
   * 由装配层按沙箱档位生成（buildMcpRoots）；缺省时 roots/list 返回空列表
   */
  roots?: McpRoot[];
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
    let listRootsSchema: typeof ListRootsRequestSchema;
    try {
      ({ Client: ClientCtor } =
        await import("@modelcontextprotocol/sdk/client/index.js"));
      ({ ListRootsRequestSchema: listRootsSchema } =
        await import("@modelcontextprotocol/sdk/types.js"));
    } catch (err) {
      throw new CliError(
        `MCP SDK 加载失败：${
          err instanceof Error ? err.message : String(err)
        }，请确认依赖已安装`,
      );
    }
    this.statuses.length = 0;
    // 并发连接所有服务器
    const statuses = await Promise.all(
      [...this.servers.entries()].map(([name, config]) =>
        this.connectOne(name, config, ClientCtor, listRootsSchema),
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
   * @param {typeof ListRootsRequestSchema} listRootsSchema - roots/list 请求 schema
   * @returns {Promise<McpServerStatus>} 连接结果（失败时含原因）
   */
  private async connectOne(
    name: string,
    config: McpServerConfig,
    ClientCtor: typeof Client,
    listRootsSchema: typeof ListRootsRequestSchema,
  ): Promise<McpServerStatus> {
    const client = new ClientCtor(
      { name: "tx-cli", version: getVersion() },
      // 声明 roots capability：支持该协议的服务器（如 chrome-devtools-mcp）可经 roots/list 获取文件白名单
      { capabilities: { roots: {} } },
    );
    // 静态 roots：会话内工作区不变，不声明 listChanged，不做变更通知
    client.setRequestHandler(listRootsSchema, () => ({
      roots: this.options?.roots ?? [],
    }));
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
   * 否则按传输类型分派到 stdio.ts / http.ts 中各自的实现
   * @param {McpServerConfig} config - 服务器配置
   * @returns {Promise<Transport>} 就绪的传输实例
   */
  private async createTransportFor(
    config: McpServerConfig,
  ): Promise<Transport> {
    if (this.options?.createTransport) {
      return this.options.createTransport(config);
    }
    return config.type === "stdio"
      ? createStdioTransport(config)
      : createHttpTransport(config);
  }

  /**
   * 汇总全部已连接服务器的工具并适配为内部 Tool
   * 基于连接时缓存的远端定义；跨服务器同名工具保留先注册者并记入警告
   * @returns {{ tools: Tool[]; warnings: string[] }} 适配后的工具与去重警告
   */
  listTools(): { tools: Tool[]; warnings: string[] } {
    const tools: Tool[] = [];
    const warnings: string[] = [];
    const registeredToolNames = new Set<string>();
    for (const [serverName, mcpTools] of this.remoteTools) {
      const client = this.clients.get(serverName);
      if (!client) {
        continue;
      }
      for (const mcpTool of mcpTools) {
        const tool = createMcpTool(serverName, client, mcpTool);
        if (registeredToolNames.has(tool.name)) {
          warnings.push(`MCP 工具 ${tool.name} 跨服务器重名，已保留先注册者`);
          continue;
        }
        registeredToolNames.add(tool.name);
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

/**
 * realpath 的容错封装：路径不存在或不可解析时返回 undefined
 * @param {string} path - 目标路径
 * @returns {string | undefined} 规范化后的绝对路径
 */
function safeRealpath(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/**
 * 按沙箱档位构建下发给 MCP 服务器的 roots 列表（MCP roots capability）
 * read-only 档承诺全禁写，不下发任何目录（服务器回退自身默认白名单）；
 * 其余档位下发项目根与 OS 临时目录。路径经 realpath 规范化后转 file:// URL，
 * 避免 macOS 符号链接（/tmp → /private/tmp、/var → /private/var）导致服务器端前缀比对失配
 * @param {SandboxLevel | undefined} sandboxLevel - 沙箱档位；undefined 表示无沙箱会话，与 full-access 同权
 * @param {string} cwd - 项目根目录
 * @returns {McpRoot[]} roots 列表（uri 为 file:// URL）
 */
export function buildMcpRoots(
  sandboxLevel: SandboxLevel | undefined,
  cwd: string,
): McpRoot[] {
  if (sandboxLevel === "read-only") {
    return [];
  }
  const roots: McpRoot[] = [];
  const workspace = safeRealpath(cwd) ?? resolve(cwd);
  roots.push({ uri: pathToFileURL(workspace).href, name: "workspace" });
  const tmpDirPath = safeRealpath(tmpdir());
  if (tmpDirPath) {
    roots.push({ uri: pathToFileURL(tmpDirPath).href, name: "temp" });
  }
  return roots;
}
