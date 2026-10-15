import type { Tool, ToolOutput } from "../tools/types";
import type { SkillCatalog } from "./catalog";

/**
 * 创建 load_skill 内置工具：模型据 system prompt 中的元数据清单自主加载技能正文
 * 技能正文作为工具输出回传，复用 agentic loop 的现有机制，对话循环与执行器零改动
 * @param {SkillCatalog} catalog - 启动时扫描得到的技能目录
 * @returns {Tool} 可直接注册进 ToolRegistry 的工具实例
 */
export function createLoadSkillTool(catalog: SkillCatalog): Tool {
  return {
    name: "load_skill",
    description:
      "加载指定技能手册的完整内容。当任务匹配某个技能的描述时，先调用本工具加载该手册，再按手册指引执行",
    parameters: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: "技能名称，取自可用技能清单",
        },
      },
      required: ["name"],
    },
    /**
     * 执行加载：参数缺失、技能不存在、读取失败均转为失败输出回传模型，由模型自行纠正
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {Promise<ToolOutput>} 技能正文或失败说明
     */
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const name = typeof args.name === "string" ? args.name.trim() : "";
      if (!name) {
        return { ok: false, output: "缺少必填参数 name（技能名称）" };
      }
      try {
        const body = await catalog.readBody(name);
        if (body === undefined) {
          const available =
            catalog
              .list()
              .map((skill) => skill.name)
              .join("、") || "（无）";
          return {
            ok: false,
            output: `未找到技能 ${name}，可用技能：${available}`,
          };
        }
        return { ok: true, output: body };
      } catch (err) {
        return {
          ok: false,
          output: `加载技能 ${name} 失败: ${(err as Error).message}`,
        };
      }
    },
  };
}
