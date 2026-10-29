import {
  readGlobalConfig,
  resolveGlobalConfigPath,
} from "../../shared/user-config";
import { parseHttpServer } from "./http";
import { inferType } from "./shared";
import { parseStdioServer } from "./stdio";
import type { McpServerConfig } from "./types";

/** MCP 服务器加载结果：合法配置与各非法项的跳过原因 */
export interface McpServersResult {
  /** 服务器名 → 配置 */
  servers: Map<string, McpServerConfig>;
  /** 加载过程中的警告（文件损坏、非法项跳过原因等） */
  warnings: string[];
}

/**
 * 解析单个 MCP 服务器配置：识别传输类型后分派到对应的解析函数
 * @param {string} name - 服务器名
 * @param {unknown} rawConfig - 原始配置值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {McpServerConfig | undefined} 合法时返回配置，否则为 undefined
 */
function parseServer(
  name: string,
  rawConfig: unknown,
  warnings: string[],
): McpServerConfig | undefined {
  if (
    typeof rawConfig !== "object" ||
    rawConfig === null ||
    Array.isArray(rawConfig)
  ) {
    warnings.push(`MCP 服务器 ${name} 的配置必须是对象，已跳过`);
    return undefined;
  }
  const record = rawConfig as Record<string, unknown>;
  const type = inferType(record);
  if (!type) {
    warnings.push(
      `MCP 服务器 ${name} 的 type 非法（需为 stdio 或 http，缺省时可按 command/url 推断），已跳过`,
    );
    return undefined;
  }
  return type === "stdio"
    ? parseStdioServer(name, record, warnings)
    : parseHttpServer(name, record, warnings);
}

/**
 * 从配置文件加载 MCP 服务器：读取 mcpServers 段并逐项校验
 * 文件读取与 JSON 解析由共享模块完成；单个服务器非法只跳过并记录警告，
 * 不影响其他服务器与整个会话（失败隔离）
 * @param {string} configPath - 配置文件路径
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {Map<string, McpServerConfig>} 服务器名 → 配置
 */
function loadServersFromFile(
  configPath: string,
  warnings: string[],
): Map<string, McpServerConfig> {
  const servers = new Map<string, McpServerConfig>();
  const { configData, warnings: readWarnings } = readGlobalConfig(configPath);
  warnings.push(...readWarnings);
  const { mcpServers } = configData;
  if (mcpServers === undefined) {
    return servers;
  }
  if (
    typeof mcpServers !== "object" ||
    mcpServers === null ||
    Array.isArray(mcpServers)
  ) {
    warnings.push(
      "配置文件 mcpServers 段必须是「服务器名 → 配置」的对象，已忽略全部 MCP 服务器",
    );
    return servers;
  }
  for (const [name, rawServerConfig] of Object.entries(mcpServers)) {
    if (!name.trim()) {
      warnings.push("MCP 服务器名不能为空，已跳过");
      continue;
    }
    const serverConfig = parseServer(name, rawServerConfig, warnings);
    if (serverConfig) {
      servers.set(name, serverConfig);
    }
  }
  return servers;
}

/** loadMcpServers 的入参 */
export interface LoadMcpServersOptions {
  /** 全局配置文件路径（缺省 ~/.tx-cli/config.json，测试可注入） */
  globalConfigPath?: string;
  /** 项目配置文件路径（缺省跳过项目层，生产由装配层传入，测试可注入） */
  projectConfigPath?: string;
}

/**
 * 从配置文件加载 MCP 服务器：全局 ~/.tx-cli/config.json 与项目 <cwd>/.tx-cli/config.json 两级合并，
 * 按服务器名合并，同名时项目配置覆盖全局并告警（与技能「项目级优先」语义一致）
 * @param {LoadMcpServersOptions} [options] - 全局/项目配置文件路径（均可注入以便测试）
 * @returns {McpServersResult} 服务器配置表与加载警告
 */
export function loadMcpServers({
  globalConfigPath = resolveGlobalConfigPath(),
  projectConfigPath,
}: LoadMcpServersOptions = {}): McpServersResult {
  const warnings: string[] = [];
  const servers = loadServersFromFile(globalConfigPath, warnings);
  if (projectConfigPath === undefined) {
    return { servers, warnings };
  }
  const projectServers = loadServersFromFile(projectConfigPath, warnings);
  if (projectServers.size > 0) {
    warnings.push(
      `已加载项目配置 ${projectConfigPath} 的 mcpServers（${projectServers.size} 个，与全局同名时以项目为准）`,
    );
  }
  for (const [name, config] of projectServers) {
    if (servers.has(name)) {
      warnings.push(
        `MCP 服务器 ${name} 在项目配置与全局配置中重复定义，已采用项目配置`,
      );
    }
    servers.set(name, config);
  }
  return { servers, warnings };
}
