/**
 * 子 Agent 调度器：同步/后台分流的唯一派生入口（delegate_task / task_status / task_stop
 * 三个工具壳在 tools.ts，经本模块的 SubAgentDispatcher 接口驱动）
 *
 * 三层职责分离（执行核 / 调度器 / 工具壳）：
 * - 执行核：attach.ts 的 createSubAgentRunner，唯一的子 agentic 循环实现，
 *   同步与后台路径 100% 复用（独立上下文、压缩、技能、审批链只写一次）；
 * - 调度器（本模块）：模式分流（sync 直连 / background 提交）、后台节点注册表、
 *   调度泵 pump、协作式停止、完成事件队列、并发上限与后台超时；
 * - 工具壳：tools.ts 的三个工具只做参数校验与委托，不感知执行细节——
 *   未来新增 DAG 编排（多节点计划）只扩展调度器与新增工具壳，主循环与执行核不动。
 *
 * DAG 预留（形状先行、逻辑后补）：
 * - 节点模型 TaskNodeSpec.dependsOn（v1 恒为空数组）与 runId/nodeId 两级 id；
 * - 调度泵 pump()：就绪判定 = queued 且依赖全部 completed，v1 spawn 即启动（5 行退化实现）；
 * - 多节点计划 SubAgentPlan.nodes（v1 长度恒为 1，由 delegate_task 单节点语法糖构造）；
 * - 拓扑排序、环检测、失败传播策略、结果聚合等逻辑明确不预埋，DAG 落地时再写。
 */
import { CancelError, CliError } from "../../../shared/errors";
import {
  runInBackgroundScope,
  runDetachedFromTurnCancellation,
} from "../../../shared/turn-cancel";
import type { TokenUsage } from "../../llm/types";
import type {
  SubAgentControl,
  SubAgentRequest,
  SubAgentRunner,
} from "./attach";
import { buildTaskPreview } from "./attach";

/** 后台节点默认并发上限：超限派生返回失败说明，提示模型先收割已完成任务 */
export const DEFAULT_MAX_BACKGROUND_NODES = 3;

/** 同步派生的工具墙钟超时（毫秒）：与主会话长任务工具同口径 */
export const SUB_AGENT_TIMEOUT_MS = 10 * 60 * 1000;

/** 后台节点的墙钟超时（毫秒）：到点协作式停止，结论按已产出的内容截断收尾 */
const BACKGROUND_NODE_TIMEOUT_MS = 10 * 60 * 1000;

/** 子任务描述字符上限 */
export const MAX_TASK_CHARS = 4_000;

/** 背景信息字符上限 */
export const MAX_CONTEXT_CHARS = 8_000;

/** 节点规格：子 Agent 执行的原子单元（v1 单节点计划，DAG 复用同一形状） */
export interface TaskNodeSpec {
  /** 自包含子任务描述 */
  task: string;
  /** 背景信息（可选）；DAG 落地时下游节点把上游结论拼入此字段 */
  context?: string;
  /** 依赖的节点 id 列表：全部 completed 才就绪；v1 恒为空数组（DAG 预留） */
  dependsOn: string[];
}

/** 派生计划：v1 恒为单节点；DAG 模式 = 多节点 + 依赖边 */
export interface SubAgentPlan {
  nodes: TaskNodeSpec[];
}

/** 后台节点状态 */
export type SubAgentNodeStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "stopped";

/** 后台节点运行态（runId 聚合 + nodeId 定位的两级 id，为 DAG 聚合视图预留） */
export interface TaskNodeState {
  /** 节点 id（如 n1），调度器内全局自增 */
  id: string;
  /** 所属 run id（如 r1）；v1 每次派生一个 run，DAG 同计划共享 */
  runId: string;
  spec: TaskNodeSpec;
  status: SubAgentNodeStatus;
  /** 任务预览（构建时生成，状态列表与通知共用） */
  preview: string;
  /** 完成时的结论全文 */
  output?: string;
  /** 失败/停止原因 */
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/** 节点终态事件：终端通知行与下一轮历史注入共用同一份载荷 */
export interface SubAgentNodeEvent {
  kind: "completed" | "failed" | "stopped";
  nodeId: string;
  runId: string;
  preview: string;
  /** 运行耗时（毫秒） */
  elapsedMs: number;
  /** completed 时的结论全文 */
  output?: string;
  /** failed / stopped 时的原因 */
  error?: string;
}

/** 派生请求：调度模式 + 计划 */
export interface SubAgentDispatchRequest {
  mode: "sync" | "background";
  plan: SubAgentPlan;
}

/** 派生结果：同步返回结论文本；后台返回任务句柄（立即返回，不等待执行） */
export type SubAgentDispatchResult =
  | { kind: "sync"; output: string }
  | { kind: "background"; runId: string; nodeId: string; preview: string };

/** 子 Agent 调度器接口：工具壳只与它对话，不接触执行核 */
export interface SubAgentDispatcher {
  /**
   * 唯一派生入口：模式合法性（并发上限、后台开关）在此校验，
   * 失败以 CliError 抛出，由工具壳转为失败输出回传模型自纠
   * @param {SubAgentDispatchRequest} request - 派生请求
   * @param {(usage: TokenUsage) => void} [onUsage] - 用量回调（后台节点在派生时刻固定 sink）
   * @returns {Promise<SubAgentDispatchResult>} 同步结论或后台任务句柄
   */
  dispatch(
    request: SubAgentDispatchRequest,
    onUsage?: (usage: TokenUsage) => void,
  ): Promise<SubAgentDispatchResult>;
  /** 列出全部后台节点（按创建顺序） */
  list(): TaskNodeState[];
  /** 按 id 查询节点 */
  get(nodeId: string): TaskNodeState | undefined;
  /**
   * 协作式停止：置停止标记，节点在当前工具执行完成后、下一轮循环安全点退出
   * @param {string} nodeId - 节点 id
   * @returns {boolean} 已受理（节点存在且未结束）为 true
   */
  requestStop(nodeId: string): boolean;
  /** 取走全部终态事件并清空队列（REPL 在回合边界调用，打印通知并注入下一轮历史） */
  drainEvents(): SubAgentNodeEvent[];
  /** 事件队列是否有待处理的终态事件（输入等待方据此立即唤醒，无需等回调） */
  hasPendingEvents(): boolean;
  /** 是否存在运行中的后台节点 */
  hasRunning(): boolean;
  /** 等待全部在途后台节点结束（会话退出前调用；期间新启动的节点也会被等待） */
  waitForAll(): Promise<void>;
}

/** 创建调度器参数 */
export interface CreateSubAgentDispatcherOptions {
  /** 子 Agent 执行核（唯一一份循环实现，同步/后台共用） */
  runner: SubAgentRunner;
  /** 后台并发上限，缺省 DEFAULT_MAX_BACKGROUND_NODES */
  maxBackground?: number;
  /**
   * 是否允许后台模式：单次会话（one-shot）传 false——进程即将退出无处等待，
   * 后台派生直接失败说明；缺省 true
   */
  backgroundEnabled?: boolean;
  /**
   * 节点终态事件回调：事件写入队列时同步触发（REPL 借此唤醒输入等待，实现
   * 「用户停在提示符纯等待时，后台任务完成即自动继续后续步骤」）
   */
  onEvent?: (event: SubAgentNodeEvent) => void;
}

/**
 * 创建子 Agent 调度器
 * @param {CreateSubAgentDispatcherOptions} options - 创建参数
 * @returns {SubAgentDispatcher} 调度器实例
 */
export function createSubAgentDispatcher(
  options: CreateSubAgentDispatcherOptions,
): SubAgentDispatcher {
  const { runner } = options;
  const maxBackground = options.maxBackground ?? DEFAULT_MAX_BACKGROUND_NODES;
  const backgroundEnabled = options.backgroundEnabled ?? true;

  let nextNodeId = 0;
  let nextRunId = 0;
  /** 节点注册表：nodeId → 运行态 */
  const nodes = new Map<string, TaskNodeState>();
  /** 运行中的节点 id（并发上限判定与 hasRunning） */
  const runningIds = new Set<string>();
  /** 已请求停止的节点 id（shouldStop 钩子读取） */
  const stopRequested = new Set<string>();
  /** 节点超时定时器（到点 requestStop；unref 不阻塞自然退出） */
  const timers = new Map<string, NodeJS.Timeout>();
  /** 各节点派生时的用量回调（启动节点时取用） */
  const usageByNode = new Map<
    string,
    ((usage: TokenUsage) => void) | undefined
  >();
  /** 终态事件队列（REPL 在回合边界 drain） */
  const pendingEvents: SubAgentNodeEvent[] = [];
  /** 在途节点 promise 集合（waitForAll 用） */
  const inflight = new Set<Promise<void>>();

  /** 由节点规格构造执行核请求 */
  const buildRequest = (spec: TaskNodeSpec): SubAgentRequest =>
    spec.context ? { task: spec.task, context: spec.context } : { task: spec.task };

  /**
   * 调度泵：就绪判定 = queued 且 dependsOn 全部 completed，受并发上限约束
   * v1 dependsOn 恒空、spawn 即启动；DAG 落地时只改这里的就绪判定
   * @returns {void}
   */
  const pump = (): void => {
    for (const node of nodes.values()) {
      if (node.status !== "queued") {
        continue;
      }
      if (runningIds.size >= maxBackground) {
        return;
      }
      const depsReady = node.spec.dependsOn.every(
        (depId) => nodes.get(depId)?.status === "completed",
      );
      if (depsReady) {
        startNode(node);
      }
    }
  };

  /**
   * 启动一个节点：detach 取消上下文 + 标记后台作用域（审批点据此拒绝交互），
   * 挂超时定时器，终态时写注册表与事件队列并触发调度泵
   * @param {TaskNodeState} node - 待启动节点
   * @returns {void}
   */
  const startNode = (node: TaskNodeState): void => {
    node.status = "running";
    node.startedAt = Date.now();
    runningIds.add(node.id);
    const timer = setTimeout(
      () => requestStop(node.id),
      BACKGROUND_NODE_TIMEOUT_MS,
    );
    timer.unref?.();
    timers.set(node.id, timer);
    const onUsage = usageByNode.get(node.id);
    const control: SubAgentControl = {
      shouldStop: () => stopRequested.has(node.id),
      quiet: true,
    };
    const promise = runInBackgroundScope(() =>
      runDetachedFromTurnCancellation(async () =>
        runner(buildRequest(node.spec), onUsage, control),
      ),
    );
    const tracked = promise.then(
      (result) => {
        finishNode(node, "completed", { output: result.output });
      },
      (err: unknown) => {
        if (err instanceof CancelError) {
          finishNode(node, "stopped", { error: "已请求停止" });
          return;
        }
        finishNode(node, "failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      },
    );
    inflight.add(tracked);
    void tracked.then(() => {
      inflight.delete(tracked);
      usageByNode.delete(node.id);
    });
  };

  /**
   * 节点到达终态：更新注册表、清理定时器、写入事件队列并触发调度泵
   * @param {TaskNodeState} node - 目标节点
   * @param {Exclude<SubAgentNodeStatus, "queued" | "running">} status - 终态
   * @param {{ output?: string; error?: string }} payload - 终态载荷
   * @returns {void}
   */
  const finishNode = (
    node: TaskNodeState,
    status: Exclude<SubAgentNodeStatus, "queued" | "running">,
    payload: { output?: string; error?: string },
  ): void => {
    node.status = status;
    node.finishedAt = Date.now();
    if (payload.output !== undefined) {
      node.output = payload.output;
    }
    if (payload.error !== undefined) {
      node.error = payload.error;
    }
    runningIds.delete(node.id);
    stopRequested.delete(node.id);
    const timer = timers.get(node.id);
    if (timer) {
      clearTimeout(timer);
      timers.delete(node.id);
    }
    pendingEvents.push({
      kind:
        status === "completed" ? "completed" : status === "failed" ? "failed" : "stopped",
      nodeId: node.id,
      runId: node.runId,
      preview: node.preview,
      elapsedMs: node.finishedAt - node.startedAt,
      output: payload.output,
      error: payload.error,
    });
    // 通知监听方（输入等待唤醒等）；回调异常不得影响节点收尾
    try {
      options.onEvent?.(pendingEvents[pendingEvents.length - 1]);
    } catch {
      // 忽略监听方异常
    }
    // 就绪节点补位启动（v1 无排队节点，此调用为空转；DAG 依赖就绪后在此续跑）
    pump();
  };

  const dispatch = async (
    request: SubAgentDispatchRequest,
    onUsage?: (usage: TokenUsage) => void,
  ): Promise<SubAgentDispatchResult> => {
    if (request.plan.nodes.length !== 1) {
      throw new CliError(
        "派生计划必须为单节点（多节点计划属于 DAG 编排，当前版本未开放）",
      );
    }
    if (request.mode === "sync") {
      // 同步路径：直连执行核，留在调用方的回合取消上下文内（现状语义，不占后台并发额度）
      const spec = request.plan.nodes[0];
      const result = await runner(buildRequest(spec), onUsage);
      return { kind: "sync", output: result.output };
    }
    if (!backgroundEnabled) {
      throw new CliError(
        "当前会话不支持后台任务（单次任务模式执行完即退出，无处等待与收割结果），请使用同步派生",
      );
    }
    if (runningIds.size >= maxBackground) {
      throw new CliError(
        `后台任务已达上限（${maxBackground} 个运行中）：请先用 task_status 查询并收割已完成任务，或稍后再试`,
      );
    }
    nextNodeId += 1;
    nextRunId += 1;
    const node: TaskNodeState = {
      id: `n${nextNodeId}`,
      runId: `r${nextRunId}`,
      spec: request.plan.nodes[0],
      status: "queued",
      preview: buildTaskPreview(request.plan.nodes[0].task) || "（空任务）",
      startedAt: Date.now(),
    };
    nodes.set(node.id, node);
    usageByNode.set(node.id, onUsage);
    // 调度泵启动该节点（v1 就绪判定恒真：依赖为空）
    pump();
    return {
      kind: "background",
      runId: node.runId,
      nodeId: node.id,
      preview: node.preview,
    };
  };

  const requestStop = (nodeId: string): boolean => {
    const node = nodes.get(nodeId);
    if (!node || (node.status !== "queued" && node.status !== "running")) {
      return false;
    }
    stopRequested.add(nodeId);
    return true;
  };

  return {
    dispatch,
    list: () => {
      const sorted = [...nodes.values()];
      sorted.sort(
        (a, b) =>
          Number(a.id.slice(1)) - Number(b.id.slice(1)),
      );
      return sorted;
    },
    get: (nodeId) => nodes.get(nodeId),
    requestStop,
    drainEvents: () => pendingEvents.splice(0, pendingEvents.length),
    hasPendingEvents: () => pendingEvents.length > 0,
    hasRunning: () => runningIds.size > 0,
    waitForAll: async () => {
      // 快照等待 + 循环：等待期间可能有新节点启动（v1 不会，防御 DAG 场景）
      while (inflight.size > 0) {
        await Promise.all([...inflight]);
      }
    },
  };
}
