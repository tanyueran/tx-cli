import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { walkDir } from "../../../shared/fs";
import { resolveFromCwd } from "../../../shared/paths";
import { findTextMatches } from "../../../shared/text";
import type { Tool, ToolOutput } from "../types";

/** 最多返回的匹配行数：防止结果过多撑爆上下文 */
const MAX_MATCHES = 200;

/** 待搜索的文件目标 */
interface SearchTarget {
  /** 展示用路径（相对根目录，或单文件时的文件名） */
  relativePath: string;
  /** 读取用绝对路径 */
  absolutePath: string;
}

/**
 * 内置工具：按正则搜索文件内容
 * 返回 `相对路径:行号: 命中行` 形式的结果；相对路径基于当前工作目录解析，默认跳过 node_modules 与 .git
 */
export const grepTool: Tool = {
  name: "grep",
  description:
    "按正则在文件内容中搜索，返回 `文件路径:行号: 命中行` 形式的结果，用于定位代码位置",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "正则表达式（JavaScript 语法），如 function\\s+\\w+",
      },
      path: {
        type: "string",
        description:
          "搜索的文件或目录，相对路径基于当前工作目录；缺省为当前工作目录",
      },
      ignoreCase: {
        type: "boolean",
        description: "是否忽略大小写，缺省 false",
      },
    },
    required: ["pattern"],
  },
  permission: {
    capabilities: ["fs.read"],
    /**
     * 生成规则键：以搜索根路径为匹配主体（遍历以根为界）
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string} 形如 grep(/abs/path) 的规则键
     */
    ruleKey(args: Record<string, unknown>): string {
      const rawPath = typeof args.path === "string" ? args.path : "";
      return `grep(${resolveFromCwd(rawPath)})`;
    },
    /**
     * 声明本次搜索涉及的根路径（门卫按档位禁读边界校验）
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string[]} 绝对路径列表
     */
    paths(args: Record<string, unknown>): string[] {
      const rawPath = typeof args.path === "string" ? args.path : "";
      return [resolveFromCwd(rawPath)];
    },
  },
  /**
   * 执行搜索：正则非法、根路径非法、遍历失败均转为失败输出回传模型
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {Promise<ToolOutput>} 命中行列表或失败说明
   */
  async execute(args: Record<string, unknown>): Promise<ToolOutput> {
    const pattern = typeof args.pattern === "string" ? args.pattern : "";
    if (!pattern) {
      return { ok: false, output: "缺少必填参数 pattern（正则表达式）" };
    }
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, args.ignoreCase === true ? "i" : "");
    } catch (err) {
      return {
        ok: false,
        output: `正则表达式非法: ${(err as Error).message}`,
      };
    }

    const rawRoot = typeof args.path === "string" ? args.path : "";
    const root = resolveFromCwd(rawRoot);

    try {
      const stats = await stat(root);
      const targets: SearchTarget[] = stats.isDirectory()
        ? (await walkDir(root))
            .filter((fileEntry) => !fileEntry.isDirectory)
            .map((fileEntry) => ({
              relativePath: fileEntry.relativePath,
              absolutePath: join(root, fileEntry.relativePath),
            }))
        : [{ relativePath: basename(root), absolutePath: root }];

      const hitLines: string[] = [];
      for (const target of targets) {
        const remaining = MAX_MATCHES - hitLines.length;
        if (remaining <= 0) {
          break;
        }
        const matches = await findTextMatches(
          target.absolutePath,
          regex,
          remaining,
        );
        for (const match of matches) {
          hitLines.push(`${target.relativePath}:${match.line}: ${match.text}`);
        }
      }

      if (hitLines.length === 0) {
        return { ok: true, output: `未匹配到内容（正则：${pattern}）` };
      }
      const truncationNote =
        hitLines.length >= MAX_MATCHES
          ? `\n...（仅展示前 ${MAX_MATCHES} 条匹配）`
          : "";
      return { ok: true, output: hitLines.join("\n") + truncationNote };
    } catch (err) {
      return {
        ok: false,
        output: `搜索失败: ${(err as Error).message}（路径：${root}）`,
      };
    }
  },
};
