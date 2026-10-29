import { readTextFile, sliceLines } from "../../../shared/fs";
import { resolveFromCwd } from "../../../shared/paths";
import type { Tool, ToolOutput } from "../types";

/**
 * 解析可选的行范围参数：缺省或非法时返回错误说明
 * @param {unknown} value - 模型给出的原始参数值
 * @param {string} field - 参数名（用于错误提示）
 * @returns {{ value: number | undefined } | { error: string }} 解析结果
 */
function parseLineParam(
  value: unknown,
  field: string
): { value: number | undefined } | { error: string } {
  if (value === undefined) {
    return { value: undefined };
  }
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    return { error: `参数 ${field} 必须是 >=1 的整数（按行计数，从 1 开始）` };
  }
  return { value };
}

/**
 * 内置工具：读取文本文件内容
 * 相对路径基于当前工作目录解析；支持 offset/limit 按行分段读取大文件
 */
export const readFileTool: Tool = {
  name: "read_file",
  description:
    "读取指定路径的文本文件内容。默认返回全文；文件较大时用 offset（起始行，从 1 开始）与 limit（行数）分段读取，避免输出被截断",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "文件路径，相对路径基于当前工作目录",
      },
      offset: {
        type: "number",
        description: "起始行号（从 1 开始），缺省为 1",
      },
      limit: {
        type: "number",
        description: "最多读取的行数，缺省读到文件末尾",
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
      const rawPath = typeof args.path === "string" ? args.path.trim() : "";
      return `read_file(${resolveFromCwd(rawPath)})`;
    },
    /**
     * 声明本次读取涉及的路径（门卫按档位禁读边界校验）
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string[]} 绝对路径列表
     */
    paths(args: Record<string, unknown>): string[] {
      const rawPath = typeof args.path === "string" ? args.path : "";
      return [resolveFromCwd(rawPath)];
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
    const offsetResult = parseLineParam(args.offset, "offset");
    if ("error" in offsetResult) {
      return { ok: false, output: offsetResult.error };
    }
    const limitResult = parseLineParam(args.limit, "limit");
    if ("error" in limitResult) {
      return { ok: false, output: limitResult.error };
    }
    const offset = offsetResult.value;
    const limit = limitResult.value;
    const absolute = resolveFromCwd(path);
    try {
      const content = await readTextFile(absolute);
      // 未指定范围时保持原有行为：返回完整文本
      if (offset === undefined && limit === undefined) {
        return { ok: true, output: content };
      }
      const slice = sliceLines(content, offset ?? 1, limit);
      if (offset !== undefined && offset > slice.totalLines) {
        return {
          ok: false,
          output: `offset（${offset}）超出文件行数（共 ${slice.totalLines} 行，路径：${absolute}）`,
        };
      }
      const continueHint =
        slice.endLine < slice.totalLines
          ? `；续读请设 offset=${slice.endLine + 1}`
          : "";
      return {
        ok: true,
        output: `${slice.text}\n\n（第 ${slice.startLine}-${slice.endLine} 行，共 ${slice.totalLines} 行${continueHint}）`,
      };
    } catch (err) {
      return {
        ok: false,
        output: `读取文件失败: ${(err as Error).message}（路径：${absolute}）`,
      };
    }
  },
};
