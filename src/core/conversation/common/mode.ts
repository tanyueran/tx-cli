/** 对话模式配置：chat、agent 命令的模式差异项，会话入口（单次/多轮）据此装配运行时 */
export interface ConversationModeConfig {
  /** 模式基础人设（chat、agent 各自定义），经 setupSkillContext 组装技能清单后下发 */
  basePrompt: string;
  /** 模式标签（REPL 欢迎语展示，如「对话模式」「Agent 模式」） */
  modeLabel: string;
  /** bash 工具是否装配；未指定时跟随 sandboxCli/配置默认（agent 模式），chat 模式固定传 false */
  bashEnabled?: boolean;
  /** agentic 循环的工具调用轮数上限，超出后软收敛为直接作答；未指定时由 loop 回退默认值 */
  maxIterations?: number;
}
