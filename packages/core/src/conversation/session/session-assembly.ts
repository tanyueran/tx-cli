/**
 * 会话装配：发现技能并装配对话所需的 system 提示词与工具带
 * 工具带按「增量分段 + 统一合并」组织：各装配步骤只产出自己的工具片段，
 * 在 assembleSessionContext 统一合并为完整工具集；子 Agent 工具（delegate_task 等）
 * 由 attachSubAgentIfEnabled 在装配后增量并入两份列表
 */
import {
  createLoadSkillTool,
  discoverSkills,
  SkillCatalog,
} from "../../skills";
import {
  builtinTools,
  createTodoTool,
  WRITE_TOOL_NAMES,
  type Tool,
} from "../../tools";
import type { TodoToolHandle } from "../../tools";
import { createBashTool } from "../../tools/builtin/bash";
import { wrapToolWithPermission } from "../../tools/permission";
import type { SandboxContext } from "../../sandbox/runtime/sandbox-context";
import { createMcpDiscoveryTool } from "../../mcp/discovery-tool";
import { buildSystemPrompt } from "./prompt";
import { CliError } from "@tx-cli/shared";

/** MCP 工具内联下发阈值：超过该数量时折叠为 discover_mcp_tools 按需激活，避免每轮请求背负全部 schema */
export const MCP_INLINE_TOOL_LIMIT = 8;

/** 会话装配结果：system 提示词、工具带、技能目录、扫描警告 */
export interface SessionAssembly {
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

/** 会话工具带装配选项：按模式裁剪 */
export interface SessionAssemblyOptions {
  /** bash 工具是否装配；缺省 true（跟随沙箱存在性），三态约定见 ConversationModeConfig.bashEnabled（runtime/mode.ts） */
  bashEnabled?: boolean;
  /** 任务清单工具（write_todos）是否装配；缺省 false，agent 模式传 true */
  todosEnabled?: boolean;
  /**
   * 写侧内置工具（write_file / edit_file）是否装配；缺省 true（由沙箱档位兜底），
   * chat 模式固定传 false，使只读语义不依赖沙箱配置（workspace-write / 沙箱关闭时同样不可写）
   */
  writeToolsEnabled?: boolean;
}

/** assembleSessionContext 入参对象 */
export interface AssembleSessionContextOptions {
  /** 场景基础提示词（chat、agent 等命令各自定义人设） */
  basePrompt: string;
  /** 追加并入的外部工具（如 MCP 工具，缺省为空） */
  extraTools?: Tool[];
  /** 会话级沙箱上下文（可选；存在时启用权限门卫） */
  sandbox?: SandboxContext;
  /** 装配选项（bash 开关、write_todos 开关等，缺省全部关闭/跟随沙箱） */
  assembly?: SessionAssemblyOptions;
}

/**
 * 发现技能并装配对话所需的提示词与工具列表
 * 工具带按「增量分段 + 统一合并」装配：内置工具（随版本发布，chat 模式剔除 write_file / edit_file）、
 * load_skill（仅存在技能时，避免空技能场景多下发一个无用工具定义）、write_todos（agent 模式）、
 * bash（沙箱启用且 bash 开关未关闭时）各自产出片段，在此统一合并后再与外部工具（如 MCP）组合；
 * 不再支持运行时动态注册工具；
 * 传入沙箱上下文时对声明了 permission 的工具做权限门卫包装（chat 模式只读工具继续受 fs 边界管控）
 * @param {AssembleSessionContextOptions} options - 入参对象（basePrompt/extraTools/sandbox/assembly 字段说明见接口定义）
 * @returns {SessionAssembly} 装配结果
 */
export function assembleSessionContext({
  basePrompt,
  extraTools = [],
  sandbox,
  assembly,
}: AssembleSessionContextOptions): SessionAssembly {
  const { skills, warnings: skillWarnings } = discoverSkills();
  const catalog = new SkillCatalog(skills);
  let todoHandle: TodoToolHandle | undefined;
  // ---- 各装配步骤只产出自己的增量片段，最后统一合并为完整工具带 ----
  // 片段一：内置静态工具；chat 只读模式剔除写侧工具，使只读语义由代码保证，不随沙箱档位或沙箱开关变化
  const builtinSegment: Tool[] =
    assembly?.writeToolsEnabled === false
      ? builtinTools.filter((tool) => !WRITE_TOOL_NAMES.has(tool.name))
      : builtinTools;
  // 片段二：load_skill（仅存在技能时装配，避免空技能场景多下发一个无用工具定义）
  const skillSegment: Tool[] =
    skills.length > 0 ? [createLoadSkillTool(catalog)] : [];
  // 片段三：write_todos（agent 模式装配，工具实例闭包持有会话级清单状态，/todos 读取）
  const todoSegment: Tool[] = [];
  if (assembly?.todosEnabled) {
    todoHandle = createTodoTool();
    todoSegment.push(todoHandle.tool);
  }
  // 片段四：bash 依赖沙箱执行，无沙箱或显式关闭（chat 模式 / --no-bash）时不装配
  const bashAssembled =
    sandbox !== undefined && (assembly?.bashEnabled ?? true);
  const bashSegment: Tool[] = bashAssembled ? [createBashTool(sandbox)] : [];
  // 片段五：外部工具（如 MCP 工具，由运行时连接后传入）
  const externalSegment: Tool[] = extraTools;

  // ---- 统一合并：内部片段按固定顺序拼接成完整工具带 ----
  const internalTools: Tool[] = [
    ...builtinSegment,
    ...skillSegment,
    ...todoSegment,
    ...bashSegment,
  ];
  ensureUniqueToolNames([...internalTools, ...externalSegment]);
  /** 按会话沙箱策略包装单个工具：声明了 permission 的工具经 L2 规则判定 + L3 审批门卫（无沙箱时原样返回） */
  const gate = (tool: Tool): Tool =>
    sandbox ? wrapToolWithPermission(tool, sandbox) : tool;
  const gatedInternal = internalTools.map(gate);
  const gatedExtra = externalSegment.map(gate);
  // 外部工具（MCP）超过阈值时折叠：常驻只下发 discover_mcp_tools，激活的工具经共享数组引用进入后续请求；
  // 执行侧始终持有全量工具（含未激活项），权限门卫与审批链不变
  const folded = gatedExtra.length > MCP_INLINE_TOOL_LIMIT;
  const advertisedTools: Tool[] = [...gatedInternal];
  if (folded) {
    advertisedTools.push(createMcpDiscoveryTool(gatedExtra, advertisedTools));
  } else {
    advertisedTools.push(...gatedExtra);
  }
  // 两份列表必须是独立数组：子 Agent 装配（attachSubAgentIfEnabled）会向 tools 与
  // advertisedTools 各 push 一次增量，非折叠场景若共享同一引用会被重复 push，
  // 导致 delegate_task 等工具定义在请求中重复出现（严格校验的服务端直接 400）
  const tools = folded
    ? [...advertisedTools, ...gatedExtra]
    : [...advertisedTools];
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
