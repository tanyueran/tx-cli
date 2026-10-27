import type { ToolDefinition } from "../llm/types";
import type { McpToolMeta } from "../sandbox/types";

/**
 * 工具执行的输出载体：不含调用配对信息（callId 由执行器统一包装）
 */
export interface ToolOutput {
  /** 执行是否成功 */
  ok: boolean;
  /**
   * 回传给模型的内容：成功时为工具输出，失败时为错误说明
   * 失败信息同样回传，模型可据此调整参数重试
   */
  output: string;
}

/**
 * 工具执行结果：ToolOutput 加上调用配对 ID，供回合适配器回传
 */
export interface ToolResult extends ToolOutput {
  /** 对应的工具调用 ID（ToolCall.callId），回传结果时用于配对 */
  callId: string;
}

/** 工具的能力类别：权限规则语法的判定依据 */
export type ToolCapability = "fs.read" | "fs.write" | "net" | "exec";

/**
 * 工具的权限声明：声明后由权限门卫（permission 包装层）做 L2/L3 管控
 * 未声明的工具不经门卫直接执行（零破坏渐进迁移）
 */
export interface ToolPermission {
  /** 工具涉及的 capability 清单 */
  capabilities: ToolCapability[];
  /**
   * 生成规则键：权限规则匹配的主体
   * 如 bash 工具生成 bash(git status)、read_file 生成 read(/abs/path)
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {string} 规则键
   */
  ruleKey(args: Record<string, unknown>): string;
  /**
   * 声明本次调用涉及的文件系统绝对路径（可选）
   * capabilities 含 fs.read/fs.write 时，门卫在规则放行后按档位 TierConfig 逐路径做边界检查；
   * 未声明则不做路径级检查（如 web_search 等纯网络工具）
   * @param {Record<string, unknown>} args - 模型给出的参数
   * @returns {string[]} 本次调用涉及的绝对路径列表
   */
  paths?(args: Record<string, unknown>): string[];
  /** 是否串行执行（如 bash 并发会互相干扰），串行工具在会话级队列中依次执行 */
  isSerial?: boolean;
  /**
   * MCP 工具元信息（仅 MCP 工具声明）：携带服务器名与只读标记，
   * 沙箱据此区分 mcp-tool / mcp-read 类目，并按服务器粒度生成授权规则
   */
  mcp?: McpToolMeta;
}

/**
 * 工具接口：在 ToolDefinition（模型可见的定义）之上增加本地执行逻辑
 * 内置工具、技能工具（load_skill）、MCP 工具均实现此接口，不支持运行时动态注册
 */
export interface Tool extends ToolDefinition {
  /**
   * 单工具执行超时（毫秒）：缺省用执行器的全局超时（30s）
   * MCP 等外部工具可放宽（如 60s），由适配层按需声明
   */
  timeoutMs?: number;
  /**
   * 权限声明（可选）：声明后经 L2 规则判定 + L3 审批门卫包装
   */
  permission?: ToolPermission;
  /**
   * 自定义调用提示渲染（可选）：返回的文本替代默认的"→ 调用 name(原始 JSON 参数)"打印
   * 用于参数可读性差的工具（如 write_todos 渲染任务清单），可含换行多行展示
   * @param {Record<string, unknown>} args - 模型给出的参数（已解析的 JSON 对象）
   * @returns {string} 展示文本（在"→ 调用 name"提示行之后打印）
   */
  renderCall?(args: Record<string, unknown>): string;
  /**
   * 执行工具
   * @param {Record<string, unknown>} args - 模型给出的参数（已解析的 JSON 对象）
   * @returns {Promise<ToolOutput>} 执行输出（成功或失败的说明）
   */
  execute(args: Record<string, unknown>): Promise<ToolOutput>;
}
