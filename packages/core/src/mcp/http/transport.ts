import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { HttpServerConfig } from "../types";

/**
 * 创建 http 传输：走 SDK 的 Streamable HTTP 客户端，配置了 headers 时随请求下发
 * @param {HttpServerConfig} config - 服务器配置
 * @returns {Promise<Transport>} 就绪的传输实例
 */
export async function createHttpTransport(
  config: HttpServerConfig,
): Promise<Transport> {
  const { StreamableHTTPClientTransport } =
    await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  return new StreamableHTTPClientTransport(new URL(config.url), {
    ...(config.headers ? { requestInit: { headers: config.headers } } : {}),
  });
}
