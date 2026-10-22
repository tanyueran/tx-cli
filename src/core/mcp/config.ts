import {
  readUserConfig,
  resolveUserConfigPath,
} from "../../shared/user-config";
import type {
  HttpServerConfig,
  McpServerConfig,
  StdioServerConfig,
} from "./types";

/** ${VAR} 形式的环境变量引用 */
const ENV_VAR_RE = /\$\{([^}]+)\}/g;

/** MCP 服务器加载结果：合法配置与各非法项的跳过原因 */
export interface McpServersResult {
  /** 服务器名 → 配置 */
  servers: Map<string, McpServerConfig>;
  /** 加载过程中的警告（文件损坏、非法项跳过原因等） */
  warnings: string[];
}

/**
 * 展开字符串中的 ${VAR} 环境变量引用
 * 未定义的变量展开为空串（与常见 shell 行为一致），不报错
 * @param {string} value - 待展开的字符串
 * @returns {string} 展开后的字符串
 */
function expandVars(value: string): string {
  return value.replace(ENV_VAR_RE, (_, name) => process.env[name] ?? "");
}

/**
 * 展开记录中所有字符串值的 ${VAR} 引用
 * @param {Record<string, string>} record - 待展开的键值对
 * @returns {Record<string, string>} 展开后的新记录
 */
function expandRecord(record: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    result[key] = expandVars(value);
  }
  return result;
}

/**
 * 判断值是否为「字符串键 → 字符串值」的普通对象
 * @param {unknown} value - 待判断的值
 * @returns {boolean} 是字符串记录时为 true
 */
function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((v) => typeof v === "string");
}

/**
 * 解析传输类型：显式 stdio/http 优先；缺省时按 command/url 字段推断（兼容 Claude Desktop 配置格式）
 * @param {Record<string, unknown>} record - 服务器配置的原始字段
 * @returns {"stdio" | "http" | undefined} 可识别的传输类型，无法识别时为 undefined
 */
function inferType(
  record: Record<string, unknown>,
): "stdio" | "http" | undefined {
  if (record.type === "stdio" || record.type === "http") {
    return record.type;
  }
  if (record.type === undefined) {
    if (typeof record.command === "string") {
      return "stdio";
    }
    if (typeof record.url === "string") {
      return "http";
    }
  }
  return undefined;
}

/**
 * 解析单个 stdio 服务器配置：校验必填项并对字符串值做 ${VAR} 展开
 * @param {string} name - 服务器名
 * @param {Record<string, unknown>} record - 原始字段
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {StdioServerConfig | undefined} 合法时返回配置，否则为 undefined
 */
function parseStdioServer(
  name: string,
  record: Record<string, unknown>,
  warnings: string[],
): StdioServerConfig | undefined {
  const { command, args, env } = record;
  if (typeof command !== "string" || !command.trim()) {
    warnings.push(`MCP 服务器 ${name} 缺少非空 command，已跳过`);
    return undefined;
  }
  if (
    args !== undefined &&
    (!Array.isArray(args) || args.some((a) => typeof a !== "string"))
  ) {
    warnings.push(`MCP 服务器 ${name} 的 args 必须是字符串数组，已跳过`);
    return undefined;
  }
  if (env !== undefined && !isStringRecord(env)) {
    warnings.push(
      `MCP 服务器 ${name} 的 env 必须是字符串到字符串的对象，已跳过`,
    );
    return undefined;
  }
  return {
    type: "stdio",
    command: expandVars(command),
    ...(args ? { args: (args as string[]).map(expandVars) } : {}),
    ...(env ? { env: expandRecord(env) } : {}),
  };
}

/**
 * 解析单个 http 服务器配置：校验必填项并对字符串值做 ${VAR} 展开
 * @param {string} name - 服务器名
 * @param {Record<string, unknown>} record - 原始字段
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {HttpServerConfig | undefined} 合法时返回配置，否则为 undefined
 */
function parseHttpServer(
  name: string,
  record: Record<string, unknown>,
  warnings: string[],
): HttpServerConfig | undefined {
  const { url, headers } = record;
  if (typeof url !== "string" || !url.trim()) {
    warnings.push(`MCP 服务器 ${name} 缺少非空 url，已跳过`);
    return undefined;
  }
  if (headers !== undefined && !isStringRecord(headers)) {
    warnings.push(
      `MCP 服务器 ${name} 的 headers 必须是字符串到字符串的对象，已跳过`,
    );
    return undefined;
  }
  return {
    type: "http",
    url: expandVars(url),
    ...(headers ? { headers: expandRecord(headers) } : {}),
  };
}

/**
 * 解析单个 MCP 服务器配置：识别传输类型后分派到对应的解析函数
 * @param {string} name - 服务器名
 * @param {unknown} raw - 原始配置值
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {McpServerConfig | undefined} 合法时返回配置，否则为 undefined
 */
function parseServer(
  name: string,
  raw: unknown,
  warnings: string[],
): McpServerConfig | undefined {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    warnings.push(`MCP 服务器 ${name} 的配置必须是对象，已跳过`);
    return undefined;
  }
  const record = raw as Record<string, unknown>;
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
 * @param {string} configPath - 配置文件路径（缺省 ~/.tx-cli/config.json，测试可注入）
 * @returns {McpServersResult} 服务器配置表与加载警告
 */
export function loadMcpServers(
  configPath: string = resolveUserConfigPath(),
): McpServersResult {
  const warnings: string[] = [];
  const servers = new Map<string, McpServerConfig>();
  const { data, warnings: readWarnings } = readUserConfig(configPath);
  warnings.push(...readWarnings);
  const { mcpServers } = data;
  if (mcpServers === undefined) {
    return { servers, warnings };
  }
  if (
    typeof mcpServers !== "object" ||
    mcpServers === null ||
    Array.isArray(mcpServers)
  ) {
    warnings.push(
      "配置文件 mcpServers 段必须是「服务器名 → 配置」的对象，已忽略全部 MCP 服务器",
    );
    return { servers, warnings };
  }
  for (const [name, raw] of Object.entries(mcpServers)) {
    if (!name.trim()) {
      warnings.push("MCP 服务器名不能为空，已跳过");
      continue;
    }
    const config = parseServer(name, raw, warnings);
    if (config) {
      servers.set(name, config);
    }
  }
  return { servers, warnings };
}
