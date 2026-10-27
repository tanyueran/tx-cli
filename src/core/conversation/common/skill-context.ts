import { createLoadSkillTool, discoverSkills, SkillCatalog } from "../../skills";
import { builtinTools, createTodoTool, type Tool } from "../../tools";
import type { TodoToolHandle } from "../../tools";
import { createBashTool } from "../../tools/builtin/bash";
import { wrapToolWithPermission } from "../../tools/permission";
import type { SandboxContext } from "../../sandbox/runtime/context";
import { buildSystemPrompt } from "./prompt";
import { CliError } from "../../../shared/errors";

/** 技能装配结果：system 提示词、工具列表、技能目录、扫描警告 */
export interface SkillContext {
  /** 组装后的 system 提示词（含技能元数据清单） */
  systemPrompt: string;
  /** 会话可用工具列表：内置工具 + load_skill（存在技能时）+ write_todos（agent 模式）+ bash（沙箱启用时）+ 外部工具（如 MCP） */
  tools: Tool[];
  /** 技能目录（/skills 内联命令展示用） */
  catalog: SkillCatalog;
  /** 扫描警告（启动时黄字提示） */
  scanWarnings: string[];
  /** 任务清单工具句柄（write_todos 装配时存在，/todos 内联命令读取清单状态） */
  todoHandle?: TodoToolHandle;
}

/**
 * 校验工具名称唯一性
 * 重名是代码 bug（MCP 工具名已带 mcp__ 前缀隔离），直接抛错暴露而非静默覆盖
 * @param {Tool[]} tools - 待校验的工具列表
 * @returns {void}
 * @throws {CliError} 工具名重复时抛出
 */
function ensureUniqueToolNames(tools: Tool[]): void {
  const seenToolNames = new Set<string>();
  for (const tool of tools) {
    if (seenToolNames.has(tool.name)) {
      throw new CliError(`工具 ${tool.name} 名称重复`);
    }
    seenToolNames.add(tool.name);
  }
}

/** 技能装配选项：按模式裁剪工具带 */
export interface SkillAssemblyOptions {
  /** bash 工具是否装配；缺省 true（跟随沙箱存在性），chat 模式固定传 false */
  bashEnabled?: boolean;
  /** 任务清单工具（write_todos）是否装配；缺省 false，agent 模式传 true */
  todosEnabled?: boolean;
}

/** setupSkillContext 入参对象 */
export interface SetupSkillContextOptions {
  /** 场景基础提示词（chat、agent 等命令各自定义人设） */
  basePrompt: string;
  /** 追加并入的外部工具（如 MCP 工具，缺省为空） */
  extraTools?: Tool[];
  /** 会话级沙箱上下文（可选；存在时启用权限门卫） */
  sandbox?: SandboxContext;
  /** 装配选项（bash 开关、write_todos 开关等，缺省全部关闭/跟随沙箱） */
  assembly?: SkillAssemblyOptions;
}

/**
 * 发现技能并装配对话所需的提示词与工具列表
 * 工具来源固定拼接：内置工具（随版本发布）+ load_skill（仅存在技能时）+ write_todos（agent 模式）+ bash（沙箱启用且 bash 开关未关闭时）+ 外部工具（如 MCP），
 * 不再支持运行时动态注册工具；
 * 仅当存在可用技能时才装配 load_skill，避免空技能场景多下发一个无用工具定义；
 * 传入沙箱上下文时对声明了 permission 的工具做权限门卫包装（chat 模式只读工具继续受 fs 边界管控）
 * @param {SetupSkillContextOptions} options - 入参对象（basePrompt/extraTools/sandbox/assembly 字段说明见接口定义）
 * @returns {SkillContext} 装配结果
 */
export function setupSkillContext({
  basePrompt,
  extraTools = [],
  sandbox,
  assembly,
}: SetupSkillContextOptions): SkillContext {
  const { skills, warnings: skillWarnings } = discoverSkills();
  const catalog = new SkillCatalog(skills);
  let todoHandle: TodoToolHandle | undefined;
  const tools: Tool[] = [...builtinTools];
  if (skills.length > 0) {
    tools.push(createLoadSkillTool(catalog));
  }
  // 任务清单工具（write_todos）：agent 模式装配，工具实例闭包持有会话级清单状态（/todos 读取）
  if (assembly?.todosEnabled) {
    todoHandle = createTodoTool();
    tools.push(todoHandle.tool);
  }
  // bash 依赖沙箱执行：无沙箱或显式关闭（chat 模式 / --no-bash）时不装配
  if (sandbox && (assembly?.bashEnabled ?? true)) {
    tools.push(createBashTool(sandbox));
  }
  tools.push(...extraTools);
  ensureUniqueToolNames(tools);
  // 声明了 permission 的工具（如 bash）经 L2 规则判定 + L3 审批门卫包装
  const gatedTools = sandbox
    ? tools.map((tool) => wrapToolWithPermission(tool, sandbox))
    : tools;
  return {
    systemPrompt: buildSystemPrompt(basePrompt, skills),
    tools: gatedTools,
    catalog,
    scanWarnings: skillWarnings,
    todoHandle,
  };
}
