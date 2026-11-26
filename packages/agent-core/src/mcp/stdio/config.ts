import type { StdioServerConfig } from "../types";
import { expandRecord, expandVars, isStringRecord } from "../shared";

/**
 * 解析单个 stdio 服务器配置：校验必填项并对字符串值做 ${VAR} 展开
 * @param {string} name - 服务器名
 * @param {Record<string, unknown>} record - 原始字段
 * @param {string[]} warnings - 警告收集器（就地追加）
 * @returns {StdioServerConfig | undefined} 合法时返回配置，否则为 undefined
 */
export function parseStdioServer(
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
    (!Array.isArray(args) || args.some((arg) => typeof arg !== "string"))
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
