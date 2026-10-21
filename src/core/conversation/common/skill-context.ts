import { createLoadSkillTool, discoverSkills, SkillCatalog } from "../../skills";
import { builtinTools, type Tool } from "../../tools";
import { createBashTool } from "../../tools/builtin/bash";
import { wrapToolWithPermission } from "../../tools/permission";
import type { SandboxContext } from "../../sandbox/gate";
import { buildSystemPrompt } from "./prompt";
import { CliError } from "../../../shared/errors";

/** 技能装配结果：system 提示词、工具列表、技能目录、扫描警告 */
export interface SkillContext {
  /** 组装后的 system 提示词（含技能元数据清单） */
  systemPrompt: string;
  /** 会话可用工具列表：内置工具 + load_skill（存在技能时）+ bash（沙箱启用且未关闭时）+ 外部工具（如 MCP） */
  tools: Tool[];
  /** 技能目录（/skills 内联命令展示用） */
  catalog: SkillCatalog;
  /** 扫描警告（启动时黄字提示） */
  warnings: string[];
}

/**
 * 校验工具名称唯一性
 * 重名是代码 bug（MCP 工具名已带 mcp__ 前缀隔离），直接抛错暴露而非静默覆盖
 * @param {Tool[]} tools - 待校验的工具列表
 * @returns {void}
 * @throws {CliError} 工具名重复时抛出
 */
function ensureUniqueToolNames(tools: Tool[]): void {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (seen.has(tool.name)) {
      throw new CliError(`工具 ${tool.name} 名称重复`);
    }
    seen.add(tool.name);
  }
}

/** 技能装配选项：按模式裁剪工具带 */
export interface SkillAssemblyOptions {
  /** bash 工具是否装配；缺省 true（跟随沙箱存在性），chat 模式固定传 false */
  bash?: boolean;
}

/**
 * 发现技能并装配对话所需的提示词与工具列表
 * 工具来源固定拼接：内置工具（随版本发布）+ load_skill（仅存在技能时）+ bash（沙箱启用且 bash 开关未关闭时）+ 外部工具（如 MCP），
 * 不再支持运行时动态注册工具；
 * 仅当存在可用技能时才装配 load_skill，避免空技能场景多下发一个无用工具定义；
 * 传入沙箱上下文时对声明了 permission 的工具做权限门卫包装（chat 模式只读工具继续受 fs 边界管控）
 * @param {string} basePrompt - 场景基础提示词（chat、agent 等命令各自定义人设）
 * @param {Tool[]} extraTools - 追加并入的外部工具（如 MCP 工具，缺省为空）
 * @param {SandboxContext} sandbox - 会话级沙箱上下文（可选；存在时启用权限门卫）
 * @param {SkillAssemblyOptions} opts - 装配选项（bash 开关等，缺省全部跟随沙箱）
 * @returns {SkillContext} 装配结果
 */
export function setupSkillContext(
  basePrompt: string,
  extraTools: Tool[] = [],
  sandbox?: SandboxContext,
  opts?: SkillAssemblyOptions,
): SkillContext {
  const { skills, warnings } = discoverSkills();
  const catalog = new SkillCatalog(skills);
  const tools: Tool[] = [...builtinTools];
  if (skills.length > 0) {
    tools.push(createLoadSkillTool(catalog));
  }
  // bash 依赖沙箱执行：无沙箱或显式关闭（chat 模式 / --no-bash）时不装配
  if (sandbox && (opts?.bash ?? true)) {
    tools.push(createBashTool(sandbox));
  }
  tools.push(...extraTools);
  ensureUniqueToolNames(tools);
  // 声明了 permission 的工具（如 bash）经 L2 规则判定 + L3 审批门卫包装
  const gated = sandbox
    ? tools.map((tool) => wrapToolWithPermission(tool, sandbox))
    : tools;
  return {
    systemPrompt: buildSystemPrompt(basePrompt, skills),
    tools: gated,
    catalog,
    warnings,
  };
}
