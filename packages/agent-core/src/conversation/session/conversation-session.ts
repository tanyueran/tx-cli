/**
 * conversation/session/conversation-session：无头多轮会话
 * 集中持有会话运行时、跨轮 history、思考档位与协议风格、累计用量、压缩配置、
 * 子 Agent 工具句柄与调度器，提供串行 runTurn、档位切换、清空会话、协作式取消
 * 与幂等 dispose；CLI、桌面端与云端复用同一套多轮控制，不各自复制
 * 子 Agent 装配、后台事件历史注入与用量汇总逻辑
 */
import { executeConversationTurn } from "../loop/execute-turn";
import { DEFAULT_MAX_ITERATIONS } from "../loop/loop";
import {
  formatCompactionNotice,
  maybeCompactHistory,
} from "../loop/compaction";
import {
  createConversationRuntime,
  disposeConversationRuntime,
} from "./runtime";
import type { ConversationRuntime } from "./runtime";
import type { ConversationModeConfig } from "./mode";
import type { SandboxCliOptions } from "../../sandbox";
import {
  createUsageAccumulator,
  resolveCompactionConfig,
  resolveResponsesThinkingFields,
  resolveThinkingLevel,
  resolveThinkingStyle,
} from "../../llm";
import type { CompactionConfig, UsageAccumulator } from "../../llm";
import type { SessionChannels } from "../../channels";
import type {
  LlmConfig,
  ResponseHistoryItem,
  ThinkingLevel,
  ThinkingStyle,
  TokenUsage,
} from "../../llm/types";
import { CancelError, CliError } from "@tanyueran/agent-common";
import { attachSubAgentIfEnabled } from "../sub-agent/attach";
import type {
  SubAgentDispatcher,
  SubAgentNodeEvent,
} from "../sub-agent/dispatcher";
import type { SubAgentToolHandle } from "../sub-agent/tools";
import {
  buildBackgroundNotice,
  printTaskEventLines,
} from "./background-events";
import { writeSessionMarkdown } from "./session-export";

/** 单轮回合的执行结果：本轮用量 + 结局（取消 / 失败时调用方跳过用量表格展示） */
export interface ConversationTurnResult {
  /** 本轮累计用量（含 agentic 循环的多次请求与子 Agent） */
  turnUsage: TokenUsage;
  /** 回合结局：completed 正常完成；cancelled 用户取消（历史已回滚）；failed 可预期业务错误（已提示） */
  status: "completed" | "cancelled" | "failed";
}

/** ConversationSession.create 入参对象 */
export interface ConversationSessionOptions {
  /** LLM 接入配置 */
  llmConfig: LlmConfig;
  /** 模式配置（人设、标签、工具带装配策略） */
  modeConfig: ConversationModeConfig;
  /** 命令行指定的思考档位，未指定时回退配置默认 */
  thinkingLevel?: ThinkingLevel;
  /** 是否启用 MCP 服务器（--no-mcp 关闭），缺省开启 */
  mcpEnabled?: boolean;
  /** CLI 传入的沙箱选项（agent 命令的 --sandbox 等），缺省按配置文件装配 */
  cliSandboxOptions?: SandboxCliOptions;
  /** 会话通道集合：输入 / 输出 / 交互提示的抽象出口，由各端注入 */
  channels: SessionChannels;
  /**
   * 后台节点终态事件回调：事件写入调度器队列时同步触发，
   * CLI 借此唤醒输入等待（用户纯等待时后台任务完成即自动继续）
   */
  onBackgroundEvent?: (event: SubAgentNodeEvent) => void;
}

/**
 * 无头多轮会话：回合编排（后台事件收割 → 压缩 → 回合执行 → 用量汇总）的唯一实现
 *
 * 历史口径：store=false，服务端不留存会话，历史由本地维护并每轮全量发送；
 * 取消时回滚未完整提交的历史，释放时关闭 MCP 与沙箱
 */
export class ConversationSession {
  /** 会话运行时（MCP、沙箱、技能装配结果） */
  readonly runtime: ConversationRuntime;
  /** 跨轮对话历史：每轮全量发送给服务端，跨轮累积 */
  readonly history: ResponseHistoryItem[] = [];
  /** 会话累计用量：主循环、压缩摘要、子 Agent 多来源汇入 */
  readonly usage: UsageAccumulator = createUsageAccumulator();
  /** 思考协议风格（会话内不变，创建时解析一次） */
  readonly thinkingStyle: ThinkingStyle;
  /** 上一次主会话请求的 input token：压缩判定优先用它（含系统提示与工具定义，口径最准） */
  lastInputTokens: number | undefined;
  /** 压缩配置：未配置 llm.context.maxContextTokens 时为 undefined，压缩完全不介入 */
  readonly compactionConfig: CompactionConfig | undefined;
  /** 子 Agent 工具句柄：按轮设置用量上报器，未装配时为 undefined */
  readonly subAgentHandle: SubAgentToolHandle | undefined;
  /** 子 Agent 调度器：收割后台节点事件、退出前等待 */
  readonly subAgentDispatcher: SubAgentDispatcher | undefined;
  /** 当前思考档位持有者：setThinkingLevel 写入，回合与子 Agent 扩展字段读取同一份 */
  private readonly level: { current: ThinkingLevel };
  /** 释放标记：dispose 幂等 */
  private disposed = false;

  /**
   * 私有构造：请使用 ConversationSession.create 装配
   * @param {ConversationSessionOptions} options - 创建入参
   * @param {ConversationRuntime} runtime - 已装配的会话运行时
   */
  private constructor(
    private readonly options: ConversationSessionOptions,
    runtime: ConversationRuntime,
  ) {
    this.runtime = runtime;
    this.thinkingStyle = resolveThinkingStyle(options.llmConfig);
    this.level = {
      current: resolveThinkingLevel({
        cliLevel: options.thinkingLevel,
        llmConfig: options.llmConfig,
        fallback: options.modeConfig.defaultThinkingLevel,
      }),
    };
    this.compactionConfig = resolveCompactionConfig(options.llmConfig.context);
    // 子 Agent 工具按模式装配：三个工具增量合并进 runtime.assembly 的两份列表；
    // 扩展字段闭包读取当前档位，setThinkingLevel 切换后子 Agent 同步生效
    const { handle, dispatcher } = attachSubAgentIfEnabled({
      enabled: options.modeConfig.subAgentEnabled,
      llmConfig: options.llmConfig,
      tools: runtime.assembly.tools,
      advertisedTools: runtime.assembly.advertisedTools,
      skills: runtime.assembly.catalog.list(),
      extraBody: () =>
        resolveResponsesThinkingFields({
          thinkingLevel: this.level.current,
          thinkingStyle: this.thinkingStyle,
          thinkingEffortMap: options.llmConfig.thinkingEffortMap,
        }),
      onNodeEvent: options.onBackgroundEvent,
      output: options.channels.output,
    });
    this.subAgentHandle = handle;
    this.subAgentDispatcher = dispatcher;
  }

  /**
   * 创建无头多轮会话：装配会话运行时（MCP / 沙箱 / 技能）与子 Agent 工具带
   * @param {ConversationSessionOptions} options - 创建入参（字段说明见接口定义）
   * @returns {Promise<ConversationSession>} 就绪的会话实例
   */
  static async create(
    options: ConversationSessionOptions,
  ): Promise<ConversationSession> {
    const runtime = await createConversationRuntime(
      options.modeConfig.basePrompt,
      {
        mcpEnabled: options.mcpEnabled ?? true,
        bashEnabled: options.modeConfig.bashEnabled,
        todosEnabled: options.modeConfig.todosEnabled,
        writeToolsEnabled: options.modeConfig.writeToolsEnabled,
        cliSandboxOptions: options.cliSandboxOptions,
        channels: options.channels,
      },
    );
    return new ConversationSession(options, runtime);
  }

  /** 当前生效的思考档位（/think 等入口经 setThinkingLevel 切换） */
  get thinkingLevel(): ThinkingLevel {
    return this.level.current;
  }

  /** 会话的 LLM 接入配置（就绪面板与用量展示读取单价等字段） */
  get llmConfig(): LlmConfig {
    return this.options.llmConfig;
  }

  /**
   * 切换思考档位：下一轮主会话请求与子 Agent 派生同步生效
   * @param {ThinkingLevel} next - 新档位
   * @returns {void}
   */
  setThinkingLevel(next: ThinkingLevel): void {
    this.level.current = next;
  }

  /**
   * 取走全部后台终态事件并清空队列（自动继续路径与回合开始收割共用）
   * @returns {SubAgentNodeEvent[]} 终态事件列表
   */
  drainBackgroundEvents(): SubAgentNodeEvent[] {
    return this.subAgentDispatcher?.drainEvents() ?? [];
  }

  /**
   * 把一批后台终态事件打印通知行并注入历史（user 角色承载的系统通知）
   * @param {SubAgentNodeEvent[]} events - 节点终态事件
   * @returns {void}
   */
  ingestBackgroundEvents(events: SubAgentNodeEvent[]): void {
    printTaskEventLines(events, this.options.channels.output);
    this.history.push({
      type: "message",
      role: "user",
      content: buildBackgroundNotice(events),
    });
  }

  /**
   * 清空会话：重置历史、累计用量与压缩口径、任务清单，保留运行时
   * （system 提示词、工具、MCP、沙箱）；输入历史等终端状态由调用方自行清理
   * @returns {number} 被清空的历史条数
   */
  clear(): number {
    const cleared = this.history.length;
    this.history.length = 0;
    this.usage.reset();
    this.lastInputTokens = undefined;
    this.runtime.assembly.todoHandle?.resetTodos();
    return cleared;
  }

  /**
   * 导出会话为 Markdown 存档：历史为空时返回 undefined
   * @returns {Promise<string | undefined>} 写入文件的绝对路径
   */
  async exportSession(): Promise<string | undefined> {
    if (this.history.length === 0) {
      return undefined;
    }
    return writeSessionMarkdown(this.history, {
      modeLabel: this.options.modeConfig.modeLabel,
      model: this.options.llmConfig.model,
      thinkingLevel: this.level.current,
      usage: this.usage.current,
      pricing: this.options.llmConfig.pricing,
    });
  }

  /**
   * 执行一个对话回合（串行）：收割后台事件 → 回合前压缩（安全点）→ 设置子 Agent
   * 用量上报器 → 回合执行 → 错误兜底；返回本轮用量与结局供调用方展示
   *
   * 单轮请求失败（网络抖动、限流等可预期错误）只提示不终止会话，避免丢失整个对话上下文；
   * 交互中取消（Ctrl+C）回滚本轮历史后继续会话；未预期错误仍上抛
   * @param {string} userInput - 本轮用户输入
   * @returns {Promise<ConversationTurnResult>} 本轮累计用量与结局（completed/cancelled/failed）
   */
  async runTurn(userInput: string): Promise<ConversationTurnResult> {
    const { output } = this.options.channels;
    // 本轮用量：agentic 循环一次用户输入可能发生多次 LLM 请求，按回调逐次累加
    const turnUsage = createUsageAccumulator();
    // 回合开始收割后台任务事件：打印通知行并注入历史，本轮请求即可见（含用户打字期间完成的任务）；
    // 注入发生在 historyStart 记录之前——回合被取消回滚时通知保留，事件不会因取消而丢失
    const pendingEvents = this.drainBackgroundEvents();
    if (pendingEvents.length > 0) {
      this.ingestBackgroundEvents(pendingEvents);
    }
    // 回合开始前是压缩安全点：上一轮已完整结束，此时压缩不会切断工具调用配对
    await this.compactBeforeTurn(turnUsage);
    // 记录本轮开始前历史长度：本轮被取消时回滚，避免残留未配对的用户输入或工具调用项
    // 必须在压缩之后记录：压缩会缩短历史，若以压缩前长度为基准回滚会把摘要一并裁掉
    const historyStart = this.history.length;
    // 回合开始前设置子 Agent 用量上报器：子 Agent 用量计入本轮与累计，
    // 但不覆盖 lastInputTokens（压缩阈值只按主会话请求口径判断）
    this.subAgentHandle?.setUsageReporter((usage) => {
      turnUsage.add(usage);
      this.usage.add(usage);
    });
    try {
      await executeConversationTurn({
        llmConfig: this.options.llmConfig,
        thinkingLevel: this.level.current,
        thinkingStyle: this.thinkingStyle,
        history: this.history,
        userInput,
        instructions: this.runtime.assembly.systemPrompt,
        tools: this.runtime.assembly.tools,
        advertisedTools: this.runtime.assembly.advertisedTools,
        maxIterations:
          this.options.modeConfig.maxIterations ?? DEFAULT_MAX_ITERATIONS,
        output,
        onUsage: (usage) => {
          turnUsage.add(usage);
          this.usage.add(usage);
          // 口径约定：lastInputTokens 只按真实请求更新（摘要请求不走此回调）
          this.lastInputTokens = usage.inputTokens;
        },
        // 压缩摘要请求的用量只计入统计：摘要 inputTokens ≈ 被压缩段原大小，
        // 回流 lastInputTokens 会让下一轮 compactBeforeTurn 误判而重复压缩
        onCompactionUsage: (usage) => {
          turnUsage.add(usage);
          this.usage.add(usage);
        },
      });
      output.text("");
      output.text("");
    } catch (err) {
      // 审批等交互中按 Ctrl+C：只中断本轮并回滚本轮历史，会话继续
      if (err instanceof CancelError) {
        this.history.length = historyStart;
        output.text("");
        output.warn("已取消本轮");
        return { turnUsage: turnUsage.current, status: "cancelled" };
      }
      // 仅吞可预期的业务错误（网络、接口报错）；未预期错误仍上抛，避免代码 bug 被无限循环掩盖
      if (!(err instanceof CliError)) {
        throw err;
      }
      // 换行避免错误提示接在残缺的流式输出之后
      output.text("");
      output.error(err.message);
      return { turnUsage: turnUsage.current, status: "failed" };
    } finally {
      // 回合结束即撤销上报器：避免子 Agent 用量混入后续轮次统计
      this.subAgentHandle?.setUsageReporter(undefined);
    }
    return { turnUsage: turnUsage.current, status: "completed" };
  }

  /**
   * 会话退出前等待后台任务：先 flush 已完成事件；仍有运行中任务时等待全部结束，
   * 等待期间产生的终态事件最后统一打印（只打印不注入历史，会话即将结束）
   * @returns {Promise<void>}
   */
  async awaitBackgroundTasksOnExit(): Promise<void> {
    const dispatcher = this.subAgentDispatcher;
    if (!dispatcher) {
      return;
    }
    const { output } = this.options.channels;
    const flush = (): void => {
      const events = this.drainBackgroundEvents();
      if (events.length > 0) {
        printTaskEventLines(events, output);
      }
    };
    flush();
    if (!dispatcher.hasRunning()) {
      return;
    }
    output.warn("存在运行中的后台任务，等待完成后再退出…（如需放弃等待请再按一次 Ctrl+C）");
    await dispatcher.waitForAll();
    flush();
  }

  /**
   * 释放会话资源：断开 MCP 连接（stdio 子进程随之退出）并关闭沙箱；幂等
   * @returns {Promise<void>}
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    await disposeConversationRuntime(this.runtime);
  }

  /**
   * 回合前压缩早期历史（安全点）：摘要请求的用量计入本轮与会话累计，保证统计口径完整
   * @param {UsageAccumulator} turnUsage - 本轮用量累加器
   * @returns {Promise<void>}
   */
  private async compactBeforeTurn(turnUsage: UsageAccumulator): Promise<void> {
    if (!this.compactionConfig) {
      return;
    }
    const outcome = await maybeCompactHistory({
      llmConfig: this.options.llmConfig,
      history: this.history,
      config: this.compactionConfig,
      lastInputTokens: this.lastInputTokens,
      onUsage: (usage) => {
        turnUsage.add(usage);
        this.usage.add(usage);
      },
    });
    const notice = formatCompactionNotice(outcome);
    if (notice) {
      if (outcome.status === "failed") {
        this.options.channels.output.warn(notice);
      } else {
        this.options.channels.output.system(notice);
      }
    }
  }
}
