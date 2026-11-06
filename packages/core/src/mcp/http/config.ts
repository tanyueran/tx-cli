import type { HttpServerConfig } from "../types";
import { expandRecord, expandVars, isStringRecord } from "../shared";

/**
 * 解析单个 http 服务器配置：校验必填项并对字符串值做 ${VAR} 展开
 * @param {string} name - 服务器名
 * @param {Record<string, unknown>} record - 原始字段
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {HttpServerConfig | undefined} 合法时返回配置，否则为 undefined
 */
export function parseHttpServer(
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
