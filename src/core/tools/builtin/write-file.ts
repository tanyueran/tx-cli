import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { resolveFromCwd } from "../../../shared/paths";
import type { Tool, ToolOutput } from "../types";

/**
 * 解析并校验 write_file 的 path 参数：必须为非空字符串
 * @param {Record<string, unknown>} args - 模型给出的参数
 * @returns {string} 解析后的绝对路径
 */
function parseWritePath(args: Record<string, unknown>): string {
  const rawPath = typeof args.path === "string" ? args.path.trim() : "";
  return resolveFromCwd(rawPath);
}

/**
 * 内置工具：创建或覆盖文本文件（write_file）
 * 写入完整内容，父目录不存在时自动创建；受沙箱可写边界管控
 * （read-only 档禁止一切写入，workspace-write 档限可写根内且禁写 .env/*.pem 等敏感模式）；
 * 串行执行（serial）：写文件是读-改-写类副作用操作，与 bash 一致进会话级队列，
 * 避免同轮多个写调用并发竞态
 */
export const writeFileTool: Tool = {
  name: "write_file",
  description:
    "创建或覆盖文本文件：写入完整内容（整体替换，非追加），父目录不存在时自动创建。" +
    "修改已有文件的小片段时优先改用 edit_file（精确字符串替换），避免整体覆盖引入意外改动",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "目标文件路径，相对路径基于当前工作目录",
      },
      content: {
        type: "string",
        description: "写入的完整文件内容（UTF-8 文本，空字符串表示清空文件）",
      },
    },
    required: ["path", "content"],
  },
  permission: {
    capabilities: ["fs.write"],
    /**
     * 生成规则键：以解析后的绝对路径为匹配主体
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string} 形如 write_file(/abs/path) 的规则键
     */
    ruleKey(args: Record<string, unknown>): string {
      return `write_file(${parseWritePath(args)})`;
    },
    /**
     * 声明本次写入涉及的路径（门卫按档位可写边界校验）
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string[]} 绝对路径列表
     */
    paths(args: Record<string, unknown>): string[] {
      return [parseWritePath(args)];
    },
    isSerial: true,
  },
  /**
   * 调用提示渲染：只展示目标与规模，不回显文件内容（避免长内容刷屏）
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {string} 展示文本
   */
  renderCall(args: Record<string, unknown>): string {
    const content = typeof args.content === "string" ? args.content : "";
    const existed = existsSync(parseWritePath(args));
    return `写入 ${parseWritePath(args)}（${
      existed ? "覆盖" : "新建"
    }，${content.length} 字符）`;
  },
  /**
   * 执行写入：参数校验失败、目录创建或写入失败均转为失败输出回传模型
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {Promise<ToolOutput>} 写入结果摘要或失败说明
   */
  async execute(args: Record<string, unknown>): Promise<ToolOutput> {
    const rawPath = typeof args.path === "string" ? args.path.trim() : "";
    if (!rawPath) {
      return { ok: false, output: "缺少必填参数 path（文件路径）" };
    }
    if (typeof args.content !== "string") {
      return { ok: false, output: "缺少必填参数 content（文件完整内容）" };
    }
    const absolute = resolveFromCwd(rawPath);
    try {
      const existed = existsSync(absolute);
      // 父目录不存在时递归创建：免去先 mkdir 的额外一轮调用
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, args.content, "utf-8");
      return {
        ok: true,
        output: `已${existed ? "覆盖" : "创建"}文件 ${absolute}（${args.content.length} 字符）`,
      };
    } catch (err) {
      return {
        ok: false,
        output: `写入文件失败: ${(err as Error).message}（路径：${absolute}）`,
      };
    }
  },
};
