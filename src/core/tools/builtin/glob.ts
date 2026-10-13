import { stat } from "node:fs/promises";
import { walkDir } from "../../../shared/fs";
import { resolveFromCwd } from "../../../shared/paths";
import { globToRegExp } from "../../../shared/text";
import type { Tool, ToolOutput } from "../types";

/** 单次 glob 返回的最大文件数：防止结果过多撑爆上下文 */
const MAX_MATCHES = 200;

/**
 * 内置工具：按 glob 模式查找文件
 * 相对路径基于当前工作目录解析，默认跳过 node_modules 与 .git
 */
export const globTool: Tool = {
  name: "glob",
  description:
    "按 glob 模式查找文件，支持 ** 递归匹配、* 与 ?。返回匹配文件的相对路径（每行一个）",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "glob 模式，如 src/**/*.ts 或 **/*.json",
      },
      path: {
        type: "string",
        description:
          "查找的根目录，相对路径基于当前工作目录；缺省为当前工作目录",
      },
    },
    required: ["pattern"],
  },
  /**
   * 执行查找：模式缺失、根目录非法、遍历失败均转为失败输出回传模型
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {Promise<ToolOutput>} 匹配文件的相对路径列表或失败说明
   */
  async execute(args: Record<string, unknown>): Promise<ToolOutput> {
    const pattern = typeof args.pattern === "string" ? args.pattern.trim() : "";
    if (!pattern) {
      return { ok: false, output: "缺少必填参数 pattern（glob 模式）" };
    }
    const rawRoot = typeof args.path === "string" ? args.path : "";
    const root = resolveFromCwd(rawRoot);
    // 统一为正斜杠并去掉前导 ./，保证与相对路径的匹配口径一致
    const normalized = pattern.replace(/\\/g, "/").replace(/^\.\//, "");
    const regex = globToRegExp(normalized);
    try {
      const info = await stat(root);
      if (!info.isDirectory()) {
        return { ok: false, output: `不是目录: ${root}` };
      }
      const matches = (await walkDir(root))
        .filter((entry) => !entry.isDirectory && regex.test(entry.relativePath))
        .map((entry) => entry.relativePath)
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_MATCHES);
      if (matches.length === 0) {
        return { ok: true, output: `未匹配到文件（模式：${pattern}）` };
      }
      const truncated =
        matches.length >= MAX_MATCHES
          ? `\n...（仅展示前 ${MAX_MATCHES} 个匹配）`
          : "";
      return { ok: true, output: matches.join("\n") + truncated };
    } catch (err) {
      return {
        ok: false,
        output: `查找失败: ${(err as Error).message}（根目录：${root}）`,
      };
    }
  },
};
