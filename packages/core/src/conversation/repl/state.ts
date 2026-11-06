/**
 * conversation/repl/state：REPL 会话状态与装配
 * ReplSession（回合执行的会话上下文）、ReplOptions（REPL 启动参数）、ReplState（主循环共享状态）
 * 与 createReplState（子 Agent 工具带装配、斜杠命令注册表桥接）集中在此，
 * 主循环（repl.ts）只消费状态、不感知装配细节
 */
import { attachSubAgentIfEnabled } from "../sub-agent/attach";
import type { SubAgentDispatcher } from "../sub-agent/dispatcher";
import type { SubAgentToolHandle } from "../sub-agent/tools";
import type { ConversationRuntime } from "../session/runtime";
import type { TodoToolHandle, Tool } from "../../tools";
import {
  createUsageAccumulator,
  resolveCompactionConfig,
  resolveResponsesThinkingFields,
} from "../../llm";
import type { CompactionConfig, UsageAccumulator } from "../../llm";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
  ThinkingStyle,
} from "../../llm/types";
import { buildSkillSuggestions, buildSlashCommands } from "./slash-commands";
import type { SlashCommand } from "./slash-commands";
import { writeSessionMarkdown } from "./session-export";

/** REPL 会话上下文：会话期间不变的依赖打包，避免逐参数透传 */
interface ReplSession {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 思考协议风格（会话内不变，启动时解析一次） */
  thinkingStyle: ThinkingStyle;
  /** 组装后的 system 提示词（含技能元数据清单） */
  systemPrompt: string;
  /** 本会话可执行的工具列表（全量，含未激活的 MCP 工具） */
  tools: Tool[];
  /** 下发给模型的工具清单（MCP 折叠时仅含 discover_mcp_tools 与已激活工具，与请求层共享引用） */
  advertisedTools: Tool[];
  /** 任务清单工具句柄（agent 模式装配 write_todos 时存在，/todos 读取清单状态） */
  todoHandle?: TodoToolHandle;
  /** 工具调用轮数上限（按模式装配：chat 8 轮、agent 40 轮），超出后软收敛为直接作答 */
  maxIterations: number;
}

/** REPL 启动参数：会话运行时与模式差异项（欢迎语标签） */
export interface ReplOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 会话运行时（MCP、沙箱、技能装配结果），生命周期由调用方管理 */
  runtime: ConversationRuntime;
  /** 思考协议风格（启动时解析一次） */
  thinkingStyle: ThinkingStyle;
  /** 初始思考档位（/think 切换后下一轮使用新档位） */
  initialThinkingLevel: ThinkingLevel;
  /** 模式标签（就绪面板「模式」行展示，如「对话模式」「Agent 模式」） */
  modeLabel: string;
  /** 工具调用轮数上限（来自模式配置，如 chat 8 轮、agent 40 轮） */
  maxIterations: number;
  /** 是否装配子 Agent 工具（delegate_task）；agent 模式开启，chat 只读问答不装配 */
  subAgentEnabled?: boolean;
}

/** REPL 会话状态：主循环各步骤共享的会话内状态，可变项集中在对象属性上 */
export interface ReplState {
  /** 启动参数（模式标签、会话运行时、配置） */
  options: ReplOptions;
  /** 会话上下文（配置、协议风格、提示词、工具列表） */
  session: ReplSession;
  /** 当前思考档位持有者：/think 写入，回合与子 Agent 扩展字段读取同一份 */
  level: { current: ThinkingLevel };
  /** 跨轮对话历史：store=false 模式下每轮全量发送给服务端，跨轮累积 */
  history: ResponseHistoryItem[];
  /** 输入历史（面板关闭时 ↑/↓ 回溯），上限 200 条 */
  inputHistory: string[];
  /** 会话累计用量：主循环、压缩摘要、子 Agent 多来源汇入 */
  usage: UsageAccumulator;
  /** 上一次主会话请求的 input token：压缩判定优先用它（含系统提示与工具定义，口径最准） */
  lastInputTokens?: number;
  /** 压缩配置：未配置 llm.context.maxContextTokens 时为 undefined，压缩完全不介入 */
  compactionConfig?: CompactionConfig;
  /** 子 Agent 工具句柄：按轮设置用量上报器，未装配时为 undefined */
  subAgentHandle?: SubAgentToolHandle;
  /** 子 Agent 调度器：收割后台节点事件（回合边界 flush 与历史注入）、退出前等待 */
  subAgentDispatcher?: SubAgentDispatcher;
  /**
   * 后台事件唤醒槽：输入等待期间由 waitForInputOrBackground 注册，
   * 调度器 onNodeEvent 回调触发（createReplState 闭包持有），离开等待即清除
   */
  backgroundWake?: () => void;
  /** 连续自动继续轮计数：后台事件自动发起的回合数（真实用户输入时清零，防自动链失控） */
  autoTurnCount: number;
  /** 被后台事件打断时还原的用户草稿：下一次输入等待时预填，提交或再次打断后清除 */
  pendingDraft?: string;
  /** 斜杠命令注册表：补全面板、/help、就绪面板与分发共用 */
  commands: SlashCommand[];
  /** 技能建议列表（/skill 二级补全）：技能清单会话内不变，构建一次 */
  skillSuggestions: ReturnType<typeof buildSkillSuggestions>;
}

/**
 * 创建 REPL 会话状态：装配子 Agent 工具带、初始化历史/用量/压缩口径、构建斜杠命令注册表
 * @param {ReplOptions} options - 启动参数（配置、会话运行时、思考风格与初始档位、模式标签）
 * @returns {ReplState} 会话状态
 */
export function createReplState(options: ReplOptions): ReplState {
  const { llmConfig, runtime, thinkingStyle } = options;
  const { systemPrompt, catalog, todoHandle } = runtime.assembly;
  // 档位持有者先建：子 Agent 的扩展字段闭包与 /think 命令读写同一份可变档位
  const level: { current: ThinkingLevel } = {
    current: options.initialThinkingLevel,
  };
  // 子 Agent 工具按模式装配：三个工具增量合并进 runtime.assembly 的两份列表；
  // 扩展字段闭包读取当前档位，/think 切换后子 Agent 同步生效；
  // onNodeEvent 转发给输入等待的唤醒槽（state 经包装引用延迟绑定，装配早于字面量创建）
  const stateRef: { current?: ReplState } = {};
  const {
    handle: subAgentHandle,
    dispatcher: subAgentDispatcher,
  } = attachSubAgentIfEnabled({
    enabled: options.subAgentEnabled,
    llmConfig,
    tools: runtime.assembly.tools,
    advertisedTools: runtime.assembly.advertisedTools,
    skills: catalog.list(),
    extraBody: () =>
      resolveResponsesThinkingFields({
        thinkingLevel: level.current,
        thinkingStyle,
        thinkingEffortMap: llmConfig.thinkingEffortMap,
      }),
    onNodeEvent: () => stateRef.current?.backgroundWake?.(),
  });
  const state: ReplState = {
    options,
    session: {
      llmConfig,
      thinkingStyle,
      systemPrompt,
      // 工具集单一事实源为 runtime.assembly（已含子 Agent 增量，与 MCP 激活机制共享引用）
      tools: runtime.assembly.tools,
      advertisedTools: runtime.assembly.advertisedTools,
      todoHandle,
      maxIterations: options.maxIterations,
    },
    level,
    history: [],
    inputHistory: [],
    usage: createUsageAccumulator(),
    compactionConfig: resolveCompactionConfig(llmConfig.context),
    subAgentHandle,
    subAgentDispatcher,
    autoTurnCount: 0,
    commands: [],
    skillSuggestions: buildSkillSuggestions(catalog),
  };
  // 唤醒槽接线完成：此后调度器事件可打断输入等待
  stateRef.current = state;
  // 斜杠命令注册表：经闭包桥接会话状态（档位读写、/clear 重置、/export 存档）
  state.commands = buildSlashCommands({
    sandbox: runtime.sandbox,
    bashEnabled: runtime.assembly.bashEnabled,
    catalog,
    todoHandle,
    thinkingStyle,
    getThinkingLevel: () => state.level.current,
    setThinkingLevel: (next) => {
      state.level.current = next;
    },
    // /clear：只重置会话状态，保留运行时（system 提示词、工具、MCP、沙箱）
    clearSession: () => {
      const cleared = state.history.length;
      state.history.length = 0;
      state.usage.reset();
      state.lastInputTokens = undefined;
      state.inputHistory.length = 0;
      todoHandle?.resetTodos();
      return cleared;
    },
    // /export：把当前历史与累计用量写入当前目录的 Markdown 存档
    exportSession: async () => {
      if (state.history.length === 0) {
        return undefined;
      }
      return writeSessionMarkdown(state.history, {
        modeLabel: options.modeLabel,
        model: llmConfig.model,
        thinkingLevel: state.level.current,
        usage: state.usage.current,
        pricing: llmConfig.pricing,
      });
    },
  });
  return state;
}
