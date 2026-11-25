/**
 * conversation/sub-agent/types：子 Agent 跨模块共享的公共契约
 *
 * 提取自 attach.ts，供 attach / dispatcher / tools 三层共同引用，
 * 避免 dispatcher、tools 为拿到类型而反向导入 attach（执行核）形成循环。
 * 本文件只允许依赖更底层的类型（llm/types），不得导入 attach.ts。
 */
import type { TokenUsage } from "../../llm/types";

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
