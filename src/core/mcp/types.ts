/**
 * stdio 传输的 MCP 服务器配置：以本地子进程方式启动
 */
export interface StdioServerConfig {
  /** 传输类型：本地子进程 */
  type: "stdio";
  /** 启动命令，如 npx / node */
  command: string;
  /** 命令参数（字符串值支持 ${VAR} 环境变量展开） */
  args?: string[];
  /** 附加环境变量（值支持 ${VAR} 展开），与基础白名单环境合并后传给子进程 */
  env?: Record<string, string>;
}

/**
 * HTTP 传输的 MCP 服务器配置：连接远程服务器（Streamable HTTP）
 */
export interface HttpServerConfig {
  /** 传输类型：远程 HTTP */
  type: "http";
  /** 服务器地址（值支持 ${VAR} 展开） */
  url: string;
  /** 附加请求头（值支持 ${VAR} 展开），如 Authorization */
  headers?: Record<string, string>;
}

/** MCP 服务器配置：stdio 与 http 的判别联合 */
export type McpServerConfig = StdioServerConfig | HttpServerConfig;

/** MCP 服务器连接状态：connectAll 的结果单元，供横幅与 /mcp 展示 */
export interface McpServerStatus {
  /** 服务器名（配置中的键名） */
  name: string;
  /** 传输类型 */
  type: "stdio" | "http";
  /** 是否连接成功 */
  ok: boolean;
  /** 连接失败原因（ok 为 false 时存在） */
  error?: string;
  /** 已发现的工具数（失败时为 0） */
  toolCount: number;
}
