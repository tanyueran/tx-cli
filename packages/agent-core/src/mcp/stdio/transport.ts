import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { StdioServerConfig } from "../types";

/**
 * stdio 服务器子进程继承的基础环境变量白名单
 * 不再全量继承 process.env，避免 LLM apiKey、shell 凭据等敏感变量
 * 暴露给第三方服务器进程；服务器需要额外变量时经配置的 env 段显式声明
 */
const MCP_BASE_ENV_KEYS = [
  "PATH",
  "HOME",
  "LANG",
  "TMPDIR",
  "TERM",
  "SHELL",
] as const;

/**
 * 构建 stdio 服务器子进程的环境变量：基础白名单 + 配置的私有变量
 * 配置 env 的 ${VAR} 引用已在配置装载阶段展开
 * @param {StdioServerConfig} config - 服务器配置
 * @returns {Record<string, string>} 子进程环境变量
 */
function buildServerEnv(config: StdioServerConfig): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of MCP_BASE_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...config.env };
}

/**
 * 创建 stdio 传输：以本地子进程方式直启服务器（不做沙箱包装，进程边界沿用主流 CLI 的信任模型——
 * 服务器由用户显式配置引入，属于信任边界之内；对模型行为的安全约束由工具审批规则链承担）。
 * 子进程环境变量为基础白名单 + 配置 env，避免把 shell 凭据等敏感变量全量暴露给第三方服务器；
 * 子进程 stderr 静默忽略，第三方服务器的 banner/免责声明不透传进终端，
 * 连接失败原因仍由 SDK 握手错误经连接状态提示
 * @param {StdioServerConfig} config - 服务器配置
 * @returns {Promise<Transport>} 就绪的传输实例
 */
export async function createStdioTransport(
  config: StdioServerConfig,
): Promise<Transport> {
  const { StdioClientTransport } =
    await import("@modelcontextprotocol/sdk/client/stdio.js");
  return new StdioClientTransport({
    command: config.command,
    ...(config.args ? { args: config.args } : {}),
    env: buildServerEnv(config),
    stderr: "ignore",
  });
}
