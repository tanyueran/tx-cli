import pico from "picocolors";
import { CancelError } from "../../../../shared/errors";
import { resolveCompactionConfig } from "../../../llm";
import type { LlmConfig, ResponseHistoryItem, TokenUsage } from "../../../llm/types";
import { createMcpDiscoveryTool } from "../../../mcp/discovery-tool";
import {
  MCP_DISCOVERY_TOOL_NAME,
  SUB_AGENT_EXCLUDED_TOOL_NAMES,
  SUB_AGENT_TOOL_NAME,
} from "../../../tools/registry";
import type { Tool, ToolOutput } from "../../../tools";
import { maybeCompactHistory } from "./compaction";
import { createResponsesTurn } from "./responses-turn";
import { runAgentLoop } from "./loop";

// 工具名与裁剪集合的唯一定义在 tools/registry.ts，此处转发以维持既有导入路径
export { SUB_AGENT_EXCLUDED_TOOL_NAMES, SUB_AGENT_TOOL_NAME };

/** 子 Agent 默认工具调用轮数上限：子任务边界清晰，轮数无需与主 Agent 对齐 */
export const DEFAULT_SUB_AGENT_MAX_ITERATIONS = 20;

/**
 * 子 Agent 超时时间（毫秒）：派生子任务包含多次 LLM 请求与工具执行，默认 30s 远不够；
 * 内层工具各自仍有独立超时，此值只约束整个子任务的墙钟上限
 */
const SUB_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/** 子任务描述的字符上限：防止主模型把整段历史原文塞进子任务 */
const MAX_TASK_CHARS = 4_000;

/** 背景信息的字符上限 */
const MAX_CONTEXT_CHARS = 8_000;

/** 调用提示里子任务预览的最大字符数 */
const TASK_PREVIEW_CHARS = 80;

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

/**
 * 子 Agent 执行器：完成一次独立子任务的运行并返回结论
 * @param {SubAgentRequest} request - 子任务与背景信息
 * @param {(usage: TokenUsage) => void} [onUsage] - 每次 LLM 请求的用量回调，供会话层累计
 * @returns {Promise<SubAgentRunResult>} 子 Agent 的最终结论
 */
export type SubAgentRunner = (
  request: SubAgentRequest,
  onUsage?: (usage: TokenUsage) => void,
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

  return async (request, onUsage) => {
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
      // 首次进入软收敛轮时打一行弱化提示：用户只看得到「运行中」一行，需有进展感知
      onSoftConverge: () => {
        console.log(
          pico.dim(
            `…… 子 Agent 已达 ${maxIterations} 轮上限，将基于已有信息直接收尾`,
          ),
        );
      },
      // 压缩安全点与主会话同构（首轮无历史不压缩）：检索型子任务最容易膨胀历史，全量重传前先摘要；
      // 子 Agent 静默运行，压缩结果不打印提示
      beforeIteration: async (iteration) => {
        if (iteration === 0 || !compactionConfig) {
          return;
        }
        await maybeCompactHistory({
          llmConfig: options.llmConfig,
          history,
          config: compactionConfig,
          lastInputTokens,
          onUsage: handleUsage,
          splitStrategy: "tool-rounds",
        });
      },
    });
    return { output: output.trim() || "（子 Agent 执行完毕，但未给出文字结论）" };
  };
}

/** 子 Agent 工具句柄：工具实例 + 当前回合用量上报器 */
export interface SubAgentToolHandle {
  /** delegate_task 工具实例 */
  tool: Tool;
  /**
   * 设置当前回合的用量上报回调（会话层每轮更新，传 undefined 清除）
   * 子 Agent 的 LLM 用量经此回调计入本轮与累计统计
   * @param {(usage: TokenUsage) => void} [reporter] - 用量回调
   * @returns {void}
   */
  setUsageReporter(reporter?: (usage: TokenUsage) => void): void;
}

/**
 * 生成子任务预览：取首行并截断，用于调用提示与进度行
 * @param {unknown} rawTask - 模型给出的 task 参数
 * @returns {string} 预览文本（无有效任务时为空串）
 */
function buildTaskPreview(rawTask: unknown): string {
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
 * 把子 Agent 执行器包装为 delegate_task 工具
 * 参数校验失败转为失败输出回传模型自纠；用户取消（CancelError）原样上抛走回合取消流程；
 * 其他异常转为失败输出，主会话可继续对话而非中断
 * @param {SubAgentRunner} runner - 子 Agent 执行器（测试可注入假实现）
 * @returns {SubAgentToolHandle} 工具句柄（工具实例 + 用量上报器设置入口）
 */
export function createSubAgentTool(runner: SubAgentRunner): SubAgentToolHandle {
  // 当前回合的用量上报器：会话层每轮设置，避免子 Agent 用量丢失统计
  let usageReporter: ((usage: TokenUsage) => void) | undefined;

  const tool: Tool = {
    name: SUB_AGENT_TOOL_NAME,
    description:
      "派生一个独立上下文的子 Agent 执行子任务：子 Agent 看不到主会话历史，" +
      "中间的工具调用与输出都不进入主上下文，只有最终结论回传。" +
      "适合边界清晰、可独立完成、且过程会产生大量无关输出的子任务（如大范围检索、批量分析）；" +
      "简单任务自己直接做，不要为每一步都派生子 Agent。" +
      "task 必须自包含：写明目标、涉及的路径或范围、期望产出。",
    parameters: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: `要交给子 Agent 的自包含子任务（目标、范围、期望产出，最多 ${MAX_TASK_CHARS} 字）`,
        },
        context: {
          type: "string",
          description:
            "背景信息（可选）：子 Agent 看不到主会话历史，任务需要的关键事实、约束、已有结论写在这里",
        },
      },
      required: ["task"],
    },
    timeoutMs: SUB_AGENT_TIMEOUT_MS,
    /**
     * 调用提示渲染：展示子任务预览（替代原始 JSON 参数打印）
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string} 展示文本
     */
    renderCall(args: Record<string, unknown>): string {
      const preview = buildTaskPreview(args.task);
      return preview ? `子任务：${preview}` : "（缺少 task 参数）";
    },
    /**
     * 执行派生：校验参数 → 运行子 Agent → 把结论作为工具输出回传主模型
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {Promise<ToolOutput>} 子 Agent 结论或失败说明
     * @throws {CancelError} 子 Agent 运行期间用户取消时上抛，交由回合取消流程处理
     */
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) {
        return {
          ok: false,
          output: "缺少 task 参数：请给出自包含的子任务描述（目标、范围、期望产出）",
        };
      }
      if (task.length > MAX_TASK_CHARS) {
        return {
          ok: false,
          output: `task 过长（${task.length} 字，上限 ${MAX_TASK_CHARS} 字）：请提炼成自包含的简明子任务`,
        };
      }
      const rawContext = args.context;
      if (rawContext !== undefined && typeof rawContext !== "string") {
        return { ok: false, output: "context 参数必须为字符串" };
      }
      const context = typeof rawContext === "string" ? rawContext.trim() : "";
      if (context.length > MAX_CONTEXT_CHARS) {
        return {
          ok: false,
          output: `context 过长（${context.length} 字，上限 ${MAX_CONTEXT_CHARS} 字）：请只保留关键事实与约束`,
        };
      }

      const preview = buildTaskPreview(task);
      console.log(pico.dim(`…… 子 Agent 运行中：${preview}（过程不进入主上下文）`));
      try {
        const result = await runner(
          context ? { task, context } : { task },
          usageReporter,
        );
        console.log(
          pico.dim(`子 Agent 完成：结论 ${result.output.length} 字`),
        );
        return { ok: true, output: `子 Agent 结论：\n${result.output}` };
      } catch (err) {
        // 用户取消不是失败：原样上抛，让主回合按取消流程中断
        if (err instanceof CancelError) {
          throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.log(pico.yellow(`子 Agent 失败：${message}`));
        return { ok: false, output: `子 Agent 执行失败：${message}` };
      }
    },
  };

  return {
    tool,
    setUsageReporter: (reporter) => {
      usageReporter = reporter;
    },
  };
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
}

/** 子 Agent 工具装配结果 */
export interface AttachSubAgentResult {
  /** 追加 delegate_task 后的全量工具列表（原数组原地追加，保持既有共享引用） */
  tools: Tool[];
  /**
   * 追加 delegate_task 后的下发工具列表（原数组原地追加）：
   * discover_mcp_tools 的激活机制依赖与请求层共享同一数组引用，复制新数组会导致激活失效
   */
  advertisedTools: Tool[];
  /** 子 Agent 工具句柄（会话层每轮设置用量上报器） */
  handle: SubAgentToolHandle;
}

/** 按模式开关装配会话工具带的结果：展开后的两份工具列表与可选句柄 */
export interface SessionToolAttachResult {
  /** 全量工具列表（未启用子 Agent 时为运行时原列表） */
  tools: Tool[];
  /** 下发给模型的工具清单（未启用子 Agent 时为运行时原列表） */
  advertisedTools: Tool[];
  /** 子 Agent 工具句柄（未启用时为 undefined） */
  handle?: SubAgentToolHandle;
}

/**
 * 按模式开关装配会话工具带：enabled 为假（如 chat 只读问答）时原样返回运行时工具列表，
 * 免去调用方「attached?.tools ?? 原列表」的三元展开；one-shot 与 REPL 共用此入口
 * @param {AttachSubAgentOptions & { enabled?: boolean }} options - 装配入参（enabled 缺省视为关闭）
 * @returns {SessionToolAttachResult} 展开后的工具列表与可选句柄
 */
export function attachSubAgentIfEnabled(
  options: AttachSubAgentOptions & { enabled?: boolean },
): SessionToolAttachResult {
  if (!options.enabled) {
    return { tools: options.tools, advertisedTools: options.advertisedTools };
  }
  const attached = attachSubAgentTools(options);
  return {
    tools: attached.tools,
    advertisedTools: attached.advertisedTools,
    handle: attached.handle,
  };
}

/**
 * 为会话装配子 Agent 工具：创建 delegate_task 并原地追加进全量与下发两份工具列表
 *
 * 原地追加而非复制新数组：MCP 折叠模式下 discover_mcp_tools 激活的工具被 push 进下发列表
 * （与请求层共享同一数组引用），复制列表会让 agent 模式下激活的工具永远到不了请求层；
 * 子 Agent 继承过滤后的工具（剔除 write_todos 与 delegate_task），沙箱与审批链不变；
 * MCP 折叠模式下为子 Agent 重绑独立的 discovery 实例——原实例的激活写入主会话下发列表，
 * 子 Agent 的请求层看不到，重绑后激活只写入子 Agent 自己的下发列表
 * @param {AttachSubAgentOptions} options - 入参（字段说明见接口定义）
 * @returns {AttachSubAgentResult} 装配结果（原工具列表引用 + 句柄）
 */
export function attachSubAgentTools(
  options: AttachSubAgentOptions,
): AttachSubAgentResult {
  // 子 Agent 下发列表：过滤后的副本，激活与裁剪都不回写主会话列表
  const subAdvertised = filterSubAgentTools(options.advertisedTools);
  // MCP 折叠模式下重绑 discovery：pool 取「执行侧有而下发侧没有」的工具（即折叠的 MCP 全集）
  const discoveryIndex = subAdvertised.findIndex(
    (tool) => tool.name === MCP_DISCOVERY_TOOL_NAME,
  );
  if (discoveryIndex >= 0) {
    const pool = options.tools.filter(
      (tool) => !options.advertisedTools.includes(tool),
    );
    subAdvertised[discoveryIndex] = createMcpDiscoveryTool(pool, subAdvertised);
  }
  const runner = createSubAgentRunner({
    llmConfig: options.llmConfig,
    tools: filterSubAgentTools(options.tools),
    advertisedTools: subAdvertised,
    skills: options.skills,
    extraBody: options.extraBody,
    maxIterations: options.maxIterations,
  });
  const handle = createSubAgentTool(runner);
  // 原地追加 delegate_task：保持与 discover_mcp_tools 激活机制共享同一数组引用
  options.tools.push(handle.tool);
  options.advertisedTools.push(handle.tool);
  return {
    tools: options.tools,
    advertisedTools: options.advertisedTools,
    handle,
  };
}
