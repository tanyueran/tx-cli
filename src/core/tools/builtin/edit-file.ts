import { writeFile } from "node:fs/promises";
import { readTextFile } from "../../../shared/fs";
import { resolveFromCwd } from "../../../shared/paths";
import type { Tool, ToolOutput } from "../types";

/**
 * 解析并校验 edit_file 的 path 参数：必须为非空字符串
 * @param {Record<string, unknown>} args - 模型给出的参数
 * @returns {string} 解析后的绝对路径
 */
function parseEditPath(args: Record<string, unknown>): string {
  const raw = typeof args.path === "string" ? args.path.trim() : "";
  return resolveFromCwd(raw);
}

/**
 * 统计子串出现的次数（非重叠匹配）
 * @param {string} content - 被检索的完整文本
 * @param {string} needle - 目标子串（保证非空）
 * @returns {number} 出现次数
 */
function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * 内置工具：精确字符串替换编辑（edit_file）
 * old_string 必须与文件中唯一片段完全一致（含空白与缩进）方可替换：
 * 出现 0 次或多次都失败，迫使模型先 read_file 确认内容后再给出带上下文的唯一片段，
 * 避免误改；受沙箱可写边界管控（与 write_file 同口径）；
 * 串行执行（serial）：读-改-写流程并发会互相覆盖，进会话级队列依次执行
 */
export const editFileTool: Tool = {
  name: "edit_file",
  description:
    "编辑文本文件：把 old_string 精确替换为 new_string（一次一处）。" +
    "old_string 必须与文件内容完全一致（含空白、缩进与换行），且在文件中唯一出现，" +
    "否则失败；请先 read_file 查看原文，截取足够长的上下文片段保证唯一性。" +
    "创建新文件或整体重写请改用 write_file",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "目标文件路径，相对路径基于当前工作目录",
      },
      old_string: {
        type: "string",
        description: "被替换的原文片段（须与文件内容完全一致且唯一出现，非空）",
      },
      new_string: {
        type: "string",
        description: "替换后的新内容（与 old_string 相同时视为无效调用）",
      },
    },
    required: ["path", "old_string", "new_string"],
  },
  permission: {
    capabilities: ["fs.write"],
    /**
     * 生成规则键：以解析后的绝对路径为匹配主体
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string} 形如 edit_file(/abs/path) 的规则键
     */
    ruleKey(args: Record<string, unknown>): string {
      return `edit_file(${parseEditPath(args)})`;
    },
    /**
     * 声明本次编辑涉及的路径（门卫按档位可写边界校验）
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string[]} 绝对路径列表
     */
    paths(args: Record<string, unknown>): string[] {
      return [parseEditPath(args)];
    },
    serial: true,
  },
  /**
   * 调用提示渲染：只展示目标与替换规模，不回显新旧文本（避免长片段刷屏）
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {string} 展示文本
   */
  renderCall(args: Record<string, unknown>): string {
    const oldLen =
      typeof args.old_string === "string" ? args.old_string.length : 0;
    const newLen =
      typeof args.new_string === "string" ? args.new_string.length : 0;
    return `编辑 ${parseEditPath(args)}（old ${oldLen} 字符 → new ${newLen} 字符）`;
  },
  /**
   * 执行编辑：读取原文 → 唯一性校验 → 替换写回；
   * 参数无效、文件不存在、匹配不唯一等均转为失败输出回传模型自纠
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {Promise<ToolOutput>} 编辑结果摘要或失败说明
   */
  async execute(args: Record<string, unknown>): Promise<ToolOutput> {
    const raw = typeof args.path === "string" ? args.path.trim() : "";
    if (!raw) {
      return { ok: false, output: "缺少必填参数 path（文件路径）" };
    }
    if (typeof args.old_string !== "string" || args.old_string.length === 0) {
      return {
        ok: false,
        output: "缺少必填参数 old_string（须为非空的原文片段）",
      };
    }
    if (typeof args.new_string !== "string") {
      return {
        ok: false,
        output: "缺少必填参数 new_string（替换后的内容，可为空字符串表示删除片段）",
      };
    }
    if (args.old_string === args.new_string) {
      return {
        ok: false,
        output: "old_string 与 new_string 相同，无需编辑；请调整参数",
      };
    }
    const absolute = resolveFromCwd(raw);
    let content: string;
    try {
      // 复用 readTextFile 的大小上限与二进制判断（编辑同样受其约束）
      content = await readTextFile(absolute);
    } catch (err) {
      return {
        ok: false,
        output: `读取文件失败: ${(err as Error).message}（路径：${absolute}）`,
      };
    }
    const count = countOccurrences(content, args.old_string);
    if (count === 0) {
      return {
        ok: false,
        output:
          `old_string 未在 ${absolute} 中出现；` +
          "文件内容可能与预期不符，请先 read_file 查看原文后重试",
      };
    }
    if (count > 1) {
      return {
        ok: false,
        output:
          `old_string 在 ${absolute} 中出现 ${count} 次，无法唯一定位；` +
          "请扩大片段范围（带上前后行）使其唯一后重试",
      };
    }
    const next = content.replace(args.old_string, args.new_string);
    try {
      await writeFile(absolute, next, "utf-8");
      return {
        ok: true,
        output: `已编辑 ${absolute}：替换 1 处（${args.old_string.length} 字符 → ${args.new_string.length} 字符）`,
      };
    } catch (err) {
      return {
        ok: false,
        output: `写入文件失败: ${(err as Error).message}（路径：${absolute}）`,
      };
    }
  },
};
