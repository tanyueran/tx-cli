import { readdir, stat } from "node:fs/promises";
import { resolveFromCwd } from "../../../shared/paths";
import type { Tool, ToolOutput } from "../types";

/**
 * 内置工具：列出目录内容（单层，不递归）
 * 目录名以 / 结尾，便于模型区分文件与目录；相对路径基于当前工作目录解析
 */
export const listDirTool: Tool = {
  name: "list_dir",
  description:
    "列出指定目录下的文件与子目录（单层，不递归），目录名以 / 结尾，便于了解目录结构",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "目录路径，相对路径基于当前工作目录；缺省为当前工作目录",
      },
    },
    required: [],
  },
  permission: {
    capabilities: ["fs.read"],
    /**
     * 生成规则键：以解析后的绝对目录为匹配主体
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string} 形如 list_dir(/abs/dir) 的规则键
     */
    ruleKey(args: Record<string, unknown>): string {
      const raw = typeof args.path === "string" ? args.path : "";
      return `list_dir(${resolveFromCwd(raw)})`;
    },
    /**
     * 声明本次列目录涉及的路径（门卫按档位禁读边界校验）
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string[]} 绝对路径列表
     */
    paths(args: Record<string, unknown>): string[] {
      const raw = typeof args.path === "string" ? args.path : "";
      return [resolveFromCwd(raw)];
    },
  },
  /**
   * 执行列目录：非目录、读取失败均转为失败输出回传模型
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {Promise<ToolOutput>} 目录条目列表或失败说明
   */
  async execute(args: Record<string, unknown>): Promise<ToolOutput> {
    const raw = typeof args.path === "string" ? args.path : "";
    const absolute = resolveFromCwd(raw);
    try {
      const info = await stat(absolute);
      if (!info.isDirectory()) {
        return { ok: false, output: `不是目录: ${absolute}` };
      }
      const dirents = await readdir(absolute, { withFileTypes: true });
      if (dirents.length === 0) {
        return { ok: true, output: `目录为空: ${absolute}` };
      }
      // 目录在前、文件在后，各自按名称排序，便于阅读
      const dirs = dirents
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => `${dirent.name}/`)
        .sort((a, b) => a.localeCompare(b));
      const files = dirents
        .filter((dirent) => dirent.isFile())
        .map((dirent) => dirent.name)
        .sort((a, b) => a.localeCompare(b));
      return { ok: true, output: [...dirs, ...files].join("\n") };
    } catch (err) {
      return {
        ok: false,
        output: `列出目录失败: ${(err as Error).message}（路径：${absolute}）`,
      };
    }
  },
};
