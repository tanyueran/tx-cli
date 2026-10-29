import { createLoadSkillTool, discoverSkills, SkillCatalog } from "../../skills";
import {
  builtinTools,
  createTodoTool,
  WRITE_TOOL_NAMES,
  type Tool,
} from "../../tools";
import type { TodoToolHandle } from "../../tools";
import { createBashTool } from "../../tools/builtin/bash";
import { wrapToolWithPermission } from "../../tools/permission";
import type { SandboxContext } from "../../sandbox/runtime/context";
import { createMcpDiscoveryTool } from "../../mcp/discovery-tool";
import { buildSystemPrompt } from "./prompt";
import { CliError } from "../../../shared/errors";

/** MCP 工具内联下发阈值：超过该数量时折叠为 discover_mcp_tools 按需激活，避免每轮请求背负全部 schema */
export const MCP_INLINE_TOOL_LIMIT = 8;

/** 技能装配结果：system 提示词、工具列表、技能目录、扫描警告 */
export interface SkillContext {
  /** 组装后的 system 提示词（含技能元数据清单） */
  systemPrompt: string;
  /** 会话可执行工具列表（全量，含未激活的 MCP 工具）：内置工具 + load_skill + write_todos + bash + 外部工具 */
  tools: Tool[];
  /**
   * 下发给模型的工具清单：MCP 工具数超过 MCP_INLINE_TOOL_LIMIT 时折叠为 discover_mcp_tools，
   * 激活的工具被原地追加进本数组（与请求层共享引用），从下一轮起携带完整定义
   */
  advertisedTools: Tool[];
  /** 技能目录（/skills 内联命令展示用） */
  catalog: SkillCatalog;
  /** 扫描警告（启动时黄字提示） */
  scanWarnings: string[];
  /** bash 工具是否装配（/permissions 展示 Provider 行时区分「未装配」与「失败关闭」） */
  bashEnabled: boolean;
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
  /**
   * 写侧内置工具（write_file / edit_file）是否装配；缺省 true（由沙箱档位兜底），
   * chat 模式固定传 false，使只读语义不依赖沙箱配置（workspace-write / 沙箱关闭时同样不可写）
   */
  writeToolsEnabled?: boolean;
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
 * 工具来源固定拼接：内置工具（随版本发布，chat 模式剔除 write_file / edit_file）+ load_skill（仅存在技能时）+ write_todos（agent 模式）+ bash（沙箱启用且 bash 开关未关闭时）+ 外部工具（如 MCP），
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
  // chat 只读模式剔除写侧工具：使只读语义由代码保证，不随沙箱档位或沙箱开关变化
  const availableBuiltinTools =
    assembly?.writeToolsEnabled === false
      ? builtinTools.filter((tool) => !WRITE_TOOL_NAMES.has(tool.name))
      : builtinTools;
  const internalTools: Tool[] = [...availableBuiltinTools];
  if (skills.length > 0) {
    internalTools.push(createLoadSkillTool(catalog));
  }
  // 任务清单工具（write_todos）：agent 模式装配，工具实例闭包持有会话级清单状态（/todos 读取）
  if (assembly?.todosEnabled) {
    todoHandle = createTodoTool();
    internalTools.push(todoHandle.tool);
  }
  // bash 依赖沙箱执行：无沙箱或显式关闭（chat 模式 / --no-bash）时不装配
  const bashAssembled = sandbox !== undefined && (assembly?.bashEnabled ?? true);
  if (bashAssembled) {
    internalTools.push(createBashTool(sandbox));
  }
  ensureUniqueToolNames([...internalTools, ...extraTools]);
  /** 按会话沙箱策略包装单个工具：声明了 permission 的工具经 L2 规则判定 + L3 审批门卫（无沙箱时原样返回） */
  const gate = (tool: Tool): Tool =>
    sandbox ? wrapToolWithPermission(tool, sandbox) : tool;
  const gatedInternal = internalTools.map(gate);
  const gatedExtra = extraTools.map(gate);
  // 外部工具（MCP）超过阈值时折叠：常驻只下发 discover_mcp_tools，激活的工具经共享数组引用进入后续请求；
  // 执行侧始终持有全量工具（含未激活项），权限门卫与审批链不变
  const folded = gatedExtra.length > MCP_INLINE_TOOL_LIMIT;
  const advertisedTools: Tool[] = [...gatedInternal];
  if (folded) {
    advertisedTools.push(createMcpDiscoveryTool(gatedExtra, advertisedTools));
  } else {
    advertisedTools.push(...gatedExtra);
  }
  const tools = folded ? [...advertisedTools, ...gatedExtra] : advertisedTools;
  let systemPrompt = buildSystemPrompt(basePrompt, skills);
  if (folded) {
    systemPrompt += `\n\n外部 MCP 工具共 ${gatedExtra.length} 个，为节省上下文未全部展开定义；需要时先调用 discover_mcp_tools 检索目录并用 activate 激活目标工具，再按工具名调用。`;
  }
  return {
    systemPrompt,
    tools,
    advertisedTools,
    catalog,
    scanWarnings: skillWarnings,
    bashEnabled: bashAssembled,
    todoHandle,
  };
}
