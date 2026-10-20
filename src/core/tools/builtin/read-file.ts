import { readTextFile } from "../../../shared/fs";
import { resolveFromCwd } from "../../../shared/paths";
import type { Tool, ToolOutput } from "../types";

/**
 * 内置工具：读取文本文件内容
 * 相对路径基于当前工作目录解析
 */
export const readFileTool: Tool = {
  name: "read_file",
  description: "读取指定路径的文本文件内容，返回文件的完整文本",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "文件路径，相对路径基于当前工作目录",
      },
    },
    required: ["path"],
  },
  permission: {
    capabilities: ["fs.read"],
    /**
     * 生成规则键：以解析后的绝对路径为匹配主体
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string} 形如 read_file(/abs/path) 的规则键
     */
    ruleKey(args: Record<string, unknown>): string {
      const raw = typeof args.path === "string" ? args.path.trim() : "";
      return `read_file(${resolveFromCwd(raw)})`;
    },
    /**
     * 声明本次读取涉及的路径（门卫按档位禁读边界校验）
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string[]} 绝对路径列表
     */
    paths(args: Record<string, unknown>): string[] {
      const raw = typeof args.path === "string" ? args.path : "";
      return [resolveFromCwd(raw)];
    },
  },
  /**
   * 执行读取：参数缺失、文件过大、读取失败均转为失败输出回传模型
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {Promise<ToolOutput>} 文件内容或失败说明
   */
  async execute(args: Record<string, unknown>): Promise<ToolOutput> {
    const path = typeof args.path === "string" ? args.path.trim() : "";
    if (!path) {
      return { ok: false, output: "缺少必填参数 path（文件路径）" };
    }
    const absolute = resolveFromCwd(path);
    try {
      const content = await readTextFile(absolute);
      return { ok: true, output: content };
    } catch (err) {
      return {
        ok: false,
        output: `读取文件失败: ${(err as Error).message}（路径：${absolute}）`,
      };
    }
  },
};
