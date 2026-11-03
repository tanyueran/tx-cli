import pico from "picocolors";
import { CancelError } from "../../../shared/errors";
import { resolveCompactionConfig } from "../../llm";
import type { LlmConfig, ResponseHistoryItem, TokenUsage } from "../../llm/types";
import { createMcpDiscoveryTool } from "../../mcp/discovery-tool";
import {
  MCP_DISCOVERY_TOOL_NAME,
  SUB_AGENT_EXCLUDED_TOOL_NAMES,
  SUB_AGENT_TOOL_NAME,
} from "../../tools/registry";
import type { Tool } from "../../tools";
import { maybeCompactHistory } from "../loop/compaction";
import { createSubAgentDispatcher } from "./dispatcher";
import type { SubAgentDispatcher, SubAgentNodeEvent } from "./dispatcher";
import {
  createDelegateTaskTool,
  createTaskStatusTool,
  createTaskStopTool,
} from "./tools";
import type { SubAgentToolHandle } from "./tools";
import { createResponsesTurn } from "../loop/responses-turn";
import { runAgentLoop } from "../loop/loop";

// 工具名与裁剪集合的唯一定义在 tools/registry.ts，此处转发以维持既有导入路径
export { SUB_AGENT_EXCLUDED_TOOL_NAMES, SUB_AGENT_TOOL_NAME };

/** 子 Agent 默认工具调用轮数上限：子任务边界清晰，轮数无需与主 Agent 对齐 */
export const DEFAULT_SUB_AGENT_MAX_ITERATIONS = 20;

/** 子 Agent 基础人设：强调「独立上下文 + 只回结论」，不复述过程 */
export const SUB_AGENT_PROMPT = [
  "你是 tx-cli 的子 Agent，负责独立完成主 Agent 交给你的一项子任务。",
  "你看不到主会话的历史：任务描述与背景信息就是你的全部上下文；信息不足时基于现有信息给出最合理的结论，并在结论中说明所做的假设。",
  "按需使用工具（读写文件、检索、执行命令、MCP）完成任务；创建或修改文件优先用 write_file / edit_file；删除、覆盖等高危操作先停下说明需要确认。",
  "完成后直接给出结论：做了什么、产出或关键发现、遗留风险；不要复述过程，也不要把大段原始输出搬进结论。",
].join("\n");

/** 子 Agent 可用的技能元数据（名称 + 描述，追加到人设提示词） */
export interface SubAgentSkillMeta {
  name: string;
  description: string;
}

/** 子 Agent 执行请求 */
export interface SubAgentRequest {
  /** 子任务描述（必须自包含） */
  task: string;
  /** 背景信息（可选）：子 Agent 看不到主会话历史，关键事实与约束需写在这里 */
  context?: string;
}

/** 子 Agent 执行结果 */
export interface SubAgentRunResult {
  /** 子 Agent 的最终结论 */
  output: string;
}

/** 子 Agent 运行控制钩子（后台调度器注入；同步派生不传，行为与历史版本一致） */
export interface SubAgentControl {
  /**
   * 协作式停止探针：在每个循环安全点（beforeIteration）检查，
   * 为真时抛 CancelError 终止本次运行——JS 无法强杀进行中的 Promise，
   * 与主回合取消同口径，由调度器在安全点之间轮询
   * @returns {boolean} 已请求停止为 true
   */
  shouldStop(): boolean;
  /** 静默运行：不打印软收敛等进度提示（后台节点使用，避免污染终端输入帧） */
  quiet?: boolean;
}

/**
 * 子 Agent 执行器：完成一次独立子任务的运行并返回结论
 * @param {SubAgentRequest} request - 子任务与背景信息
 * @param {(usage: TokenUsage) => void} [onUsage] - 每次 LLM 请求的用量回调，供会话层累计
 * @param {SubAgentControl} [control] - 运行控制钩子（后台调度器注入协作停止与静默）
 * @returns {Promise<SubAgentRunResult>} 子 Agent 的最终结论
 */
export type SubAgentRunner = (
  request: SubAgentRequest,
  onUsage?: (usage: TokenUsage) => void,
  control?: SubAgentControl,
) => Promise<SubAgentRunResult>;

/** 创建子 Agent 执行器的参数 */
export interface CreateSubAgentRunnerOptions {
  /** LLM 接入配置（与主会话同一套接入） */
  llmConfig: LlmConfig;
  /** 子 Agent 可执行工具（已经权限门卫包装，不含 delegate_task / write_todos） */
  tools: Tool[];
  /** 下发给子 Agent 的工具清单（MCP 折叠时仅含发现工具，缺省同 tools） */
  advertisedTools?: Tool[];
  /** 可用技能元数据（缺省为空，不追加技能段） */
  skills?: SubAgentSkillMeta[];
  /** 思考协议扩展字段提供器（闭包读取当前档位，/think 切换后下一轮生效） */
  extraBody?: () => Record<string, unknown> | undefined;
  /** 工具调用轮数上限，缺省 DEFAULT_SUB_AGENT_MAX_ITERATIONS */
  maxIterations?: number;
}

/**
 * 组装子 Agent 的 system 提示词：基础人设 + 技能元数据清单
 * 技能正文仍由 load_skill 按需加载，避免撑大子 Agent 的每次请求
 * @param {SubAgentSkillMeta[]} skills - 可用技能元数据
 * @returns {string} 子 Agent 的 system 提示词
 */
function buildSubAgentInstructions(skills: SubAgentSkillMeta[]): string {
  if (skills.length === 0) {
    return SUB_AGENT_PROMPT;
  }
  return [
    SUB_AGENT_PROMPT,
    "",
    "你可以使用 load_skill 工具加载以下技能手册，任务匹配某个技能时先加载手册再执行：",
    ...skills.map((skill) => `- ${skill.name}: ${skill.description}`),
  ].join("\n");
}

/**
 * 把子任务与背景信息组装成子 Agent 的首条用户消息
 * @param {SubAgentRequest} request - 子任务与背景信息
 * @returns {string} 用户消息文本
 */
function buildSubAgentUserInput(request: SubAgentRequest): string {
  const lines = [`子任务：${request.task}`];
  if (request.context) {
    lines.push("", "背景信息：", request.context);
  }
  return lines.join("\n");
}

/**
 * 创建子 Agent 执行器：每次调用使用全新历史，跑独立 agentic loop，只返回最终结论
 * 子 Agent 的输出不再流式渲染到终端（避免中间过程污染主会话展示），
 * 但它调用的工具仍是主会话经权限门卫包装的实例，沙箱边界与审批链完全沿用；
 * 循环内接入与主会话同口径的上下文压缩（tool-rounds 切分策略）与软收敛提示
 * @param {CreateSubAgentRunnerOptions} options - 入参（字段说明见接口定义）
 * @returns {SubAgentRunner} 子 Agent 执行器
 */
export function createSubAgentRunner(
  options: CreateSubAgentRunnerOptions,
): SubAgentRunner {
  const maxIterations = options.maxIterations ?? DEFAULT_SUB_AGENT_MAX_ITERATIONS;
  const instructions = buildSubAgentInstructions(options.skills ?? []);
  const advertisedTools = options.advertisedTools ?? options.tools;
  // 上下文压缩配置：未配置 llm.context.maxContextTokens 时为 undefined，压缩完全不介入（与主会话同口径）
  const compactionConfig = resolveCompactionConfig(options.llmConfig.context);

  return async (request, onUsage, control) => {
    // 每次派生使用全新历史：子 Agent 与主会话上下文彻底隔离，结束即丢弃
    const history: ResponseHistoryItem[] = [];
    // 上一次请求的真实 input token：子 Agent 压缩判定与主会话同口径
    let lastInputTokens: number | undefined;
    const handleUsage = (usage: TokenUsage): void => {
      lastInputTokens = usage.inputTokens;
      onUsage?.(usage);
    };
    const runTurn = createResponsesTurn({
      llmConfig: options.llmConfig,
      userInput: buildSubAgentUserInput(request),
      history,
      instructions,
      extraBody: options.extraBody?.(),
      tools: advertisedTools,
      // 子 Agent 正文与思考不渲染：主会话只关心最终结论
      onDelta: () => {},
      onReasoningDelta: () => {},
      onUsage: handleUsage,
    });
    const output = await runAgentLoop({
      runTurn,
      tools: options.tools,
      maxIterations,
      // 首次进入软收敛轮时打一行弱化提示：用户只看得到「运行中」一行，需有进展感知；
      // 后台节点静默运行（quiet），避免进度行污染终端输入帧
      onSoftConverge: control?.quiet
        ? () => {}
        : () => {
            console.log(
              pico.dim(
                `…… 子 Agent 已达 ${maxIterations} 轮上限，将基于已有信息直接收尾`,
              ),
            );
          },
      // 压缩安全点与主会话同构（首轮无历史不压缩）：检索型子任务最容易膨胀历史，全量重传前先摘要；
      // 子 Agent 静默运行，压缩结果不打印提示；
      // 后台调度器注入 shouldStop 钩子时在安全点检查协作停止，抛 CancelError 终止本次运行
      beforeIteration: async (iteration) => {
        if (control?.shouldStop()) {
          throw new CancelError("后台任务已请求停止");
        }
        if (iteration === 0 || !compactionConfig) {
          return;
        }
        await maybeCompactHistory({
          llmConfig: options.llmConfig,
          history,
          config: compactionConfig,
          lastInputTokens,
          // 摘要请求的用量只计入会话统计（onUsage），不回写 lastInputTokens——
          // 摘要的 inputTokens ≈ 被压缩段原大小（仍超阈值），回写会让后续安全点误判再次压缩
          onUsage,
          splitStrategy: "tool-rounds",
        });
      },
    });
    return { output: output.trim() || "（子 Agent 执行完毕，但未给出文字结论）" };
  };
}

/** 子任务预览的目标字符数（调度器的进度行、通知与状态列表共用） */
export const TASK_PREVIEW_CHARS = 80;

/**
 * 生成子任务预览：取首行并截断，用于调用提示与进度行
 * @param {unknown} rawTask - 模型给出的 task 参数
 * @returns {string} 预览文本（无有效任务时为空串）
 */
export function buildTaskPreview(rawTask: unknown): string {
  if (typeof rawTask !== "string") {
    return "";
  }
  const task = rawTask.trim();
  if (task.length <= TASK_PREVIEW_CHARS) {
    return task;
  }
  return `${task.slice(0, TASK_PREVIEW_CHARS)}…`;
}

/**
 * 过滤子 Agent 可继承的工具：剔除共享状态工具与派生工具自身
 * @param {Tool[]} tools - 主会话工具列表
 * @returns {Tool[]} 子 Agent 可用的工具列表
 */
export function filterSubAgentTools(tools: Tool[]): Tool[] {
  return tools.filter((tool) => !SUB_AGENT_EXCLUDED_TOOL_NAMES.has(tool.name));
}

/** 为会话装配子 Agent 工具的参数 */
export interface AttachSubAgentOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 主会话全量工具（执行侧） */
  tools: Tool[];
  /** 主会话下发给模型的工具清单（MCP 折叠时仅含发现工具） */
  advertisedTools: Tool[];
  /** 可用技能元数据 */
  skills?: SubAgentSkillMeta[];
  /** 思考协议扩展字段提供器 */
  extraBody?: () => Record<string, unknown> | undefined;
  /** 子 Agent 工具调用轮数上限 */
  maxIterations?: number;
  /**
   * 是否允许后台派生（delegate_task background=true）：
   * 多轮 REPL 缺省允许；单次会话（one-shot）传 false，进程即将退出无处等待
   */
  backgroundEnabled?: boolean;
  /**
   * 后台节点终态事件回调（透传给调度器）：REPL 借此在输入等待期间
   * 被事件唤醒，实现「用户纯等待时后台任务完成即自动继续」
   */
  onNodeEvent?: (event: SubAgentNodeEvent) => void;
}

/**
 * 子 Agent 工具装配结果：纯增量
 * 只返回本次新增的工具与句柄，不回传（也不修改）全量工具列表——
 * 会话工具集的单一事实源始终是 runtime.assembly.tools / advertisedTools
 */
export interface AttachSubAgentResult {
  /** 本次新增的工具增量（delegate_task / task_status / task_stop，顺序即合并顺序） */
  addedTools: Tool[];
  /** 子 Agent 工具句柄（会话层每轮设置用量上报器） */
  handle: SubAgentToolHandle;
  /** 子 Agent 调度器（REPL 据此收割后台节点事件、退出前等待） */
  dispatcher: SubAgentDispatcher;
}

/** 按模式开关装配会话工具带的合并结果：只含句柄与调度器，工具列表不再回传 */
export interface SessionToolAttachResult {
  /** 子 Agent 工具句柄（未启用时为 undefined） */
  handle?: SubAgentToolHandle;
  /** 子 Agent 调度器（未启用时为 undefined） */
  dispatcher?: SubAgentDispatcher;
}

/**
 * 按模式开关装配会话工具带（one-shot 与 REPL 共用的统一合并入口）：
 * enabled 为假（如 chat 只读问答）时不产生任何增量，直接返回空句柄；
 * 启用时把 attachSubAgentTools 产出的三个工具增量合并进会话工具带（两份列表原地追加）
 *
 * 合并必须原地追加而非复制新数组：MCP 折叠模式下 discover_mcp_tools 激活的工具被 push 进
 * 下发列表（与请求层共享同一数组引用），复制列表会让 agent 模式下激活的工具永远到不了请求层
 * @param {AttachSubAgentOptions & { enabled?: boolean }} options - 装配入参（enabled 缺省视为关闭）
 * @returns {SessionToolAttachResult} 子 Agent 句柄与调度器（未启用时均为 undefined）
 */
export function attachSubAgentIfEnabled(
  options: AttachSubAgentOptions & { enabled?: boolean },
): SessionToolAttachResult {
  if (!options.enabled) {
    return {};
  }
  const { addedTools, handle, dispatcher } = attachSubAgentTools(options);
  // 统一合并点：增量原地追加进两份共享列表（执行侧全量 + 下发侧）
  options.tools.push(...addedTools);
  options.advertisedTools.push(...addedTools);
  return { handle, dispatcher };
}

/**
 * 为会话装配子 Agent 工具（纯增量）：创建执行核与调度器，返回
 * delegate_task / task_status / task_stop 三个工具的增量与句柄，不修改入参两份列表；
 * 合并进会话工具带由 attachSubAgentIfEnabled 统一执行
 *
 * 子 Agent 继承过滤后的工具（剔除 write_todos / delegate_task / task_status / task_stop），
 * 沙箱与审批链不变；
 * MCP 折叠模式下为子 Agent 重绑独立的 discovery 实例——原实例的激活写入主会话下发列表，
 * 子 Agent 的请求层看不到，重绑后激活只写入子 Agent 自己的下发列表
 * @param {AttachSubAgentOptions} options - 入参（字段说明见接口定义）
 * @returns {AttachSubAgentResult} 本次新增的工具增量 + 句柄 + 调度器
 */
export function attachSubAgentTools(
  options: AttachSubAgentOptions,
): AttachSubAgentResult {
  // 子 Agent 侧两份列表：均为过滤后的副本，激活与裁剪都不回写主会话列表
  const subTools = filterSubAgentTools(options.tools);
  const subAdvertised = filterSubAgentTools(options.advertisedTools);
  // MCP 折叠模式下重绑 discovery：pool 取「执行侧有而下发侧没有」的工具（即折叠的 MCP 全集）
  const discoveryIndex = subAdvertised.findIndex(
    (tool) => tool.name === MCP_DISCOVERY_TOOL_NAME,
  );
  if (discoveryIndex >= 0) {
    const pool = options.tools.filter(
      (tool) => !options.advertisedTools.includes(tool),
    );
    const rebound = createMcpDiscoveryTool(pool, subAdvertised);
    subAdvertised[discoveryIndex] = rebound;
    // 执行侧同步替换：agentic loop 按执行侧列表建 toolMap，模型实际调用的实例由此决定；
    // 若仍保留主会话实例，激活会写进主会话下发列表（泄漏），子 Agent 自己的下发列表也收不到
    const execDiscoveryIndex = subTools.findIndex(
      (tool) => tool.name === MCP_DISCOVERY_TOOL_NAME,
    );
    if (execDiscoveryIndex >= 0) {
      subTools[execDiscoveryIndex] = rebound;
    }
  }
  const runner = createSubAgentRunner({
    llmConfig: options.llmConfig,
    tools: subTools,
    advertisedTools: subAdvertised,
    skills: options.skills,
    extraBody: options.extraBody,
    maxIterations: options.maxIterations,
  });
  // 调度器是唯一派生入口：同步直连执行核，后台注册节点并跨回合收割
  const dispatcher = createSubAgentDispatcher({
    runner,
    backgroundEnabled: options.backgroundEnabled ?? true,
    onEvent: options.onNodeEvent,
  });
  const handle = createDelegateTaskTool(dispatcher);
  // 本次装配的增量：三个子 Agent 工具（合并进会话工具带由 attachSubAgentIfEnabled 统一执行）
  const addedTools: Tool[] = [
    handle.tool,
    createTaskStatusTool(dispatcher),
    createTaskStopTool(dispatcher),
  ];
  return { addedTools, handle, dispatcher };
}
