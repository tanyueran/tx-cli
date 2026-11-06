/**
 * 子 Agent 工具壳：delegate_task / task_status / task_stop 三个工具的模型接口
 * 只做参数校验与委托，不感知执行细节——执行核与调度器见 attach.ts / dispatcher.ts；
 * 未来新增 DAG 编排（多节点计划）只扩展调度器与新增工具壳，主循环与执行核不动
 */
import pico from "picocolors";
import { CancelError } from "@tx-cli/shared";
import type { Tool, ToolOutput } from "../../tools";
import {
  SUB_AGENT_TOOL_NAME,
  TASK_STATUS_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
} from "../../tools/registry";
import type { TokenUsage } from "../../llm/types";
import type { SubAgentDispatcher, SubAgentNodeStatus, TaskNodeState } from "./dispatcher";
import { MAX_CONTEXT_CHARS, MAX_TASK_CHARS, SUB_AGENT_TIMEOUT_MS } from "./dispatcher";
import { buildTaskPreview } from "./attach";

/** task_status 收割结论的截断上限：全文超限时截断并提示长度 */
const STATUS_OUTPUT_MAX_CHARS = 8_000;

/** delegate_task 工具句柄：工具实例 + 当前回合用量上报器设置入口 */
export interface SubAgentToolHandle {
  /** delegate_task 工具实例 */
  tool: Tool;
  /**
   * 设置当前回合的用量上报回调（会话层每轮更新，传 undefined 清除）
   * 后台节点在派生时刻捕获该回调：始终计入会话累计；当轮累加器仍活跃时同时计入当轮
   * @param {(usage: TokenUsage) => void} [reporter] - 用量回调
   * @returns {void}
   */
  setUsageReporter(reporter?: (usage: TokenUsage) => void): void;
}

/**
 * 把调度器包装为 delegate_task 工具壳
 * 参数校验失败转为失败输出回传模型自纠；用户取消（CancelError）原样上抛走回合取消流程；
 * 其他异常（含调度器拒绝：并发上限、后台禁用）转为失败输出，主会话可继续对话而非中断
 * @param {SubAgentDispatcher} dispatcher - 子 Agent 调度器
 * @returns {SubAgentToolHandle} 工具句柄（工具实例 + 用量上报器设置入口）
 */
export function createDelegateTaskTool(
  dispatcher: SubAgentDispatcher,
): SubAgentToolHandle {
  let usageReporter: ((usage: TokenUsage) => void) | undefined;

  const tool: Tool = {
    name: SUB_AGENT_TOOL_NAME,
    description:
      "派生一个独立上下文的子 Agent 执行子任务：子 Agent 看不到主会话历史，" +
      "中间的工具调用与输出都不进入主上下文，只有最终结论回传。" +
      "适合边界清晰、可独立完成、且过程会产生大量无关输出的子任务（如大范围检索、批量分析）；" +
      "简单任务自己直接做，不要为每一步都派生子 Agent。" +
      "task 必须自包含：写明目标、涉及的路径或范围、期望产出。" +
      "background=true 时任务转入后台立即返回：适合长耗时且无需立即结论的子任务，" +
      "派生后可继续与用户对话；完成时结论自动注入对话，也可用 task_status 查询、" +
      "task_stop 停止。注意：后台任务不能执行需要交互审批的命令，" +
      "涉及审批的步骤请用同步派生（默认）。",
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
        background: {
          type: "boolean",
          description:
            "是否转入后台执行（可选，默认 false 同步等待结论）：true 适用于长耗时、无需立即结论的检索或批量任务",
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
      const suffix = args.background === true ? "（后台）" : "";
      return preview ? `子任务：${preview}${suffix}` : "（缺少 task 参数）";
    },
    /**
     * 执行派生：校验参数 → 分发到调度器 → 同步回传结论 / 后台回传任务句柄
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {Promise<ToolOutput>} 子 Agent 结论、后台任务受理说明或失败说明
     * @throws {CancelError} 同步派生期间用户取消时上抛，交由回合取消流程处理
     */
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const task = typeof args.task === "string" ? args.task.trim() : "";
      if (!task) {
        return {
          ok: false,
          output:
            "缺少 task 参数：请给出自包含的子任务描述（目标、范围、期望产出）",
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
      if (args.background !== undefined && typeof args.background !== "boolean") {
        return { ok: false, output: "background 参数必须为布尔值" };
      }
      const background = args.background === true;
      const preview = buildTaskPreview(task);
      try {
        const result = await dispatcher.dispatch(
          {
            mode: background ? "background" : "sync",
            plan: {
              nodes: [
                context
                  ? { task, context, dependsOn: [] }
                  : { task, dependsOn: [] },
              ],
            },
          },
          usageReporter,
        );
        if (result.kind === "sync") {
          console.log(
            pico.dim(`…… 子 Agent 运行中：${preview}（过程不进入主上下文）`),
          );
          console.log(
            pico.dim(`子 Agent 完成：结论 ${result.output.length} 字`),
          );
          return { ok: true, output: `子 Agent 结论：\n${result.output}` };
        }
        console.log(
          pico.dim(
            `…… 子任务转后台：${preview}（${result.nodeId}，完成后结论自动带入对话）`,
          ),
        );
        return {
          ok: true,
          output:
            `已转后台任务 ${result.nodeId}（run ${result.runId}）：${result.preview}\n` +
            "完成后结论会自动注入对话，无需重复询问；期间可继续其他工作，" +
            "也可用 task_status 查询状态或收割全文、task_stop 停止该任务。",
        };
      } catch (err) {
        // 用户取消不是失败：原样上抛，让主回合按取消流程中断（仅同步路径会发生）
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

/** 节点状态中文标签（状态列表与详情共用） */
const STATUS_LABELS: Record<SubAgentNodeStatus, string> = {
  queued: "排队中",
  running: "运行中",
  completed: "已完成",
  failed: "失败",
  stopped: "已停止",
};

/**
 * 格式化耗时：不足 1 秒显示毫秒整数，达到 1 秒显示保留一位小数的秒
 * @param {number} ms - 耗时（毫秒）
 * @returns {string} 形如「820ms」「1.8s」的展示文本
 */
function formatNodeElapsed(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 节点单行摘要：id、状态、任务预览与耗时
 * @param {TaskNodeState} node - 后台节点
 * @returns {string} 单行摘要
 */
function formatNodeBrief(node: TaskNodeState): string {
  const elapsed = (node.finishedAt ?? Date.now()) - node.startedAt;
  return `${node.id} [${STATUS_LABELS[node.status]}] ${node.preview}（${formatNodeElapsed(elapsed)}）`;
}

/**
 * 节点详情：状态行 + 终态附加信息（结论全文 / 失败原因 / 停止说明）
 * @param {TaskNodeState} node - 后台节点
 * @returns {string} 详情文本
 */
function formatNodeDetail(node: TaskNodeState): string {
  const lines = [`后台任务 ${formatNodeBrief(node)}`];
  if (node.status === "completed" && node.output !== undefined) {
    const output =
      node.output.length > STATUS_OUTPUT_MAX_CHARS
        ? `${node.output.slice(0, STATUS_OUTPUT_MAX_CHARS)}…（结论已截断，全文 ${node.output.length} 字）`
        : node.output;
    lines.push("结论：", output);
  } else if (node.status === "failed") {
    lines.push(`失败原因：${node.error ?? "未知"}`);
  } else if (node.status === "stopped") {
    lines.push("任务已停止，没有产出");
  } else {
    lines.push("任务尚未完成，稍后可再次查询");
  }
  return lines.join("\n");
}

/**
 * 创建 task_status 工具壳：无参列出全部后台任务，带 id 查询单个任务详情与结论
 * @param {SubAgentDispatcher} dispatcher - 子 Agent 调度器
 * @returns {Tool} task_status 工具实例
 */
export function createTaskStatusTool(dispatcher: SubAgentDispatcher): Tool {
  return {
    name: TASK_STATUS_TOOL_NAME,
    description:
      "查询后台子任务的状态与结论：不带参数列出全部后台任务（id、状态、耗时、任务预览）；" +
      "传入 id 返回单个任务详情，已完成时附结论全文。" +
      "后台任务完成时结论会自动注入对话，本工具用于主动回查或收割长结论。",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "后台任务节点 id（如 n1）；缺省列出全部",
        },
      },
    },
    /**
     * 调用提示渲染
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string} 展示文本
     */
    renderCall(args: Record<string, unknown>): string {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      return id ? `查询后台任务 ${id}` : "查询后台任务列表";
    },
    /**
     * 执行查询
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {Promise<ToolOutput>} 任务列表 / 详情 / 失败说明
     */
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) {
        const all = dispatcher.list();
        if (all.length === 0) {
          return { ok: true, output: "当前会话没有后台任务记录" };
        }
        return {
          ok: true,
          output: ["后台任务列表：", ...all.map(formatNodeBrief)].join("\n  "),
        };
      }
      const node = dispatcher.get(id);
      if (!node) {
        return {
          ok: false,
          output: `后台任务不存在：${id}（可用无参调用列出全部任务）`,
        };
      }
      return { ok: true, output: formatNodeDetail(node) };
    },
  };
}

/**
 * 创建 task_stop 工具壳：协作式停止一个后台任务
 * @param {SubAgentDispatcher} dispatcher - 子 Agent 调度器
 * @returns {Tool} task_stop 工具实例
 */
export function createTaskStopTool(dispatcher: SubAgentDispatcher): Tool {
  return {
    name: TASK_STOP_TOOL_NAME,
    description:
      "停止一个后台子任务：协作式停止，任务在当前工具执行完成后、下一轮循环安全点退出，" +
      "不中断进行中的操作。已完成、失败或已停止的任务无需停止。",
    parameters: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "要停止的后台任务节点 id（如 n1）",
        },
      },
      required: ["id"],
    },
    /**
     * 调用提示渲染
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {string} 展示文本
     */
    renderCall(args: Record<string, unknown>): string {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      return id ? `停止后台任务 ${id}` : "停止后台任务";
    },
    /**
     * 执行停止
     * @param {Record<string, unknown>} args - 模型给出的参数
     * @returns {Promise<ToolOutput>} 受理说明或失败说明
     */
    async execute(args: Record<string, unknown>): Promise<ToolOutput> {
      const id = typeof args.id === "string" ? args.id.trim() : "";
      if (!id) {
        return {
          ok: false,
          output: "缺少 id 参数：请给出要停止的后台任务节点 id",
        };
      }
      const accepted = dispatcher.requestStop(id);
      return accepted
        ? {
            ok: true,
            output: `已请求停止 ${id}：任务将在当前执行步骤完成后退出，结果不再产出`,
          }
        : {
            ok: false,
            output: `${id} 不存在或已结束，无需停止（可用 task_status 查看任务列表）`,
          };
    },
  };
}
