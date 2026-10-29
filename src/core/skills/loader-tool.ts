import { dirname } from "node:path";
import type { Tool, ToolOutput } from "../tools/types";
import type { SkillCatalog } from "./catalog";
import type { SkillMeta } from "./discovery";

/**
 * 单次返回的技能正文上限（字符数）
 * 留出余量给分页说明与依赖清单，避免整体输出撞上执行器 8KB 截断后丢失续读信息
 */
const MAX_SKILL_BODY_CHARS = 6_000;

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
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
    return { error: `参数 ${field} 必须是 >=1 的整数（按行计数，从 1 开始）` };
  }
  return { value };
}

/**
 * 创建 load_skill 内置工具：模型据 system prompt 中的元数据清单自主加载技能正文
 * 技能正文作为工具输出回传，复用 agentic loop 的现有机制；
 * 超长正文按行分页返回并给出续读 offset，依赖技能以元数据清单形式附带，避免模型逐个探查目录
 * @param {SkillCatalog} catalog - 启动时扫描得到的技能目录
 * @returns {Tool} 可直接并入会话工具列表的工具实例
 */
export function createLoadSkillTool(catalog: SkillCatalog): Tool {
  return {
    name: "load_skill",
    description:
      "加载指定技能手册的内容。当任务匹配某个技能的描述时，先调用本工具加载该手册，再按手册指引执行。超长正文按行分页返回（用 offset 续读），并附带 frontmatter 声明的依赖技能清单",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "技能名称，取自可用技能清单",
        },
        offset: {
          type: "number",
          description: "正文起始行号（从 1 开始），缺省为 1；用于读取分页后的后续内容",
        },
        limit: {
          type: "number",
          description: "最多返回的行数，缺省按单次字符上限自动分页",
        },
      },
      required: ["name"],
    },
    /**
     * 执行加载：参数缺失、技能不存在、读取失败均转为失败输出回传模型，由模型自行纠正
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {Promise<ToolOutput>} 技能正文（含依赖清单）或失败说明
     */
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return { ok: false, output: "缺少必填参数 name（技能名称）" };
      }
      const offsetResult = parseLineParam(args.offset, "offset");
      if ("error" in offsetResult) {
        return { ok: false, output: offsetResult.error };
      }
      const limitResult = parseLineParam(args.limit, "limit");
      if ("error" in limitResult) {
        return { ok: false, output: limitResult.error };
      }
      try {
        const body = await catalog.readRawBody(name);
        if (body === undefined) {
          const availableSkillNames =
            catalog
              .list()
              .map((skill) => skill.name)
              .join("、") || "（无）";
          return {
            ok: false,
            output: `未找到技能 ${name}，可用技能：${availableSkillNames}`,
          };
        }
        const meta = catalog.get(name);
        if (!meta) {
          return { ok: false, output: `未找到技能 ${name}` };
        }
        const lines = body.split("\n");
        const totalLines = lines.length;
        const requestedOffset = offsetResult.value ?? 1;
        if (requestedOffset > totalLines) {
          return {
            ok: false,
            output: `offset（${requestedOffset}）超出技能正文行数（共 ${totalLines} 行）`,
          };
        }
        // 按行累积内容，同时受 limit 行数与字符预算约束，确保输出留有余量给分页与依赖说明
        const startLine = requestedOffset;
        const endByLimit =
          limitResult.value === undefined
            ? totalLines
            : Math.min(startLine + limitResult.value - 1, totalLines);
        let text = "";
        let endLine = startLine - 1;
        for (let index = startLine - 1; index < endByLimit; index += 1) {
          const candidate = text ? `${text}\n${lines[index]}` : lines[index];
          if (candidate.length > MAX_SKILL_BODY_CHARS) {
            break;
          }
          text = candidate;
          endLine = index + 1;
        }
        if (endLine < startLine) {
          // 单行即超出字符预算：硬截断该行，续读转入下一行
          text = lines[startLine - 1].slice(0, MAX_SKILL_BODY_CHARS);
          endLine = startLine;
        }
        const parts = [`技能目录：${dirname(meta.path)}`, "", text];
        if (endLine < totalLines) {
          parts.push(
            "",
            `（技能正文共 ${totalLines} 行，已返回第 ${startLine}-${endLine} 行；续读请调用 load_skill(name="${name}", offset=${endLine + 1})）`,
          );
        }
        const requirements = meta.requires
          .map((depName) => catalog.get(depName))
          .filter((dep): dep is SkillMeta => dep !== undefined);
        if (requirements.length > 0) {
          parts.push("", "依赖技能（frontmatter requires，需要时用 load_skill 加载）：");
          for (const dep of requirements) {
            parts.push(`- ${dep.name}：${dep.description}（路径：${dep.path}）`);
          }
        }
        return { ok: true, output: parts.join("\n") };
      } catch (err) {
        return {
          ok: false,
          output: `加载技能 ${name} 失败: ${(err as Error).message}`,
        };
      }
    },
  };
}
