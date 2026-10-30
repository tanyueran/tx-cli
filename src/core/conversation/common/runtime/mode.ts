import type { ThinkingLevel } from "../../../llm/types";

/** 对话模式配置：chat、agent 命令的模式差异项，会话入口（单次/多轮）据此装配运行时 */
export interface ConversationModeConfig {
  /** 模式基础人设（chat、agent 各自定义），经 setupSkillContext 组装技能清单后下发 */
  basePrompt: string;
  /** 模式标签（REPL 就绪面板「模式」行展示，如「对话模式」「Agent 模式」） */
  modeLabel: string;
  /**
   * bash 工具是否装配（三态约定的单一说明源）：
   * - undefined（缺省）：跟随 CLI/配置/沙箱存在性决定（agent 模式）
   * - false：强制不装配，同时跳过 bash 专用装载（Provider）并抑制 bash 相关警告（chat 模式）
   * 传递链：ConversationModeConfig → ConversationOptions → SkillAssemblyOptions（skill-context 侧缺省视为 true）
   */
  bashEnabled?: boolean;
  /** 任务清单工具（write_todos）是否装配；agent 模式开启，chat 只读问答不装配 */
  todosEnabled?: boolean;
  /** 写侧内置工具（write_file / edit_file）是否装配；未指定时装配（由沙箱档位兜底），chat 模式固定传 false */
  writeToolsEnabled?: boolean;
  /** agentic 循环的工具调用轮数上限，超出后软收敛为直接作答；未指定时由 loop 回退默认值 */
  maxIterations?: number;
  /** 思考档位兜底默认值：CLI 与配置（项目 > 全局）均未指定时使用；未指定时回退 medium */
  defaultThinkingLevel?: ThinkingLevel;
}
