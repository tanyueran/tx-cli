/**
 * cli/conversation/repl/state：终端 REPL 状态与装配
 * 通用会话状态（历史、用量、子 Agent、压缩）由 core 的 ConversationSession 持有；
 * 本模块只负责终端专属状态（输入历史、草稿还原、后台唤醒槽、自动继续计数）
 * 与斜杠命令注册表的桥接
 */
import type { ConversationSession, SessionChannels } from "@tx-cli/core";
import { buildSkillSuggestions, buildSlashCommands } from "./slash-commands";
import type { SlashCommand } from "./slash-commands";

/** 终端 REPL 启动参数：已装配的无头会话与模式标签 */
export interface ReplOptions {
  /** 无头多轮会话（core 装配，生命周期由调用方管理） */
  session: ConversationSession;
  /** 模式标签（就绪面板「模式」行展示，如「对话模式」「Agent 模式」） */
  modeLabel: string;
  /** 会话通道集合：输入 / 输出 / 交互提示的终端实现 */
  channels: SessionChannels;
}

/** 终端 REPL 状态：主循环各步骤共享的终端侧状态，可变项集中在对象属性上 */
export interface ReplState {
  /** 启动参数（无头会话、模式标签、通道） */
  options: ReplOptions;
  /** 输入历史（面板关闭时 ↑/↓ 回溯），上限 200 条 */
  inputHistory: string[];
  /** 被后台事件打断时还原的用户草稿：下一次输入等待时预填，提交或再次打断后清除 */
  pendingDraft?: string;
  /**
   * 后台事件唤醒槽：输入等待期间由 waitForInputOrBackground 注册，
   * 会话的 onBackgroundEvent 回调触发，离开等待即清除
   */
  backgroundWake?: () => void;
  /** 连续自动继续轮计数：后台事件自动发起的回合数（真实用户输入时清零，防自动链失控） */
  autoTurnCount: number;
  /** 斜杠命令注册表：补全面板、/help、就绪面板与分发共用 */
  commands: SlashCommand[];
  /** 技能建议列表（/skill 二级补全）：技能清单会话内不变，构建一次 */
  skillSuggestions: ReturnType<typeof buildSkillSuggestions>;
}

/**
 * 创建终端 REPL 状态：初始化输入历史等终端状态，构建桥接无头会话的斜杠命令注册表
 * @param {ReplOptions} options - 启动参数（无头会话、模式标签、通道）
 * @returns {ReplState} 终端 REPL 状态
 */
export function createReplState(options: ReplOptions): ReplState {
  const { session } = options;
  const { runtime } = session;
  const state: ReplState = {
    options,
    inputHistory: [],
    autoTurnCount: 0,
    commands: [],
    skillSuggestions: buildSkillSuggestions(runtime.assembly.catalog),
  };
  // 斜杠命令注册表：经闭包桥接无头会话（档位读写、/clear 重置、/export 存档）
  state.commands = buildSlashCommands({
    sandbox: runtime.sandbox,
    bashEnabled: runtime.assembly.bashEnabled,
    catalog: runtime.assembly.catalog,
    todoHandle: runtime.assembly.todoHandle,
    thinkingStyle: session.thinkingStyle,
    output: options.channels.output,
    getThinkingLevel: () => session.thinkingLevel,
    setThinkingLevel: (next) => {
      session.setThinkingLevel(next);
    },
    // /clear：重置会话状态（历史、用量、任务清单），输入历史由终端侧一并清理
    clearSession: () => {
      const cleared = session.clear();
      state.inputHistory.length = 0;
      return cleared;
    },
    // /export：把当前历史与累计用量写入当前目录的 Markdown 存档
    exportSession: () => session.exportSession(),
  });
  return state;
}
